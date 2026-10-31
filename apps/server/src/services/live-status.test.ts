import { describe, expect, it, vi } from "vitest";
import { runAgent, type LlmClient, type LlmInputItem } from "../agent/agent-service.js";
import { resolveArea } from "./airport-resolver.js";
import {
  STATUS_MEANING,
  buildLiveStatusReport,
  classifyNotice,
  summarizeEvents,
  type FeedResult,
} from "./live-status.js";
import { FIXTURE_AIRPORTS as airports } from "./test-fixtures.js";

const FETCHED_AT = "2026-10-31T18:00:00.000Z";
const feed = (events: unknown[]): FeedResult => ({ ok: true, events, fetchedAt: FETCHED_AT });
const failed: FeedResult = { ok: false, error: "HTTP 503", attemptedAt: FETCHED_AT };

// Shapes follow the FAA NAS Status feed (field names from nasstatus.faa.gov); values are made up.
const LAX_GA_NOTICE = {
  airportId: "LAX",
  airportLongName: "Los Angeles International",
  freeForm: { text: "TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR", updatedAt: "2026-05-27T18:31:49Z" },
};
const EWR_GDP = {
  airportId: "EWR",
  airportLongName: "Newark Liberty International",
  groundDelay: { avgDelay: 74, impactingCondition: "Low ceilings", updatedAt: "2026-10-31T17:52:00Z" },
};
const LGA_ARRIVALS = {
  airportId: "LGA",
  arrivalDelay: { averageDelay: "31", trend: "increasing", reason: "VOL:Volume", updateTime: "2026-10-31T17:40:00Z" },
};

const report = (location: string, f: FeedResult) => buildLiveStatusReport(resolveArea(location, airports), f);
const statusOf = (r: ReturnType<typeof report>, code: string) => r.airports.find((a) => a.code === code)!;

describe("live status for a location", () => {
  it('"Are there any delays in LA?" checks every commercial airport serving Los Angeles', () => {
    const r = report("LA", feed([LAX_GA_NOTICE]));
    expect(r.resolvedAs.kind).toBe("metro");
    expect([...r.resolvedAs.airportsChecked].sort()).toEqual(["BUR", "LAX", "LGB", "ONT", "SNA"]);
    expect(r.airports.every((a) => a.name.length > 0)).toBe(true);
    expect(r.feed).toEqual({ status: "ok", fetchedAt: FETCHED_AT });
  });

  it('"Are there delays at LAX?" checks only LAX', () => {
    const r = report("LAX", feed([LAX_GA_NOTICE]));
    expect(r.resolvedAs).toMatchObject({ kind: "airport", airportsChecked: ["LAX"] });
  });

  it('"Any delays in NYC?" resolves the metro airports and aggregates mixed statuses', () => {
    const r = report("NYC", feed([EWR_GDP, LGA_ARRIVALS]));
    expect(r.resolvedAs.airportsChecked).toEqual(expect.arrayContaining(["JFK", "LGA", "EWR"]));
    expect(statusOf(r, "EWR")).toMatchObject({
      status: "delay_program_active",
      programs: { groundDelayProgram: { avgDelayMinutes: 74, reason: "Low ceilings" } },
      worstAvgDelayMinutes: 74,
      faaUpdatedAt: "2026-10-31T17:52:00Z",
    });
    expect(statusOf(r, "LGA")).toMatchObject({
      status: "delay_program_active",
      programs: { arrivalDelay: { avgDelayMinutes: 31, trend: "increasing" } },
    });
    expect(statusOf(r, "JFK").status).toBe("no_active_program_reported");
    expect(r.summary.withActiveDelayPrograms.sort()).toEqual(["EWR", "LGA"]);
  });

  it("no active FAA programs: never claims flights are on time", () => {
    const r = report("LA", feed([LAX_GA_NOTICE]));
    expect(r.airports.every((a) => a.status === "no_active_program_reported")).toBe(true);
    for (const a of r.airports) expect(a.meaning).toMatch(/does not mean flights are on time/);
    expect(r.notAvailable.join(" ")).toMatch(/Individual flight delays.*not available/);
    const text = JSON.stringify(r).toLowerCase();
    expect(text).not.toMatch(/"(on_time|normal|operating normally|no delays)"/);
  });

  it("general-aviation notices are classified and flagged as not airline disruption", () => {
    const r = report("LA", feed([LAX_GA_NOTICE]));
    expect(statusOf(r, "LAX").restrictions).toEqual([
      expect.objectContaining({ type: "general_aviation_restriction", affectsScheduledAirlineFlights: false }),
    ]);
    expect(r.warnings.join(" ")).toMatch(/LAX: only general-aviation restrictions.*do not indicate airline flight disruption/);
  });

  it("partial data problems: one malformed airport entry becomes data_unavailable, the others are still checked", () => {
    const r = report("LA", feed([{ airportId: "BUR", groundDelay: "garbled" }, { airportId: "ONT", arrivalDelay: { averageDelay: 22 } }, LAX_GA_NOTICE]));
    expect(statusOf(r, "BUR")).toMatchObject({ status: "data_unavailable", programs: null, meaning: STATUS_MEANING.data_unavailable });
    expect(statusOf(r, "ONT")).toMatchObject({ status: "delay_program_active", worstAvgDelayMinutes: 22 });
    expect(statusOf(r, "LAX").status).toBe("no_active_program_reported");
    expect(r.summary.dataUnavailable).toEqual(["BUR"]);
    expect(r.warnings.join(" ")).toMatch(/Status unknown for BUR/);
  });

  it("API failure: every airport is request_failed with a warning, never 'no program'", () => {
    const r = report("NYC", failed);
    expect(r.feed).toMatchObject({ status: "request_failed", error: "HTTP 503" });
    expect(r.airports.every((a) => a.status === "request_failed")).toBe(true);
    expect(r.summary.noActiveProgramReported).toEqual([]);
    expect(r.warnings[0]).toMatch(/request failed.*no airport status could be confirmed/);
  });

  it("missing airport data is reported as 'no program listed', not as a normal operating status", () => {
    const r = report("ANC", feed([]));
    expect(statusOf(r, "ANC")).toMatchObject({ status: "no_active_program_reported", programs: null, restrictions: [] });
    expect(statusOf(r, "ANC").meaning).toMatch(/FAA lists no delay program.*does not mean flights are on time/);
  });

  it("keeps the four states distinct", () => {
    expect(new Set(Object.values(STATUS_MEANING)).size).toBe(4);
  });

  it("reports same-name places elsewhere", () => {
    expect(report("Portland", feed([])).resolvedAs.sameNameElsewhere).toEqual(["PWM (Portland, ME)"]);
  });
});

