/** Runs every agent tool once against the loaded database: `npx tsx scripts/smoke-tools.ts` (from apps/server). */
import { runTool } from "../src/agent/tools.js";
import { pool } from "../src/db/client.js";

const calls: [string, unknown][] = [
  ["resolve_airport", { query: "LA" }],
  ["resolve_airport", { query: "Santa Ana" }],
  ["rank_airports", { region: "New England", limit: 5 }],
  ["compare_airports", { codes: ["LAX", "SNA"] }],
  ["get_long_haul_share", { code: "ANC" }],
  ["get_unmet_demand_signals", { code: "SFO" }],
  ["get_airport_profile", { code: "DJT" }],
  ["get_live_airport_status", { location: "SFO" }],
  ["get_live_airport_status", { location: "LA" }],
  ["get_live_airport_status", { location: "NYC" }],
  ["get_live_delays_nationwide", {}],
  ["get_methodology", {}],
  ["get_airport_profile", { code: "XXX" }], // expected error, returned as data
];

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
};

for (const [name, args] of calls) {
  const t0 = Date.now();
  const res = await runTool(name, args);
  console.log(`\n## ${name} ${JSON.stringify(args)} (${Date.now() - t0}ms) ok=${res.ok}`);
  console.log(short(res.ok ? res.data : res.error));
}
await pool.end();
