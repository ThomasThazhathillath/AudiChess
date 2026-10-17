import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { runTurn, type AgentDeps, type TurnResult } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore, type Session } from "../src/sessions.js";
import { QUESTIONS, type Question, type ScenarioId } from "../eval/questions.js";
import { PRICES, estimateCost } from "./converse-eval.js";

// Question-answering eval: each of the user's 305 questions is asked in a position that fits it (fresh game per
// question), through the real agent (Bedrock + the local chess MCP server), and graded by a stronger model that
// sees the true facts of the position.
//   (packages/mcp-server: PORT=3011 npm run dev)   then
//   npm run qa -- [--only <category>] [--n 1,5,9] [--concurrency 4] [--label name] [--no-judge]
// Results: eval-results/qa-<timestamp>-<label>.json and a summary on stdout.

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : d);
const REGION = process.env.AWS_REGION ?? "ap-south-1";
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3011/mcp";
const MODEL_ID = process.env.MODEL_ID ?? "global.amazon.nova-2-lite-v1:0";
// Claude on Bedrock needs an AWS Marketplace subscription this account cannot complete (INVALID_PAYMENT_INSTRUMENT,
// 2026-10-16), so the first-party Nova Pro grades; failures are also reviewed by hand.
const JUDGE_ID = opt("judge", "apac.amazon.nova-pro-v1:0")!;
const CONCURRENCY = Number(opt("concurrency", "4"));
const LABEL = opt("label", "run")!;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval-results");

const bedrock = new BedrockRuntimeClient({ region: REGION });
const tools = new McpChessTools(MCP_URL, async () => "local");
const sessions = new MemorySessionStore();
const deps: AgentDeps = { converse: (input) => bedrock.send(new ConverseCommand(input)), tools, sessions, modelId: MODEL_ID };

// ---------- scenarios ----------

