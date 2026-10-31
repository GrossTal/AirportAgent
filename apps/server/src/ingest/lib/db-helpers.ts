import { getTableColumns, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../../db/client.js";
import { dataSources } from "../../db/schema.js";

/**
 * Idempotent bulk upsert: re-running an ingest step overwrites rows instead of duplicating them.
 * Only the columns present in the rows are updated, so columns owned by another step
 * (e.g. airports.bts_airport_id, set by the T-100 step) are left alone.
 */
export async function upsertBatched<T extends PgTable>(
  table: T,
  rows: T["$inferInsert"][],
  conflictTarget: PgColumn[],
  batchSize = 1000,
): Promise<void> {
  if (!rows.length) return;
  const targetNames = new Set(conflictTarget.map((c) => c.name));
  const provided = new Set(Object.keys(rows[0]!));
  const set: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    if (provided.has(key) && !targetNames.has(col.name)) set[key] = sql.raw(`excluded."${col.name}"`);
  }
  for (let i = 0; i < rows.length; i += batchSize) {
    await db
      .insert(table)
      .values(rows.slice(i, i + batchSize))
      .onConflictDoUpdate({ target: conflictTarget, set });
  }
}

export async function recordSource(source: typeof dataSources.$inferInsert): Promise<void> {
  await upsertBatched(dataSources, [source], [dataSources.id]);
}
