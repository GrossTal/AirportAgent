/**
 * Deterministic analytics behind the agent's tools. Every function returns plain JSON with the
 * numbers, the period they cover, their sources, and the assumptions behind them. The LLM only
 * explains these results; it never computes them.
 */
import { listAirportsWithTraffic, findAirports, type AirportRow } from "../repositories/airports.repository.js";
import { latestTrafficMonth, opsTotals, trafficTotals, type OpsTotals, type TrafficTotals } from "../repositories/metrics.repository.js";
import { listDataSources, listScores, type ScoreRow } from "../repositories/scores.repository.js";
import { addMonths } from "../ingest/lib/months.js";
import { resolveAirportFromList, resolveArea } from "./airport-resolver.js";
import { buildLiveStatusReport, fetchFaaFeed } from "./live-status.js";
import { KNOWN_REGION_NAMES, resolveRegion } from "./regions.js";
import { SCORING_MODEL, percentileRanks } from "./scoring.js";

export class ToolInputError extends Error {}

// Human-readable, because the agent quotes them to users. get_methodology lists the full source records.
const SOURCES = {
  t100: "BTS T-100 Segment Summary by Origin Airport (data.bts.gov API)",
  ontime: "BTS Reporting Carrier On-Time Performance",
  airports: "OurAirports reference data",
  scores: `${SCORING_MODEL.name} ${SCORING_MODEL.version} (computed from the BTS data)`,
};

// ---------- window ----------

export type AnalysisWindow = { start: string; end: string; priorStart: string; priorEnd: string };

export async function getAnalysisWindow(): Promise<AnalysisWindow> {
  const end = await latestTrafficMonth();
  if (!end) throw new Error("No traffic data loaded. Run `npm run db:seed`.");
  return { start: addMonths(end, -11), end, priorStart: addMonths(end, -23), priorEnd: addMonths(end, -12) };
}

const period = (w: AnalysisWindow) => ({ from: w.start.slice(0, 7), to: w.end.slice(0, 7), months: 12 });

// ---------- metric derivation ----------

const r = (v: number | null | undefined, d = 3) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function trafficMetrics(cur: TrafficTotals | undefined, prior: TrafficTotals | undefined) {
  if (!cur) return null;
  const priorComplete = prior && prior.months === 12;
  return {
    passengers: Math.round(cur.passengers),
    seats: Math.round(cur.seats),
    departures: Math.round(cur.departures),
    loadFactor: r(ratio(cur.passengers, cur.seats)),
    passengerGrowthYoY: priorComplete ? r(ratio(cur.passengers - prior.passengers, prior.passengers)) : null,
    seatGrowthYoY: priorComplete ? r(ratio(cur.seats - prior.seats, prior.seats)) : null,
    internationalPassengerShare: r(ratio(cur.intlPassengers, cur.passengers)),
    internationalDepartureShare: r(ratio(cur.intlDepartures, cur.departures)),
    avgDistancePerDepartureMiles: r(ratio(cur.distanceWeighted, cur.departures), 0),
    freightShortTons: Math.round(cur.freightLbs / 2000),
  };
}

function opsMetrics(ops: OpsTotals | undefined) {
  if (!ops || ops.arrFlights === 0) return null;
  const perDay = ops.depByHour.map((v) => v / ops.days);
  const peakHour = perDay.indexOf(Math.max(...perDay));
  const dailyDeps = perDay.reduce((s, v) => s + v, 0);
  return {
    arrivals: ops.arrFlights,
    arrivalDelayRate: r(ratio(ops.arrDelayed15, ops.arrFlights)),
    avgArrivalDelayMinutes: r(ratio(ops.arrDelayMinutes, ops.arrFlights), 1),
    nasDelayMinutesPerArrival: r(ratio(ops.nasDelayMinutes, ops.arrFlights), 2),
    departureDelayRate: r(ratio(ops.depDelayed15, ops.depOperated)),
    avgTaxiOutMinutes: r(ratio(ops.taxiOutMinutes, ops.taxiOutCount), 1),
    avgTaxiInMinutes: r(ratio(ops.taxiInMinutes, ops.taxiInCount), 1),
    cancellationRate: r(ratio(ops.depCancelled, ops.depScheduled)),
    scheduledDeparturesPerDay: r(dailyDeps, 1),
    peakHourLocal: peakHour, // scheduled departure hour, local time
    peakHourDeparturesPerDay: r(perDay[peakHour], 1),
    peakHourShareOfDailyDepartures: r(ratio(perDay[peakHour]!, dailyDeps)),
  };
}

