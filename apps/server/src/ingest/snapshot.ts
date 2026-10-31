import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { db } from "../db/client.js";
import { airportMonthOps, airportMonthTraffic, airports, dataSources } from "../db/schema.js";
import { upsertBatched } from "./lib/db-helpers.js";
import { SEED_DIR } from "./lib/paths.js";

// Processed tables in FK order. Scores aren't snapshotted: they are recomputed from these.
const TABLES = [
  { name: "data_sources", table: dataSources, key: [dataSources.id] },
  { name: "airports", table: airports, key: [airports.code] },
  { name: "airport_month_traffic", table: airportMonthTraffic, key: [airportMonthTraffic.code, airportMonthTraffic.month] },
  { name: "airport_month_ops", table: airportMonthOps, key: [airportMonthOps.code, airportMonthOps.month] },
] as const;

const fileFor = (name: string) => path.join(SEED_DIR, `${name}.json.gz`);

/** Writes the processed tables to data/seed so reviewers can skip the ~400 MB of raw downloads. */
export async function exportSnapshot(log = console.log): Promise<void> {
  await mkdir(SEED_DIR, { recursive: true });
  for (const { name, table } of TABLES) {
    const rows = await db.select().from(table);
    await writeFile(fileFor(name), gzipSync(JSON.stringify(rows)));
    log(`  snapshot ${name}: ${rows.length} rows`);
  }
}

export function snapshotExists(): boolean {
  return TABLES.every(({ name }) => existsSync(fileFor(name)));
}

export async function loadSnapshot(log = console.log): Promise<void> {
  for (const { name, table, key } of TABLES) {
    const rows = JSON.parse(gunzipSync(await readFile(fileFor(name))).toString("utf8"));
    if (name === "data_sources") for (const r of rows) r.fetchedAt = new Date(r.fetchedAt);
    await upsertBatched(table, rows, [...key]);
    log(`  seed ${name}: ${rows.length} rows`);
  }
}
