// US Census Bureau regions and divisions, used for questions like "airports in New England".
const DIVISIONS: Record<string, { region: string; states: string[] }> = {
  "New England": { region: "Northeast", states: ["CT", "ME", "MA", "NH", "RI", "VT"] },
  "Middle Atlantic": { region: "Northeast", states: ["NJ", "NY", "PA"] },
  "East North Central": { region: "Midwest", states: ["IL", "IN", "MI", "OH", "WI"] },
  "West North Central": { region: "Midwest", states: ["IA", "KS", "MN", "MO", "NE", "ND", "SD"] },
  "South Atlantic": { region: "South", states: ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV"] },
  "East South Central": { region: "South", states: ["AL", "KY", "MS", "TN"] },
  "West South Central": { region: "South", states: ["AR", "LA", "OK", "TX"] },
  Mountain: { region: "West", states: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"] },
  Pacific: { region: "West", states: ["AK", "CA", "HI", "OR", "WA"] },
};

export const STATE_TO_DIVISION: Record<string, { division: string; region: string }> = Object.fromEntries(
  Object.entries(DIVISIONS).flatMap(([division, { region, states }]) =>
    states.map((s) => [s, { division, region }]),
  ),
);
