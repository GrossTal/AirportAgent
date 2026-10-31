/** Client for POST /api/chat, which answers with a server-sent event stream. */

export type ServerEvent =
  | { event: "conversation"; data: { conversationId: string } }
  | { event: "guardrail"; data: { verdict: "in_scope" | "out_of_scope" | "needs_clarification"; category: string; containsUnrelatedRequest: boolean } }
  | { event: "tool_call"; data: { callId: string; name: string; args: Record<string, unknown> | undefined; attempt: number } }
  | { event: "tool_result"; data: { callId: string; name: string; ok: boolean; error?: string; durationMs: number } }
  | { event: "limit_reached"; data: { limit: "tool_calls" | "llm_iterations" } }
  | { event: "answer"; data: { text: string } }
  | { event: "done"; data: { status: string; toolCalls: number; llmIterations: number; durationMs: number } }
  | { event: "error"; data: { message: string } };

export async function streamChat(
  body: { conversationId?: string; message: string },
  onEvent: (e: ServerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Request failed (${res.status})`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) onEvent({ event, data: JSON.parse(data) } as ServerEvent);
    }
  }
}
