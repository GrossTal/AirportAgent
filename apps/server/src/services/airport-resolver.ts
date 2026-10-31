/**
 * Resolves what a user typed ("LA", "NYC", "Santa Ana", "John Wayne", "SFO") to airports.
 * Names differ between sources and users, so names are only used here, to find codes;
 * everything downstream works on codes.
 *
 * - An IATA code resolves to exactly that airport.
 * - A city or metro name resolves geographically: the city's busiest airport is the anchor, and every
 *   commercial airport within METRO_RADIUS_MILES of it serves the area. No metro is hardcoded.
 * - An airport name ("John Wayne", "Portland Jetport") resolves to that single airport.
 */

export type ResolverAirport = {
  code: string;
  name: string;
  city: string | null;
  state: string;
  passengers: number; // last 12 months
  latitude: number;
  longitude: number;
};

export type AirportMatch = {
  code: string;
  name: string;
  city: string | null;
  state: string;
  annualPassengers: number;
  distanceMiles?: number; // from the anchor airport, for metro results
};

/**
 * Airports that serve one metro are all within ~47 miles of its main airport (ONT-LAX 47, BWI-IAD 45),
 * while the next ring starts at ~55 miles (ABE-PHL 55, TTN-JFK 60, RFD-ORD 63), measured on our data.
 */
export const METRO_RADIUS_MILES = 50;
/** Excludes general-aviation fields and airports with minimal scheduled service from metro lists. */
export const MIN_COMMERCIAL_PASSENGERS = 100_000;

/** Common abbreviations mapped to the city name they stand for (data, not per-city logic). */
const NICKNAMES: Record<string, { city: string; note?: string }> = {
  la: { city: "los angeles", note: '"LA" interpreted as Los Angeles, not Louisiana.' },
  nyc: { city: "new york" },
  "new york city": { city: "new york" },
  sf: { city: "san francisco" },
  "bay area": { city: "san francisco" },
  dc: { city: "washington" },
  "washington dc": { city: "washington", note: "Interpreted as Washington, DC." },
  philly: { city: "philadelphia" },
  vegas: { city: "las vegas" },
  nola: { city: "new orleans" },
  "twin cities": { city: "minneapolis" },
};

const AIRPORT_WORDS = /\b(airport|international|intl|regional|field|jetport)\b/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(airport|international|intl|regional)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Great-circle distance in statute miles. */
export function milesBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

const toMatch = (a: ResolverAirport, distanceMiles?: number): AirportMatch => ({
  code: a.code,
  name: a.name,
  city: a.city,
  state: a.state,
  annualPassengers: Math.round(a.passengers),
  ...(distanceMiles !== undefined && { distanceMiles: Math.round(distanceMiles) }),
});

export type AreaResolution = {
  query: string;
  kind: "airport" | "metro" | "none";
  method: string;
  anchor: AirportMatch | null;
  /** Airports to check: the single airport, or every commercial airport serving the metro (anchor first). */
  airports: AirportMatch[];
  /** Same-name places elsewhere (e.g. Portland, ME when Portland, OR was chosen) or other name matches. */
  otherCandidates: AirportMatch[];
  ambiguous: boolean;
  note?: string;
};

function metroAround(anchor: ResolverAirport, airports: ResolverAirport[]): AirportMatch[] {
  return airports
    .map((a) => ({ a, d: milesBetween(anchor, a) }))
    .filter(({ a, d }) => a.code === anchor.code || (d <= METRO_RADIUS_MILES && a.passengers >= MIN_COMMERCIAL_PASSENGERS))
    .sort((x, y) => Number(y.a.code === anchor.code) - Number(x.a.code === anchor.code) || y.a.passengers - x.a.passengers)
    .map(({ a, d }) => toMatch(a, d));
}

