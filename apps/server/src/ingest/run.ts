/**
 * Data pipeline CLI.
 *
 *   npm run ingest            fetch all sources, aggregate, score, write snapshot
 *   npm run ingest -- <step>  airports | t100 | ontime | score | snapshot
 *   npm run db:seed           load the committed snapshot (no downloads) and score
 */
import { pool } from "../db/client.js";
import { ingestAirports } from "./airports.js";
import { addMonths, monthsEndingAt } from "./lib/months.js";
import { ingestOnTime } from "./ontime.js";
import { computeScores } from "./score.js";
import { exportSnapshot, loadSnapshot } from "./snapshot.js";
import { ingestT100, latestT100Month } from "./t100.js";

const ANALYSIS_MONTHS = 12;

async function main(step: string) {
  const timed = async <T>(label: string, fn: () => Promise<T>) => {
    const t0 = Date.now();
    const res = await fn();
    console.log(`✓ ${label}: ${res ?? "done"} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return res;
  };

  if (step === "seed") {
    await timed("seed", () => loadSnapshot());
    const { max } = (await pool.query("select max(month)::text as max from airport_month_traffic")).rows[0];
    await timed("score", () => computeScores(max));
    return;
  }

  // The analysis window ends at the latest month T-100 has published; on-time data is aligned to it.
  const end = await latestT100Month();
  console.log(`Analysis window: ${addMonths(end, -(ANALYSIS_MONTHS - 1)).slice(0, 7)} .. ${end.slice(0, 7)}`);
  const all = step === "all";

  if (all || step === "airports") await timed("airports", () => ingestAirports());
  // Two years of T-100 so the score can compare against the prior 12 months.
  if (all || step === "t100") await timed("t100", () => ingestT100(addMonths(end, -(2 * ANALYSIS_MONTHS - 1)), end));
  if (all || step === "ontime") await timed("ontime", () => ingestOnTime(monthsEndingAt(end, ANALYSIS_MONTHS)));
  if (all || step === "score") await timed("score", () => computeScores(end));
  if (all || step === "snapshot") await timed("snapshot", () => exportSnapshot());
}

const step = process.argv[2] ?? "all";
main(step)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
