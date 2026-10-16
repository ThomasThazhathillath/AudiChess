import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolTrace, TurnResult } from "../src/agent.js";
import type { ChessTools } from "../src/mcpClient.js";

// Conversation-quality eval: one scripted ~25-turn game through runTurn, then metrics on the replies.
//   (packages/mcp-server: npm run dev)   then   npm run eval -- [--model <bedrock id>] [--label <name>]
// Results go to eval-results/<timestamp>-<label>.json (gitignored) so before/after runs can be diffed.

// ---------- the script ----------

/**
 * "spoken|alt1|alt2": the first part is what speech recognition heard best, the rest are alternatives.
 * "@move" plays White's next move and "@blunder" a deliberate blunder (see pickMove): the engine is not
 * deterministic, so a fixed move list would soon be illegal and turn the rest of the run into error handling.
 */
export const SCRIPT = [
  "let's play chess",
  "white",
  "easy",
  "@move",
  "@move",
  "@move",
  "hello",
  "@move",
  "where is my queen",
  "@move",
  "only for",
  "@move",
  "talk less",
  "@move",
  "@move",
  "what was your last move?",
  "talk more",
  "@move",
  "@blunder",
  "how am I doing?",
  "@move",
  "@move",
  "I resign",
  "how could I have played better",
];

export interface Candidate {
  say: string;
  /** Accepted SAN spellings ("Nd2" and "Nbd2" are the same move in different positions). */
  san: string[];
}

/** A quiet Italian-style setup, garbled lines included; spares at the end for when some are skipped. */
export const OPENING: Candidate[] = [
  { say: "pawn e4", san: ["e4"] },
  { say: "night free|knight f3", san: ["Nf3"] },
  { say: "Pondicherry|pawn d3", san: ["d3"] },
  { say: "bishop e2", san: ["Be2"] },
  { say: "castle kingside", san: ["O-O"] },
  { say: "pawn c3", san: ["c3"] },
  { say: "porn D4|pawn d4", san: ["d4"] },
  { say: "knight d2", san: ["Nbd2", "Nd2"] },
  { say: "pawn h3", san: ["h3"] },
  { say: "pawn a3", san: ["a3"] },
  { say: "rook e1", san: ["Re1", "Rfe1"] },
  { say: "queen c2", san: ["Qc2"] },
  { say: "bishop e3", san: ["Be3"] },
  { say: "pawn b4", san: ["b4"] },
];

/** Moves that usually hang a piece; the first legal one is played. */
export const BLUNDERS: Candidate[] = [
  { say: "bishop to a6", san: ["Ba6"] },
  { say: "queen to h5", san: ["Qh5"] },
  { say: "queen to g4", san: ["Qg4"] },
  { say: "bishop to b5", san: ["Bb5"] },
  { say: "bishop to g5", san: ["Bg5"] },
];

