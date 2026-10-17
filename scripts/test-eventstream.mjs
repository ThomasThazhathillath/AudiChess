// Tests for web/eventstream.js (AWS event-stream codec used for Amazon Transcribe streaming).
// Run: node scripts/test-eventstream.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

new Function(readFileSync(new URL("../web/eventstream.js", import.meta.url), "utf8"))();
const ES = globalThis.AlexaEventStream;
const enc = new TextEncoder();
const dec = (b) => new TextDecoder().decode(b);
let n = 0;
const ok = (name, fn) => { fn(); n++; };

ok("crc32 standard check value", () => assert.equal(ES.crc32(enc.encode("123456789")), 0xcbf43926));
ok("crc32 empty", () => assert.equal(ES.crc32(new Uint8Array(0)), 0));

ok("audio event round trip", () => {
  const pcm = Uint8Array.from({ length: 3200 }, (_, i) => (i * 7) & 255);
  const msg = ES.decodeMessage(ES.encodeAudioEvent(pcm));
  assert.equal(msg.headers[":event-type"], "AudioEvent");
  assert.equal(msg.headers[":message-type"], "event");
  assert.equal(msg.headers[":content-type"], "application/octet-stream");
  assert.deepEqual(Array.from(msg.payload), Array.from(pcm));
});

ok("empty audio event (end of stream) is valid", () => {
  const raw = ES.encodeAudioEvent(new Uint8Array(0));
  assert.equal(ES.decodeMessage(raw).payload.length, 0);
  assert.equal(raw.length, 12 + (1 + 13 + 1 + 2 + 24) + (1 + 11 + 1 + 2 + 10) + (1 + 13 + 1 + 2 + 5) + 4);
});

ok("a real AWS response frame (from the Transcribe docs) decodes with valid CRCs", () => {
  const b64 = "AAAAUwAAAEP1RHpYBTpkYXRlCAAAAWiXUkMLEDpjaHVuay1zaWduYXR1cmUGACCt6Zy+uymwEK2SrLp/zVBI5eGn83jdBwCaRUBJA+eaDafqjqI=";
  const msg = ES.decodeMessage(Buffer.from(b64, "base64"));
  assert.equal(typeof msg.headers[":date"], "number");
  assert.equal(msg.headers[":chunk-signature"].length, 32);
  assert.equal(msg.payload.length, 0x53 - 12 - 0x43 - 4);
});

ok("corrupt bytes are rejected", () => {
  const raw = ES.encodeAudioEvent(enc.encode("hello"));
  const a = raw.slice(); a[a.length - 6] ^= 1;
  assert.throws(() => ES.decodeMessage(a), /message CRC/);
  const b = raw.slice(); b[5] ^= 1;
  assert.throws(() => ES.decodeMessage(b), /prelude CRC/);
  assert.throws(() => ES.decodeMessage(raw.subarray(0, raw.length - 1)), /length mismatch/);
});

ok("decoder reassembles split and merged chunks", () => {
  const frames = [1, 2, 3].map((k) => ES.encodeAudioEvent(Uint8Array.from({ length: 50 * k }, () => k)));
  const all = new Uint8Array(frames.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  for (const step of [1, 7, 64, all.length]) {
    const d = new ES.Decoder();
    const got = [];
    for (let i = 0; i < all.length; i += step) got.push(...d.push(all.subarray(i, i + step)));
    assert.equal(got.length, 3, `step ${step}`);
    assert.deepEqual(got.map((m) => m.payload.length), [50, 100, 150]);
  }
});

ok("all header value types parse", () => {
  // Hand-built message exercising each header type.
  const parts = [];
  const h = (name, type, valueBytes) => parts.push(Uint8Array.from([name.length, ...enc.encode(name), type, ...valueBytes]));
  h("t", 0, []); h("f", 1, []); h("b", 2, [0xfe]); h("s", 3, [0xff, 0xfe]); h("i", 4, [0, 0, 1, 0]);
  h("l", 5, [0, 0, 0, 0, 0, 0, 1, 0]); h("y", 6, [0, 2, 9, 8]); h("x", 7, [0, 2, 104, 105]);
  h("d", 8, [0, 0, 0, 0, 0, 0, 3, 232]); h("u", 9, Array.from({ length: 16 }, (_, i) => i));
  const headers = Uint8Array.from(parts.flatMap((p) => Array.from(p)));
  const payload = enc.encode("ok");
  const total = 12 + headers.length + payload.length + 4;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, total); dv.setUint32(4, headers.length); dv.setUint32(8, ES.crc32(out, 0, 8));
  out.set(headers, 12); out.set(payload, 12 + headers.length);
  dv.setUint32(total - 4, ES.crc32(out, 0, total - 4));
  const m = ES.decodeMessage(out);
  assert.equal(m.headers.t, true); assert.equal(m.headers.f, false); assert.equal(m.headers.b, -2);
  assert.equal(m.headers.s, -2); assert.equal(m.headers.i, 256); assert.equal(m.headers.l, 256n);
  assert.deepEqual(Array.from(m.headers.y), [9, 8]); assert.equal(m.headers.x, "hi");
  assert.equal(m.headers.d, 1000); assert.equal(m.headers.u, "000102030405060708090a0b0c0d0e0f");
  assert.equal(dec(m.payload), "ok");
});

