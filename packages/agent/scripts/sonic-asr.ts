import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";

// What Sonic writes down for recorded phrases, per voice and speech-prompt setting. A stub agent answers "Okay."
// (no Nova 2 Lite), so only Sonic is billed: about $0.01 per variant.
//   node --import tsx scripts/sonic-asr.ts [audio dir under eval-results] [voice:speechPrompt ...]
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "eval-results", process.argv[2] ?? "sonic-audio-in");
const variants = process.argv.slice(3).length ? process.argv.slice(3) : ["kiara:on", "kiara:off", "matthew:off", "amy:off"];
new Function(readFileSync(join(here, "..", "..", "..", "web", "sonic.js"), "utf8"))();
const Sonic = (globalThis as any).AlexaSonic;
const client = new BedrockRuntimeClient({ region: "ap-northeast-1" });
const phrases: string[] = JSON.parse(readFileSync(join(dir, "phrases.json"), "utf8"));
const wavPcm = (f: string) => { const b = readFileSync(f); return new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const v of variants) {
  const [voiceId, sp] = v.split(":");
  const heard: string[][] = phrases.map(() => []);
  let cur = -1;
  const s = Sonic.open({
    send: (input: any) => client.send(new InvokeModelWithBidirectionalStreamCommand(input)),
    voiceId, speechPrompt: sp !== "off",
    onUserText: (t: string) => { if (cur >= 0) heard[cur].push(t); },
    onToolUse: async () => "Okay.",
  });
  const stream = async (pcm: Int16Array) => { const t0 = Date.now(); for (let i = 0, n = 0; i < pcm.length; i += 512, n++) { const f = new Int16Array(512); f.set(pcm.subarray(i, i + 512)); s.audio(f); const w = t0 + (n + 1) * 32 - Date.now(); if (w > 0) await sleep(w); } };
  await stream(new Int16Array(16000));
  for (let i = 0; i < phrases.length; i++) { cur = i; await stream(wavPcm(join(dir, `${i}.wav`))); await stream(new Int16Array(16000 * 4)); }
  s.close();
  await sleep(1000);
  const ok = phrases.filter((p, i) => Sonic.clean(heard[i].join(" ")).toLowerCase().replace(/[^a-z0-9 ]/g, "") .includes(Sonic.clean(p).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/(\b[a-h])(\d)/g, "$1$2")));
  console.log(`\n== ${v}: ${phrases.map((p, i) => `${p} → ${heard[i].join(" / ") || "-"}`).join(" | ")}`);
}
process.exit(0);
