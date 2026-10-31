import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamChat, type ServerEvent } from "./api";
import { readAloudSupported, speak, stopSpeaking, useVoiceInput, voiceInputSupported } from "./speech";

const EXAMPLES = [
  "Which airports in New England are strong candidates for terminal expansion?",
  "Compare LA and Santa Ana airport congestion levels.",
  "What is the percentage of long haul flights out of Anchorage airport?",
  "What is the unmet flight demand in SFO airport and why?",
];

type Step = { id: string; label: string; state: "running" | "ok" | "error"; detail?: string };
type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; steps: Step[]; status?: string; pending: boolean; meta?: string };

const TOOL_LABELS: Record<string, (a: Record<string, unknown>) => string> = {
  resolve_airport: (a) => `Looking up airport “${a.query}”`,
  get_airport_profile: (a) => `Loading ${a.code} profile`,
  compare_airports: (a) => `Comparing ${(a.codes as string[] | undefined)?.join(", ")}`,
  rank_airports: (a) => `Ranking airports${a.region ? ` in ${a.region}` : " nationally"}${a.sortBy ? ` by ${a.sortBy}` : ""}`,
  get_long_haul_share: (a) => `Long-haul share for ${a.code}${a.thresholdMiles ? ` (${a.thresholdMiles}+ mi)` : ""}`,
  get_unmet_demand_signals: (a) => `Unmet-demand signals for ${a.code}`,
  get_live_airport_status: (a) => `Live FAA status for ${a.location}`,
  get_live_delays_nationwide: () => "Checking live FAA delays at all US airports",
  get_methodology: () => "Reading scoring methodology",
};
const toolLabel = (name: string, args: Record<string, unknown> = {}) => TOOL_LABELS[name]?.(args) ?? name;

