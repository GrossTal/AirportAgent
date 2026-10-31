import type { ScoreComponent } from "../db/schema.js";

/**
 * Terminal Expansion Opportunity Screening Score (deterministic, no LLM involved).
 *
 * A screening score, not an investment recommendation: it ranks airports by public-data
 * signals that terminal expansion could plausibly be needed and monetized. Thesis, in order
 * of weight: terminals are sized by passenger throughput (scale), throughput that keeps
 * growing eventually exceeds terminal capacity (growth), and full aircraft show sustained
 * demand relative to supplied seats (seat demand pressure). Operational congestion is kept
 * only as a low-weight proxy: it is driven by runways, ATC, weather and airlines, which a
 * terminal does not fix. See docs/scoring.md.
 *
 * Each component is converted to a percentile (0-100) within the eligible airport universe,
 * so units don't matter and single outliers can't dominate. The score is the weighted mean
 * of available component percentiles; missing components are dropped and the remaining
 * weights re-normalized (see `coverage` and docs/scoring.md for the implications).
 */
export const SCORING_MODEL = {
  version: "v2",
  name: "Terminal Expansion Opportunity Screening Score",
  minAnnualPassengers: 250_000, // ~FAA small-hub threshold and up; excludes tiny airports
  minArrivalsForCongestion: 1_000, // per 12 months, for on-time metrics to be meaningful
  weights: {
    scale: 0.35,
    growth: 0.35,
    demandPressure: 0.2,
    congestion: 0.1,
  },
  // Components the thesis rests on. Missing one of these makes the score `limited` coverage.
  coreComponents: ["scale", "growth", "demandPressure"],
  limitations: [
    "This is a screening score for terminal expansion opportunities, not an investment recommendation.",
    "No public dataset measures terminal capacity directly (gates, terminal design capacity, checkpoint waits); every component is an indirect signal.",
    "Operational congestion (delays, NAS delay, taxi-out, cancellations) reflects runways, ATC, weather and airline operations. It does not establish a need for terminal expansion and carries only 10% weight.",
    "Load factor reflects airline seat supply decisions as well as passenger demand.",
    "Coverage describes which components could be computed, not data quality or confidence in the investment case.",
    "On-time metrics cover only large US carriers' domestic flights; T-100 covers all carriers.",
  ],
} as const;

export type ScoringModel = typeof SCORING_MODEL;
type ComponentKey = keyof ScoringModel["weights"];

/**
 * Which score components could be computed for this airport. This is NOT data quality and NOT
 * confidence in the investment case:
 *  - full:    all components available
 *  - partial: only the operational congestion proxy is missing
 *  - limited: a core component (scale, growth, demand pressure) is missing
 */
export type Coverage = "full" | "partial" | "limited";

export type CongestionInputs = {
  arrivals: number;
  arrDelayed15: number;
  nasDelayMinutes: number;
  taxiOutMinutes: number;
  taxiOutCount: number;
  depScheduled: number;
  depCancelled: number;
};

export type AirportScoringInput = {
  code: string;
  passengers: number; // enplaned passengers, analysis window (12 months)
  seats: number;
  passengersPrior: number | null; // same airport, the 12 months before the window
  ops: CongestionInputs | null; // null when no reporting-carrier flights
};

export type AirportScore = {
  code: string;
  score: number;
  rank: number;
  universeSize: number;
  coverage: Coverage;
  components: ScoreComponent[];
  notes: string[];
};

const CAVEATS: Record<ComponentKey, string> = {
  scale: "Passengers enplaned on departing flights (T-100, all carriers); a proxy for terminal throughput.",
  growth: "Single year-over-year comparison; one unusual year (new service, disruptions) can swing it.",
  demandPressure: "Load factor measures how full aircraft are; it also reflects airline seat supply decisions.",
  congestion:
    "Operational congestion proxy (airside/ATC/weather/airline). Not evidence of terminal constraints; low weight by design.",
};

