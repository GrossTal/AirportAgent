import { describe, expect, it } from "vitest";
import { METRO_RADIUS_MILES, milesBetween, resolveAirportFromList, resolveArea } from "./airport-resolver.js";
import { resolveRegion } from "./regions.js";
import { FIXTURE_AIRPORTS as airports } from "./test-fixtures.js";

const codes = (q: string) => resolveArea(q, airports).airports.map((a) => a.code);

describe("resolveArea (geographic metro resolution)", () => {
  it("LA: the city's main airport plus every commercial airport within the metro radius", () => {
    const r = resolveArea("LA", airports);
    expect(r.kind).toBe("metro");
    expect(r.anchor?.code).toBe("LAX");
    expect(codes("LA")[0]).toBe("LAX");
    expect([...codes("LA")].sort()).toEqual(["BUR", "LAX", "LGB", "ONT", "SNA"]);
    expect(r.note).toMatch(/not Louisiana/);
    expect(r.airports.every((a) => a.distanceMiles! <= METRO_RADIUS_MILES)).toBe(true);
  });

  it("excludes general-aviation fields and airports beyond the radius", () => {
    expect(codes("Los Angeles")).not.toContain("VNY"); // GA, below the commercial floor
    expect(codes("Los Angeles")).not.toContain("PSP"); // ~107 miles away
  });

  it("NYC: JFK, LGA and EWR (plus nearby commercial airports), not distant ones", () => {
    const nyc = codes("NYC");
    expect(nyc).toEqual(expect.arrayContaining(["JFK", "LGA", "EWR"]));
    expect(nyc).toEqual(expect.arrayContaining(["HPN", "ISP"]));
    expect(nyc).not.toContain("SWF");
    expect(codes("New York")).toEqual(nyc);
  });

  it("an explicit IATA code checks only that airport", () => {
    const r = resolveArea("LAX", airports);
    expect(r).toMatchObject({ kind: "airport", method: "IATA code" });
    expect(r.airports.map((a) => a.code)).toEqual(["LAX"]);
    expect(codes("lax")).toEqual(["LAX"]);
  });

  it("an airport name checks only that airport", () => {
    expect(resolveArea("John Wayne Airport", airports)).toMatchObject({ kind: "airport", anchor: { code: "SNA" } });
    expect(codes("John Wayne")).toEqual(["SNA"]);
    expect(codes("Portland Jetport")).toEqual(["PWM"]);
  });

  it("same city name in another state is reported, not merged", () => {
    const r = resolveArea("Portland", airports);
    expect(r.anchor?.code).toBe("PDX");
    expect(r.airports.map((a) => a.code)).toEqual(["PDX"]);
    expect(r.otherCandidates.map((a) => a.code)).toEqual(["PWM"]);
  });

  it("returns no match instead of guessing", () => {
    expect(resolveArea("Atlantis", airports)).toMatchObject({ kind: "none", anchor: null, airports: [] });
  });

  it("measures distance correctly", () => {
    const lax = airports.find((a) => a.code === "LAX")!;
    const ont = airports.find((a) => a.code === "ONT")!;
    expect(Math.round(milesBetween(lax, ont))).toBe(47);
  });
});

describe("resolveAirportFromList (single airport for analytics tools)", () => {
  it("uses the metro anchor as best and the rest of the metro as alternatives", () => {
    const r = resolveAirportFromList("LA", airports);
    expect(r.best?.code).toBe("LAX");
    expect(r.alternatives.map((a) => a.code)).toContain("SNA");
    expect(r.note).toMatch(/not Louisiana/);
  });

  it("resolves codes, cities and names", () => {
    expect(resolveAirportFromList("sfo", airports).best?.code).toBe("SFO");
    expect(resolveAirportFromList("Santa Ana", airports).best?.code).toBe("SNA");
    expect(resolveAirportFromList("John Wayne airport", airports).best?.code).toBe("SNA");
    expect(resolveAirportFromList("Anchorage", airports).best?.code).toBe("ANC");
    expect(resolveAirportFromList("Atlantis", airports).best).toBeNull();
  });

  it("lists same-name airports elsewhere as alternatives", () => {
    const r = resolveAirportFromList("Portland", airports);
    expect(r.best?.code).toBe("PDX");
    expect(r.alternatives[0]?.code).toBe("PWM");
    expect(r.ambiguous).toBe(false); // PWM < 20% of PDX volume
  });
});

describe("resolveRegion", () => {
  it("handles divisions, regions, states and informal names", () => {
    expect(resolveRegion("New England")?.states.sort()).toEqual(["CT", "MA", "ME", "NH", "RI", "VT"]);
    expect(resolveRegion("the West")?.kind).toBe("region");
    expect(resolveRegion("Texas")?.states).toEqual(["TX"]);
    expect(resolveRegion("CA")?.states).toEqual(["CA"]);
    expect(resolveRegion("West Coast")?.states).toEqual(["CA", "OR", "WA"]);
    expect(resolveRegion("Narnia")).toBeNull();
  });

  it.each([
    ["north", "informal", "Northern US"],
    ["the north of US", "informal", "Northern US"],
    ["northern United States", "informal", "Northern US"],
    ["the east", "informal", "Eastern US"],
    ["eastern U.S.", "informal", "Eastern US"],
    ["south", "region", "South"],
    ["the southern US", "region", "South"],
    ["west", "region", "West"],
    ["western states", "region", "West"],
    ["Northeastern US", "region", "Northeast"],
    ["midwestern airports area", "region", "Midwest"],
    ["east coast", "informal", "East Coast"],
    ["Gulf Coast", "informal", "Gulf Coast"],
    ["the Southeast", "informal", "Southeast"],
  ])("directional / informal: %s", (query, kind, label) => {
    const r = resolveRegion(query);
    expect(r).toMatchObject({ kind, label });
    expect(r!.definition.length).toBeGreaterThan(0);
  });

  it("defines the directional regions explicitly and sensibly", () => {
    const north = resolveRegion("north")!;
    expect(north.states).toEqual(expect.arrayContaining(["MA", "NY", "IL", "MN", "WA", "AK"]));
    expect(north.states).not.toContain("TX");
    expect(north.definition).toMatch(/Northeast and Midwest/);
    const east = resolveRegion("east")!;
    expect(east.states).toEqual(expect.arrayContaining(["NY", "FL", "GA", "MA"]));
    expect(east.states).not.toContain("CA");
  });

  it("keeps state names and codes that look like filler or directions", () => {
    expect(resolveRegion("West Virginia")?.states).toEqual(["WV"]);
    expect(resolveRegion("North Carolina")?.states).toEqual(["NC"]);
    expect(resolveRegion("IN")?.states).toEqual(["IN"]);
    expect(resolveRegion("OR")?.states).toEqual(["OR"]);
    expect(resolveRegion("District of Columbia")?.states).toEqual(["DC"]);
    expect(resolveRegion("Washington")?.states).toEqual(["WA"]);
  });
});
