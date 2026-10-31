/**
 * One chat turn: scope guardrail first, then the agent. Out-of-scope, clarification and
 * guardrail-unavailable outcomes return a fixed message and never reach the agent or its tools.
 */
import { runAgent, type AgentDeps, type AgentEvent, type AgentResult, type ChatMessage } from "./agent-service.js";
import { GUARDRAIL_MESSAGES, checkScope, type GuardrailDecision, type GuardrailDeps } from "./guardrail.js";

export type ChatEvent =
  | AgentEvent
  | {
      type: "guardrail";
      verdict: GuardrailDecision["verdict"];
      category: GuardrailDecision["category"];
      containsUnrelatedRequest: boolean;
    };

export type ChatStatus = AgentResult["status"] | "out_of_scope" | "needs_clarification" | "guardrail_unavailable";

export type ChatResult = {
  status: ChatStatus;
  answer: string;
  toolCalls: number;
  llmIterations: number;
};

export type ChatDeps = {
  guardrail: GuardrailDeps;
  agent: Omit<AgentDeps, "onEvent">;
  onEvent?: (event: ChatEvent) => void;
};

export async function respondToUser(history: ChatMessage[], message: string, deps: ChatDeps): Promise<ChatResult> {
  const decision = await checkScope(message, history, deps.guardrail);
  // Verdict and category only; nothing the classifier produced reaches the user as text.
  deps.onEvent?.({
    type: "guardrail",
    verdict: decision.verdict,
    category: decision.category,
    containsUnrelatedRequest: decision.contains_unrelated_request,
  });

  const fixed = (status: ChatStatus, answer: string): ChatResult => ({ status, answer, toolCalls: 0, llmIterations: 0 });
  if (decision.source === "fallback") return fixed("guardrail_unavailable", GUARDRAIL_MESSAGES.unavailable);
  if (decision.verdict === "out_of_scope") return fixed("out_of_scope", GUARDRAIL_MESSAGES.outOfScope);
  if (decision.verdict === "needs_clarification") return fixed("needs_clarification", GUARDRAIL_MESSAGES.clarification);

  return runAgent(history, message, {
    ...deps.agent,
    ...(decision.contains_unrelated_request && { turnNote: GUARDRAIL_MESSAGES.unrelatedPartNote }),
    onEvent: deps.onEvent,
  });
}
