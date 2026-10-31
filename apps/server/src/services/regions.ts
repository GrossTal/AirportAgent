import { STATE_TO_DIVISION } from "../ingest/lib/regions.js";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const statesIn = (pred: (v: { division: string; region: string }) => boolean) =>
  Object.entries(STATE_TO_DIVISION)
    .filter(([, v]) => pred(v))
    .map(([s]) => s);

/**
 * Informal and directional regions. These have no official definition, so each one carries the
 * definition we used; the agent must state it to the user.
 */
const INFORMAL: Record<string, { label: string; states: string[]; definition: string }> = {
  north: {
    label: "Northern US",
    states: [...statesIn((v) => v.region === "Northeast" || v.region === "Midwest"), "WA", "OR", "ID", "MT", "WY", "AK"],
    definition:
      "Assumed 'North' = Census Northeast and Midwest regions plus the northern-tier West states (WA, OR, ID, MT, WY, AK).",
  },
  east: {
    label: "Eastern US",
    states: statesIn((v) => v.region === "Northeast" || v.division === "South Atlantic"),
    definition: "Assumed 'East' = Census Northeast region plus the South Atlantic division (Atlantic-side states).",
  },
  "east coast": {
    label: "East Coast",
    states: ["ME", "NH", "MA", "RI", "CT", "NY", "NJ", "DE", "MD", "DC", "VA", "NC", "SC", "GA", "FL"],
    definition: "Assumed 'East Coast' = states with an Atlantic coastline, plus DC.",
  },
  "west coast": { label: "West Coast", states: ["CA", "OR", "WA"], definition: "Assumed 'West Coast' = CA, OR, WA." },
  "gulf coast": { label: "Gulf Coast", states: ["TX", "LA", "MS", "AL", "FL"], definition: "Assumed 'Gulf Coast' = TX, LA, MS, AL, FL." },
  southeast: {
    label: "Southeast",
    states: ["FL", "GA", "SC", "NC", "AL", "MS", "TN"],
    definition: "Assumed 'Southeast' = FL, GA, SC, NC, AL, MS, TN.",
  },
  southwest: { label: "Southwest", states: ["AZ", "NM", "NV", "TX", "OK"], definition: "Assumed 'Southwest' = AZ, NM, NV, TX, OK." },
  northwest: { label: "Northwest", states: ["WA", "OR", "ID"], definition: "Assumed 'Northwest' = WA, OR, ID (Pacific Northwest)." },
  "pacific northwest": { label: "Pacific Northwest", states: ["WA", "OR", "ID"], definition: "Assumed 'Pacific Northwest' = WA, OR, ID." },
  "tri state": { label: "Tri-State area", states: ["NY", "NJ", "CT"], definition: "Assumed 'Tri-State' = NY, NJ, CT." },
};

export type ResolvedRegion = {
  label: string;
  kind: "division" | "region" | "state" | "informal";
  states: string[];
  definition: string;
};

/** "the north of the US" -> "north", "Northeastern U.S." -> "northeast", "midwestern states" -> "midwest". */
export function normalizeRegionQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/u\.s\.a?\.?/g, " us ")
    .replace(/[^a-z ]/g, " ")
    .replace(/\b(the|of|in|us|usa|united states|america|american|country|regions?|parts?|areas?|states?|airports?)\b/g, " ")
    .replace(/\b(north|south)(east|west)?ern\b/g, "$1$2")
    .replace(/\b(east|west|midwest)ern\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Maps a Census division/region, a state, or an informal/directional region to state codes. */
export function resolveRegion(query: string): ResolvedRegion | null {
  // State codes first, on the raw input: "IN" and "OR" would otherwise be stripped as filler words.
  const raw = query.trim();
  if (/^[A-Za-z]{2}$/.test(raw) && STATE_NAMES[raw.toUpperCase()])
    return { label: STATE_NAMES[raw.toUpperCase()]!, kind: "state", states: [raw.toUpperCase()], definition: "Single state." };

  const q = normalizeRegionQuery(query);
  if (!q) return null;
  const entries = Object.values(STATE_TO_DIVISION);

  const division = [...new Set(entries.map((v) => v.division))].find((d) => d.toLowerCase() === q);
  if (division)
    return { label: division, kind: "division", states: statesIn((v) => v.division === division), definition: `US Census Bureau division: ${division}.` };

  const region = [...new Set(entries.map((v) => v.region))].find((r) => r.toLowerCase() === q);
  if (region)
    return { label: region, kind: "region", states: statesIn((v) => v.region === region), definition: `US Census Bureau region: ${region}.` };

  const informal = INFORMAL[q];
  if (informal) return { label: informal.label, kind: "informal", states: informal.states, definition: informal.definition };

  const byName = Object.entries(STATE_NAMES).find(([, name]) => name.toLowerCase() === q || name.toLowerCase() === raw.toLowerCase());
  if (byName) return { label: byName[1], kind: "state", states: [byName[0]], definition: "Single state." };

  return null;
}

export const KNOWN_REGION_NAMES = [
  ...new Set(Object.values(STATE_TO_DIVISION).flatMap((v) => [v.division, v.region])),
  ...Object.values(INFORMAL).map((r) => r.label),
];
