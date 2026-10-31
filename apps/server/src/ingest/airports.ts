import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { airports } from "../db/schema.js";
import { recordSource, upsertBatched } from "./lib/db-helpers.js";
import { downloadCached } from "./lib/download.js";
import { STATE_TO_DIVISION } from "./lib/regions.js";

const SOURCE_ID = "ourairports";
const URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

// When two OurAirports rows share an IATA code, keep the most significant one.
const TYPE_PRIORITY: Record<string, number> = { large_airport: 3, medium_airport: 2, small_airport: 1 };

type OurAirportsRow = {
  type: string;
  name: string;
  latitude_deg: string;
  longitude_deg: string;
  iso_country: string;
  iso_region: string;
  municipality: string;
  iata_code: string;
};

export async function ingestAirports(): Promise<number> {
  const file = await downloadCached(URL, "ourairports/airports.csv");
  const rows: OurAirportsRow[] = parse(await readFile(file), { columns: true, skip_empty_lines: true });

  const byCode = new Map<string, typeof airports.$inferInsert>();
  for (const r of rows) {
    // Scope: the 50 states + DC (territories like PR/GU have their own iso_country).
    if (r.iso_country !== "US" || !/^[A-Z0-9]{3}$/.test(r.iata_code)) continue;
    const priority = TYPE_PRIORITY[r.type];
    if (!priority) continue; // heliports, seaplane bases, closed
    const state = r.iso_region.slice(3);
    const geo = STATE_TO_DIVISION[state];
    if (!geo) continue;

    const existing = byCode.get(r.iata_code);
    if (existing && TYPE_PRIORITY[existing.airportType]! >= priority) continue;
    byCode.set(r.iata_code, {
      code: r.iata_code,
      name: r.name,
      city: r.municipality || null,
      state,
      censusDivision: geo.division,
      censusRegion: geo.region,
      airportType: r.type,
      latitude: Number(r.latitude_deg),
      longitude: Number(r.longitude_deg),
    });
  }

  const values = [...byCode.values()];
  await recordSource({
    id: SOURCE_ID,
    name: "OurAirports",
    url: URL,
    description: "Open airport reference data: IATA codes, names, locations, airport type.",
    rowCount: values.length,
    fetchedAt: new Date(),
  });
  await upsertBatched(airports, values, [airports.code]);
  return values.length;
}
