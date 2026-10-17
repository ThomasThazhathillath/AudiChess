// End-to-end check of the Transcribe ears with no microphone: Polly speaks chess commands, the audio is streamed
// through the real presigned-URL path (the Lambda handler, signed with your local AWS credentials) and the
// event-stream codec the page uses, and the transcripts are checked.
//
//   node scripts/test-transcribe.mjs                 default config (what the site uses), must pass
//   node scripts/test-transcribe.mjs --compare       also run: no vocabulary, multi-language, stabilization off
//   node scripts/test-transcribe.mjs --wav file.wav  stream a 16 kHz mono 16-bit WAV instead of Polly
//   node scripts/test-transcribe.mjs --say "pawn to d4" --say "pawn d 4"   ad-hoc phrases (report only)
//   options: --only "knight to f3"   --speed 2 (stream faster than real time)   --voice Kajal   --noise 0
//
// Needs AWS credentials (profile "default"), Polly + Transcribe in ap-south-1, and the custom vocabulary
// alexa_chess_vocabulary (scripts/deploy.ps1 -VocabularyOnly) for the default config.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const agentRequire = createRequire(new URL("packages/agent/package.json", root));
const { PollyClient, SynthesizeSpeechCommand } = agentRequire("@aws-sdk/client-polly");
const { defaultProvider } = agentRequire("@aws-sdk/credential-provider-node");
// The Lambda handler itself (TypeScript, run directly by Node's type stripping).
const { handler } = await import(new URL("packages/transcribe-url/src/handler.ts", root).href).catch(() => ({}));
const { presignTranscribeUrl } = await import(new URL("packages/transcribe-url/src/presign.ts", root).href);
const { defaultSettings, applyOverrides } = await import(new URL("packages/transcribe-url/src/config.ts", root).href);
new Function(readFileSync(new URL("web/eventstream.js", root), "utf8"))();
const ES = globalThis.AlexaEventStream;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const REGION = process.env.AWS_REGION ?? "ap-south-1";
const SPEED = Number(opt("speed", 1));
const VOICE = opt("voice", "Kajal");
const NOISE = Number(opt("noise", 1));

