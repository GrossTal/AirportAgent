import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmInputItem } from "./agent/agent-service.js";
import { respondToUser } from "./agent/chat-service.js";
import { GUARDRAIL_MESSAGES, type ScopeVerdict } from "./agent/guardrail.js";
import { buildApp, type RespondFn } from "./app.js";

/** Parses an SSE body into [event, data] pairs. */
const parseSse = (body: string) =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
      return { event, data };
    });

/** Real chat pipeline with a mocked classifier, a scripted agent LLM, and a spy tool executor. */
function pipeline(v: ScopeVerdict) {
  const executeTool = vi.fn(async () => ({ ok: true as const, data: { rank: 1 } }));
  const llm: LlmClient = {
    respond: vi.fn(async ({ input }) => ({
      output: input.some((i: LlmInputItem) => "type" in i && i.type === "function_call_output")
        ? [{ type: "message", content: [{ type: "output_text", text: "BOS ranks first." }] }]
        : [{ type: "function_call", call_id: "c1", name: "rank_airports", arguments: '{"region":"New England"}' }],
    })),
  };
  const respond: RespondFn = (history, message, onEvent, logger) =>
    respondToUser(history, message, {
      guardrail: { classifier: { classify: async () => v }, timeoutMs: 1_000, logger },
      agent: { llm, executeTool, tools: [], instructions: "x", logger },
      onEvent,
    });
  return { respond, executeTool, llm };
}

const inScope: ScopeVerdict = { verdict: "in_scope", category: "airport_analytics", contains_unrelated_request: false };
const outOfScope: ScopeVerdict = { verdict: "out_of_scope", category: "off_topic", contains_unrelated_request: false };

describe("POST /chat (SSE)", () => {
  it("streams guardrail, tool steps, the answer, and done for an in-scope question", async () => {
    const { respond } = pipeline(inScope);
    const res = await buildApp({ respond }).inject({ method: "POST", url: "/chat", payload: { message: "Rank New England" } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(["conversation", "guardrail", "tool_call", "tool_result", "answer", "done"]);
    expect(events[2]!.data).toMatchObject({ name: "rank_airports", args: { region: "New England" } });
    expect(events[4]!.data).toEqual({ text: "BOS ranks first." });
    expect(events[5]!.data).toMatchObject({ status: "completed", toolCalls: 1 });
  });

  it("delivers every event over a real HTTP connection (not just inject)", async () => {
    const { respond } = pipeline(inScope);
    const app = buildApp({ respond });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Rank New England" }),
      });
      const events = parseSse(await res.text()).map((e) => e.event);
      expect(events).toEqual(["conversation", "guardrail", "tool_call", "tool_result", "answer", "done"]);
    } finally {
      await app.close();
    }
  });

  it("out of scope: fixed refusal, normal completion, no agent or tool calls", async () => {
    const { respond, executeTool, llm } = pipeline(outOfScope);
    const res = await buildApp({ respond }).inject({ method: "POST", url: "/chat", payload: { message: "Cake recipe please" } });

    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(["conversation", "guardrail", "answer", "done"]);
    expect(events[2]!.data).toEqual({ text: GUARDRAIL_MESSAGES.outOfScope });
    expect(events[3]!.data).toMatchObject({ status: "out_of_scope", toolCalls: 0 });
    expect(llm.respond).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("keeps conversation history on the server for follow-ups", async () => {
    const seen: number[] = [];
    const respond: RespondFn = async (history) => {
      seen.push(history.length);
      return { status: "completed", answer: "ok", toolCalls: 0, llmIterations: 1 };
    };
    const app = buildApp({ respond });
    const first = parseSse((await app.inject({ method: "POST", url: "/chat", payload: { message: "Rank New England" } })).body);
    const conversationId = first[0]!.data.conversationId;
    await app.inject({ method: "POST", url: "/chat", payload: { conversationId, message: "What about California?" } });
    await app.inject({ method: "POST", url: "/chat", payload: { message: "new chat" } });

    expect(seen).toEqual([0, 2, 0]);
  });

  it("does not keep failed turns in the history", async () => {
    const seen: number[] = [];
    const respond: RespondFn = async (history) => {
      seen.push(history.length);
      return { status: "guardrail_unavailable", answer: GUARDRAIL_MESSAGES.unavailable, toolCalls: 0, llmIterations: 0 };
    };
    const app = buildApp({ respond });
    const conversationId = parseSse((await app.inject({ method: "POST", url: "/chat", payload: { message: "a" } })).body)[0]!.data
      .conversationId;
    await app.inject({ method: "POST", url: "/chat", payload: { conversationId, message: "b" } });
    expect(seen).toEqual([0, 0]);
  });

  it("ends with an error event instead of crashing when the pipeline throws", async () => {
    const res = await buildApp({ respond: async () => Promise.reject(new Error("boom")) }).inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi there" },
    });
    const events = parseSse(res.body);
    expect(events.at(-1)).toEqual({ event: "error", data: { message: expect.stringMatching(/try again/) } });
    expect(res.body).not.toContain("boom");
  });

  it.each([{}, { message: "" }, { message: "   " }, { message: "x".repeat(2001) }, { message: "ok", conversationId: "nope" }])(
    "rejects invalid bodies with 400: %j",
    async (payload) => {
      const res = await buildApp({ respond: vi.fn() }).inject({ method: "POST", url: "/chat", payload });
      expect(res.statusCode).toBe(400);
    },
  );
});
