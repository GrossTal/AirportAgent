/**
 * Runs the labeled guardrail cases through the real pipeline (rules + OpenAI classifier) and reports
 * false positives (legitimate questions rejected) and false negatives (off-topic questions accepted).
 *
 *   npm run eval:guardrail -w apps/server      (needs OPENAI_API_KEY in apps/server/.env)
 */
import "dotenv/config";
import { GUARDRAIL_CASES } from "../src/agent/guardrail-cases.js";
import { checkScope, type GuardrailDecision } from "../src/agent/guardrail.js";
import { createOpenAiScopeClassifier } from "../src/agent/openai-llm.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is not set in apps/server/.env; cannot run the real classifier.");
  process.exit(1);
}
const model = process.env.GUARDRAIL_MODEL ?? "gpt-4o-mini";
const timeoutMs = Number(process.env.GUARDRAIL_TIMEOUT_MS ?? 8_000);
const classifier = createOpenAiScopeClassifier({ apiKey, model });
const silent = { info() {}, warn() {}, error() {} };

type Row = { id: string; group: string; expected: string; got: GuardrailDecision; outcome: string };
const rows: Row[] = [];

const CONCURRENCY = 4;
const queue = [...GUARDRAIL_CASES];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const got = await checkScope(c.message, c.history ?? [], { classifier, timeoutMs, logger: silent });
      const accepted = got.source !== "fallback" && got.verdict === "in_scope";
      let outcome: string;
      if (got.source === "fallback") outcome = `ERROR (${got.failure})`;
      else if (c.expected === "in_scope")
        outcome = accepted
          ? c.unrelatedPart && !got.contains_unrelated_request
            ? "ok (unrelated part not flagged)"
            : "ok"
          : got.verdict === "needs_clarification"
            ? "soft miss (clarification)"
            : "FALSE POSITIVE";
      else outcome = accepted ? "FALSE NEGATIVE" : "ok";
      rows.push({ id: c.id, group: c.group, expected: c.expected, got, outcome });
    }
  }),
);

rows.sort((a, b) => GUARDRAIL_CASES.findIndex((c) => c.id === a.id) - GUARDRAIL_CASES.findIndex((c) => c.id === b.id));
console.log(`Guardrail eval: ${model}, ${rows.length} cases\n`);
for (const r of rows) {
  const flag = r.got.contains_unrelated_request ? " +unrelated" : "";
  console.log(
    `${r.outcome.startsWith("ok") ? "  " : "!!"} ${r.id.padEnd(22)} ${r.group.padEnd(12)} expected ${r.expected.padEnd(12)} got ${`${r.got.verdict}/${r.got.category}${flag}`.padEnd(42)} ${r.got.source.padEnd(10)} ${String(r.got.latencyMs).padStart(5)}ms  ${r.outcome}`,
  );
}

const legit = rows.filter((r) => r.expected === "in_scope");
const offTopic = rows.filter((r) => r.expected === "out_of_scope");
const fp = legit.filter((r) => r.outcome === "FALSE POSITIVE").length;
const soft = legit.filter((r) => r.outcome.startsWith("soft")).length;
const fn = offTopic.filter((r) => r.outcome === "FALSE NEGATIVE").length;
const errors = rows.filter((r) => r.outcome.startsWith("ERROR")).length;
const llmLatencies = rows.filter((r) => r.got.source === "classifier").map((r) => r.got.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => llmLatencies[Math.min(llmLatencies.length - 1, Math.floor(p * llmLatencies.length))] ?? 0;

console.log(`
False positives (legitimate rejected):  ${fp}/${legit.length}  (${((fp / legit.length) * 100).toFixed(1)}%)
Clarification on legitimate questions:  ${soft}/${legit.length}
False negatives (off-topic accepted):   ${fn}/${offTopic.length}  (${((fn / offTopic.length) * 100).toFixed(1)}%)
Classifier errors / timeouts:           ${errors}
Decided by rules:                       ${rows.filter((r) => r.got.source === "rule").length}/${rows.length}
Classifier latency p50 / p95:           ${pct(0.5)}ms / ${pct(0.95)}ms`);

process.exitCode = fp + fn + errors > 0 ? 1 : 0;
