import { describe, expect, it, vi } from "vitest";
import {
  AGENT_MESSAGES,
  runAgent,
  type AgentDeps,
  type AgentEvent,
  type LlmClient,
  type LlmInputItem,
  type LlmOutputItem,
} from "./agent-service.js";

let callSeq = 0;
const call = (name = "get_airport_profile", args: string = '{"code":"SFO"}'): LlmOutputItem => ({
  type: "function_call",
  call_id: `call_${++callSeq}`,
  name,
  arguments: args,
});
const message = (text: string): LlmOutputItem => ({ type: "message", content: [{ type: "output_text", text }] });

/** Fake LLM that replays scripted responses; once the script runs out it repeats the last one. */
function scriptedLlm(script: LlmOutputItem[][] | (() => LlmOutputItem[])) {
  const inputs: LlmInputItem[][] = [];
  let i = 0;
  const llm: LlmClient = {
    respond: vi.fn(async ({ input }) => {
      inputs.push([...input]);
      const output = typeof script === "function" ? script() : script[Math.min(i++, script.length - 1)]!;
      return { output };
    }),
  };
  return { llm, inputs };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function deps(llm: LlmClient, overrides: Partial<AgentDeps> = {}) {
  const events: AgentEvent[] = [];
  const d: AgentDeps = {
    llm,
    executeTool: vi.fn(async () => ({ ok: true as const, data: { value: 1 } })),
    tools: [],
    instructions: "test",
    logger: logger(),
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  return { d, events };
}

describe("runAgent", () => {
  it("completes a normal request within the limits", async () => {
    const { llm, inputs } = scriptedLlm([[call()], [message("SFO looks constrained.")]]);
    const { d, events } = deps(llm);
    const res = await runAgent([], "What about SFO?", d);

    expect(res).toEqual({ status: "completed", answer: "SFO looks constrained.", toolCalls: 1, llmIterations: 2 });
    expect(d.executeTool).toHaveBeenCalledWith("get_airport_profile", { code: "SFO" });
    // The second LLM call receives the tool output.
    expect(inputs[1]!.some((x) => "type" in x && x.type === "function_call_output")).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });

  it("stops when the maximum number of tool executions is reached", async () => {
    const { llm } = scriptedLlm(() => [call()]); // never answers, always asks for another tool
    const { d, events } = deps(llm, { limits: { maxToolCalls: 3, maxLlmIterations: 20 } });
    const res = await runAgent([], "loop", d);

    expect(res.status).toBe("tool_limit_reached");
    expect(res.toolCalls).toBe(3);
    expect(d.executeTool).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({ type: "limit_reached", limit: "tool_calls" });
  });

  it("defaults to 10 tool executions per request", async () => {
    const { llm } = scriptedLlm(() => [call()]);
    const { d } = deps(llm, { limits: { maxLlmIterations: 50 } });
    const res = await runAgent([], "loop", d);
    expect(res.status).toBe("tool_limit_reached");
    expect(d.executeTool).toHaveBeenCalledTimes(10);
  });

  it("counts failed tool calls toward the limit (tool errors, invalid JSON, throws, timeouts)", async () => {
    const { llm } = scriptedLlm([
      [call("get_airport_profile", "{not json")], // invalid JSON: never reaches the executor
      [call("unknown_tool")], // executor returns an error result
      [call("boom")], // executor throws
      [call("slow")], // executor times out
      [call()], // would be the 5th attempt
      [message("done")],
    ]);
    const executeTool = vi.fn(async (name: string) => {
      if (name === "boom") throw new Error("db down");
      if (name === "slow") return new Promise<never>(() => {});
      if (name === "unknown_tool") return { ok: false as const, error: 'Unknown tool "unknown_tool".' };
      return { ok: true as const, data: {} };
    });
    const { d, events } = deps(llm, { executeTool, limits: { maxToolCalls: 4, toolTimeoutMs: 20 } });
    const res = await runAgent([], "q", d);

    expect(res.status).toBe("tool_limit_reached");
    expect(res.toolCalls).toBe(4);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.ok)).toEqual([false, false, false, false]);
    expect(results.map((e) => (e.type === "tool_result" ? e.error : ""))).toEqual([
      "Arguments were not valid JSON.",
      'Unknown tool "unknown_tool".',
      "Tool boom failed unexpectedly.",
      "Tool slow timed out after 20ms",
    ]);
  });

  it("applies the limit across multiple LLM responses, including parallel calls in one response", async () => {
    const { llm } = scriptedLlm(() => [call(), call()]); // two tool calls per response
    const { d } = deps(llm, { limits: { maxToolCalls: 5, maxLlmIterations: 20 } });
    const res = await runAgent([], "q", d);

    expect(res.status).toBe("tool_limit_reached");
    expect(d.executeTool).toHaveBeenCalledTimes(5); // 2 + 2 + 1, the 6th is refused mid-response
    expect(res.llmIterations).toBe(3);
  });

  it("returns a graceful, explanatory answer instead of throwing when the limit is exceeded", async () => {
    const { llm } = scriptedLlm(() => [call()]);
    const { d } = deps(llm, { limits: { maxToolCalls: 2 } });
    const res = await runAgent([], "q", d);

    expect(res.answer).toBe(AGENT_MESSAGES.toolLimit(2));
    expect(res.answer).toMatch(/more than 2 data lookups/);
    expect(d.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ maxToolCalls: 2 }), "tool call limit reached");
  });

  it("stops responses with neither tool calls nor an answer at the LLM iteration limit", async () => {
    const { llm, inputs } = scriptedLlm(() => []);
    const { d, events } = deps(llm, { limits: { maxLlmIterations: 3 } });
    const res = await runAgent([], "q", d);

    expect(res).toMatchObject({ status: "iteration_limit_reached", llmIterations: 3, toolCalls: 0 });
    expect(res.answer).toBe(AGENT_MESSAGES.iterationLimit);
    expect(llm.respond).toHaveBeenCalledTimes(3);
    // After an empty response the model is nudged to answer.
    expect(inputs[1]!.at(-1)).toEqual({ role: "user", content: AGENT_MESSAGES.nudge });
    expect(events.at(-1)).toEqual({ type: "limit_reached", limit: "llm_iterations" });
  });

  it("recovers after an empty response if the model then answers", async () => {
    const { llm } = scriptedLlm([[], [message("Here is the answer.")]]);
    const res = await runAgent([], "q", deps(llm).d);
    expect(res).toMatchObject({ status: "completed", answer: "Here is the answer.", llmIterations: 2 });
  });

  it("returns a graceful error when the LLM fails or times out", async () => {
    const failing: LlmClient = { respond: vi.fn(async () => Promise.reject(new Error("503"))) };
    expect(await runAgent([], "q", deps(failing).d)).toMatchObject({ status: "llm_error", answer: AGENT_MESSAGES.llmError });

    const hanging: LlmClient = { respond: vi.fn(() => new Promise<never>(() => {})) };
    const { d } = deps(hanging, { limits: { llmTimeoutMs: 20 } });
    expect(await runAgent([], "q", d)).toMatchObject({ status: "llm_error" });
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("passes conversation history to the LLM for follow-up questions", async () => {
    const { llm, inputs } = scriptedLlm([[message("ok")]]);
    await runAgent(
      [
        { role: "user", content: "Tell me about SFO" },
        { role: "assistant", content: "SFO is..." },
      ],
      "and its growth?",
      deps(llm).d,
    );
    expect(inputs[0]).toEqual([
      { role: "user", content: "Tell me about SFO" },
      { role: "assistant", content: "SFO is..." },
      { role: "user", content: "and its growth?" },
    ]);
  });
});
