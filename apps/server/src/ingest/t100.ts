import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { airportMonthTraffic, airports } from "../db/schema.js";
import { recordSource, upsertBatched } from "./lib/db-helpers.js";
import { RAW_DIR } from "./lib/paths.js";

const SOURCE_ID = "bts_t100_origin";
// "AFF - T100 Segment Summary By Origin Airport" on data.bts.gov (Socrata SODA API).
const DATASET_URL = "https://data.bts.gov/resource/r495-tyji.json";
const PAGE_SIZE = 50_000;

// Socrata gives some international columns generic suffixed names; map them explicitly.
const FIELDS = {
  month: "reporting_month",
  code: "origin_airport_code",
  btsAirportId: "origin_airport_id",
  departures: "total_departures",
  passengers: "total_passengers",
  seats: "total_seats",
  distancePerFlight: "total_distance_flight_sm",
  freightLbs: "total_freight_lbs",
  mailLbs: "total_mail_lbs",
  domesticDepartures: "domestic_departures",
  domesticPassengers: "domestic_passengers",
  domesticSeats: "domestic_seats",
  intlDepartures: "outbound_international", // Outbound International Departures
  intlPassengers: "outbound_international_1", // Outbound International Passengers
  intlSeats: "outbound_international_seats",
} as const;

type SodaRow = Partial<Record<(typeof FIELDS)[keyof typeof FIELDS], string>>;

async function soda<T>(params: Record<string, string>): Promise<T> {
  const res = await fetch(`${DATASET_URL}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`BTS SODA API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Latest month BTS has published, as "YYYY-MM-01". T-100 typically lags ~3 months. */
export async function latestT100Month(): Promise<string> {
  const [row] = await soda<{ max_reporting_month: string }[]>({ $select: "max(reporting_month)" });
  return row!.max_reporting_month.slice(0, 10);
}

export async function ingestT100(start: string, end: string, log = console.log): Promise<number> {
  const raw: SodaRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await soda<SodaRow[]>({
      $select: Object.values(FIELDS).join(","),
      $where: `reporting_month between '${start}T00:00:00' and '${end}T00:00:00'`,
      $order: ":id",
      $limit: String(PAGE_SIZE),
      $offset: String(offset),
    });
    raw.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  log(`  t100: fetched ${raw.length} airport-month rows from BTS API`);

  // Keep the raw API response alongside the other downloaded sources for reproducibility.
  await mkdir(path.join(RAW_DIR, "t100"), { recursive: true });
  await writeFile(path.join(RAW_DIR, "t100", `${start}_${end}.json`), JSON.stringify(raw));

  const known = new Set((await db.select({ code: airports.code }).from(airports)).map((r) => r.code));
  const n = (v: string | undefined) => (v ? Number(v) : 0);

  // BTS airport ID per code (by passengers, in case a code ever maps to several IDs). The on-time
  // step joins on this ID because codes can change (PBI -> DJT) while the ID stays the same.
  const idVolume = new Map<string, Map<number, number>>();
  for (const r of raw) {
    const code = r[FIELDS.code];
    const id = Number(r[FIELDS.btsAirportId]);
    if (!code || !known.has(code) || !Number.isInteger(id)) continue;
    const ids = idVolume.get(code) ?? new Map<number, number>();
    ids.set(id, (ids.get(id) ?? 0) + n(r[FIELDS.passengers]) + 1);
    idVolume.set(code, ids);
  }
  for (const [code, ids] of idVolume) {
    const [bestId] = [...ids].sort((a, b) => b[1] - a[1])[0]!;
    if (ids.size > 1) log(`  t100: ${code} reported under BTS IDs ${[...ids.keys()].join(", ")}; using ${bestId}`);
    await db.update(airports).set({ btsAirportId: bestId }).where(eq(airports.code, code));
  }

  // An IATA code can appear under more than one BTS airport ID in a month; sum them.
  const byKey = new Map<string, typeof airportMonthTraffic.$inferInsert & { distanceSum: number }>();
  for (const r of raw) {
    const code = r[FIELDS.code];
    const month = r[FIELDS.month]?.slice(0, 10);
    if (!code || !month || !known.has(code)) continue;
    const key = `${code}|${month}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        code,
        month,
        departures: 0,
        passengers: 0,
        seats: 0,
        domesticDepartures: 0,
        domesticPassengers: 0,
        domesticSeats: 0,
        intlDepartures: 0,
        intlPassengers: 0,
        intlSeats: 0,
        freightLbs: 0,
        mailLbs: 0,
        sourceId: SOURCE_ID,
        distanceSum: 0,
      };
      byKey.set(key, row);
    }
    const departures = n(r[FIELDS.departures]);
    row.departures += departures;
    row.passengers += n(r[FIELDS.passengers]);
    row.seats += n(r[FIELDS.seats]);
    row.domesticDepartures += n(r[FIELDS.domesticDepartures]);
    row.domesticPassengers += n(r[FIELDS.domesticPassengers]);
    row.domesticSeats += n(r[FIELDS.domesticSeats]);
    row.intlDepartures += n(r[FIELDS.intlDepartures]);
    row.intlPassengers += n(r[FIELDS.intlPassengers]);
    row.intlSeats += n(r[FIELDS.intlSeats]);
    row.freightLbs += n(r[FIELDS.freightLbs]);
    row.mailLbs += n(r[FIELDS.mailLbs]);
    row.distanceSum += n(r[FIELDS.distancePerFlight]) * departures;
  }

  const rows = [...byKey.values()].map(({ distanceSum, ...row }) => ({
    ...row,
    passengers: Math.round(row.passengers),
    seats: Math.round(row.seats),
    avgDistancePerFlight: row.departures > 0 ? distanceSum / row.departures : null,
  }));

  await recordSource({
    id: SOURCE_ID,
    name: "BTS T-100 Segment Summary by Origin Airport",
    url: "https://data.bts.gov/Aviation/AFF-T100-Segment-Summary-By-Origin-Airport/r495-tyji",
    description:
      "Monthly departures, passengers, seats, freight and mail on flights departing each airport; all carriers (US and foreign) reporting T-100, domestic and international.",
    periodStart: start,
    periodEnd: end,
    rowCount: rows.length,
    fetchedAt: new Date(),
  });
  await upsertBatched(airportMonthTraffic, rows, [airportMonthTraffic.code, airportMonthTraffic.month]);
  return rows.length;
}