const transcriptFrame = (obj, type = "TranscriptEvent") =>
  ES.decodeMessage(ES.encodeMessage({ ":content-type": "application/json", ":event-type": type, ":message-type": "event" }, enc.encode(JSON.stringify(obj))));

ok("parseTranscript: partial and final results", () => {
  const p = ES.parseTranscript(transcriptFrame({ Transcript: { Results: [{ ResultId: "r1", IsPartial: true, StartTime: 0.5, EndTime: 1.2, Alternatives: [{ Transcript: "alexa knight", Items: [{ Content: "alexa", Type: "pronunciation", Stable: true }] }] }] } }));
  assert.equal(p.kind, "results");
  assert.equal(p.results[0].isPartial, true);
  assert.equal(p.results[0].text, "alexa knight");
  assert.equal(p.results[0].alternatives[0].items[0].stable, true);
  const f = ES.parseTranscript(transcriptFrame({ Transcript: { Results: [{ ResultId: "r1", IsPartial: false, LanguageCode: "en-IN", Alternatives: [{ Transcript: " Alexa, knight to f3. ", Items: [{ Content: "Alexa", Confidence: 0.99 }] }] }] } }));
  assert.equal(f.results[0].isPartial, false);
  assert.equal(f.results[0].text, "Alexa, knight to f3.");
  assert.equal(f.results[0].languageCode, "en-IN");
  assert.equal(f.results[0].alternatives[0].items[0].confidence, 0.99);
});

ok("parseTranscript: empty results list and unrelated events", () => {
  assert.deepEqual(ES.parseTranscript(transcriptFrame({ Transcript: { Results: [] } })), { kind: "results", results: [] });
  assert.equal(ES.parseTranscript(transcriptFrame({}, "SomethingElse")).kind, "other");
});

ok("parseTranscript: exceptions", () => {
  const m = ES.decodeMessage(ES.encodeMessage({ ":content-type": "application/json", ":exception-type": "BadRequestException", ":message-type": "exception" }, enc.encode(JSON.stringify({ Message: "Your request is not valid" }))));
  assert.deepEqual(ES.parseTranscript(m), { kind: "exception", type: "BadRequestException", message: "Your request is not valid" });
  const raw = ES.decodeMessage(ES.encodeMessage({ ":exception-type": "LimitExceededException", ":message-type": "exception" }, enc.encode("slow down")));
  assert.equal(ES.parseTranscript(raw).message, "slow down");
});

ok("floatToPcm16", () => {
  const b = ES.floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  const dv = new DataView(b.buffer);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => dv.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768, 16383]);
});

ok("buildAlternatives: final first, newest differing partials after, deduped", () => {
  assert.deepEqual(
    ES.buildAlternatives("Alexa, knight to f3.", ["alexa", "alexa night", "alexa night to f3", "Alexa, knight to f3"]),
    ["Alexa, knight to f3.", "alexa night to f3", "alexa night"],
  );
  // Partials that are just the start of the final are dropped (seen live: "Alexa, let'" and "2" for "24").
  assert.deepEqual(ES.buildAlternatives("Alexa, let's play chess.", ["Alexa", "Alexa, let'", "Alexa, let's play"]), ["Alexa, let's play chess."]);
  assert.deepEqual(ES.buildAlternatives("24", ["2"]), ["24"]);
  assert.deepEqual(ES.buildAlternatives("", []), []);
  assert.equal(ES.buildAlternatives("a", ["b", "c", "d", "e", "f", "g"]).length, 5);
});

console.log(`eventstream: ${n} checks passed`);
