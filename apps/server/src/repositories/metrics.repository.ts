import { and, between, inArray, max, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { airportMonthOps, airportMonthTraffic } from "../db/schema.js";

export type TrafficTotals = {
  code: string;
  months: number;
  departures: number;
  passengers: number;
  seats: number;
  intlPassengers: number;
  intlDepartures: number;
  freightLbs: number;
  distanceWeighted: number; // sum(avg distance per flight * departures)
};

export type OpsTotals = {
  code: string;
  months: number;
  days: number;
  depScheduled: number;
  depCancelled: number;
  depOperated: number;
  depDelayed15: number;
  taxiOutMinutes: number;
  taxiOutCount: number;
  arrFlights: number;
  arrDelayed15: number;
  arrDelayMinutes: number;
  nasDelayMinutes: number;
  taxiInMinutes: number;
  taxiInCount: number;
  depByDistanceGroup: number[];
  depByHour: number[];
};

const t = airportMonthTraffic;
const o = airportMonthOps;

export async function latestTrafficMonth(): Promise<string | null> {
  const [row] = await db.select({ m: max(t.month) }).from(t);
  return row?.m ?? null;
}

export async function trafficTotals(codes: string[], start: string, end: string): Promise<TrafficTotals[]> {
  if (!codes.length) return [];
  return db
    .select({
      code: t.code,
      months: sql<number>`count(*)::int`,
      departures: sql<number>`sum(${t.departures})::float8`,
      passengers: sql<number>`sum(${t.passengers})::float8`,
      seats: sql<number>`sum(${t.seats})::float8`,
      intlPassengers: sql<number>`sum(${t.intlPassengers})::float8`,
      intlDepartures: sql<number>`sum(${t.intlDepartures})::float8`,
      freightLbs: sql<number>`sum(${t.freightLbs})::float8`,
      distanceWeighted: sql<number>`coalesce(sum(${t.avgDistancePerFlight} * ${t.departures}), 0)::float8`,
    })
    .from(t)
    .where(and(inArray(t.code, codes), between(t.month, start, end)))
    .groupBy(t.code);
}

/** Ops sums per airport. The jsonb histograms are added element-wise in code. */
export async function opsTotals(codes: string[], start: string, end: string): Promise<OpsTotals[]> {
  if (!codes.length) return [];
  const rows = await db
    .select()
    .from(o)
    .where(and(inArray(o.code, codes), between(o.month, start, end)));

  const byCode = new Map<string, OpsTotals>();
  for (const r of rows) {
    let a = byCode.get(r.code);
    if (!a) {
      a = {
        code: r.code,
        months: 0,
        days: 0,
        depScheduled: 0,
        depCancelled: 0,
        depOperated: 0,
        depDelayed15: 0,
        taxiOutMinutes: 0,
        taxiOutCount: 0,
        arrFlights: 0,
        arrDelayed15: 0,
        arrDelayMinutes: 0,
        nasDelayMinutes: 0,
        taxiInMinutes: 0,
        taxiInCount: 0,
        depByDistanceGroup: new Array(r.depByDistanceGroup.length).fill(0),
        depByHour: new Array(24).fill(0),
      };
      byCode.set(r.code, a);
    }
    a.months++;
    a.days += r.daysInMonth;
    a.depScheduled += r.depScheduled;
    a.depCancelled += r.depCancelled;
    a.depOperated += r.depOperated;
    a.depDelayed15 += r.depDelayed15;
    a.taxiOutMinutes += r.taxiOutMinutes;
    a.taxiOutCount += r.taxiOutCount;
    a.arrFlights += r.arrFlights;
    a.arrDelayed15 += r.arrDelayed15;
    a.arrDelayMinutes += r.arrDelayMinutes;
    a.nasDelayMinutes += r.nasDelayMinutes;
    a.taxiInMinutes += r.taxiInMinutes;
    a.taxiInCount += r.taxiInCount;
    r.depByDistanceGroup.forEach((v, i) => (a.depByDistanceGroup[i] = (a.depByDistanceGroup[i] ?? 0) + v));
    r.depByHour.forEach((v, i) => (a.depByHour[i]! += v));
  }
  return [...byCode.values()];
}
