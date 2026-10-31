import { describe, expect, it } from "vitest";
import { SCORING_MODEL, percentileRanks, scoreAirports, type AirportScoringInput } from "./scoring.js";

const ops = (delayRate: number, arrivals = 10_000) => ({
  arrivals,
  arrDelayed15: Math.round(arrivals * delayRate),
  nasDelayMinutes: arrivals * delayRate * 10,
  taxiOutMinutes: arrivals * 15,
  taxiOutCount: arrivals,
  depScheduled: arrivals,
  depCancelled: Math.round(arrivals * delayRate * 0.1),
});

const airport = (code: string, over: Partial<AirportScoringInput> = {}): AirportScoringInput => ({
  code,
  passengers: 1_000_000,
  seats: 1_250_000,
  passengersPrior: 1_000_000,
  ops: ops(0.2),
  ...over,
});

const component = (score: ReturnType<typeof scoreAirports>[number], key: string) =>
  score.components.find((c) => c.key === key)!;

describe("percentileRanks", () => {
  it("maps min to 0, max to 100, and averages ties", () => {
    expect(percentileRanks([10, 20, 30])).toEqual([0, 50, 100]);
    expect(percentileRanks([5, 5, 10])).toEqual([25, 25, 100]);
  });
  it("keeps nulls out of the ranking", () => {
    expect(percentileRanks([null, 1, 2])).toEqual([null, 0, 100]);
  });
});

describe("SCORING_MODEL", () => {
  it("weights sum to 1 and the operational congestion proxy has the smallest weight", () => {
    const w = Object.values(SCORING_MODEL.weights);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
    expect(SCORING_MODEL.weights.congestion).toBe(Math.min(...w));
  });
  it("states the terminal-expansion limitations explicitly", () => {
    const text = SCORING_MODEL.limitations.join(" ");
    expect(text).toMatch(/not an investment recommendation/);
    expect(text).toMatch(/does not establish a need for terminal expansion/);
    expect(text).toMatch(/not data quality/);
  });
});

describe("scoreAirports", () => {
  it("is deterministic and ranks the stronger airport first", () => {
    const inputs = [
      airport("AAA"),
      airport("BBB", { passengers: 2_000_000, seats: 2_100_000, passengersPrior: 1_500_000, ops: ops(0.3) }),
    ];
    const a = scoreAirports(inputs);
    expect(a).toEqual(scoreAirports(inputs));
    expect(a[0]!.code).toBe("BBB");
    expect(a[0]!.rank).toBe(1);
    expect(a[0]!.score).toBe(100);
  });

  it("excludes airports below the passenger threshold", () => {
    const res = scoreAirports([airport("AAA"), airport("TNY", { passengers: 1_000, seats: 2_000 })]);
    expect(res.map((r) => r.code)).toEqual(["AAA"]);
  });

  it("congestion alone cannot outrank stronger passenger fundamentals", () => {
    // CON is the most congested but smaller and slower-growing; BIG wins on scale + growth.
    const res = scoreAirports([
      airport("CON", { passengers: 1_000_000, passengersPrior: 1_000_000, ops: ops(0.5) }),
      airport("BIG", { passengers: 3_000_000, seats: 3_750_000, passengersPrior: 2_500_000, ops: ops(0.1) }),
    ]);
    expect(res[0]!.code).toBe("BIG");
  });

  it("attaches a caveat to every component", () => {
    const [s] = scoreAirports([airport("AAA")]);
    for (const c of s!.components) expect(c.caveat.length).toBeGreaterThan(0);
    expect(component(s!, "congestion").caveat).toMatch(/Not evidence of terminal constraints/);
  });

  it("missing congestion proxy: coverage partial, small re-normalization", () => {
    const res = scoreAirports([airport("AAA"), airport("NOP", { ops: null }), airport("CCC")]);
    const nop = res.find((r) => r.code === "NOP")!;
    expect(nop.coverage).toBe("partial");
    expect(component(nop, "congestion").percentile).toBeNull();
    // 0.35/0.9 ≈ 0.389: the remaining weights each grow by ~11%.
    expect(nop.notes.join(" ")).toMatch(/scale 39%, growth 39%, demandPressure 22%/);
    const total = nop.components.reduce((s, c) => s + c.contribution, 0);
    expect(total).toBeCloseTo(nop.score, 1);
  });

  it("missing growth: coverage limited, and the note exposes the shifted weights", () => {
    const res = scoreAirports([airport("AAA"), airport("NEW", { passengersPrior: null }), airport("CCC")]);
    const neu = res.find((r) => r.code === "NEW")!;
    expect(neu.coverage).toBe("limited");
    // Without growth (35%) the congestion proxy grows from 10% to ~15% of the score.
    expect(neu.notes.join(" ")).toMatch(/scale 54%, demandPressure 31%, congestion 15%/);
  });

  it("full coverage when all components are available", () => {
    expect(scoreAirports([airport("AAA"), airport("BBB")]).every((s) => s.coverage === "full")).toBe(true);
  });
});
