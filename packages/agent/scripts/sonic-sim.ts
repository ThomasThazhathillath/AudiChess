import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand, InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { runTurn } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";

// Nova 2 Sonic end to end, without a browser or a microphone: the page's own Sonic session code (web/sonic.js) streams
// recorded phrases in real time, with silence between them, and Sonic's tool calls go to the real agent (Nova 2 Lite).
// It checks what Sonic heard, that every turn went through the agent, that Sonic said the agent's reply word for word,
// and the time from the end of a phrase to her first sound. It prints the Sonic and agent cost.
//   ..\..\scripts\make-sonic-audio.ps1  (once)   (packages/mcp-server: npm run dev)   then   npm run sonic
// Costs about $0.02 a run (Sonic in ap-northeast-1 plus Nova 2 Lite in ap-south-1).

const here = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(here, "..", "eval-results", "sonic-audio");
const SONIC_REGION = process.env.SONIC_REGION ?? "ap-northeast-1";
const VOICE = process.env.VOICE ?? "kiara";

// The page's code, loaded the way the browser loads it.
new Function(readFileSync(join(here, "..", "..", "..", "web", "sonic.js"), "utf8"))();
const Sonic = (globalThis as any).AlexaSonic;

// Billed prices, ap-northeast-1 (AWS Price List, 2026-10-23), per 1K tokens.
const PRICE = { speechIn: 0.00363, speechOut: 0.01452, textIn: 0.000396, textOut: 0.003311 };
const LITE = { input: 0.35 / 1e6, output: 2.95 / 1e6 }; // Nova 2 Lite, ap-south-1

const phrases: string[] = JSON.parse(readFileSync(join(AUDIO, "phrases.json"), "utf8"));
/** 16 kHz mono 16-bit PCM from a WAV file (the data chunk). */
function wavPcm(file: string): Int16Array {
  const b = readFileSync(file);
  let i = 12;
  while (i < b.length - 8) {
    const id = b.toString("ascii", i, i + 4), size = b.readUInt32LE(i + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + size));
    i += 8 + size;
  }
  throw new Error(`no data chunk in ${file}`);
}

const sonicClient = new BedrockRuntimeClient({ region: SONIC_REGION });
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-south-1" });
const deps = {
  converse: (input: any) => bedrock.send(new ConverseCommand(input)),
  tools: new McpChessTools(process.env.MCP_URL ?? "http://127.0.0.1:3001/mcp", async () => process.env.MCP_TOKEN ?? "local"),
  sessions: new MemorySessionStore(),
  modelId: process.env.MODEL_ID ?? "global.amazon.nova-2-lite-v1:0",
};
const sessionId = `sonic-sim-${Date.now()}`;

/** Times are milliseconds after the end of the phrase: heard = Sonic's transcript, tool = its tool call, agent = reply ready. */
interface Turn { phrase: string; heard: string[]; toolHeard: string[]; replies: string[]; spoken: string; firstAudioMs?: number; heardMs?: number; toolMs?: number; agentMs: number[]; repeatCalls: number; audioMs: number; firstAudioAt?: number }
const turns: Turn[] = phrases.map((phrase) => ({ phrase, heard: [], toolHeard: [], replies: [], spoken: "", agentMs: [], repeatCalls: 0, audioMs: 0 }));
let current = -1;
let phraseEndAt = 0;
let lastAudioAt = 0;
let turnEnded = false;
let audioEnded = false;
let usage: any = null;
let liteIn = 0, liteOut = 0;
let audioBytes = 0;

const started = Date.now();
const s = Sonic.open({
  send: (input: any) => sonicClient.send(new InvokeModelWithBidirectionalStreamCommand(input)),
  voiceId: VOICE,
  onUserText: (t: string) => { const turn = turns[current]; if (!turn) return; turn.heard.push(t); turn.heardMs ??= Date.now() - phraseEndAt; },
  onRepeatTool: () => { if (turns[current]) turns[current].repeatCalls++; },
  onToolUse: async ({ heard }: { heard: string }) => {
    const turn = turns[current];
    const text = Sonic.clean(turn?.heard.at(-1) || heard);
    heard = Sonic.clean(heard);
    turn?.toolHeard.push(heard);
    const t = Date.now();
    if (turn) turn.toolMs ??= t - phraseEndAt;
    const r = await runTurn(deps, sessionId, { text, alternatives: heard && heard !== text ? [text, heard] : [], woken: false });
    turn?.agentMs.push(Date.now() - t);
    liteIn += r.usage.inputTokens; liteOut += r.usage.outputTokens;
    const say = r.ignored ? "" : r.reply;
    turn?.replies.push(say || "(ignored)");
    return say;
  },
  onAssistantText: (t: string, stage: string) => { if (stage === "FINAL" && turns[current]) turns[current].spoken += (turns[current].spoken ? " " : "") + t; },
  onAudio: (b64: string) => {
    const turn = turns[current];
    if (turn && turn.firstAudioMs === undefined) { turn.firstAudioMs = Date.now() - phraseEndAt; turn.firstAudioAt = Date.now(); }
    audioBytes += (b64.length * 3) / 4;
    if (turn) turn.audioMs += ((b64.length * 3) / 4 / 2 / 24000) * 1000;
    lastAudioAt = Date.now();
  },
  onAudioEnd: (reason: string) => { if (reason === "END_TURN") audioEnded = true; },
  onTurnEnd: () => { turnEnded = true; },
  onUsage: (u: any) => { usage = u; },
  onClose: (err?: Error) => { if (err) console.error("Sonic closed with an error:", err.message); },
});