const GUARDRAIL_LABELS: Record<string, string> = {
  in_scope: "In scope",
  out_of_scope: "Out of scope: not answered",
  needs_clarification: "Needs clarification",
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView, which React rejects as a cleanup.
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  /** Applies a change to the last (assistant) message. */
  const updateLast = (fn: (m: Extract<Message, { role: "assistant" }>) => Extract<Message, { role: "assistant" }>) =>
    setMessages((ms) => {
      const last = ms.at(-1);
      return last?.role === "assistant" ? [...ms.slice(0, -1), fn(last)] : ms;
    });

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      stopSpeaking();
      setInput("");
      setBusy(true);
      setMessages((ms) => [...ms, { role: "user", text: message }, { role: "assistant", text: "", steps: [], pending: true }]);
      abort.current = new AbortController();

      const onEvent = (e: ServerEvent) => {
        switch (e.event) {
          case "conversation":
            conversationId.current = e.data.conversationId;
            break;
          case "guardrail":
            updateLast((m) => ({
              ...m,
              steps: [
                ...m.steps,
                {
                  id: "guardrail",
                  label: `Scope check: ${GUARDRAIL_LABELS[e.data.verdict] ?? e.data.verdict}`,
                  state: e.data.verdict === "in_scope" ? "ok" : "error",
                  detail: e.data.containsUnrelatedRequest ? "unrelated part will be skipped" : undefined,
                },
              ],
            }));
            break;
          case "tool_call":
            updateLast((m) => ({
              ...m,
              steps: [...m.steps, { id: e.data.callId, label: toolLabel(e.data.name, e.data.args), state: "running" }],
            }));
            break;
          case "tool_result":
            updateLast((m) => ({
              ...m,
              steps: m.steps.map((s) =>
                s.id === e.data.callId
                  ? { ...s, state: e.data.ok ? "ok" : "error", detail: e.data.ok ? `${e.data.durationMs} ms` : e.data.error }
                  : s,
              ),
            }));
            break;
          case "limit_reached":
            updateLast((m) => ({
              ...m,
              steps: [...m.steps, { id: "limit", label: `Stopped: ${e.data.limit.replace("_", " ")} limit reached`, state: "error" }],
            }));
            break;
          case "answer":
            updateLast((m) => ({ ...m, text: e.data.text }));
            if (readAloud) speak(e.data.text);
            break;
          case "done":
            updateLast((m) => ({
              ...m,
              pending: false,
              status: e.data.status,
              meta: `${e.data.toolCalls} data lookup${e.data.toolCalls === 1 ? "" : "s"} · ${(e.data.durationMs / 1000).toFixed(1)} s`,
            }));
            break;
          case "error":
            updateLast((m) => ({ ...m, pending: false, status: "error", text: e.data.message }));
            break;
        }
      };

      try {
        await streamChat({ conversationId: conversationId.current, message }, onEvent, abort.current.signal);
      } catch (err) {
        if ((err as Error).name !== "AbortError")
          updateLast((m) => ({ ...m, pending: false, status: "error", text: `Could not reach the server: ${(err as Error).message}` }));
      } finally {
        updateLast((m) => (m.pending ? { ...m, pending: false } : m));
        setBusy(false);
      }
    },
    [busy, readAloud],
  );

  const voice = useVoiceInput(setInput, send);

  const newConversation = () => {
    abort.current?.abort();
    stopSpeaking();
    conversationId.current = undefined;
    setMessages([]);
    setInput("");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden>
            ✈
          </span>
          <div>
            <h1>Airport Investment Intelligence</h1>
            <p>Terminal expansion screening from public BTS &amp; FAA data · not investment advice</p>
          </div>
        </div>
        <div className="header-actions">
          {readAloudSupported && (
            <label className="toggle" title="Read answers aloud">
              <input
                type="checkbox"
                checked={readAloud}
                onChange={(e) => {
                  setReadAloud(e.target.checked);
                  if (!e.target.checked) stopSpeaking();
                }}
              />
              Read aloud
            </label>
          )}
          <button className="ghost" onClick={newConversation} disabled={!messages.length}>
            New chat
          </button>
        </div>
      </header>

      <main className="thread">
        {!messages.length && (
          <section className="empty">
            <h2>Ask about US airport traffic, congestion and expansion opportunities</h2>
            <p>
              Answers come from deterministic tools over BTS T-100, BTS On-Time and FAA data; the AI explains them. Follow-up
              questions keep the context.
            </p>
            <div className="examples">
              {EXAMPLES.map((q) => (
                <button key={q} className="example" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </section>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              {m.text}
            </div>
          ) : (
            <div key={i} className={`msg assistant ${m.status === "out_of_scope" || m.status === "error" ? "muted" : ""}`}>
              {m.steps.length > 0 && (
                <details className="steps" open={m.pending}>
                  <summary>{m.pending ? "Working…" : `How I got this (${m.steps.length} step${m.steps.length === 1 ? "" : "s"})`}</summary>
                  <ul>
                    {m.steps.map((s) => (
                      <li key={s.id} className={s.state}>
                        <span className="dot" aria-hidden />
                        {s.label}
                        {s.detail && <span className="detail"> · {s.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {m.text ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                </div>
              ) : (
                m.pending && <div className="typing" aria-label="Thinking"><span /><span /><span /></div>
              )}
              {!m.pending && (m.meta || m.text) && (
                <div className="meta">
                  {m.meta}
                  {readAloudSupported && m.text && (
                    <button className="link" onClick={() => speak(m.text)}>
                      🔊 Listen
                    </button>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          placeholder={voice.listening ? "Listening…" : "Ask about an airport, a region, or a comparison…"}
          rows={1}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {voiceInputSupported && (
          <button
            type="button"
            className={`icon ${voice.listening ? "recording" : ""}`}
            onClick={voice.listening ? voice.stop : voice.start}
            disabled={busy}
            title={voice.listening ? "Stop listening" : "Ask by voice"}
            aria-label={voice.listening ? "Stop listening" : "Ask by voice"}
          >
            🎤
          </button>
        )}
        <button type="submit" className="primary" disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </form>
      {voice.error && <div className="voice-error">{voice.error}</div>}
    </div>
  );
}
