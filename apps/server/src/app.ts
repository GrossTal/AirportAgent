import cors from "@fastify/cors";
import Fastify, { type FastifyBaseLogger, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { ChatMessage } from "./agent/agent-service.js";
import type { ChatEvent, ChatResult } from "./agent/chat-service.js";
import { ConversationStore } from "./chat/conversation-store.js";

/** One chat turn (guardrail + agent); injected so the HTTP layer can be tested without OpenAI or a database. */
export type RespondFn = (
  history: ChatMessage[],
  message: string,
  onEvent: (e: ChatEvent) => void,
  logger: FastifyBaseLogger,
) => Promise<ChatResult>;

const ChatBody = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
});

export function buildApp(deps: { respond: RespondFn; store?: ConversationStore }, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);
  const store = deps.store ?? new ConversationStore();

  app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  /**
   * POST /chat -> text/event-stream
   * Events: conversation, guardrail, tool_call, tool_result, limit_reached, answer, done, error.
   * Every request ends with exactly one `done` (or `error`) event.
   */
  app.post("/chat", async (request, reply) => {
    const body = ChatBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: z.prettifyError(body.error) });

    const { id, history } = store.open(body.data.conversationId);
    if (!store.tryLock(id)) return reply.code(409).send({ error: "This conversation is already answering a message." });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Watch the response, not the request: the request's "close" fires once its body has been read.
    let open = true;
    reply.raw.on("close", () => (open = false));
    const send = (event: string, data: unknown) => {
      if (open) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const started = Date.now();
    send("conversation", { conversationId: id });
    try {
      const result = await deps.respond(history, body.data.message, (e) => send(e.type, e), request.log);
      // Failed turns stay out of the history so a retry starts clean.
      if (result.status !== "llm_error" && result.status !== "guardrail_unavailable")
        store.append(id, { role: "user", content: body.data.message }, { role: "assistant", content: result.answer });
      send("answer", { text: result.answer });
      send("done", { status: result.status, toolCalls: result.toolCalls, llmIterations: result.llmIterations, durationMs: Date.now() - started });
    } catch (err) {
      request.log.error({ err }, "chat request failed");
      send("error", { message: "Something went wrong while answering. Please try again." });
    } finally {
      store.unlock(id);
      reply.raw.end();
    }
  });

  return app;
}
