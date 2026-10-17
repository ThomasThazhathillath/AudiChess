import type { StreamSettings } from "./presign.js";

const STABILITY = ["high", "medium", "low", "off"] as const;
const LANGUAGES = ["en-IN", "en-US", "en-GB", "hi-IN"];

/** Defaults from the environment (template.yaml); the page may switch mode/stability per request for A/B tests. */
export function defaultSettings(env: Record<string, string | undefined> = process.env): StreamSettings {
  const stability = env.STABILITY as StreamSettings["stability"];
  return {
    mode: env.LANGUAGE_MODE === "multi" ? "multi" : "single",
    languageCode: env.LANGUAGE_CODE || "en-IN",
    languageOptions: (env.LANGUAGE_OPTIONS || "en-IN,hi-IN").split(",").map((s) => s.trim()).filter(Boolean),
    vocabularies: (env.VOCABULARY_NAMES ?? "alexa_chess_vocabulary").split(",").map((s) => s.trim()).filter(Boolean),
    stability: (STABILITY as readonly string[]).includes(stability) ? stability : "high",
    sampleRate: 16000,
    ...(env.TRANSCRIPT_FORMAT === "spoken" || env.TRANSCRIPT_FORMAT === "written" ? { transcriptFormat: env.TRANSCRIPT_FORMAT } : {}),
  };
}

/** Apply the whitelisted overrides a request may carry. Unknown or malformed values are ignored. */
export function applyOverrides(base: StreamSettings, body: Record<string, unknown>): StreamSettings {
  const s = { ...base };
  if (body.mode === "single" || body.mode === "multi") s.mode = body.mode;
  if (typeof body.stability === "string" && (STABILITY as readonly string[]).includes(body.stability)) {
    s.stability = body.stability as StreamSettings["stability"];
  }
  if (body.vocabulary === false) s.vocabularies = [];
  // Other English accents for A/B tests. The chess vocabulary is en-IN, and a vocabulary must match the stream's language.
  if (typeof body.languageCode === "string" && LANGUAGES.includes(body.languageCode) && body.languageCode !== s.languageCode) {
    s.languageCode = body.languageCode;
    if (s.mode === "single") s.vocabularies = [];
  }
  if (body.transcriptFormat === "spoken" || body.transcriptFormat === "written") s.transcriptFormat = body.transcriptFormat;
  return s;
}