const ITALIAN = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];
const SCENARIOS: Record<ScenarioId, { describe: string; setup: (sessionId: string) => Promise<Partial<Session>> }> = {
  italian: { describe: "User plays White. Italian Game after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5; White (the user) to move.", setup: (s) => game(s, "white", { setupMoves: ITALIAN }) },
  sicilian: { describe: "User plays Black. Open Sicilian after 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3; Black (the user) to move.", setup: (s) => game(s, "black", { setupMoves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3"] }) },
  in_check: { describe: "User plays White and is in check: 1.e4 e5 2.f3 Qh4+. White (the user) to move; g3 blocks, the king can go to e2.", setup: (s) => game(s, "white", { setupMoves: ["e4", "e5", "f3", "Qh4+"] }) },
  fork: { describe: "User plays White in a set-up position: White knight on d5 can play Nc7+ forking the king on e8 and the rook on a8.", setup: (s) => game(s, "white", { fen: "r3k2r/ppp2ppp/2n5/3N4/8/8/PPP2PPP/R3K2R w KQkq - 0 1" }) },
  mate1: { describe: "User plays White in a set-up position: Rd8 is checkmate in one (back rank).", setup: (s) => game(s, "white", { fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1" }) },
  queen_attacked: { describe: "User plays White: 1.e4 e5 2.Qh5 Nc6 3.Bc4 g6. The white queen on h5 is attacked by the pawn on g6; White (the user) to move.", setup: (s) => game(s, "white", { setupMoves: ["e4", "e5", "Qh5", "Nc6", "Bc4", "g6"] }) },
  pin: { describe: "User plays White: 1.e4 e6 2.d4 d5 3.Nc3 Bb4. The knight on c3 is pinned to the king by the bishop on b4; White (the user) to move.", setup: (s) => game(s, "white", { setupMoves: ["e4", "e6", "d4", "d5", "Nc3", "Bb4"] }) },
  endgame_pawn: { describe: "User plays White: king and pawn (Ke1, e2 pawn) against king (Kd4). White to move.", setup: (s) => game(s, "white", { fen: "8/8/8/8/3k4/8/4P3/4K3 w - - 0 1" }) },
  endgame_rook: { describe: "User plays White: king and rook (Ke1, Ra1) against a lone king (Ke5). White to move; a forced win.", setup: (s) => game(s, "white", { fen: "8/8/8/4k3/8/8/8/R3K3 w - - 0 1" }) },
  history: {
    describe: "User plays White: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6 5.d3 d6, then the user blundered with 6.Ba6 (giving the bishop away to the pawn on b7), I replied, and the user played one more move. Which moves were mistakes, and what was better, is in the review facts: trust those.",
    setup: async (s) => {
      const base = await game(s, "white", { setupMoves: [...ITALIAN, "c3", "Nf6", "d3", "d6"] });
      await tools.callTool("make_move", { gameId: base.gameId, move: "Ba6" });
      for (const move of ["O-O", "h3", "a3"]) {
        const r = await tools.callTool("make_move", { gameId: base.gameId, move });
        if (!r.isError && !r.data.needsConfirmation) break;
      }
      return base;
    },
  },
  game_over: {
    describe: "The game just ended: the user (White) delivered checkmate with Rd8#. The user won.",
    setup: async (s) => {
      const base = await game(s, "white", { fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1" });
      await tools.callTool("make_move", { gameId: base.gameId, move: "Rd8#" });
      return { ...base, gameOver: true };
    },
  },
  no_game: { describe: "No game has started yet.", setup: async () => ({}) },
  prior_answer: {
    describe: "Italian Game, user White to move. Alexa's previous answer was: \"I'm not threatening anything serious right now. My best idea would be knight to f6, attacking your pawn on e4, and then castling.\"",
    setup: async (s) => ({
      ...(await game(s, "white", { setupMoves: ITALIAN })),
      turns: [
        { role: "user", text: "what are you planning" },
        { role: "assistant", text: "I'm not threatening anything serious right now. My best idea would be knight to f6, attacking your pawn on e4, and then castling." },
      ],
    }),
  },
};

async function game(sessionId: string, color: "white" | "black", extra: Record<string, unknown>): Promise<Partial<Session>> {
  const r = await tools.callTool("new_game", { color, level: 2, sessionId, ...extra });
  if (r.isError) throw new Error(`scenario setup failed: ${JSON.stringify(r.data)}`);
  return { gameId: String(r.data.gameId), humanColor: color === "white" ? "White" : "Black", level: 2, gameOver: false };
}

/** The truth the judge grades against: the position analysis and the move list, from the chess server itself. */
async function facts(session: Partial<Session>): Promise<Record<string, unknown>> {
  if (!session.gameId) return { game: "none" };
  const out: Record<string, unknown> = {};
  const a = await tools.callTool("analyze_position", { gameId: session.gameId });
  const { speech: _s, ...analysis } = a.data;
  out.analysis = analysis;
  const h = await tools.callTool("game_history", { gameId: session.gameId });
  out.moves = h.data.speech;
  out.pgn = h.data.pgn;
  const rv = await tools.callTool("review_game", { gameId: session.gameId });
  out.review = rv.data;
  const lm = await tools.callTool("legal_moves", { gameId: session.gameId });
  out.allLegalMovesForTheUser = lm.data.moves; // SAN, complete
  const board = await tools.callTool("read_board", { gameId: session.gameId });
  out.board = board.data.speech;
  return out;
}

// ---------- judge ----------

const RUBRIC = `You grade answers from "Alexa", a voice chess companion for a BLIND player who plays against Alexa (Alexa is the opponent).
Everything Alexa says is spoken aloud, so short, direct answers are best. You get the question, the scenario, the true facts
of the position (from the chess engine and board, from the user's point of view: "you" = the user, "me"/"my" = Alexa) and
Alexa's reply. Grade:
- correct (0-2): 2 = every chess claim matches the facts or is correct general chess knowledge; 1 = vague or a minor slip;
  0 = a wrong fact (wrong square, wrong piece, illegal move, made-up threat or history, wrong evaluation) or misleading.
- answered (0-2): 2 = directly answers what was asked; 1 = partly, or a reasonable "this game doesn't have that" for
  features that don't exist (there is no clock, no redo, no pause, no handicap); 0 = doesn't answer, answers a different question.
- brief (0-2): 2 = to the point (about three short sentences or fewer; a full read-out is fine when the user asked for the
  whole board / all moves / everything); 1 = somewhat long; 0 = rambling, or lists many options nobody asked for.
- pass = correct is 2 AND answered >= 1 AND brief >= 1.
- If a question refers to something not in context ("that piece", "this move") a short clarifying question is a good answer.
- TRUST THE FACTS. The board, the complete list of the user's legal moves (allLegalMovesForTheUser) and the analysis come
  from the chess engine and are always right. Do not work out the position yourself: a reply that matches the facts is
  correct even if it surprises you (for example, a queen with only one legal move).
Reply with JSON only: {"correct":0|1|2,"answered":0|1|2,"brief":0|1|2,"pass":true|false,"issue":"short reason if not perfect, else empty"}`;

async function judge(q: Question, scenario: string, truth: Record<string, unknown>, reply: string, toolsUsed: string[]): Promise<Record<string, unknown>> {
  const prompt = `QUESTION: ${q.text}\nSCENARIO: ${scenario}\nTRUE FACTS: ${JSON.stringify(truth)}\nTOOLS ALEXA CALLED: ${toolsUsed.join(", ") || "none"}\nALEXA'S REPLY: ${reply || "(silence)"}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await bedrock.send(
        new ConverseCommand({
          modelId: JUDGE_ID,
          system: [{ text: RUBRIC }],
          messages: [{ role: "user", content: [{ text: prompt }] }],
          inferenceConfig: { maxTokens: 300, temperature: 0 },
        }),
      );
      const text = res.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      if (json) return JSON.parse(json);
    } catch (err) {
      // Access problems won't fix themselves; throttling does, with a growing pause.
      if (attempt === 4 || /AccessDenied|ValidationException/.test(String(err))) return { error: String(err) };
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    }
  }
  return { error: "no verdict" };
}

// ---------- run ----------

interface Row {
  n: number;
  category: string;
  question: string;
  scenario: ScenarioId;
  reply: string;
  ignored?: boolean;
  tools: string[];
  ms: number;
  timings?: TurnResult["timings"];
  usage?: TurnResult["usage"];
  sentences: number;
  verdict?: Record<string, unknown>;
  error?: string;
}

const only = opt("only");
const nums = opt("n")?.split(",").map(Number);
let list = QUESTIONS.filter((q) => (!only || q.category.toLowerCase().includes(only.toLowerCase())) && (!nums || nums.includes(q.n)));
if (opt("limit")) list = list.slice(0, Number(opt("limit")));
const doJudge = !args.includes("--no-judge");

async function runOne(q: Question): Promise<Row> {
  const sessionId = `qa-${q.n}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sc = SCENARIOS[q.scenario];
  try {
    const setup = await sc.setup(sessionId);
    await sessions.put({ sessionId, turns: [], updatedAt: "", expiresAt: 0, ...setup } as Session);
    const truth = doJudge ? await facts(setup) : {};
    const t = Date.now();
    const r = await runTurn(deps, sessionId, { text: q.text, alternatives: [q.text], woken: true });
    const ms = Date.now() - t;
    const row: Row = {
      n: q.n, category: q.category, question: q.text, scenario: q.scenario, reply: r.reply, ignored: r.ignored,
      tools: r.toolCalls.map((c) => `${c.name}${c.isError ? "!" : ""}`), ms, timings: r.timings, usage: r.usage,
      sentences: r.reply ? r.reply.split(/(?<=[.!?])\s+/).length : 0,
    };
    if (doJudge) row.verdict = await judge(q, sc.describe, truth, r.reply, row.tools);
    return row;
  } catch (err) {
    return { n: q.n, category: q.category, question: q.text, scenario: q.scenario, reply: "", tools: [], ms: 0, sentences: 0, error: String(err) };
  }
}

const rows: Row[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < list.length) {
      const q = list[next++];
      const row = await runOne(q);
      rows.push(row);
      const v = row.verdict as { pass?: boolean; issue?: string; error?: string } | undefined;
      const tag = row.error || v?.error ? "ERR " : v ? (v.pass ? "PASS" : "FAIL") : "    ";
      console.log(`${String(q.n).padStart(3)} ${tag} ${(row.ms / 1000).toFixed(1)}s [${row.tools.join(",")}] ${q.text} -> ${row.error ?? row.reply}${v && !v.pass && (v.issue || v.error) ? `  ## ${v.issue || v.error}` : ""}`);
    }
  }),
);
rows.sort((a, b) => a.n - b.n);

// ---------- summary ----------
const cats = [...new Set(rows.map((r) => r.category))];
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
console.log("\ncategory                      pass   avg s   avg sentences");
let passAll = 0;
for (const c of cats) {
  const rs = rows.filter((r) => r.category === c);
  const pass = rs.filter((r) => (r.verdict as any)?.pass).length;
  passAll += pass;
  console.log(`${c.padEnd(30)}${String(pct(pass, rs.length)).padStart(3)}%  ${(rs.reduce((s, r) => s + r.ms, 0) / rs.length / 1000).toFixed(1).padStart(5)}   ${(rs.reduce((s, r) => s + r.sentences, 0) / rs.length).toFixed(1).padStart(5)}`);
}
console.log(`${"ALL".padEnd(30)}${String(pct(passAll, rows.length)).padStart(3)}%  ${(rows.reduce((s, r) => s + r.ms, 0) / rows.length / 1000).toFixed(1).padStart(5)}   (${passAll}/${rows.length})`);
// What the agent's model calls cost (the judge's calls are not counted), at the prices billed in ap-south-1.
const used = rows.reduce((s, r) => ({ inputTokens: s.inputTokens + (r.usage?.inputTokens ?? 0), outputTokens: s.outputTokens + (r.usage?.outputTokens ?? 0), cacheReadTokens: s.cacheReadTokens + (r.usage?.cacheReadTokens ?? 0), cacheWriteTokens: s.cacheWriteTokens + (r.usage?.cacheWriteTokens ?? 0), rounds: s.rounds + (r.usage?.rounds ?? 0) }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 0 });
const cost = estimateCost(used, PRICES[MODEL_ID]);
const words = rows.map((r) => (r.reply ? r.reply.split(/\s+/).length : 0)).sort((a, b) => a - b);
console.log(`agent: ${used.rounds} model calls, ${used.inputTokens} in + ${used.outputTokens} out + ${used.cacheReadTokens} cache read${cost !== undefined ? `, about $${cost.toFixed(3)}` : ""}`);
console.log(`words per answer: avg ${(words.reduce((s, w) => s + w, 0) / Math.max(1, words.length)).toFixed(1)}, p50 ${words[words.length >> 1]}, p90 ${words[Math.floor(words.length * 0.9)]}, max ${words[words.length - 1]}`);
mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `qa-${new Date().toISOString().replace(/[:.]/g, "-")}-${LABEL}.json`);
writeFileSync(file, JSON.stringify({ model: MODEL_ID, judge: JUDGE_ID, rows }, null, 2));
console.log(`\nwrote ${file}`);
process.exit(0);
