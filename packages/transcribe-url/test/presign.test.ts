import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyOverrides, defaultSettings } from "../src/config.js";
import { handler } from "../src/handler.js";
import { presignTranscribeUrl, streamQuery, type StreamSettings } from "../src/presign.js";

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const now = new Date("2026-10-16T08:30:00Z");
const single: StreamSettings = { mode: "single", languageCode: "en-IN", languageOptions: ["en-IN", "hi-IN"], vocabularies: ["alexa_chess_vocabulary"], stability: "high", sampleRate: 16000 };

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

/** Independent implementation of the signing steps in the Transcribe docs ("Setting up a WebSocket stream"). */
function reference(c: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }, region: string, query: Record<string, string>, date: Date, expires: number) {
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const stamp = amzDate.slice(0, 8);
  const scope = `${stamp}/${region}/transcribe/aws4_request`;
  const host = `transcribestreaming.${region}.amazonaws.com:8443`;
  const q: Record<string, string> = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  if (c.sessionToken) q["X-Amz-Security-Token"] = c.sessionToken;
  const canonicalQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonicalRequest = ["GET", "/stream-transcription-websocket", canonicalQuery, `host:${host}\n`, "host", createHash("sha256").update("").digest("hex")].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + c.secretAccessKey, stamp), region), "transcribe"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `wss://${host}/stream-transcription-websocket?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Same URL regardless of where X-Amz-Signature sits in the query. */
const parts = (u: string) => { const x = new URL(u.replace("wss:", "https:")); return { host: x.host, path: x.pathname, q: Object.fromEntries(x.searchParams) }; };

describe("presignTranscribeUrl", () => {
  it("matches an independent implementation of the documented signing steps", async () => {
    const url = await presignTranscribeUrl({ credentials: creds, region: "ap-south-1", settings: single, now });
    expect(parts(url)).toEqual(parts(reference(creds, "ap-south-1", streamQuery(single), now, 300)));
  });

  it("includes the session token when the credentials have one (Lambda role)", async () => {
    const withToken = { ...creds, sessionToken: "IQoJb3JpZ2luX2Vj/+token=" };
    const url = await presignTranscribeUrl({ credentials: withToken, region: "ap-south-1", settings: single, now });
    expect(url).toContain("X-Amz-Security-Token=IQoJb3JpZ2luX2Vj%2F%2Btoken%3D");
    expect(parts(url)).toEqual(parts(reference(withToken, "ap-south-1", streamQuery(single), now, 300)));
  });

  it("multi-language mode signs identify-multiple-languages and vocabulary-names", async () => {
    const multi: StreamSettings = { ...single, mode: "multi", vocabularies: ["alexa_chess_vocabulary", "alexa_chess_vocabulary_hi"] };
    const url = await presignTranscribeUrl({ credentials: creds, region: "ap-south-1", settings: multi, now });
    expect(url).toContain("identify-multiple-languages=true");
    expect(url).toContain("language-options=en-IN%2Chi-IN");
    expect(url).toContain("vocabulary-names=alexa_chess_vocabulary%2Calexa_chess_vocabulary_hi");
    expect(url).not.toContain("language-code=");
    expect(parts(url)).toEqual(parts(reference(creds, "ap-south-1", streamQuery(multi), now, 300)));
  });

  it("never signs more than 300 seconds and defaults to 300", async () => {
    const long = await presignTranscribeUrl({ credentials: creds, region: "ap-south-1", settings: single, now, expiresIn: 3600 });
    expect(long).toContain("X-Amz-Expires=300");
    const short = await presignTranscribeUrl({ credentials: creds, region: "ap-south-1", settings: single, now, expiresIn: 60 });
    expect(short).toContain("X-Amz-Expires=60");
  });

  it("stability off omits the stabilization parameters", () => {
    expect(streamQuery({ ...single, stability: "off" })).not.toHaveProperty("enable-partial-results-stabilization");
    expect(streamQuery(single)).toMatchObject({ "enable-partial-results-stabilization": "true", "partial-results-stability": "high", "language-code": "en-IN", "vocabulary-name": "alexa_chess_vocabulary", "media-encoding": "pcm", "sample-rate": "16000" });
  });
});

describe("config", () => {
  it("defaults to single en-IN with the chess vocabulary and high stability", () => {
    expect(defaultSettings({})).toMatchObject({ mode: "single", languageCode: "en-IN", vocabularies: ["alexa_chess_vocabulary"], stability: "high", sampleRate: 16000 });
  });
  it("reads the environment and ignores junk", () => {
    expect(defaultSettings({ LANGUAGE_MODE: "multi", STABILITY: "bogus", VOCABULARY_NAMES: "a, b" })).toMatchObject({ mode: "multi", stability: "high", vocabularies: ["a", "b"] });
  });
  it("applies only whitelisted overrides", () => {
    const base = defaultSettings({});
    expect(applyOverrides(base, { mode: "multi", stability: "low", languageCode: "xx-XX", sampleRate: 1 })).toMatchObject({ mode: "multi", stability: "low", languageCode: "en-IN", sampleRate: 16000 });
    expect(applyOverrides(base, { mode: "evil", stability: 5 })).toEqual(base);
    expect(applyOverrides(base, { vocabulary: false }).vocabularies).toEqual([]);
    expect(applyOverrides(base, { languageCode: "en-US" })).toMatchObject({ languageCode: "en-US", vocabularies: [] });
    expect(applyOverrides(base, { languageCode: "en-IN" }).vocabularies).toEqual(["alexa_chess_vocabulary"]);
  });
});

describe("handler", () => {
  const ev = (body: unknown, headers: Record<string, string> = {}) => ({ headers, body: typeof body === "string" ? body : JSON.stringify(body), isBase64Encoded: false, requestContext: { http: { method: "POST", sourceIp: "1.2.3.4" } } }) as any;
  const deps = { credentials: () => ({ ...creds, sessionToken: "tok" }), now: () => now };

  it("returns a presigned url for a request with a sessionId", async () => {
    const res = await handler(ev({ sessionId: "abcdefgh-1234" }), deps);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.url).toMatch(/^wss:\/\/transcribestreaming\.ap-south-1\.amazonaws\.com:8443\/stream-transcription-websocket\?/);
    expect(body).toMatchObject({ expiresIn: 300, mode: "single", sampleRate: 16000 });
  });

  it("rejects a missing, short or non-string sessionId and bad JSON", async () => {
    for (const body of [{}, { sessionId: "x" }, { sessionId: 12345678 }, "not json"]) {
      const res = await handler(ev(body), deps);
      expect(res.statusCode).toBe(400);
    }
  });

  it("passes whitelisted overrides through", async () => {
    const res = await handler(ev({ sessionId: "abcdefgh-1234", mode: "multi", stability: "off" }), deps);
    const body = JSON.parse(res.body as string);
    expect(body).toMatchObject({ mode: "multi", stability: "off" });
    expect(body.url).toContain("identify-multiple-languages=true");
    expect(body.url).not.toContain("partial-results-stability");
  });
});