function scoreSummary(s: ScoreRow | undefined) {
  if (!s) return null;
  return {
    model: SCORING_MODEL.name,
    version: s.scoreVersion,
    score: s.score,
    rank: s.rank,
    outOf: s.universeSize,
    coverage: s.coverage,
    components: s.components.map((c) => ({
      key: c.key,
      label: c.label,
      rawValue: c.rawValue,
      unit: c.unit,
      percentile: c.percentile,
      weight: c.weight,
      contribution: c.contribution,
      caveat: c.caveat,
      ...(c.details && { details: c.details }),
    })),
    notes: s.notes,
  };
}

const airportInfo = (a: AirportRow) => ({
  code: a.code,
  name: a.name,
  city: a.city,
  state: a.state,
  division: a.censusDivision,
  region: a.censusRegion,
});

/** Loads everything known about a set of airports for the current window. */
async function loadAirportData(codes: string[], w: AnalysisWindow) {
  const unique = [...new Set(codes.map((c) => c.toUpperCase()))];
  const [airports, cur, prior, ops, scores] = await Promise.all([
    findAirports(unique),
    trafficTotals(unique, w.start, w.end),
    trafficTotals(unique, w.priorStart, w.priorEnd),
    opsTotals(unique, w.start, w.end),
    listScores(),
  ]);
  const found = new Set(airports.map((a) => a.code));
  const missing = unique.filter((c) => !found.has(c));
  if (missing.length)
    throw new ToolInputError(`Unknown airport code(s): ${missing.join(", ")}. Use resolve_airport first.`);

  const byCode = <T extends { code: string }>(rows: T[]) => new Map(rows.map((x) => [x.code, x]));
  const [curM, priorM, opsM, scoreM] = [byCode(cur), byCode(prior), byCode(ops), byCode(scores)];
  return {
    airports: unique.map((code) => {
      const a = airports.find((x) => x.code === code)!;
      return {
        airport: airportInfo(a),
        traffic: trafficMetrics(curM.get(code), priorM.get(code)),
        operations: opsMetrics(opsM.get(code)),
        opportunityScore: scoreSummary(scoreM.get(code)),
        rawOps: opsM.get(code),
      };
    }),
    scores,
  };
}

// ---------- benchmarks (scored universe) ----------

type Benchmarked = { value: number | null; percentileAmongScoredAirports: number | null; median: number | null };

function benchmark(value: number | null, universe: (number | null)[]): Benchmarked {
  const vals = universe.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor(vals.length / 2)]! : null;
  const pct = value === null ? null : percentileRanks([value, ...vals])[0]!;
  return { value, percentileAmongScoredAirports: r(pct, 1), median: r(median, 3) };
}

const componentRaw = (s: ScoreRow, key: string) => s.components.find((c) => c.key === key)?.rawValue ?? null;
const congestionDetail = (s: ScoreRow, key: string) =>
  s.components.find((c) => c.key === "congestion")?.details?.[key] ?? null;

// ---------- public API (one function per tool) ----------

export async function resolveAirport(query: string) {
  const w = await getAnalysisWindow();
  const airports = await listAirportsWithTraffic(w.start, w.end);
  return { ...resolveAirportFromList(query, airports), passengerPeriod: period(w) };
}

/**
 * Live FAA status for a location: an IATA code checks that airport only; a city or metro name checks
 * every commercial airport serving the area (resolved geographically), aggregated into one report.
 */
export async function getLiveStatusForLocation(location: string) {
  const w = await getAnalysisWindow();
  const area = resolveArea(location, await listAirportsWithTraffic(w.start, w.end));
  if (!area.anchor)
    throw new ToolInputError(`No US airport or city with commercial service matches "${location}". Try a city name or an IATA code.`);
  return buildLiveStatusReport(area, await fetchFaaFeed());
}

