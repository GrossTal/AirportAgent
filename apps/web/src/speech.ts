/** Voice input (Web Speech API) and read-aloud (speechSynthesis). Both are browser-only and optional. */
import { useCallback, useRef, useState } from "react";

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | undefined =
  typeof window !== "undefined"
    ? ((window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition)
    : undefined;

export const voiceInputSupported = Boolean(Ctor);
export const readAloudSupported = typeof window !== "undefined" && "speechSynthesis" in window;

/** Live transcription into `onText`; `onFinal` fires with the full text when the user stops talking. */
export function useVoiceInput(onText: (text: string) => void, onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const transcript = useRef("");

  const start = useCallback(() => {
    if (!Ctor) return;
    setError(null);
    transcript.current = "";
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      transcript.current = Array.from(e.results)
        .map((res) => res[0]?.transcript ?? "")
        .join("");
      onText(transcript.current);
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone permission was denied." : `Voice input error: ${e.error}`);
    r.onend = () => {
      setListening(false);
      if (transcript.current.trim()) onFinal(transcript.current.trim());
    };
    rec.current = r;
    r.start();
    setListening(true);
  }, [onText, onFinal]);

  const stop = useCallback(() => rec.current?.stop(), []);
  return { listening, error, start, stop };
}

/** Reads an answer aloud, skipping Markdown symbols. */
export function speak(markdown: string) {
  if (!readAloudSupported) return;
  window.speechSynthesis.cancel();
  const text = markdown
    .replace(/^\s*[-*]\s+/gm, "") // list bullets only: "-2.3%" must keep its sign
    .replace(/^\|?[\s:|-]+\|?$/gm, "") // table separator rows
    .replace(/\|/g, " ")
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}

export const stopSpeaking = () => readAloudSupported && window.speechSynthesis.cancel();
