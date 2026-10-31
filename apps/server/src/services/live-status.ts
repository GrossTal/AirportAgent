/**
 * Live FAA National Airspace System status (public, no key). One call returns every US airport
 * with an active FAA event. Used for "right now" context only, never for scoring.
 *
 * What this source can and cannot say:
 *  - It reports FAA traffic-management programs (ground stops, ground delay programs), general
 *    arrival/departure delays with average minutes, and closures/NOTAM restrictions.
 *  - It does NOT report individual flights. "No active program" is not "no delays" or "on time".
 */
import { z } from "zod";
import type { AirportMatch, AreaResolution } from "./airport-resolver.js";

const URL = "https://nasstatus.faa.gov/api/airport-events";
const CACHE_MS = 60_000;

// Field names as used by the FAA NAS Status dashboard (nasstatus.faa.gov). Delay values are minutes.
const Program = z
  .object({
    avgDelay: z.union([z.number(), z.string()]).nullish(),
    averageDelay: z.union([z.number(), z.string()]).nullish(),
    reason: z.string().nullish(),
    impactingCondition: z.string().nullish(),
    trend: z.string().nullish(),
    endTime: z.string().nullish(),
    updatedAt: z.string().nullish(),
    updateTime: z.string().nullish(),
  })
  .passthrough();
const Notice = z.object({ text: z.string().nullish(), simpleText: z.string().nullish(), updatedAt: z.string().nullish() }).passthrough();
const FaaEventSchema = z
  .object({
    airportId: z.string(),
    airportLongName: z.string().nullish(),
    groundStop: Program.nullish(),
    groundDelay: Program.nullish(),
    arrivalDelay: Program.nullish(),
    departureDelay: Program.nullish(),
    airportClosure: Notice.nullish(),
    freeForm: Notice.nullish(),
  })
  .passthrough();
export type FaaEvent = z.input<typeof FaaEventSchema>;

export type FeedResult =
  | { ok: true; events: unknown[]; fetchedAt: string }
  | { ok: false; error: string; attemptedAt: string };

// ---------- interpretation (pure) ----------

const minutes = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

export type Restriction = {
  type: "general_aviation_restriction" | "airport_closure" | "other_notice";
  affectsScheduledAirlineFlights: boolean | null; // null = cannot tell from the notice
  notice: string;
};

/** NOTAM-style notices: GA-only restrictions are common and do not disrupt airline service. */
export function classifyNotice(text: string): Restriction {
  const t = text.toUpperCase();
  if (/\b(TRANSIENT|GA ACFT|GENERAL AVIATION|NON SKED|PPR)\b/.test(t))
    return { type: "general_aviation_restriction", affectsScheduledAirlineFlights: false, notice: text };
  if (/\bAD AP CLSD\b|\bAIRPORT CLOSED\b/.test(t)) return { type: "airport_closure", affectsScheduledAirlineFlights: true, notice: text };
  return { type: "other_notice", affectsScheduledAirlineFlights: null, notice: text };
}

export type AirportPrograms = {
  groundStop: { until: string | null; reason: string | null } | null;
  groundDelayProgram: { avgDelayMinutes: number | null; reason: string | null } | null;
  arrivalDelay: { avgDelayMinutes: number | null; trend: string | null; reason: string | null } | null;
  departureDelay: { avgDelayMinutes: number | null; trend: string | null; reason: string | null } | null;
};

type ParsedEvent = {
  code: string;
  name: string | null;
  programs: AirportPrograms;
  restrictions: Restriction[];
  worstAvgDelayMinutes: number | null;
  faaUpdatedAt: string | null;
};