export async function getAirportProfile(code: string) {
  const w = await getAnalysisWindow();
  const { airports } = await loadAirportData([code], w);
  const { rawOps: _, ...a } = airports[0]!;
  return {
    ...a,
    period: period(w),
    sources: [SOURCES.t100, SOURCES.ontime, SOURCES.airports, SOURCES.scores],
    assumptions: [
      "Passengers are enplanements on flights departing the airport (T-100, all carriers, domestic + international).",
      "Operations metrics cover only domestic flights of large US reporting carriers (BTS on-time data).",
      "Growth compares the 12-month window with the previous 12 months.",
    ],
  };
}

export async function compareAirports(codes: string[]) {
  if (codes.length < 2) throw new ToolInputError("Provide at least two airport codes to compare.");
  const w = await getAnalysisWindow();
  const { airports, scores } = await loadAirportData(codes, w);
  const universe = {
    arrivalDelayRate: scores.map((s) => congestionDetail(s, "arrDelayRate")),
    nasDelayMinutesPerArrival: scores.map((s) => congestionDetail(s, "nasDelayMinutesPerArrival")),
    avgTaxiOutMinutes: scores.map((s) => congestionDetail(s, "avgTaxiOutMinutes")),
    cancellationRate: scores.map((s) => congestionDetail(s, "cancelRate")),
    loadFactor: scores.map((s) => componentRaw(s, "demandPressure")),
  };
  return {
    period: period(w),
    airports: airports.map(({ rawOps: _, ...a }) => ({
      ...a,
      congestionBenchmarks: a.operations
        ? {
            arrivalDelayRate: benchmark(a.operations.arrivalDelayRate, universe.arrivalDelayRate),
            nasDelayMinutesPerArrival: benchmark(a.operations.nasDelayMinutesPerArrival, universe.nasDelayMinutesPerArrival),
            avgTaxiOutMinutes: benchmark(a.operations.avgTaxiOutMinutes, universe.avgTaxiOutMinutes),
            cancellationRate: benchmark(a.operations.cancellationRate, universe.cancellationRate),
          }
        : null,
      loadFactorBenchmark: benchmark(a.traffic?.loadFactor ?? null, universe.loadFactor),
    })),
    sources: [SOURCES.t100, SOURCES.ontime, SOURCES.scores],
    assumptions: [
      "Congestion here is operational (delays, NAS delay, taxi times, cancellations): airside/ATC/weather/airline driven, not terminal congestion.",
      "Benchmarks are percentiles among the airports in the opportunity-score universe (≥250k passengers/yr).",
      "Operations metrics cover only domestic flights of large US reporting carriers.",
    ],
  };
}

type SortKey = "score" | keyof typeof SCORING_MODEL.weights;

export async function rankAirports(opts: { region?: string; limit?: number; sortBy?: SortKey }) {
  const w = await getAnalysisWindow();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const sortBy = opts.sortBy ?? "score";
  const scores = await listScores();

  let regionInfo: ReturnType<typeof resolveRegion> = null;
  let pool = scores;
  if (opts.region) {
    regionInfo = resolveRegion(opts.region);
    if (!regionInfo)
      throw new ToolInputError(`Unknown region "${opts.region}". Known: ${KNOWN_REGION_NAMES.join(", ")}, or a US state.`);
    const airports = await findAirports(scores.map((s) => s.code));
    const inRegion = new Set(airports.filter((a) => regionInfo!.states.includes(a.state)).map((a) => a.code));
    pool = scores.filter((s) => inRegion.has(s.code));
  }

  const keyOf = (s: ScoreRow) =>
    sortBy === "score" ? s.score : (s.components.find((c) => c.key === sortBy)?.percentile ?? -1);
  const ranked = [...pool].sort((a, b) => keyOf(b) - keyOf(a)).slice(0, limit);
  const info = new Map((await findAirports(ranked.map((s) => s.code))).map((a) => [a.code, a]));

  return {
    model: SCORING_MODEL.name,
    version: SCORING_MODEL.version,
    period: period(w),
    region: regionInfo,
    sortedBy: sortBy,
    airportsInScope: pool.length,
    results: ranked.map((s, i) => ({
      position: i + 1,
      ...airportInfo(info.get(s.code)!),
      score: s.score,
      nationalRank: s.rank,
      outOf: s.universeSize,
      coverage: s.coverage,
      componentPercentiles: Object.fromEntries(s.components.map((c) => [c.key, c.percentile])),
      componentRawValues: Object.fromEntries(s.components.map((c) => [c.key, c.rawValue])),
      notes: s.notes,
    })),
    excludedFromScoring: `Airports under ${SCORING_MODEL.minAnnualPassengers.toLocaleString()} annual passengers are not scored.`,
    limitations: SCORING_MODEL.limitations,
    sources: [SOURCES.scores, SOURCES.t100, SOURCES.ontime],
  };
}

