/**
 * Ask the agent from the terminal through the full pipeline (guardrail -> agent -> tools), as one conversation.
 *
 *   npm run ask -w apps/server -- "Compare LA and Santa Ana airport congestion levels." "What about SFO?"
 */
import type { ChatMessage } from "../src/agent/agent-service.js";
import { respondToUser } from "../src/agent/chat-service.js";
import { createOpenAiLlm, createOpenAiScopeClassifier } from "../src/agent/openai-llm.js";
import { SYSTEM_PROMPT } from "../src/agent/prompt.js";
import { runTool, toolDefinitions } from "../src/agent/tools.js";
import { agentLimits, config } from "../src/config.js";
import { pool } from "../src/db/client.js";

const questions = process.argv.slice(2);
if (!questions.length) {
  console.error('Usage: npm run ask -w apps/server -- "question 1" ["follow-up" ...]');
  process.exit(1);
}

const logger = { info() {}, warn: (o: object, m?: string) => console.warn("  [warn]", m, o), error: (o: object, m?: string) => console.error("  [error]", m, o) };
const history: ChatMessage[] = [];

for (const q of questions) {
  console.log(`\n================================================================\nUSER: ${q}\n`);
  const t0 = Date.now();
  const res = await respondToUser(history, q, {
    guardrail: {
      classifier: createOpenAiScopeClassifier({ apiKey: config.OPENAI_API_KEY, model: config.GUARDRAIL_MODEL }),
      timeoutMs: config.GUARDRAIL_TIMEOUT_MS,
      logger,
    },
    agent: {
      llm: createOpenAiLlm({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL }),
      executeTool: runTool,
      tools: toolDefinitions,
      instructions: SYSTEM_PROMPT,
      limits: agentLimits,
      logger,
    },
    onEvent: (e) => {
      if (e.type === "guardrail")
        console.log(`  [guardrail] ${e.verdict} (${e.category})${e.containsUnrelatedRequest ? " +unrelated part" : ""}`);
      if (e.type === "tool_call") console.log(`  [tool] ${e.name} ${JSON.stringify(e.args)}`);
      if (e.type === "tool_result" && !e.ok) console.log(`  [tool error] ${e.name}: ${e.error}`);
      if (e.type === "limit_reached") console.log(`  [limit] ${e.limit}`);
    },
  });
  console.log(`\nASSISTANT (${res.status}, ${res.toolCalls} tool calls, ${res.llmIterations} LLM calls, ${((Date.now() - t0) / 1000).toFixed(1)}s):\n\n${res.answer}`);
  history.push({ role: "user", content: q }, { role: "assistant", content: res.answer });
}
await pool.end();
