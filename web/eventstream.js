// AWS event-stream codec for Amazon Transcribe streaming over WebSocket. Pure logic, no DOM, so the same file runs
// in the browser and in Node (scripts/test-eventstream.mjs, scripts/test-transcribe.mjs).
//
// Message layout (all integers big-endian):
//   total length (4) | headers length (4) | prelude CRC32 (4) | headers | payload | message CRC32 (4)
// Each header: name length (1) | name | value type (1) | value (type-dependent).
(function (root) {
  "use strict";

  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8");

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** Standard (gzip) CRC32 of bytes[from, to), returned as an unsigned 32-bit number. */
  function crc32(bytes, from = 0, to = bytes.length) {
    let c = 0xffffffff;
    for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Build one message from string headers and a payload. */
  function encodeMessage(headers, payload) {
    const parts = [];
    let headerLen = 0;
    for (const [name, value] of Object.entries(headers)) {
      const n = enc.encode(name), v = enc.encode(value);
      const h = new Uint8Array(1 + n.length + 1 + 2 + v.length);
      const dv = new DataView(h.buffer);
      h[0] = n.length;
      h.set(n, 1);
      h[1 + n.length] = 7; // string
      dv.setUint16(2 + n.length, v.length);
      h.set(v, 4 + n.length);
      parts.push(h);
      headerLen += h.length;
    }
    const total = 12 + headerLen + payload.length + 4;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, total);
    dv.setUint32(4, headerLen);
    dv.setUint32(8, crc32(out, 0, 8));
    let o = 12;
    for (const h of parts) { out.set(h, o); o += h.length; }
    out.set(payload, o);
    dv.setUint32(total - 4, crc32(out, 0, total - 4));
    return out;
  }

  /** One audio frame for the Transcribe WebSocket. An empty payload ends the stream. */
  function encodeAudioEvent(pcm) {
    const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return encodeMessage(
      { ":content-type": "application/octet-stream", ":event-type": "AudioEvent", ":message-type": "event" },
      bytes,
    );
  }

  /** Decode one complete message (verifies both CRCs). Returns { headers, payload }. */
  function decodeMessage(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes.length < 16) throw new Error("event-stream message too short");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const total = dv.getUint32(0), headerLen = dv.getUint32(4);
    if (total !== bytes.length) throw new Error(`event-stream length mismatch (${total} vs ${bytes.length})`);
    if (dv.getUint32(8) !== crc32(bytes, 0, 8)) throw new Error("event-stream prelude CRC mismatch");
    if (dv.getUint32(total - 4) !== crc32(bytes, 0, total - 4)) throw new Error("event-stream message CRC mismatch");
    if (12 + headerLen > total - 4) throw new Error("event-stream header length out of range");
    const headers = {};
    let o = 12;
    const end = 12 + headerLen;
    while (o < end) {
      const nl = bytes[o++];
      const name = dec.decode(bytes.subarray(o, o + nl));
      o += nl;
      const type = bytes[o++];
      let value;
      switch (type) {
        case 0: value = true; break;
        case 1: value = false; break;
        case 2: value = dv.getInt8(o); o += 1; break;
        case 3: value = dv.getInt16(o); o += 2; break;
        case 4: value = dv.getInt32(o); o += 4; break;
        case 5: value = dv.getBigInt64(o); o += 8; break;
        case 6: case 7: {
          const len = dv.getUint16(o); o += 2;
          const raw = bytes.subarray(o, o + len);
          value = type === 7 ? dec.decode(raw) : raw.slice();
          o += len;
          break;
        }
        case 8: value = Number(dv.getBigInt64(o)); o += 8; break;
        case 9: value = Array.from(bytes.subarray(o, o + 16), (b) => b.toString(16).padStart(2, "0")).join(""); o += 16; break;
        default: throw new Error(`event-stream: unknown header type ${type}`);
      }
      headers[name] = value;
    }
    return { headers, payload: bytes.subarray(end, total - 4) };
  }

  /** Reassembles messages from arbitrary chunks (a WebSocket frame can hold part of one, or several). */
  class Decoder {
    constructor() { this.buf = new Uint8Array(0); }
    /** @returns {{headers:Object, payload:Uint8Array}[]} every message completed by this chunk */
    push(chunk) {
      const add = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const merged = new Uint8Array(this.buf.length + add.length);
      merged.set(this.buf);
      merged.set(add, this.buf.length);
      this.buf = merged;
      const out = [];
      while (this.buf.length >= 4) {
        const total = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(0);
        if (total < 16) throw new Error("event-stream: bad message length");
        if (this.buf.length < total) break;
        out.push(decodeMessage(this.buf.subarray(0, total)));
        this.buf = this.buf.slice(total);
      }
      return out;
    }
  }

  /**
   * Turn a decoded message into something the page can use.
   * @returns {{kind:"results", results:Object[]} | {kind:"exception", type:string, message:string} | {kind:"other"}}
   */
  function parseTranscript(msg) {
    const h = msg.headers;
    const text = () => dec.decode(msg.payload);
    if (h[":message-type"] === "exception") {
      let message = text();
      try { message = JSON.parse(message).Message || message; } catch { /* keep the raw text */ }
      return { kind: "exception", type: String(h[":exception-type"] || "UnknownException"), message };
    }
    if (h[":event-type"] !== "TranscriptEvent") return { kind: "other" };
    const body = JSON.parse(text());
    const results = (body.Transcript?.Results || []).map((r) => {
      const alts = (r.Alternatives || []).map((a) => ({
        text: String(a.Transcript || "").trim(),
        items: (a.Items || []).map((i) => ({
          content: i.Content, type: i.Type, confidence: i.Confidence, stable: i.Stable, start: i.StartTime, end: i.EndTime,
        })),
      }));
      return {
        id: r.ResultId,
        isPartial: !!r.IsPartial,
        start: r.StartTime,
        end: r.EndTime,
        languageCode: r.LanguageCode,
        alternatives: alts,
        text: alts[0]?.text || "",
      };
    });
    return { kind: "results", results };
  }

  /** Float32 samples in [-1, 1] -> little-endian signed 16-bit PCM bytes. */
  function floatToPcm16(samples) {
    const out = new Uint8Array(samples.length * 2);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return out;
  }

  /**
   * The alternatives sent to the agent. Transcribe streaming returns one alternative per result, so the extras are
   * the partials that differed from the final (the recogniser often shows the right word before revising it).
   */
  function buildAlternatives(finalText, partials) {
    const seen = new Set();
    const out = [];
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
    const finalKey = norm(finalText || "");
    for (const t of [finalText, ...[...partials].reverse()]) {
      const key = norm(t || "");
      if (!key || seen.has(key)) continue;
      // A partial that is only the start of the final ("alexa let", "2" for "24") adds nothing but noise.
      if (out.length && finalKey.startsWith(key)) continue;
      seen.add(key);
      out.push(t.trim());
      if (out.length >= 5) break;
    }
    return out;
  }

  root.AlexaEventStream = { crc32, encodeMessage, encodeAudioEvent, decodeMessage, Decoder, parseTranscript, floatToPcm16, buildAlternatives };
})(typeof window !== "undefined" ? window : globalThis);