const DISTANCE_BAND_MILES = 250; // BTS DistanceGroup width; group 11 is "2,500 miles and over"

export async function getLongHaulShare(code: string, thresholdMiles = 2500) {
  if (thresholdMiles % DISTANCE_BAND_MILES !== 0 || thresholdMiles < 250 || thresholdMiles > 2500)
    throw new ToolInputError("thresholdMiles must be a multiple of 250 between 250 and 2500 (BTS distance bands).");
  const w = await getAnalysisWindow();
  const { airports } = await loadAirportData([code], w);
  const a = airports[0]!;
  const groups = a.rawOps?.depByDistanceGroup ?? [];
  const total = groups.reduce((s, v) => s + v, 0);
  const firstGroup = thresholdMiles / DISTANCE_BAND_MILES + 1; // group g covers [(g-1)*250, g*250)
  const longHaul = groups.slice(firstGroup).reduce((s, v) => s + v, 0);

  return {
    airport: a.airport,
    period: period(w),
    definition: `Long-haul = scheduled departures of ${thresholdMiles.toLocaleString()}+ statute miles.`,
    domesticReportingCarriers: total
      ? {
          departures: total,
          longHaulDepartures: longHaul,
          longHaulShare: r(longHaul / total),
          bands: groups.slice(1).map((v, i) => ({
            miles: i === 10 ? "2500+" : `${i * 250}-${i * 250 + 249}`,
            departures: v,
          })),
        }
      : null,
    allCarriersT100: a.traffic
      ? {
          avgDistancePerDepartureMiles: a.traffic.avgDistancePerDepartureMiles,
          internationalDepartureShare: a.traffic.internationalDepartureShare,
          internationalPassengerShare: a.traffic.internationalPassengerShare,
          freightShortTons: a.traffic.freightShortTons,
        }
      : null,
    sources: [SOURCES.ontime, SOURCES.t100],
    assumptions: [
      "\"Long-haul\" has no single standard; the threshold is a parameter (default 2,500 miles, the largest BTS distance band, roughly 5+ hours).",
      "The distance distribution comes from on-time data: domestic flights of large US reporting carriers only. International flights are reported separately from T-100 and are not split by distance.",
      "T-100 departures include all-cargo flights; at cargo hubs (e.g. ANC) passenger and flight shares can differ a lot.",
    ],
  };
}