// Moves are judged the way the game judges them: the transcript goes through the chess server's spoken-move
// resolver (packages/mcp-server/src/chess/spokenMove.ts) in a position where the move is legal, and must come
// out as `san`. Other lines must contain the `must` words after normalising ("f 3" -> "f3").
// `required: false` lines (noise, Hindi mid-command) are reported but don't fail the run.
const ITALIAN = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
const CASTLED = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 5";
const OPEN_D = "rnbqkbnr/ppp1pppp/8/3p4/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 3";
const TWO_KNIGHTS = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
const CASES = [
  { say: "Alexa, knight to f3", must: [/alexa/], san: "Nf3" },
  { say: "Alexa, let's play chess", must: [/alexa/, /play/, /chess/] },
  { say: "black, easy", must: [/black/, /easy/] },
  { say: "pawn d4", san: "d4" },
  { say: "knight f3", san: "Nf3" },
  { say: "castle kingside", fen: ITALIAN, san: "O-O" },
  { say: "bishop takes f7", fen: ITALIAN, san: "Bxf7+" },
  { say: "rook e1", fen: CASTLED, san: "Re1" },
  { say: "queen takes d5", fen: OPEN_D, san: "Qxd5" },
  { say: "pawn e4", san: "e4" },
  { say: "pawn takes e6", fen: "rnbqkbnr/ppp2ppp/4p3/3P4/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 3", san: "dxe6" }, // live site, 2026-10-16
  { say: "knight takes e5", fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", san: "Nxe5" },
  { say: "undo", must: [/undo/] },
  { ssml: `<speak><lang xml:lang="hi-IN">और</lang> black, easy</speak>`, say: "aur black, easy (Hindi 'aur')", must: [/black/, /easy/] },
  { ssml: `<speak>Alexa, <lang xml:lang="hi-IN">haan</lang>, knight to f3</speak>`, say: "Alexa, haan, knight to f3", san: "Nf3", required: false },
  { say: "knight to f3 (noisy)", text: "knight to f3", noise: 0.25, san: "Nf3", required: false },
  { say: "bishop c4 (noisy)", text: "bishop c4", noise: 0.25, fen: TWO_KNIGHTS, san: "Bc4", required: false },
].filter((c) => !opt("only") || c.say.toLowerCase().includes(opt("only").toLowerCase()));

// The chess server's resolver and chess.js, loaded through tsx (the server is TypeScript with .js import paths).
const { register } = await import(new URL("packages/agent/node_modules/tsx/dist/esm/api/index.mjs", root).href);
register();
const { resolveSpokenMove } = await import(new URL("packages/mcp-server/src/chess/spokenMove.ts", root).href);
const { Chess } = createRequire(new URL("packages/mcp-server/package.json", root))("chess.js");
// The app's accent decoder (Amazon Nova), for readings the matcher is unsure about.
const { decodeMove } = await import(new URL("packages/agent/src/guessMove.ts", root).href);
const { BedrockRuntimeClient, ConverseCommand } = agentRequire("@aws-sdk/client-bedrock-runtime");
const bedrock = new BedrockRuntimeClient({ region: REGION });
const converse = (input) => bedrock.send(new ConverseCommand(input));
const MODEL_ID = process.env.MODEL_ID ?? "global.amazon.nova-2-lite-v1:0";

/**
 * What the game would do with this transcript (+ partials), with the app's "decide, don't ask" policy: a clear
 * reading is played; unclear readings are decided (one candidate, or Nova picks between two); words that named no
 * move are decoded over all legal moves; an understood illegal move is refused; only "which piece?" is asked.
 */
async function resolve(c, alternatives) {
  const chess = new Chess(c.fen);
  const res = resolveSpokenMove(chess, undefined, alternatives);
  if (res.kind === "move") return res.san;
  if (res.kind === "confirm") {
    const ms = res.candidates.map((s) => new Chess(c.fen).move(s));
    if (ms.length === 2 && ms[0].piece === ms[1].piece && ms[0].to === ms[1].to) return `asks which: ${res.candidates.join(" or ")}`;
    if (res.reason === "illegal") return "says it's illegal";
    if (res.candidates.length === 1) return res.candidates[0];
    return (await decodeMove(converse, MODEL_ID, alternatives, res.candidates)).san ?? res.candidates[0];
  }
  return (await decodeMove(converse, MODEL_ID, alternatives, chess.moves())).san ?? "no move";
}
// --say "pawn to d4" --say "pawn d 4": transcribe ad-hoc phrases instead (reported, never failed).
if (flag("say")) {
  CASES.length = 0;
  args.forEach((a, i) => { if (a === "--say") CASES.push({ say: args[i + 1], must: [] }); });
}

const CONFIGS = [{ name: "default (en-IN + vocabulary, stability high)", overrides: {}, required: true }];
if (flag("compare")) {
  CONFIGS.push(
    { name: "no vocabulary", overrides: { vocabulary: false } },
    { name: "stability off", overrides: { stability: "off" } },
    { name: "spoken numbers + vocabulary", overrides: { transcriptFormat: "spoken" } },
    { name: "multi-language en-IN + hi-IN", overrides: { mode: "multi", vocabulary: false } },
    { name: "en-US (no vocabulary)", overrides: { languageCode: "en-US" } },
  );
}

const polly = new PollyClient({ region: REGION });
async function speak(c) {
  // Accents: Kajal (Indian), Joanna/Matthew (US), Amy/Brian (British), Olivia (Australian).
  const lang = { Kajal: "en-IN", Joanna: "en-US", Matthew: "en-US", Ruth: "en-US", Amy: "en-GB", Brian: "en-GB", Olivia: "en-AU" }[VOICE] ?? "en-US";
  const out = await polly.send(new SynthesizeSpeechCommand({
    Engine: "neural", VoiceId: VOICE, LanguageCode: lang, OutputFormat: "pcm", SampleRate: "16000",
    ...(c.ssml ? { TextType: "ssml", Text: c.ssml } : { Text: c.text ?? c.say }),
  }));
  let pcm = Buffer.from(await out.AudioStream.transformToByteArray());
  if (NOISE && c.noise) pcm = addNoise(pcm, c.noise);
  return pcm;
}

function addNoise(pcm, ratio) {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  let sum = 0;
  for (const v of s) sum += v * v;
  const rms = Math.sqrt(sum / s.length);
  const out = new Int16Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const g = (Math.random() + Math.random() + Math.random() - 1.5) * 2; // roughly gaussian
    out[i] = Math.max(-32768, Math.min(32767, s[i] + g * rms * ratio));
  }
  return Buffer.from(out.buffer);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => t.toLowerCase().replace(/(\b[a-h])[\s-]+([1-8]\b)/g, "$1$2").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

async function getUrl(overrides, sessionId) {
  if (handler) {
    const res = await handler(
      { headers: {}, body: JSON.stringify({ sessionId, ...overrides }), isBase64Encoded: false, requestContext: { http: { method: "POST", sourceIp: "127.0.0.1" } } },
      { credentials: defaultProvider() },
    );
    if (res.statusCode !== 200) throw new Error(`presign handler said ${res.statusCode}: ${res.body}`);
    return JSON.parse(res.body).url;
  }
  return presignTranscribeUrl({ credentials: await defaultProvider()(), region: REGION, settings: applyOverrides(defaultSettings(), overrides) });
}

/** Stream one utterance (with lead-in and trailing silence) and collect everything Transcribe says. */
async function transcribe(pcm, overrides) {
  const url = await getUrl(overrides, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const dec = new ES.Decoder();
  const t0 = { open: 0 };
  const res = { partials: [], finals: [], langs: new Set(), error: null, firstPartialMs: null, finalMs: null };
  const done = new Promise((resolve) => {
    ws.onmessage = (e) => {
      for (const m of dec.push(new Uint8Array(e.data))) {
        const p = ES.parseTranscript(m);
        if (p.kind === "exception") { res.error = `${p.type}: ${p.message}`; resolve(); }
        if (p.kind !== "results") continue;
        for (const r of p.results) {
          if (r.languageCode) res.langs.add(r.languageCode);
          if (!r.text) continue;
          const at = Date.now() - t0.open;
          if (r.isPartial) { res.partials.push(r.text); res.firstPartialMs ??= at; } else { res.finals.push(r.text); res.finalMs = at; }
        }
      }
    };
    ws.onerror = () => { res.error ??= "websocket error"; resolve(); };
    ws.onclose = (e) => { if (e.code !== 1000 && !res.error) res.error = `closed ${e.code} ${e.reason || ""}`.trim(); resolve(); };
  });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.addEventListener("error", () => reject(new Error("could not open the websocket (bad signature, missing vocabulary or permissions?)")), { once: true }); });
  t0.open = Date.now();
  const CHUNK = 3200; // 100 ms of 16 kHz 16-bit mono
  const silence = Buffer.alloc(CHUNK * 8); // 0.8 s lead-in
  const tail = Buffer.alloc(CHUNK * 20); // 2 s so the segment is finalised
  const all = Buffer.concat([silence, pcm, tail]);
  for (let i = 0; i < all.length && !res.error; i += CHUNK) {
    ws.send(ES.encodeAudioEvent(new Uint8Array(all.subarray(i, i + CHUNK))));
    await sleep(100 / SPEED);
  }
  if (!res.error) ws.send(ES.encodeAudioEvent(new Uint8Array(0))); // end of stream
  await Promise.race([done, sleep(8000)]);
  try { ws.close(1000); } catch { /* already closed */ }
  res.speechEndMs = (silence.length + pcm.length) / 32 / SPEED; // 16 kHz * 2 bytes = 32 bytes per ms
  return res;
}