describe("through the agent loop", () => {
  it("one tool call for 'delays in LA' returns all LA-area airports to the model", async () => {
    let toolOutput = "";
    const llm: LlmClient = {
      respond: vi.fn(async ({ input }) => {
        const out = input.find((i: LlmInputItem) => "type" in i && i.type === "function_call_output");
        if (out && "output" in out) {
          toolOutput = String(out.output);
          return { output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }] };
        }
        return { output: [{ type: "function_call", call_id: "c1", name: "get_live_airport_status", arguments: '{"location":"LA"}' }] };
      }),
    };
    const executeTool = vi.fn(async (_name: string, args: unknown) => ({
      ok: true as const,
      data: report((args as { location: string }).location, feed([LAX_GA_NOTICE])),
    }));
    const res = await runAgent([], "Are there any delays in LA?", {
      llm,
      executeTool,
      tools: [],
      instructions: "x",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(res.toolCalls).toBe(1);
    expect(JSON.parse(toolOutput).data.resolvedAs.airportsChecked).toHaveLength(5);
  });
});

describe("classifyNotice", () => {
  it.each([
    ["!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR", "general_aviation_restriction", false],
    ["!SBY 10/069 SBY AD AP CLSD 2610310300-2610311000", "airport_closure", true],
    ["RWY 07L/25R CLSD", "other_notice", null],
  ])("%s", (text, type, affects) => {
    expect(classifyNotice(text)).toMatchObject({ type, affectsScheduledAirlineFlights: affects });
  });
});

describe("summarizeEvents (nationwide)", () => {
  it("ranks ground stops first, then by the largest average delay; skips malformed entries", () => {
    const { delays, notices, malformedEntries } = summarizeEvents([
      { airportId: "ORD", arrivalDelay: { averageDelay: 45, trend: "increasing" } },
      { airportId: "SFO", groundDelay: { avgDelay: 112, impactingCondition: "Low ceilings" } },
      { airportId: "EWR", groundStop: { endTime: "2026-10-31T20:00:00Z", impactingCondition: "Thunderstorms" } },
      { airportId: "DEN", departureDelay: { averageDelay: "31" } },
      LAX_GA_NOTICE,
      { airportId: "BAD", groundStop: 42 },
    ]);
    expect(delays.map((d) => d.code)).toEqual(["EWR", "SFO", "ORD", "DEN"]);
    expect(delays[0]!.programs.groundStop).toEqual({ until: "2026-10-31T20:00:00Z", reason: "Thunderstorms" });
    expect(notices.map((n) => n.code)).toEqual(["LAX"]);
    expect(malformedEntries).toBe(1);
  });

  it("returns empty results on a quiet day", () => {
    expect(summarizeEvents([])).toEqual({ delays: [], notices: [], malformedEntries: 0 });
  });
});