export async function getUnmetDemandSignals(code: string) {
  const w = await getAnalysisWindow();
  const { airports, scores } = await loadAirportData([code], w);
  const a = airports[0]!;
  const t = a.traffic;
  const o = a.operations;

  const lf = benchmark(t?.loadFactor ?? null, scores.map((s) => componentRaw(s, "demandPressure")));
  const growth = benchmark(t?.passengerGrowthYoY ?? null, scores.map((s) => componentRaw(s, "growth")));
  const nas = benchmark(o?.nasDelayMinutesPerArrival ?? null, scores.map((s) => congestionDetail(s, "nasDelayMinutesPerArrival")));
  const delay = benchmark(o?.arrivalDelayRate ?? null, scores.map((s) => congestionDetail(s, "arrDelayRate")));

  // Deterministic rules. Each signal says what it does and does not show.
  const signals: { signal: string; triggered: boolean; evidence: string; interpretation: string }[] = [];
  if (t?.loadFactor != null)
    signals.push({
      signal: "High load factor",
      triggered: t.loadFactor >= 0.85 || (lf.percentileAmongScoredAirports ?? 0) >= 75,
      evidence: `Load factor ${(t.loadFactor * 100).toFixed(1)}% (${lf.percentileAmongScoredAirports}th percentile; median ${((lf.median ?? 0) * 100).toFixed(1)}%).`,
      interpretation: "Aircraft are full: some demand may be turned away (spill). Also reflects airline seat supply decisions.",
    });
  if (t?.passengerGrowthYoY != null && t.seatGrowthYoY != null)
    signals.push({
      signal: "Demand growing faster than seat supply",
      triggered: t.passengerGrowthYoY - t.seatGrowthYoY >= 0.02,
      evidence: `Passengers ${(t.passengerGrowthYoY * 100).toFixed(1)}% vs seats ${(t.seatGrowthYoY * 100).toFixed(1)}% year over year.`,
      interpretation: "Airlines are not adding seats as fast as passengers grow; capacity (airline, airfield or terminal) may be lagging demand.",
    });
  if (o?.nasDelayMinutesPerArrival != null)
    signals.push({
      signal: "Airspace / airfield capacity constraint",
      triggered: (nas.percentileAmongScoredAirports ?? 0) >= 90,
      evidence: `${o.nasDelayMinutesPerArrival} NAS delay minutes per arrival (${nas.percentileAmongScoredAirports}th percentile; median ${nas.median}).`,
      interpretation: "NAS delays come from traffic volume, ATC and weather: the airport often cannot accept all scheduled arrivals. This is an operational constraint, not terminal evidence.",
    });
  if (o?.arrivalDelayRate != null)
    signals.push({
      signal: "Frequent arrival delays",
      triggered: (delay.percentileAmongScoredAirports ?? 0) >= 75,
      evidence: `${(o.arrivalDelayRate * 100).toFixed(1)}% of arrivals 15+ min late (${delay.percentileAmongScoredAirports}th percentile).`,
      interpretation: "Operational congestion proxy; causes include airline operations and weather.",
    });
  if (o?.peakHourShareOfDailyDepartures != null)
    signals.push({
      signal: "Peaked schedule",
      triggered: o.peakHourShareOfDailyDepartures >= 0.1,
      evidence: `${o.peakHourDeparturesPerDay} scheduled departures in the busiest hour (${o.peakHourLocal}:00 local), ${(o.peakHourShareOfDailyDepartures * 100).toFixed(1)}% of the day.`,
      interpretation: "Concentrated peaks stress gates and checkpoints at specific hours. Reporting carriers only; not a measured terminal capacity.",
    });

  return {
    airport: a.airport,
    period: period(w),
    signalsTriggered: signals.filter((s) => s.triggered).length,
    signals,
    traffic: t,
    operations: o,
    sources: [SOURCES.t100, SOURCES.ontime, SOURCES.scores],
    limitations: [
      "Unmet demand cannot be observed directly in public data (turned-away passengers are not recorded). These are indirect signals.",
      "Signals do not identify which constraint (airline seats, runways/ATC, or terminal) is binding.",
      "Thresholds (85% load factor, 75th/90th percentiles, 2-point growth gap, 10% peak-hour share) are analyst choices, not industry standards.",
    ],
  };
}

export async function getMethodology() {
  const w = await getAnalysisWindow();
  const sources = await listDataSources();
  return {
    score: {
      name: SCORING_MODEL.name,
      version: SCORING_MODEL.version,
      weights: SCORING_MODEL.weights,
      method:
        "Each component is a percentile (0-100) among airports with ≥250k annual passengers; the score is the weighted mean. Missing components are dropped and the remaining weights re-normalized.",
      coverage:
        "full = all components; partial = only the operational congestion proxy missing; limited = a core component (usually growth) missing. Coverage is NOT data quality or investment confidence.",
      limitations: SCORING_MODEL.limitations,
    },
    period: period(w),
    dataSources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      description: s.description,
      coversFrom: s.periodStart,
      coversTo: s.periodEnd,
      fetchedAt: s.fetchedAt,
    })),
    scope: "50 US states + DC. US territories (e.g. San Juan, Guam) are excluded.",
  };
}