const PIECE_WORDS: Record<string, string> = { N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" };

/** "Nxe5" -> "knight takes e5", "dxe4" -> "pawn takes e4", "O-O" -> "castle kingside". */
export function spokenSan(san: string): string {
  const s = san.replace(/[+#!?]/g, "");
  if (s.startsWith("O-O-O")) return "castle queenside";
  if (s.startsWith("O-O")) return "castle kingside";
  const target = s.match(/([a-h][1-8])(=[QRBN])?$/);
  const piece = PIECE_WORDS[s[0]] ?? "pawn";
  const promo = target?.[2] ? ` promote to ${PIECE_WORDS[target[2][1]]}` : "";
  return `${piece} ${s.includes("x") ? "takes" : "to"} ${target?.[1] ?? s}${promo}`;
}

/**
 * White's next move: take back if the engine just captured and we can, otherwise the first legal move left
 * in `queue` (removed from it), otherwise any legal move. `legal` is the server's SAN list.
 */
export function pickMove(legal: string[], queue: Candidate[], lastEngineMove?: string): Candidate | undefined {
  const plain = legal.map((m) => m.replace(/[+#]/g, ""));
  const captured = lastEngineMove?.includes("x") ? squaresIn(lastEngineMove.replace(/=.*/, "")).at(-1) : undefined;
  const recapture = captured ? plain.find((m) => m.includes(`x${captured}`)) : undefined;
  if (recapture) return { say: spokenSan(recapture), san: [recapture] };
  const i = queue.findIndex((c) => c.san.some((s) => plain.includes(s)));
  if (i >= 0) return queue.splice(i, 1)[0];
  return plain[0] ? { say: spokenSan(plain[0]), san: [plain[0]] } : undefined;
}

// ---------- pure metrics ----------

export interface EvalTurn {
  user: string;
  alternatives: string[];
  /** For move turns: the SAN the script meant by what it said. */
  planned?: string[];
  reply: string;
  toolCalls: ToolTrace[];
  /** Raw chess-server results this turn (fen and ids dropped): the facts the reply may draw on. */
  toolResults: { name: string; isError: boolean; data: Record<string, unknown> }[];
  ms: number;
  usage: TurnResult["usage"];
  error?: string;
}

/** Approximate on-demand prices per 1M tokens (same sources as scripts/ab.ts). */
export const PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  "apac.amazon.nova-pro-v1:0": { inPerM: 0.8, outPerM: 3.2 },
  "apac.amazon.nova-lite-v1:0": { inPerM: 0.06, outPerM: 0.24 },
  "global.amazon.nova-2-lite-v1:0": { inPerM: 0.3, outPerM: 2.5 },
};

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[a-z0-9]/i.test(s));
}

const MOVE_TOKEN = /^([kqrbn]?[a-h]?[1-8]?x?[a-h][1-8](=[qrbn])?|o-o(-o)?|0-0(-0)?)$/;

/**
 * n-word phrases that occur in two or more different replies, most widespread first.
 * Moves and squares become "<move>", so "You played e4. I play e5." and "You played Nf3. I play Nc6." share a template.
 */
export function repeatedPhrases(replies: string[], n = 3): { phrase: string; replies: number }[] {
  const seen = new Map<string, number>();
  for (const reply of replies) {
    const w = words(reply).map((x) => (MOVE_TOKEN.test(x) ? "<move>" : x));
    const grams = new Set<string>();
    for (let i = 0; i + n <= w.length; i++) grams.add(w.slice(i, i + n).join(" "));
    for (const g of grams) seen.set(g, (seen.get(g) ?? 0) + 1);
  }
  return [...seen]
    .filter(([, count]) => count > 1)
    .map(([phrase, count]) => ({ phrase, replies: count }))
    .sort((a, b) => b.replies - a.replies || a.phrase.localeCompare(b.phrase));
}

/** True when the reply's last sentence hands the turn back ("Your move.", "Over to you!"). */
export function endsWithHandback(reply: string): boolean {
  const last = sentences(reply).at(-1) ?? "";
  return /\b(your (next )?(move|turn)|over to you)\W*$/i.test(last);
}

/** First words used by more than one reply, with counts. */
export function repeatedFirstWords(replies: string[]): { word: string; replies: number }[] {
  const counts = new Map<string, number>();
  for (const r of replies) {
    const first = words(r)[0];
    if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c > 1)
    .map(([word, c]) => ({ word, replies: c }))
    .sort((a, b) => b.replies - a.replies || a.word.localeCompare(b.word));
}

const MOVE_CLAIM = /\b(you played|I play|I['’]ll play|I respond)\b/i;
const GROUNDING_TOOLS = ["make_move", "new_game"];

/** A reply that announces moves although no move was made this turn (no successful make_move / new_game). */
export function isMadeUpClaim(reply: string, toolCalls: Pick<ToolTrace, "name" | "isError">[], groundingTools = GROUNDING_TOOLS): boolean {
  if (!MOVE_CLAIM.test(reply)) return false;
  return !toolCalls.some((c) => groundingTools.includes(c.name) && !c.isError);
}

/** Board squares named in a text ("e4", "Nf3" -> f3, "Bxa6" -> a6), lower-case, in order. */
export function squaresIn(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[a-h][1-8](?![0-9])/g)].map((m) => m[0]);
}

/**
 * Squares the reply names that appear neither in what the user said nor in any chess-server result this turn.
 * Catches "I answer with pawn to d4" when the server said e5, and advice made up without a tool call.
 */
export function ungroundedSquares(reply: string, sources: string[]): string[] {
  const known = new Set(sources.flatMap(squaresIn));
  return [...new Set(squaresIn(reply).filter((s) => !known.has(s)))];
}

/** The engine replied with `engineMove` (SAN) but the reply never says where it went. */
export function engineMoveMissing(reply: string, engineMove: string): boolean {
  if (/^O-O/i.test(engineMove)) return !/\bcastl/i.test(reply);
  const target = squaresIn(engineMove.replace(/=.*/, "")).at(-1);
  return !!target && !squaresIn(reply).includes(target);
}

/** Drops fields whose characters look like squares without being facts (FEN ranks such as "r1bq", uuids). */
export function factsOnly(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data, (key, value) => (/^(fen|gameId|sessionId|id)$/i.test(key) ? undefined : value)));
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Cache reads are billed at about a quarter of the input price; cache writes at the input price. */
export function estimateCost(usage: Omit<TurnResult["usage"], "rounds">, price: { inPerM: number; outPerM: number } | undefined): number | undefined {
  if (!price) return undefined;
  return (
    (usage.inputTokens * price.inPerM + usage.cacheWriteTokens * price.inPerM + usage.cacheReadTokens * price.inPerM * 0.25 + usage.outputTokens * price.outPerM) / 1e6
  );
}

export function computeMetrics(turns: EvalTurn[], modelId: string) {
  const answered = turns.filter((t) => !t.error);
  const replies = answered.map((t) => t.reply);
  const phrases = repeatedPhrases(replies);
  const sentenceCounts = replies.map((r) => sentences(r).length);
  const wordCounts = replies.map((r) => words(r).length);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const toolErrors = turns.flatMap((t, i) => t.toolCalls.filter((c) => c.isError).map((c) => ({ turn: i + 1, tool: c.name, args: c.args, speech: c.speech })));
  const madeUp = turns.flatMap((t, i) => (!t.error && isMadeUpClaim(t.reply, t.toolCalls) ? [{ turn: i + 1, user: t.user, reply: t.reply }] : []));
  const ungrounded = turns.flatMap((t, i) => {
    const squares = t.error ? [] : ungroundedSquares(t.reply, [t.user, ...t.alternatives, ...t.toolResults.map((r) => JSON.stringify(r.data))]);
    return squares.length ? [{ turn: i + 1, squares, reply: t.reply }] : [];
  });
  const missedEngine = turns.flatMap((t, i) =>
    t.toolResults.flatMap((r) => {
      const move = r.name === "make_move" && !r.isError ? r.data.engineMove : undefined;
      return typeof move === "string" && engineMoveMissing(t.reply, move) ? [{ turn: i + 1, engineMove: move, reply: t.reply }] : [];
    }),
  );
  const latencies = turns.map((t) => t.ms);
  const tokens = turns.reduce(
    (s, t) => ({
      inputTokens: s.inputTokens + t.usage.inputTokens,
      outputTokens: s.outputTokens + t.usage.outputTokens,
      cacheReadTokens: s.cacheReadTokens + t.usage.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens + t.usage.cacheWriteTokens,
      rounds: s.rounds + t.usage.rounds,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 0 },
  );
  const cost = estimateCost(tokens, PRICES[modelId]);
  const handbacks = replies.filter(endsWithHandback).length;
  return {
    turns: turns.length,
    failedTurns: turns.length - answered.length,
    repeatedPhrases: { count: phrases.length, examples: phrases.slice(0, 15) },
    handbackEndingPct: replies.length ? round((100 * handbacks) / replies.length, 1) : 0,
    avgSentencesPerReply: round(avg(sentenceCounts)),
    avgWordsPerReply: round(avg(wordCounts), 1),
    repeatedFirstWords: repeatedFirstWords(replies),
    toolErrors: { count: toolErrors.length, list: toolErrors },
    madeUpClaims: { count: madeUp.length, list: madeUp },
    ungroundedSquares: { turns: ungrounded.length, list: ungrounded },
    engineMoveNotSaid: { count: missedEngine.length, list: missedEngine },
    latencyMs: { perTurn: latencies, avg: Math.round(avg(latencies)), p50: percentile(latencies, 50), p90: percentile(latencies, 90), max: Math.max(0, ...latencies) },
    tokens: { ...tokens, perTurnIn: Math.round(tokens.inputTokens / Math.max(1, turns.length)), perTurnOut: Math.round(tokens.outputTokens / Math.max(1, turns.length)) },
    costUsd: cost === undefined ? null : { total: round(cost, 5), perTurn: round(cost / Math.max(1, turns.length), 6), per60TurnGame: round((60 * cost) / Math.max(1, turns.length), 4) },
  };
}

export type Metrics = ReturnType<typeof computeMetrics>;

export function formatMetrics(m: Metrics): string {
  const lines = [
    `turns: ${m.turns}${m.failedTurns ? ` (${m.failedTurns} failed)` : ""}`,
    `repeated 3-word phrases: ${m.repeatedPhrases.count}  e.g. ${m.repeatedPhrases.examples.slice(0, 8).map((p) => `"${p.phrase}"×${p.replies}`).join(", ") || "-"}`,
    `ends with "your move/turn/over to you": ${m.handbackEndingPct}%`,
    `avg per reply: ${m.avgSentencesPerReply} sentences, ${m.avgWordsPerReply} words`,
    `repeated first words: ${m.repeatedFirstWords.map((w) => `${w.word}×${w.replies}`).join(", ") || "-"}`,
    `tool errors: ${m.toolErrors.count}${m.toolErrors.list.map((e) => `\n   #${e.turn} ${e.tool} ${JSON.stringify(e.args)}: ${e.speech ?? ""}`).join("")}`,
    `made-up move claims: ${m.madeUpClaims.count}${m.madeUpClaims.list.map((c) => `\n   #${c.turn} "${c.user}" -> ${c.reply}`).join("")}`,
    `replies naming squares no tool or user mentioned this turn: ${m.ungroundedSquares.turns}${m.ungroundedSquares.list.map((u) => `\n   #${u.turn} [${u.squares.join(" ")}] ${u.reply}`).join("")}`,
    `engine replies the reply never says: ${m.engineMoveNotSaid.count}${m.engineMoveNotSaid.list.map((e) => `\n   #${e.turn} ${e.engineMove}: ${e.reply}`).join("")}`,
    `latency: avg ${m.latencyMs.avg} ms, p50 ${m.latencyMs.p50}, p90 ${m.latencyMs.p90}, max ${m.latencyMs.max}`,
    `tokens: ${m.tokens.inputTokens} in + ${m.tokens.outputTokens} out + ${m.tokens.cacheReadTokens} cache read + ${m.tokens.cacheWriteTokens} cache write (${m.tokens.rounds} model calls; ${m.tokens.perTurnIn} in / ${m.tokens.perTurnOut} out per turn)`,
    `cost: ${m.costUsd ? `$${m.costUsd.total} total, $${m.costUsd.perTurn}/turn, ≈ $${m.costUsd.per60TurnGame} per 60-turn game` : "unknown price for this model"}`,
  ];
  return lines.join("\n");
}

// ---------- runner ----------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [{ BedrockRuntimeClient, ConverseCommand }, { runTurn }, { McpChessTools }, { MemorySessionStore }] = await Promise.all([
    import("@aws-sdk/client-bedrock-runtime"),
    import("../src/agent.js"),
    import("../src/mcpClient.js"),
    import("../src/sessions.js"),
  ]);
  const modelId = arg("model") ?? process.env.MODEL_ID ?? "global.amazon.nova-2-lite-v1:0";
  const label = arg("label") ?? "run";
  const mcpUrl = process.env.MCP_URL ?? "http://127.0.0.1:3001/mcp";
  const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-south-1" });
  // Records every raw chess-server result, so replies can be checked against what the server actually said.
  const mcp = new McpChessTools(mcpUrl, async () => "local");
  let recorded: EvalTurn["toolResults"] = [];
  const tools: ChessTools = {
    listTools: () => mcp.listTools(),
    async callTool(name, args) {
      const r = await mcp.callTool(name, args);
      recorded.push({ name, isError: r.isError, data: factsOnly(r.data) });
      return r;
    },
  };
  const deps = {
    converse: (input: any) => bedrock.send(new ConverseCommand(input)),
    tools,
    sessions: new MemorySessionStore(),
    modelId,
  };
  const startedAt = new Date();
  const sessionId = `eval-${label}-${startedAt.getTime()}`;
  console.log(`================ ${label}: ${modelId} ================`);

  const turns: EvalTurn[] = [];
  const queue = structuredClone(OPENING);
  let lastEngineMove: string | undefined;
  for (const [i, step] of SCRIPT.entries()) {
    let line = step;
    let planned: string[] | undefined;
    if (step === "@move" || step === "@blunder") {
      // Asked of the server directly, so it doesn't show up as one of the agent's tool calls.
      const gameId = (await deps.sessions.get(sessionId))?.gameId;
      const legal = gameId ? await mcp.callTool("legal_moves", { gameId }) : undefined;
      const moves = legal && !legal.isError && Array.isArray(legal.data.moves) ? (legal.data.moves as string[]) : [];
      const blunder = step === "@blunder" ? BLUNDERS.find((c) => c.san.some((s) => moves.some((m) => m.replace(/[+#]/g, "") === s))) : undefined;
      const pick = blunder ?? pickMove(moves, queue, lastEngineMove);
      line = pick?.say ?? "pawn e4";
      planned = pick?.san;
    }
    const [text, ...alts] = line.split("|");
    const alternatives = alts.length ? [text, ...alts] : [];
    const t = Date.now();
    recorded = [];
    try {
      const r = await runTurn(deps, sessionId, { text, alternatives });
      const toolCalls = r.toolCalls.map((c) => ({ ...c, args: factsOnly(c.args) }));
      const turn: EvalTurn = { user: text, alternatives, planned, reply: r.reply, toolCalls, toolResults: recorded, ms: Date.now() - t, usage: r.usage };
      turns.push(turn);
      const engineMove = [...recorded].reverse().find((x) => x.name === "make_move" && !x.isError && typeof x.data.engineMove === "string")?.data.engineMove;
      if (typeof engineMove === "string") lastEngineMove = engineMove;
      const used = toolCalls.map((c) => `${c.name}${Object.keys(c.args).length ? JSON.stringify(c.args) : ""}${c.isError ? " ✗" : ""}`).join(", ") || "-";
      const flags = computeMetrics([turn], modelId);
      const warn = [
        flags.madeUpClaims.count && "made-up claim",
        flags.ungroundedSquares.turns && `ungrounded ${flags.ungroundedSquares.list[0].squares.join(" ")}`,
        flags.engineMoveNotSaid.count && `engine move ${flags.engineMoveNotSaid.list[0].engineMove} not said`,
      ].filter(Boolean);
      console.log(`\n#${i + 1} 🧑 ${line}\n   🔧 ${used}\n   🔵 ${r.reply}  (${turn.ms} ms)${warn.length ? `\n   ⚠ ${warn.join("; ")}` : ""}`);
    } catch (err) {
      const turn: EvalTurn = { user: text, alternatives, planned, reply: "", toolCalls: [], toolResults: recorded, ms: Date.now() - t, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 0 }, error: String(err) };
      turns.push(turn);
      console.log(`\n#${i + 1} 🧑 ${line}\n   💥 ${turn.error!.slice(0, 200)}`);
    }
  }

  const metrics = computeMetrics(turns, modelId);
  console.log(`\n📊 ${label} (${modelId})\n${formatMetrics(metrics)}`);

  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../eval-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "*\n");
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}-${label.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ label, modelId, mcpUrl, startedAt: startedAt.toISOString(), script: SCRIPT, turns, metrics }, null, 2));
  console.log(`\n💾 ${file}`);
}

const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