async function runConfig(cfg, audio) {
  const rows = [];
  for (const c of CASES) {
    let r;
    try { r = await transcribe(audio.get(c), cfg.overrides); } catch (err) { r = { error: String(err.message ?? err), finals: [], partials: [], langs: new Set() }; }
    const text = r.finals.join(" ");
    const n = norm(text);
    const missing = (c.must ?? []).filter((re) => !re.test(n));
    // Same alternatives the page sends: the final, then the partials that differed from it.
    const move = c.san && text ? await resolve(c, ES.buildAlternatives(text, r.partials)) : undefined;
    const ok = !r.error && missing.length === 0 && (!c.san || move === c.san);
    rows.push({ c, text, ok, missing, move, r });
  }
  return rows;
}

// ---------- main ----------
console.log(`Polly voice ${VOICE}, ${CASES.length} utterances, ${CONFIGS.length} config(s), speed x${SPEED}\n`);
const audio = new Map();
if (opt("wav")) {
  const wav = readFileSync(opt("wav"));
  // A .pcm file is the page's raw recording (packages/agent/eval-results/live/<date>-<session>.pcm): no header.
  const pcm = /\.pcm$/i.test(opt("wav")) ? wav : wav.subarray(44);
  CASES.length = 0;
  CASES.push({ say: opt("wav"), must: [] });
  audio.get = () => pcm;
} else {
  for (const c of CASES) audio.set(c, await speak(c));
  audio.get = Map.prototype.get.bind(audio);
}

let failed = false;
const summary = [];
for (const cfg of CONFIGS) {
  const rows = await runConfig(cfg, audio);
  console.log(`== ${cfg.name}`);
  for (const { c, text, ok, missing, move, r } of rows) {
    const lat = r.finalMs != null && r.speechEndMs != null ? `${Math.round(r.finalMs - r.speechEndMs)} ms after speech` : "-";
    const tag = ok ? "PASS" : c.required === false ? "miss" : "FAIL";
    console.log(`${tag}  ${c.say.padEnd(34)} -> ${JSON.stringify(text)}${move ? ` => ${move}` : ""}${r.langs?.size ? `  [${[...r.langs].join(",")}]` : ""}  (${lat})${r.error ? `  ERROR ${r.error}` : ""}${missing.length ? `  missing ${missing.join(" ")}` : ""}${c.san && !ok ? `  wanted ${c.san}` : ""}`);
  }
  const required = rows.filter((x) => x.c.required !== false);
  const passedRequired = required.filter((x) => x.ok).length;
  const passedExtra = rows.filter((x) => x.c.required === false && x.ok).length;
  summary.push(`${cfg.name}: required ${passedRequired}/${required.length}, extra (noise, Hindi mid-command) ${passedExtra}/${rows.length - required.length}`);
  if (cfg.required && passedRequired !== required.length && !opt("wav") && !flag("say")) failed = true;
  console.log("");
}
console.log(summary.join("\n"));
process.exit(failed ? 1 : 0);