/** Pure resolution over a list of candidate airports (testable without a database). */
export function resolveArea(query: string, airports: ResolverAirport[]): AreaResolution {
  const raw = query.trim();
  const byCode = new Map(airports.map((a) => [a.code, a]));
  const nickname = NICKNAMES[norm(raw)];
  const none: AreaResolution = { query, kind: "none", method: "no match", anchor: null, airports: [], otherCandidates: [], ambiguous: false };

  // 1. Explicit IATA code: only that airport.
  const upper = raw.toUpperCase();
  if (/^[A-Z0-9]{3}$/.test(upper) && byCode.has(upper) && !nickname) {
    const a = toMatch(byCode.get(upper)!);
    return { query, kind: "airport", method: "IATA code", anchor: a, airports: [a], otherCandidates: [], ambiguous: false };
  }

  const q = nickname?.city ?? norm(raw);
  if (!q) return none;
  const explicitAirport = AIRPORT_WORDS.test(raw);

  // 2. City or metro name: exact city match, anchored on its busiest airport, expanded geographically.
  const cityMatches = airports.filter((a) => a.city && norm(a.city) === q);
  if (cityMatches.length && !explicitAirport) {
    const byState = new Map<string, ResolverAirport[]>();
    for (const a of cityMatches) byState.set(a.state, [...(byState.get(a.state) ?? []), a]);
    const groups = [...byState.values()].map((g) => g.sort((x, y) => y.passengers - x.passengers));
    groups.sort((x, y) => y.reduce((s, a) => s + a.passengers, 0) - x.reduce((s, a) => s + a.passengers, 0));
    const anchor = groups[0]![0]!;
    const elsewhere = groups.slice(1).map((g) => toMatch(g[0]!));
    return {
      query,
      kind: "metro",
      method: `city "${q}": ${anchor.code} plus commercial airports within ${METRO_RADIUS_MILES} miles`,
      anchor: toMatch(anchor),
      airports: metroAround(anchor, airports),
      otherCandidates: elsewhere,
      // Same city name in another state with comparable traffic is a genuine ambiguity.
      ambiguous: elsewhere.some((e) => e.annualPassengers > 0.2 * anchor.passengers),
      ...(nickname?.note && { note: nickname.note }),
    };
  }

  // 3. Airport name (or partial name/city): match tokens against airport name and city.
  const tokens = q.split(" ").filter(Boolean);
  const matches = airports
    .filter((a) => tokens.every((t) => norm(`${a.name} ${a.city ?? ""}`).includes(t)))
    .sort((a, b) => b.passengers - a.passengers);
  if (!matches.length) return none;
  const best = matches[0]!;
  const namedAirport = explicitAirport || tokens.every((t) => norm(best.name).includes(t));
  if (namedAirport) {
    const a = toMatch(best);
    const others = matches.slice(1, 5).map((m) => toMatch(m));
    return {
      query,
      kind: "airport",
      method: "airport name",
      anchor: a,
      airports: [a],
      otherCandidates: others,
      ambiguous: others.some((o) => o.annualPassengers > 0.2 * best.passengers),
    };
  }
  return {
    query,
    kind: "metro",
    method: `place "${q}": ${best.code} plus commercial airports within ${METRO_RADIUS_MILES} miles`,
    anchor: toMatch(best),
    airports: metroAround(best, airports),
    otherCandidates: [],
    ambiguous: false,
  };
}

export type ResolveResult = {
  query: string;
  best: AirportMatch | null;
  alternatives: AirportMatch[];
  ambiguous: boolean;
  resolvedAs: AreaResolution["kind"];
  note?: string;
};

/** Single-airport view of resolveArea for analytics tools: the anchor, with the metro's other airports as alternatives. */
export function resolveAirportFromList(query: string, airports: ResolverAirport[]): ResolveResult {
  const r = resolveArea(query, airports);
  return {
    query,
    best: r.anchor,
    alternatives: [...r.airports.slice(1), ...r.otherCandidates].slice(0, 6),
    ambiguous: r.ambiguous,
    resolvedAs: r.kind,
    ...(r.note && { note: r.note }),
  };
}