const FRAME = 512; // 32 ms at 16 kHz
const silence = new Int16Array(FRAME);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Real-time pacing: one frame every 32 ms, like a microphone. */
async function stream(pcm: Int16Array) {
  const t0 = Date.now();
  for (let i = 0, n = 0; i < pcm.length; i += FRAME, n++) {
    const frame = new Int16Array(FRAME);
    frame.set(pcm.subarray(i, i + FRAME));
    s.audio(frame);
    const wait = t0 + (n + 1) * 32 - Date.now();
    if (wait > 0) await sleep(wait);
  }
}
async function quiet(ms: number) { await stream(new Int16Array(Math.round((ms / 1000) * 16000))); }

await quiet(1000);
for (let i = 0; i < phrases.length; i++) {
  current = i;
  turnEnded = false;
  audioEnded = false;
  await stream(wavPcm(join(AUDIO, `${i}.wav`)));
  phraseEndAt = Date.now();
  // Keep the mic "open" (silence) until she has finished speaking, as heard: Sonic sends audio faster than real time,
  // so the turn ends when its audio would have finished playing.
  const deadline = Date.now() + 20000;
  const t = turns[i];
  const done = () => (audioEnded || turnEnded) && (t.firstAudioAt === undefined ? turnEnded || Date.now() - phraseEndAt > 8000 : Date.now() > t.firstAudioAt + t.audioMs + 300);
  while (!done() && Date.now() < deadline) await quiet(160);
  await quiet(1500);
  console.log(`🧑 ${t.phrase}  👂 ${t.heard.join(" / ") || "-"}  🔧 ${t.replies.join(" / ") || "no tool call"}${t.repeatCalls ? ` (+${t.repeatCalls} repeat calls)` : ""}  🔊 ${t.spoken || "-"}  (heard ${t.heardMs ?? "-"}, tool ${t.toolMs ?? "-"}, agent ${t.agentMs.join("+") || "-"}, first sound ${t.firstAudioMs ?? "-"} ms)`);
}
// Cost of silence: 10 s of nothing, to measure the speech-input tokens per second.
const before = usage?.details?.total?.input?.speechTokens ?? 0;
current = -1;
await quiet(10000);
await sleep(500);
const silenceTokensPerSec = ((usage?.details?.total?.input?.speechTokens ?? 0) - before) / 10;
s.close();
await sleep(1500);

// ---------- metrics ----------
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const words = (x: string) => new Set(norm(x).split(" ").filter(Boolean));
/** Share of the agent's words that Sonic said: 1 = word for word. */
function fidelity(reply: string, spoken: string) {
  const r = [...words(reply)], sp = words(spoken);
  return r.length ? r.filter((w) => sp.has(w)).length / r.length : spoken ? 0 : 1;
}
const tot = usage?.details?.total ?? { input: { speechTokens: 0, textTokens: 0 }, output: { speechTokens: 0, textTokens: 0 } };
const sonicCost = (tot.input.speechTokens * PRICE.speechIn + tot.output.speechTokens * PRICE.speechOut + tot.input.textTokens * PRICE.textIn + tot.output.textTokens * PRICE.textOut) / 1000;
const liteCost = liteIn * LITE.input + liteOut * LITE.output;
const scored = turns.map((t) => ({
  ...t,
  fidelity: t.replies.length ? fidelity(t.replies.filter((r) => r !== "(ignored)").join(" "), t.spoken) : 0,
  extraWords: [...words(t.spoken)].filter((w) => !words(t.replies.join(" ")).has(w)),
}));
const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
const latencies = scored.map((t) => t.firstAudioMs).filter((x): x is number => typeof x === "number");
const summary = {
  at: new Date().toISOString(),
  voice: VOICE,
  turns: scored.length,
  toolCalled: scored.filter((t) => t.replies.length > 0).length,
  wordForWord: scored.filter((t) => t.fidelity === 1 && t.extraWords.length === 0).length,
  avgFidelity: +(scored.reduce((a, t) => a + t.fidelity, 0) / scored.length).toFixed(3),
  repeatToolCalls: scored.reduce((a, t) => a + t.repeatCalls, 0),
  stagesMs: { heard: avg(scored.map((t) => t.heardMs)), tool: avg(scored.map((t) => t.toolMs)), agent: avg(scored.flatMap((t) => t.agentMs)) },
  firstAudioMs: { avg: Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)), max: Math.max(0, ...latencies) },
  silenceSpeechTokensPerSec: silenceTokensPerSec,
  sonicTokens: tot,
  seconds: Math.round((Date.now() - started) / 1000),
  cost: { sonic: +sonicCost.toFixed(4), lite: +liteCost.toFixed(4), total: +(sonicCost + liteCost).toFixed(4) },
};
console.log(JSON.stringify(summary, null, 2));
for (const t of scored) if (t.fidelity < 1 || t.extraWords.length) console.log(`✗ "${t.phrase}": said "${t.spoken}" for "${t.replies.join(" / ")}" (extra: ${t.extraWords.join(", ") || "-"})`);
const outDir = join(here, "..", "eval-results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-sonic.json`), JSON.stringify({ summary, turns: scored }, null, 2));
process.exit(0);