/** Validates and interprets one FAA event. Returns null if the entry is malformed. */
export function parseEvent(raw: unknown): ParsedEvent | null {
  const parsed = FaaEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const programs: AirportPrograms = {
    groundStop: e.groundStop ? { until: e.groundStop.endTime ?? null, reason: e.groundStop.impactingCondition ?? null } : null,
    groundDelayProgram: e.groundDelay
      ? { avgDelayMinutes: minutes(e.groundDelay.avgDelay), reason: e.groundDelay.impactingCondition ?? null }
      : null,
    arrivalDelay: e.arrivalDelay
      ? { avgDelayMinutes: minutes(e.arrivalDelay.averageDelay), trend: e.arrivalDelay.trend ?? null, reason: e.arrivalDelay.reason ?? null }
      : null,
    departureDelay: e.departureDelay
      ? { avgDelayMinutes: minutes(e.departureDelay.averageDelay), trend: e.departureDelay.trend ?? null, reason: e.departureDelay.reason ?? null }
      : null,
  };
  const delays = [programs.groundDelayProgram, programs.arrivalDelay, programs.departureDelay]
    .map((p) => p?.avgDelayMinutes)
    .filter((m): m is number => m != null);
  const restrictions = [e.airportClosure, e.freeForm]
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .map((n) => classifyNotice(n.text || n.simpleText || "Notice without text"));
  type Stamped = { updatedAt?: string | null; updateTime?: string | null } | null | undefined;
  const updated = ([e.groundStop, e.groundDelay, e.arrivalDelay, e.departureDelay, e.airportClosure, e.freeForm] as Stamped[])
    .map((p) => p?.updatedAt ?? p?.updateTime ?? null)
    .filter((t): t is string => Boolean(t))
    .sort();
  return {
    code: e.airportId,
    name: e.airportLongName ?? null,
    programs,
    restrictions,
    worstAvgDelayMinutes: delays.length ? Math.max(...delays) : null,
    faaUpdatedAt: updated.at(-1) ?? null,
  };
}

const hasProgram = (p: AirportPrograms) => Boolean(p.groundStop || p.groundDelayProgram || p.arrivalDelay || p.departureDelay);

/** The four per-airport states. They are never interchangeable. */
export type LiveStatus = "delay_program_active" | "no_active_program_reported" | "data_unavailable" | "request_failed";

export const STATUS_MEANING: Record<LiveStatus, string> = {
  delay_program_active: "FAA reports an active ground stop, ground delay program, or arrival/departure delay at this airport.",
  no_active_program_reported:
    "FAA lists no delay program for this airport right now. This does not mean flights are on time: individual flights can still be delayed.",
  data_unavailable: "FAA returned an entry for this airport that could not be interpreted; its status is unknown.",
  request_failed: "The FAA status feed could not be reached, so this airport's status is unknown.",
};

export type AirportLiveReport = {
  code: string;
  name: string;
  distanceMiles?: number;
  status: LiveStatus;
  meaning: string;
  programs: AirportPrograms | null;
  worstAvgDelayMinutes: number | null;
  restrictions: Restriction[];
  faaUpdatedAt: string | null;
};

/** Pure: per-airport status for a set of airports, from one FAA feed result. One bad entry never affects the others. */
export function assessAirports(airports: AirportMatch[], feed: FeedResult): AirportLiveReport[] {
  return airports.map((a) => {
    const base = { code: a.code, name: a.name, ...(a.distanceMiles !== undefined && { distanceMiles: a.distanceMiles }) };
    if (!feed.ok)
      return { ...base, status: "request_failed", meaning: STATUS_MEANING.request_failed, programs: null, worstAvgDelayMinutes: null, restrictions: [], faaUpdatedAt: null };

    const entries = feed.events.filter((e) => (e as { airportId?: unknown })?.airportId === a.code);
    const parsed = entries.map(parseEvent);
    if (parsed.some((p) => p === null))
      return { ...base, status: "data_unavailable", meaning: STATUS_MEANING.data_unavailable, programs: null, worstAvgDelayMinutes: null, restrictions: [], faaUpdatedAt: null };

    const events = parsed as ParsedEvent[];
    const programs = events.find((p) => hasProgram(p.programs))?.programs ?? null;
    const status: LiveStatus = programs ? "delay_program_active" : "no_active_program_reported";
    const worst = events.map((p) => p.worstAvgDelayMinutes).filter((m): m is number => m !== null);
    return {
      ...base,
      status,
      meaning: STATUS_MEANING[status],
      programs,
      worstAvgDelayMinutes: worst.length ? Math.max(...worst) : null,
      restrictions: events.flatMap((p) => p.restrictions),
      faaUpdatedAt: events.map((p) => p.faaUpdatedAt).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null,
    };
  });
}

const NOT_AVAILABLE = [
  "Individual flight delays and on-time status: not available from any connected data source (FAA NAS Status reports airport-level programs only).",
  "Number of delayed or cancelled flights today: not available.",
];

const SOURCE = { name: "FAA NAS Status (live)", url: "https://nasstatus.faa.gov" };

