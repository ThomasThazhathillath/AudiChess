import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";

// Indian-English test phrases for the Sonic harness, read by Sonic's own Indian-English voices (Arjun and Kiara):
// Windows has no Indian-English voice, and the user's "knight f3" came back as Hindi ("maine tab key", 2026-10-23).
// Writes 16 kHz mono WAVs to eval-results/sonic-audio-in/<n>.wav plus phrases.json, for: SONIC_AUDIO=sonic-audio-in npm run sonic
//   node --import tsx scripts/make-accent-audio.ts      (about $0.01)

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "eval-results", "sonic-audio-in");
const PHRASES = [
  ["let's play chess", "arjun"],
  ["white, easy", "kiara"],
  ["e4", "arjun"],
  ["knight f3", "arjun"],
  ["that's an interesting move", "kiara"],
  ["bishop c4", "arjun"],
  ["pawn takes d5", "kiara"],
  ["castle kingside", "arjun"],
  ["what was your last move?", "kiara"],
  ["undo", "arjun"],
] as const;

const client = new BedrockRuntimeClient({ region: "ap-northeast-1" });
const enc = new TextEncoder();

/** One Sonic session that reads one phrase aloud; returns its 24 kHz PCM. */
async function speak(text: string, voiceId: string): Promise<Int16Array> {
  const p = "p", sys = "s", user = "u";
  const events = [
    { sessionStart: { inferenceConfiguration: { maxTokens: 200, topP: 0.9, temperature: 0 } } },
    { promptStart: { promptName: p, textOutputConfiguration: { mediaType: "text/plain" }, audioOutputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId, encoding: "base64", audioType: "SPEECH" } } },
    { contentStart: { promptName: p, contentName: sys, type: "TEXT", interactive: false, role: "SYSTEM", textInputConfiguration: { mediaType: "text/plain" } } },
    { textInput: { promptName: p, contentName: sys, content: "You are a voice actor reading chess commands in English, in a natural Indian English accent. Say exactly the words the user types, once, and nothing else: no greeting, no reply, no extra words." } },
    { contentEnd: { promptName: p, contentName: sys } },
    { contentStart: { promptName: p, contentName: "a", type: "AUDIO", interactive: true, role: "USER", audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" } } },
    { contentStart: { promptName: p, contentName: user, type: "TEXT", interactive: true, role: "USER", textInputConfiguration: { mediaType: "text/plain" } } },
    { textInput: { promptName: p, contentName: user, content: text } },
    { contentEnd: { promptName: p, contentName: user } },
  ];
  let done: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  async function* body() {
    for (const e of events) yield { chunk: { bytes: enc.encode(JSON.stringify({ event: e })) } };
    const silence = Buffer.alloc(1024).toString("base64");
    const until = Date.now() + 15000;
    let stop = false;
    finished.then(() => { stop = true; });
    while (!stop && Date.now() < until) { yield { chunk: { bytes: enc.encode(JSON.stringify({ event: { audioInput: { promptName: p, contentName: "a", content: silence } } })) } }; await new Promise((r) => setTimeout(r, 32)); }
    for (const e of [{ contentEnd: { promptName: p, contentName: "a" } }, { promptEnd: { promptName: p } }, { sessionEnd: {} }]) yield { chunk: { bytes: enc.encode(JSON.stringify({ event: e })) } };
  }
  const res = await client.send(new InvokeModelWithBidirectionalStreamCommand({ modelId: "amazon.nova-2-sonic-v1:0", body: body() }));
  const chunks: Buffer[] = [];
  for await (const part of res.body!) {
    if (!part.chunk?.bytes) continue;
    const ev = JSON.parse(new TextDecoder().decode(part.chunk.bytes)).event;
    if (ev?.audioOutput) chunks.push(Buffer.from(ev.audioOutput.content, "base64"));
    if (ev?.contentEnd?.type === "AUDIO" && ev.contentEnd.stopReason === "END_TURN") done!();
    if (ev?.completionEnd) done!();
  }
  const b = Buffer.concat(chunks);
  return new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
}

/** 24 kHz -> 16 kHz (linear interpolation), with 300 ms of silence either side. */
function to16k(pcm: Int16Array): Int16Array {
  const n = Math.floor((pcm.length * 2) / 3);
  const pad = 4800;
  const out = new Int16Array(n + 2 * pad);
  for (let i = 0; i < n; i++) {
    const x = i * 1.5, j = Math.floor(x), f = x - j;
    out[pad + i] = Math.round(pcm[j] * (1 - f) + (pcm[Math.min(j + 1, pcm.length - 1)] ?? 0) * f);
  }
  return out;
}

function wav(pcm: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

mkdirSync(OUT, { recursive: true });
for (let i = 0; i < PHRASES.length; i++) {
  const [text, voice] = PHRASES[i];
  const pcm = await speak(text, voice);
  writeFileSync(join(OUT, `${i}.wav`), wav(to16k(pcm)));
  console.log(`${i}: "${text}" (${voice}) ${(pcm.length / 24000).toFixed(1)} s`);
}
writeFileSync(join(OUT, "phrases.json"), JSON.stringify(PHRASES.map(([t]) => t)));
process.exit(0);
