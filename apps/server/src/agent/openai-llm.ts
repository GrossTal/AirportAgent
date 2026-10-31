import OpenAI from "openai";
import type { ResponseInput, Tool } from "openai/resources/responses/responses";
import type { LlmClient, LlmOutputItem } from "./agent-service.js";
import { SCOPE_VERDICT_JSON_SCHEMA, type ScopeClassifier } from "./guardrail.js";

// Timeouts are enforced by the callers (AbortSignal); one SDK retry covers transient errors.
const createClient = (apiKey: string) => new OpenAI({ apiKey, maxRetries: 1 });

/** LlmClient backed by the OpenAI Responses API with function tools. */
export function createOpenAiLlm(opts: { apiKey: string; model: string }): LlmClient {
  const client = createClient(opts.apiKey);
  return {
    async respond({ instructions, input, tools, signal }) {
      const res = await client.responses.create(
        {
          model: opts.model,
          instructions,
          input: input as ResponseInput,
          tools: tools as Tool[],
          parallel_tool_calls: true,
          temperature: 0.2,
        },
        { signal },
      );
      return { output: res.output as LlmOutputItem[] };
    },
  };
}

/** Scope classifier: a small model with strict JSON-schema output, so it can only return enum values. */
export function createOpenAiScopeClassifier(opts: { apiKey: string; model: string }): ScopeClassifier {
  const client = createClient(opts.apiKey);
  return {
    async classify({ instructions, input, signal }) {
      const res = await client.responses.create(
        {
          model: opts.model,
          instructions,
          input,
          temperature: 0,
          max_output_tokens: 100,
          store: false,
          text: { format: { type: "json_schema", name: "scope_verdict", schema: SCOPE_VERDICT_JSON_SCHEMA, strict: true } },
        },
        { signal },
      );
      return JSON.parse(res.output_text);
    },
  };
}
