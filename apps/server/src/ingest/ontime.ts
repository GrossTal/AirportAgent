import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import { eq } from "drizzle-orm";
import { parse } from "csv-parse";
import { db } from "../db/client.js";
import { airportMonthOps, airports } from "../db/schema.js";
import { recordSource, upsertBatched } from "./lib/db-helpers.js";
import { downloadCached, urlExists } from "./lib/download.js";
import { daysInMonth, parseMonth } from "./lib/months.js";

const SOURCE_ID = "bts_ontime";
const SOURCE = {
  id: SOURCE_ID,
  name: "BTS Reporting Carrier On-Time Performance",
  url: "https://transtats.bts.gov/PREZIP/",
  description:
    "Every domestic flight by US reporting carriers (~0.5% of revenue or more): delays, cancellations, taxi times, distance. Aggregated per airport-month.",
};
// Verified cases where the sources disagree on state for the same airport.
const STATE_EQUIVALENTS: Record<string, string[]> = {
  DCA: ["VA"], // Reagan National: OurAirports files it under DC, BTS under VA (it sits in Arlington, VA)
};
const DISTANCE_GROUPS =12; // BTS DistanceGroup 1..11 (250-mile bands; 11 = 2,500+ miles), index 0 unused

const zipUrl = (year: number, month: number) =>
  `https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_${year}_${month}.zip`;

type Agg = Omit<typeof airportMonthOps.$inferInsert, "code" | "month" | "daysInMonth" | "sourceId">;

const emptyAgg = (): Agg => ({
  depScheduled: 0,
  depCancelled: 0,
  depOperated: 0,
  depDelayed15: 0,
  depDelayMinutes: 0,
  taxiOutMinutes: 0,
  taxiOutCount: 0,
  arrScheduled: 0,
  arrFlights: 0,
  arrDelayed15: 0,
  arrDelayMinutes: 0,
  nasDelayMinutes: 0,
  taxiInMinutes: 0,
  taxiInCount: 0,
  depByDistanceGroup: new Array(DISTANCE_GROUPS).fill(0),
  depByHour: new Array(24).fill(0),
});

/** Feed a large buffer to the CSV parser in slices so it can apply backpressure. */
function* slices(buf: Buffer, size = 1 << 20) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

type MonthAggregate = {
  aggs: Map<string, Agg>; // keyed by BTS airport ID
  seen: Map<string, { codes: Set<string>; states: Set<string> }>; // BTS ID -> codes/states reported this month
};

async function aggregateMonth(zipPath: string): Promise<MonthAggregate> {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
  if (!entry) throw new Error(`No CSV inside ${zipPath}`);

  const parser = Readable.from(slices(entry.getData())).pipe(parse({ relax_column_count: true }));
  const aggs = new Map<string, Agg>();
  const seen: MonthAggregate["seen"] = new Map();
  const get = (id: string, code: string, state: string | undefined) => {
    let s = seen.get(id);
    if (!s) seen.set(id, (s = { codes: new Set(), states: new Set() }));
    s.codes.add(code);
    if (state) s.states.add(state);
    let a = aggs.get(id);
    if (!a) aggs.set(id, (a = emptyAgg()));
    return a;
  };

  let col: Record<string, number> | undefined;
  for await (const rec of parser as AsyncIterable<string[]>) {
    if (!col) {
      col = Object.fromEntries(rec.map((name, i) => [name, i]));
      continue;
    }
    const num = (name: string) => {
      const v = rec[col![name]!];
      return v === undefined || v === "" ? null : Number(v);
    };
    const cancelled = num("Cancelled") === 1;
    const diverted = num("Diverted") === 1;

    const o = get(rec[col.OriginAirportID!]!, rec[col.Origin!]!, rec[col.OriginState!]);
    o.depScheduled++;
    if (cancelled) o.depCancelled++;
    const depDel15 = num("DepDel15");
    if (!cancelled && depDel15 !== null) {
      o.depOperated++;
      o.depDelayed15 += depDel15;
      o.depDelayMinutes += num("DepDelayMinutes") ?? 0;
    }
    const taxiOut = num("TaxiOut");
    if (taxiOut !== null) {
      o.taxiOutMinutes += taxiOut;
      o.taxiOutCount++;
    }
    const dg = num("DistanceGroup");
    if (dg !== null && dg >= 1 && dg < DISTANCE_GROUPS) o.depByDistanceGroup[dg]++;
    const crsDep = num("CRSDepTime");
    if (crsDep !== null) o.depByHour[Math.floor(crsDep / 100) % 24]++;

    const d = get(rec[col.DestAirportID!]!, rec[col.Dest!]!, rec[col.DestState!]);
    d.arrScheduled++;
    const arrDel15 = num("ArrDel15");
    if (!cancelled && !diverted && arrDel15 !== null) {
      d.arrFlights++;
      d.arrDelayed15 += arrDel15;
      d.arrDelayMinutes += num("ArrDelayMinutes") ?? 0;
      d.nasDelayMinutes += num("NASDelay") ?? 0;
    }
    const taxiIn = num("TaxiIn");
    if (taxiIn !== null) {
      d.taxiInMinutes += taxiIn;
      d.taxiInCount++;
    }
  }
  return { aggs, seen };
}