/** Percentile rank (0-100) of each value among the non-null values; ties share the average rank. */
export function percentileRanks(values: (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const n = present.length;
  return values.map((v) => {
    if (v === null) return null;
    if (n === 1) return 50;
    let below = 0;
    let equal = 0;
    for (const p of present) {
      if (p < v) below++;
      else if (p === v) equal++;
    }
    const avgRank = below + (equal - 1) / 2; // 0-based
    return (avgRank / (n - 1)) * 100;
  });
}

const round = (v: number | null, digits = 4) => (v === null ? null : Number(v.toFixed(digits)));

export function scoreAirports(inputs: AirportScoringInput[], model: ScoringModel = SCORING_MODEL): AirportScore[] {
  const eligible = inputs.filter((a) => a.passengers >= model.minAnnualPassengers && a.seats > 0);

  // Raw component values
  const loadFactor = eligible.map((a) => a.passengers / a.seats);
  const growth = eligible.map((a) =>
    a.passengersPrior && a.passengersPrior > 0 ? (a.passengers - a.passengersPrior) / a.passengersPrior : null,
  );
  const hasOps = eligible.map((a) => a.ops !== null && a.ops.arrivals >= model.minArrivalsForCongestion);
  const congestionRaw = eligible.map((a, i) =>
    hasOps[i]
      ? {
          arrDelayRate: a.ops!.arrDelayed15 / a.ops!.arrivals,
          nasDelayPerArrival: a.ops!.nasDelayMinutes / a.ops!.arrivals,
          avgTaxiOut: a.ops!.taxiOutCount > 0 ? a.ops!.taxiOutMinutes / a.ops!.taxiOutCount : null,
          cancelRate: a.ops!.depScheduled > 0 ? a.ops!.depCancelled / a.ops!.depScheduled : null,
        }
      : null,
  );

  // Congestion proxy = mean percentile of its sub-metrics
  const sub = (k: "arrDelayRate" | "nasDelayPerArrival" | "avgTaxiOut" | "cancelRate") =>
    percentileRanks(congestionRaw.map((c) => c?.[k] ?? null));
  const subPct = {
    arrDelayRate: sub("arrDelayRate"),
    nasDelayPerArrival: sub("nasDelayPerArrival"),
    avgTaxiOut: sub("avgTaxiOut"),
    cancelRate: sub("cancelRate"),
  };
  const congestionIndex = eligible.map((_, i) => {
    const parts = Object.values(subPct)
      .map((p) => p[i])
      .filter((v): v is number => v !== null);
    return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
  });

  const pct: Record<ComponentKey, (number | null)[]> = {
    scale: percentileRanks(eligible.map((a) => a.passengers)),
    growth: percentileRanks(growth),
    demandPressure: percentileRanks(loadFactor),
    congestion: percentileRanks(congestionIndex),
  };

  const scored = eligible.map((a, i) => {
    const notes: string[] = [];
    const comp = (
      key: ComponentKey,
      label: string,
      rawValue: number | null,
      unit: string,
      details?: ScoreComponent["details"],
    ): ScoreComponent => ({
      key,
      label,
      rawValue: round(rawValue),
      unit,
      percentile: round(pct[key][i]!, 1),
      weight: model.weights[key],
      contribution: 0,
      caveat: CAVEATS[key],
      ...(details && { details }),
    });

    const c = congestionRaw[i];
    const components = [
      comp("scale", "Passenger scale", a.passengers, "passengers / 12 mo"),
      comp("growth", "Passenger growth (YoY)", growth[i]!, "ratio"),
      comp("demandPressure", "Seat demand pressure (load factor)", loadFactor[i]!, "ratio"),
      comp(
        "congestion",
        "Operational congestion proxy",
        congestionIndex[i]!,
        "index 0-100",
        c
          ? {
              arrDelayRate: round(c.arrDelayRate),
              nasDelayMinutesPerArrival: round(c.nasDelayPerArrival, 2),
              avgTaxiOutMinutes: round(c.avgTaxiOut, 2),
              cancelRate: round(c.cancelRate),
            }
          : undefined,
      ),
    ];

    if (growth[i] === null) notes.push("No complete prior-year passenger data; growth excluded.");
    if (!hasOps[i])
      notes.push("Too few reporting-carrier flights for on-time metrics; operational congestion proxy excluded.");

    const available = components.filter((x) => x.percentile !== null);
    const weightSum = available.reduce((s, x) => s + x.weight, 0);
    for (const x of available) x.contribution = round((x.weight / weightSum) * x.percentile!, 2)!;
    const score = available.reduce((s, x) => s + x.contribution, 0);

    const missing = components.filter((x) => x.percentile === null).map((x) => x.key as ComponentKey);
    const coverage: Coverage =
      missing.length === 0
        ? "full"
        : missing.some((k) => (model.coreComponents as readonly string[]).includes(k))
          ? "limited"
          : "partial";
    if (missing.length) {
      const effective = available.map((x) => `${x.key} ${Math.round((x.weight / weightSum) * 100)}%`).join(", ");
      notes.push(`Weights re-normalized over available components: ${effective}.`);
    }

    return { code: a.code, score: round(score, 2)!, rank: 0, universeSize: eligible.length, coverage, components, notes };
  });

  scored.sort((x, y) => y.score - x.score || x.code.localeCompare(y.code));
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}
