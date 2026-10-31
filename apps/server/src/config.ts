import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  GUARDRAIL_MODEL: z.string().default("gpt-4o-mini"),
  GUARDRAIL_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  PORT: z.coerce.number().default(3001),
  // Agent safeguards, per user request
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(10),
  AGENT_MAX_LLM_ITERATIONS: z.coerce.number().int().positive().default(8),
  AGENT_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

export const config = Env.parse(process.env);

export const agentLimits = {
  maxToolCalls: config.AGENT_MAX_TOOL_CALLS,
  maxLlmIterations: config.AGENT_MAX_LLM_ITERATIONS,
  llmTimeoutMs: config.AGENT_LLM_TIMEOUT_MS,
  toolTimeoutMs: config.AGENT_TOOL_TIMEOUT_MS,
};
