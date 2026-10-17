import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Transcribe streaming settings the page may ask for; everything else is fixed by config.ts. */
export interface StreamSettings {
  /** "single": one language (language-code); "multi": identify-multiple-languages over languageOptions. */
  mode: "single" | "multi";
  languageCode: string;
  languageOptions: string[];
  /** Custom vocabulary names. Single mode uses the first; multi mode sends them all (one per language). */
  vocabularies: string[];
  /** Partial-results stabilization level, or "off". */
  stability: "high" | "medium" | "low" | "off";
  sampleRate: number;
  /** "spoken" returns numbers as words ("d four") instead of digits ("24"); the chess matcher prefers that. */
  transcriptFormat?: "spoken" | "written";
}

export const MAX_EXPIRES_SECONDS = 300; // the documented maximum for a Transcribe WebSocket URL

/** The query parameters Transcribe sees (before signing), in a stable order. */
export function streamQuery(s: StreamSettings): Record<string, string> {
  const q: Record<string, string> = { "media-encoding": "pcm", "sample-rate": String(s.sampleRate) };
  if (s.mode === "multi") {
    q["identify-multiple-languages"] = "true";
    q["language-options"] = s.languageOptions.join(",");
    if (s.vocabularies.length) q["vocabulary-names"] = s.vocabularies.join(",");
  } else {
    q["language-code"] = s.languageCode;
    if (s.vocabularies.length) q["vocabulary-name"] = s.vocabularies[0];
  }
  if (s.transcriptFormat) q["transcript-format"] = s.transcriptFormat;
  if (s.stability !== "off") {
    q["enable-partial-results-stabilization"] = "true";
    q["partial-results-stability"] = s.stability;
  }
  return q;
}

/**
 * A SigV4-presigned wss URL for Amazon Transcribe's StartStreamTranscriptionWebSocket.
 * Only the handshake is time-limited: a connection opened with the URL keeps streaming after it expires.
 */
export async function presignTranscribeUrl(opts: {
  credentials: Credentials;
  region: string;
  settings: StreamSettings;
  expiresIn?: number;
  now?: Date;
}): Promise<string> {
  const expiresIn = Math.min(opts.expiresIn ?? MAX_EXPIRES_SECONDS, MAX_EXPIRES_SECONDS);
  const hostname = `transcribestreaming.${opts.region}.amazonaws.com`;
  const signer = new SignatureV4({
    service: "transcribe",
    region: opts.region,
    credentials: opts.credentials,
    sha256: Sha256,
    uriEscapePath: true,
  });
  const request = new HttpRequest({
    protocol: "wss:",
    method: "GET",
    hostname,
    port: 8443,
    path: "/stream-transcription-websocket",
    query: streamQuery(opts.settings),
    headers: { host: `${hostname}:8443` },
  });
  const signed = await signer.presign(request, { expiresIn, signingDate: opts.now });
  const query = Object.entries(signed.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    .join("&");
  return `wss://${hostname}:8443${signed.path}?${query}`;
}
