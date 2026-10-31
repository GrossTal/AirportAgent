import type { ResolverAirport } from "./airport-resolver.js";

const A = (code: string, name: string, city: string, state: string, passengers: number, latitude: number, longitude: number): ResolverAirport => ({
  code,
  name,
  city,
  state,
  passengers,
  latitude,
  longitude,
});

/** Real coordinates and approximate 12-month passenger volumes. */
export const FIXTURE_AIRPORTS: ResolverAirport[] = [
  // Los Angeles area
  A("LAX", "Los Angeles International Airport", "Los Angeles", "CA", 36_000_000, 33.9425, -118.4081),
  A("BUR", "Hollywood Burbank Airport", "Burbank", "CA", 3_060_000, 34.2007, -118.3585),
  A("LGB", "Long Beach Airport", "Long Beach", "CA", 1_780_000, 33.8177, -118.1516),
  A("ONT", "Ontario International Airport", "Ontario", "CA", 3_500_000, 34.056, -117.6012),
  A("SNA", "John Wayne Orange County International Airport", "Santa Ana", "CA", 5_530_000, 33.6757, -117.8682),
  A("VNY", "Van Nuys Airport", "Los Angeles", "CA", 4_000, 34.2098, -118.4899), // general aviation: below the commercial floor
  A("PSP", "Palm Springs International Airport", "Palm Springs", "CA", 1_500_000, 33.8297, -116.5067), // ~107 mi: outside the metro
  // New York area
  A("JFK", "John F Kennedy International Airport", "New York", "NY", 29_700_000, 40.6413, -73.7781),
  A("LGA", "LaGuardia Airport", "New York", "NY", 16_000_000, 40.7769, -73.874),
  A("EWR", "Newark Liberty International Airport", "Newark", "NJ", 23_600_000, 40.6895, -74.1745),
  A("HPN", "Westchester County Airport", "White Plains", "NY", 1_190_000, 41.067, -73.7076),
  A("ISP", "Long Island MacArthur Airport", "Islip", "NY", 800_000, 40.7952, -73.1002),
  A("SWF", "New York Stewart International Airport", "Newburgh", "NY", 130_000, 41.5041, -74.1048), // ~62 mi
  // Others
  A("ANC", "Ted Stevens Anchorage International Airport", "Anchorage", "AK", 2_800_000, 61.1743, -149.9963),
  A("SFO", "San Francisco International Airport", "San Francisco", "CA", 26_000_000, 37.6213, -122.379),
  A("PDX", "Portland International Airport", "Portland", "OR", 9_300_000, 45.5898, -122.5951),
  A("PWM", "Portland International Jetport", "Portland", "ME", 1_300_000, 43.6462, -70.3093),
];
