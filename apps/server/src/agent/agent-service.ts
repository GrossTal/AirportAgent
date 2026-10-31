/**
 * Agent loop: OpenAI tool calling over the deterministic tools.
 *
 * Safeguards (all per user request):
 *  - maxToolCalls:     attempted tool executions, including invalid arguments, tool errors and timeouts
 *  - maxLlmIterations: LLM calls, so responses with neither tool calls nor an answer can't loop forever
 *  - llmTimeoutMs / toolTimeoutMs: per call
 * Hitting a limit or an LLM failure returns a fixed, explanatory answer instead of throwing.
 *
 * The LLM client and tool executor are injected so the loop is testable without OpenAI or a database.
 */
import type { ToolResult } from "./tools.js";

export type ChatMessage = { role: "user" | "assistant"; content: string };
/** Instruction from our own code (not the user) placed right after the user's message, where models weigh it most. */
export type DeveloperMessage = { role: "developer"; content: string };
export type FunctionCallItem = { type: "function_call"; call_id: string; name: string; arguments: string };
export type MessageItem = { type: "message"; role?: string; content: { type: string; text?: string }[] };
export type LlmOutputItem = FunctionCallItem | MessageItem | { type: string; [key: string]: unknown };
export type FunctionCallOutputItem = { type: "function_call_output"; call_id: string; output: string };
export type LlmInputItem = ChatMessage | DeveloperMessage | LlmOutputItem | FunctionCallOutputItem;

export interface LlmClient {
  respond(req: {
    instructions: string;
    input: LlmInputItem[];
    tools: unknown[];
    signal: AbortSignal;
  }): Promise<{ output: LlmOutputItem[] }>;
}

export type ToolExecutor = (name: string, args: unknown) => Promise<ToolResult>;

/** pino-compatible subset, so Fastify's request logger can be passed straight in. */
export interface AgentLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type AgentLimits = {
  maxToolCalls: number;
  maxLlmIterations: number;
  llmTimeoutMs: number;
  toolTimeoutMs: number;
};

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxToolCalls: 10,
  maxLlmIterations: 8,
  llmTimeoutMs: 60_000,
  toolTimeoutMs: 20_000,
};

export type AgentEvent =
  | { type: "tool_call"; callId: string; name: string; args: unknown; attempt: number }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; error?: string; durationMs: number }
  | { type: "limit_reached"; limit: "tool_calls" | "llm_iterations" };

export type AgentStatus = "completed" | "tool_limit_reached" | "iteration_limit_reached" | "llm_error";

export type AgentResult = {
  status: AgentStatus;
  answer: string;
  toolCalls: number;
  llmIterations: number;
};

export type AgentDeps = {
  llm: LlmClient;
  executeTool: ToolExecutor;
  tools: unknown[];
  instructions: string;
  /** Optional per-turn instruction inserted after the user's message (e.g. the guardrail's scope note). */
  turnNote?: string;
  limits?: Partial<AgentLimits>;
  logger: AgentLogger;
  onEvent?: (event: AgentEvent) => void;
};

export const AGENT_MESSAGES = {
  toolLimit: (n: number) =>
    `I stopped because answering this would need more than ${n} data lookups, which is the limit per question. ` +
    "Please try a narrower question, for example one airport or one region at a time.",
  iterationLimit:
    "I couldn't reach a complete answer within the allowed number of reasoning steps. Please rephrase or narrow the question.",
  llmError: "Sorry, the language model is unavailable right now, so I couldn't answer. Please try again in a moment.",
  // Sent to the model when it returns neither tool calls nor text.
  nudge: "Please give your final answer to my question now, based on the tool results so far.",
};

export class TimeoutError extends Error {}

export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const isFunctionCall = (item: LlmOutputItem): item is FunctionCallItem => item.type === "function_call";

function outputText(output: LlmOutputItem[]): string {
  return output
    .filter((i): i is MessageItem => i.type === "message")
    .flatMap((m) => m.content)
    .map((c) => (c.type === "output_text" ? (c.text ?? "") : ""))
    .join("")
    .trim();
}

export async function runAgent(history: ChatMessage[], userMessage: string, deps: AgentDeps): Promise<AgentResult> {
  const limits = { ...DEFAULT_AGENT_LIMITS, ...deps.limits };
  const { logger: log } = deps;
  const input: LlmInputItem[] = [
    ...history,
    { role: "user", content: userMessage },
    ...(deps.turnNote ? [{ role: "developer" as const, content: deps.turnNote }] : []),
  ];
  let toolCalls = 0;
  let llmIterations = 0;

  const finish = (status: AgentStatus, answer: string): AgentResult => {
    const level = status === "completed" ? "info" : "warn";
    log[level]({ status, toolCalls, llmIterations }, "agent finished");
    return { status, answer, toolCalls, llmIterations };
  };

  /** Runs one tool call. Never throws: every failure becomes an error result the model can read. */
  const execute = async (call: FunctionCallItem): Promise<ToolResult> => {
    const started = Date.now();
    let result: ToolResult;
    let args: unknown;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      result = { ok: false, error: "Arguments were not valid JSON." };
    }
    deps.onEvent?.({ type: "tool_call", callId: call.call_id, name: call.name, args, attempt: toolCalls });
    result ??= await withTimeout(() => deps.executeTool(call.name, args), limits.toolTimeoutMs, `Tool ${call.name}`).catch(
      (err: unknown): ToolResult => {
        log.error({ err, tool: call.name }, "tool execution failed");
        return {
          ok: false,
          error: err instanceof TimeoutError ? err.message : `Tool ${call.name} failed unexpectedly.`,
        };
      },
    );
    const durationMs = Date.now() - started;
    log.info({ tool: call.name, ok: result.ok, durationMs, attempt: toolCalls }, "tool call");
    deps.onEvent?.({
      type: "tool_result",
      callId: call.call_id,
      name: call.name,
      ok: result.ok,
      ...(!result.ok && { error: result.error }),
      durationMs,
    });
    return result;
  };

  while (llmIterations < limits.maxLlmIterations) {
    llmIterations++;
    let output: LlmOutputItem[];
    try {
      ({ output } = await withTimeout(
        (signal) => deps.llm.respond({ instructions: deps.instructions, input, tools: deps.tools, signal }),
        limits.llmTimeoutMs,
        "LLM call",
      ));
    } catch (err) {
      log.error({ err, llmIterations }, "LLM call failed");
      return finish("llm_error", AGENT_MESSAGES.llmError);
    }

    const calls = output.filter(isFunctionCall);
    if (!calls.length) {
      const text = outputText(output);
      if (text) return finish("completed", text);
      log.warn({ llmIterations }, "LLM returned neither tool calls nor text");
      input.push(...output, { role: "user", content: AGENT_MESSAGES.nudge });
      continue;
    }

    input.push(...output);
    for (const call of calls) {
      if (toolCalls >= limits.maxToolCalls) {
        log.warn({ maxToolCalls: limits.maxToolCalls, requested: call.name }, "tool call limit reached");
        deps.onEvent?.({ type: "limit_reached", limit: "tool_calls" });
        return finish("tool_limit_reached", AGENT_MESSAGES.toolLimit(limits.maxToolCalls));
      }
      toolCalls++;
      const result = await execute(call);
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  log.warn({ maxLlmIterations: limits.maxLlmIterations }, "LLM iteration limit reached");
  deps.onEvent?.({ type: "limit_reached", limit: "llm_iterations" });
  return finish("iteration_limit_reached", AGENT_MESSAGES.iterationLimit);
}
