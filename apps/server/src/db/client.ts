import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

// Reads DATABASE_URL directly so ingest scripts don't require the OpenAI settings in config.ts.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (copy apps/server/.env.example to apps/server/.env)");

export const pool = new pg.Pool({ connectionString: url });
export const db = drizzle(pool, { schema });
