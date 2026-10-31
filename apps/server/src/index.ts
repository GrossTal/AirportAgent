import { respondToUser } from "./agent/chat-service.js";
import { createOpenAiLlm, createOpenAiScopeClassifier } from "./agent/openai-llm.js";
import { SYSTEM_PROMPT } from "./agent/prompt.js";
import { runTool, toolDefinitions } from "./agent/tools.js";
import { buildApp } from "./app.js";
import { agentLimits, config } from "./config.js";

const llm = createOpenAiLlm({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL });
const classifier = createOpenAiScopeClassifier({ apiKey: config.OPENAI_API_KEY, model: config.GUARDRAIL_MODEL });

const app = buildApp(
  {
    respond: (history, message, onEvent, logger) =>
      respondToUser(history, message, {
        guardrail: { classifier, timeoutMs: config.GUARDRAIL_TIMEOUT_MS, logger },
        agent: { llm, executeTool: runTool, tools: toolDefinitions, instructions: SYSTEM_PROMPT, limits: agentLimits, logger },
        onEvent,
      }),
  },
  { logger: { transport: { target: "pino-pretty" } } },
);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