export async function ingestOnTime(months: string[], log = console.log): Promise<number> {
  const known = await db
    .select({ code: airports.code, state: airports.state, btsAirportId: airports.btsAirportId })
    .from(airports);
  const stateByCode = new Map(known.map((r) => [r.code, r.state]));
  const codeByBtsId = new Map(known.filter((r) => r.btsAirportId !== null).map((r) => [String(r.btsAirportId), r.code]));
  if (!codeByBtsId.size) log("  on-time: no BTS airport IDs recorded yet (run the t100 step first); falling back to codes");
  const loaded: string[] = [];
  let total = 0;

  // Register the source up front so the fact rows' foreign key is satisfied.
  await recordSource({ ...SOURCE, fetchedAt: new Date() });

  for (const m of months) {
    const { year, month } = parseMonth(m);
    const url = zipUrl(year, month);
    if (!(await urlExists(url))) {
      log(`  on-time ${m.slice(0, 7)}: not published yet, skipping`);
      continue;
    }
    log(`  on-time ${m.slice(0, 7)}: downloading/parsing...`);
    const zipPath = await downloadCached(url, `ontime/${year}_${month}.zip`);
    const { aggs, seen } = await aggregateMonth(zipPath);

    // Map each BTS airport to our code. Names are never used. Primary key: the BTS airport ID
    // (stable across code changes such as PBI -> DJT). Fallback for airports without an ID: the
    // reported code, accepted only if its state agrees with OurAirports.
    const toCode = (btsId: string): string | null => {
      const { codes, states } = seen.get(btsId)!;
      const reportedCode = [...codes].join("/");
      const byId = codeByBtsId.get(btsId);
      if (byId) {
        if (!codes.has(byId)) log(`  on-time ${m.slice(0, 7)}: ${reportedCode} -> ${byId} via BTS airport ID ${btsId}`);
        return byId;
      }
      if (codes.size !== 1) return null;
      const code = [...codes][0]!;
      const expected = stateByCode.get(code);
      if (!expected) return null;
      const accepted = new Set([expected, ...(STATE_EQUIVALENTS[code] ?? [])]);
      if ([...states].some((s) => !accepted.has(s))) {
        log(`  on-time ${m.slice(0, 7)}: SKIP ${code}, BTS state ${[...states].join("/")} != OurAirports ${expected}`);
        return null;
      }
      return code;
    };

    const byCode = new Map<string, Agg>();
    for (const [btsId, a] of aggs) {
      const code = toCode(btsId);
      if (!code) continue;
      if (byCode.has(code)) throw new Error(`Two BTS airports map to ${code} in ${m}; check airports.bts_airport_id`);
      byCode.set(code, a);
    }
    const rows = [...byCode].map(([code, a]) => ({ code, month: m, daysInMonth: daysInMonth(m), sourceId: SOURCE_ID, ...a }));
    // Replace the month wholesale so airports rejected on this run don't keep rows from an earlier one.
    await db.delete(airportMonthOps).where(eq(airportMonthOps.month, m));
    await upsertBatched(airportMonthOps, rows, [airportMonthOps.code, airportMonthOps.month]);
    log(`  on-time ${m.slice(0, 7)}: ${rows.length} airports`);
    loaded.push(m);
    total += rows.length;
  }

  if (loaded.length) {
    await recordSource({
      ...SOURCE,
      periodStart: loaded[0],
      periodEnd: loaded.at(-1),
      rowCount: total,
      fetchedAt: new Date(),
    });
  }
  return total;
}