/** Pure: the live-status answer for a resolved location. */
export function buildLiveStatusReport(area: AreaResolution, feed: FeedResult) {
  const airports = assessAirports(area.airports, feed);
  const by = (s: LiveStatus) => airports.filter((a) => a.status === s).map((a) => a.code);
  const gaOnly = airports.filter(
    (a) => a.restrictions.length > 0 && a.restrictions.every((r) => r.type === "general_aviation_restriction"),
  );
  const warnings: string[] = [];
  if (!feed.ok) warnings.push(`FAA status feed request failed (${feed.error}); no airport status could be confirmed.`);
  if (by("data_unavailable").length) warnings.push(`Status unknown for ${by("data_unavailable").join(", ")}: FAA data could not be interpreted.`);
  if (gaOnly.length)
    warnings.push(`${gaOnly.map((a) => a.code).join(", ")}: only general-aviation restrictions listed; these do not indicate airline flight disruption.`);

  return {
    query: area.query,
    resolvedAs: {
      kind: area.kind,
      method: area.method,
      airportsChecked: airports.map((a) => a.code),
      ...(area.otherCandidates.length && { sameNameElsewhere: area.otherCandidates.map((c) => `${c.code} (${c.city}, ${c.state})`) }),
      ...(area.note && { note: area.note }),
    },
    feed: feed.ok ? { status: "ok" as const, fetchedAt: feed.fetchedAt } : { status: "request_failed" as const, error: feed.error, attemptedAt: feed.attemptedAt },
    summary: {
      withActiveDelayPrograms: by("delay_program_active"),
      noActiveProgramReported: by("no_active_program_reported"),
      dataUnavailable: by("data_unavailable"),
      requestFailed: by("request_failed"),
    },
    airports,
    warnings,
    notAvailable: NOT_AVAILABLE,
    source: SOURCE,
  };
}

/** Nationwide view: every airport with an active FAA delay program, most severe first. Pure. */
export function summarizeEvents(events: unknown[]) {
  const parsed = events.map(parseEvent);
  const delays = parsed
    .filter((p): p is ParsedEvent => p !== null && hasProgram(p.programs))
    .sort(
      (a, b) =>
        Number(Boolean(b.programs.groundStop)) - Number(Boolean(a.programs.groundStop)) ||
        (b.worstAvgDelayMinutes ?? 0) - (a.worstAvgDelayMinutes ?? 0) ||
        a.code.localeCompare(b.code),
    );
  const notices = parsed.filter((p): p is ParsedEvent => p !== null && p.restrictions.length > 0);
  return { delays, notices, malformedEntries: parsed.filter((p) => p === null).length };
}

// ---------- I/O ----------

let cache: { at: number; events: unknown[]; fetchedAt: string } | null = null;

/** Fetches the FAA feed. Never throws: failures come back as { ok: false } so callers can report them per airport. */
export async function fetchFaaFeed(): Promise<FeedResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { ok: true, events: cache.events, fetchedAt: cache.fetchedAt };
  const attemptedAt = new Date().toISOString();
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, attemptedAt };
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return { ok: false, error: "unexpected response format", attemptedAt };
    cache = { at: Date.now(), events: body, fetchedAt: attemptedAt };
    return { ok: true, events: body, fetchedAt: attemptedAt };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), attemptedAt };
  }
}

/** Every US airport with an active FAA delay program, most severe first. */
export async function getNationwideLiveDelays(limit = 15) {
  const feed = await fetchFaaFeed();
  if (!feed.ok)
    return { feed: { status: "request_failed" as const, error: feed.error, attemptedAt: feed.attemptedAt }, notAvailable: NOT_AVAILABLE, source: SOURCE };
  const { delays, notices, malformedEntries } = summarizeEvents(feed.events);
  return {
    feed: { status: "ok" as const, fetchedAt: feed.fetchedAt },
    airportsWithActiveDelayPrograms: delays.length,
    mostSevere: delays.slice(0, limit),
    notices: notices.slice(0, 10).map((n) => ({ code: n.code, name: n.name, restrictions: n.restrictions })),
    ...(malformedEntries && { warning: `${malformedEntries} FAA entries could not be interpreted and were skipped.` }),
    ranking: "Ground stops first, then the largest FAA-reported average delay (ground delay program, arrival or departure).",
    interpretation: "Airports not listed have no active FAA delay program; that does not mean their flights are on time.",
    notAvailable: NOT_AVAILABLE,
    source: SOURCE,
  };
}
