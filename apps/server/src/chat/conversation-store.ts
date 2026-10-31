import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../agent/agent-service.js";

/**
 * In-memory conversation history (no extra infrastructure; resets on restart). History lives on the
 * server so clients can't inject fabricated assistant turns. Bounded in size and age.
 */
export class ConversationStore {
  private conversations = new Map<string, { messages: ChatMessage[]; touched: number; busy: boolean }>();

  constructor(
    private readonly opts = { maxConversations: 500, maxMessages: 20, ttlMs: 2 * 60 * 60 * 1000 },
  ) {}

  /** Returns the conversation, creating it if the id is unknown or expired. */
  open(id?: string): { id: string; history: ChatMessage[] } {
    this.evict();
    const existing = id ? this.conversations.get(id) : undefined;
    if (id && existing) {
      existing.touched = Date.now();
      return { id, history: [...existing.messages] };
    }
    const newId = randomUUID();
    this.conversations.set(newId, { messages: [], touched: Date.now(), busy: false });
    return { id: newId, history: [] };
  }

  /** One request at a time per conversation, so turns can't interleave. */
  tryLock(id: string): boolean {
    const c = this.conversations.get(id);
    if (!c || c.busy) return false;
    c.busy = true;
    return true;
  }

  unlock(id: string) {
    const c = this.conversations.get(id);
    if (c) c.busy = false;
  }

  append(id: string, ...messages: ChatMessage[]) {
    const c = this.conversations.get(id);
    if (!c) return;
    c.messages.push(...messages);
    c.messages.splice(0, Math.max(0, c.messages.length - this.opts.maxMessages));
    c.touched = Date.now();
  }

  private evict() {
    const now = Date.now();
    for (const [id, c] of this.conversations) if (!c.busy && now - c.touched > this.opts.ttlMs) this.conversations.delete(id);
    while (this.conversations.size >= this.opts.maxConversations) {
      const oldest = [...this.conversations].filter(([, c]) => !c.busy).sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest) break;
      this.conversations.delete(oldest[0]);
    }
  }
}
