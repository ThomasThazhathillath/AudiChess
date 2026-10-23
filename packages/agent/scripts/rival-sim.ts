import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn, type AgentDeps } from "../src/agent.js";
import { ENDINGS, PRAISE, TAUNTS } from "../src/banter.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";
import { spokenSan } from "./converse-eval.js";

// Whole games through the real agent (brief mode, the default) and the local chess server, with no model at all:
// move turns never need one. Measures what Phase 8 changed:
//   - how often she jabs or compliments, and that the line fits (a jab after a blunder, praise after a good move);
//   - how long her move replies are;
//   - that nothing coaches ("careful", "under attack", "was better", "you should");
//   - how a simulated casual player (half engine moves, half random) does against each level.
// It costs nothing: no Bedrock (a model call fails the run).
//   PORT=3011 npm run dev --prefix packages/mcp-server   then   npm run rival -- [--games 4] [--levels 1,2,3,4,5,6] [--best 0.55]

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GAMES = Number(opt("games", "4"));
const LEVELS = opt("levels", "1,2,3,4,5,6").split(",").map(Number);
const BEST_SHARE = Number(opt("best", "0.55")); // the simulated player's engine-move share; the rest are random
const MAX_TURNS = 90;
const COACHING = /\b(careful|under attack|was better|you should|watch out|hanging|threaten|consider)\b/i;

const tools = new McpChessTools(process.env.MCP_URL ?? "http://127.0.0.1:3011/mcp", async () => "local");
let modelCalls = 0;
let lastSaid = "";
const modelTurns: string[] = [];
const deps: AgentDeps = {
  // A stand-in that only counts: a model call here means a move turn left the fast path (reported at the end).
  converse: async () => {
    modelCalls++;
    modelTurns.push(lastSaid);
    return { output: { message: { role: "assistant", content: [{ text: "Say that again?" }] } }, stopReason: "end_turn" } as never;
  },
  tools,
  sessions: new MemorySessionStore(),
  modelId: "none",
};

const taunts = new Set(Object.values(TAUNTS).flat());
const praise = new Set(Object.values(PRAISE).flat());
const endings = new Set(Object.values(ENDINGS).flat());
/** The jab or compliment at the end of a reply, if any. */
function remarkOf(reply: string): "taunt" | "praise" | "ending" | undefined {
  for (const [kind, pool] of [["taunt", taunts], ["praise", praise], ["ending", endings]] as const) {
    for (const line of pool) if (reply.includes(line)) return kind;
  }
  return undefined;
}

interface LevelStats {
  games: number;
  userPoints: number;
  moveReplies: number;
  words: number[];
  remarks: { taunt: number; praise: number; ending: number };
  coaching: string[];
  errors: number;
}

const results: Record<number, LevelStats> = {};
const samples: string[] = [];

for (const level of LEVELS) {
  const s: LevelStats = { games: 0, userPoints: 0, moveReplies: 0, words: [], remarks: { taunt: 0, praise: 0, ending: 0 }, coaching: [], errors: 0 };
  results[level] = s;
  for (let g = 0; g < GAMES; g++) {
    const game = await tools.callTool("new_game", { color: "white", level });
    const gameId = String(game.data.gameId);
    const sessionId = `rival-${level}-${g}-${Date.now()}`;
    await deps.sessions.put({ sessionId, gameId, humanColor: "White", level, turns: [], updatedAt: "", expiresAt: 0 });
    s.games++;
    let over = false;
    for (let turn = 0; turn < MAX_TURNS && !over; turn++) {
      const legal = await tools.callTool("legal_moves", { gameId });
      const moves = Array.isArray(legal.data.moves) ? (legal.data.moves as string[]) : [];
      if (!moves.length) break;
      let san = moves[Math.floor(Math.random() * moves.length)];
      if (Math.random() < BEST_SHARE) {
        const hint = await tools.callTool("hint", { gameId, count: 1 });
        const best = (hint.data.options as { san?: string }[] | undefined)?.[0]?.san;
        if (best) san = best;
      }
      const said = spokenSan(san);
      lastSaid = `${said} (${san})`;
      let r = await runTurn(deps, sessionId, { text: said, alternatives: [said] });
      // "Which knight?": answer with the file or rank the SAN disambiguates by.
      for (let ask = 0; ask < 2 && /^(?:Which |Did you mean |Castle which way)/.test(r.reply); ask++) {
        const d = /^[NBRQK]([a-h1-8])x?[a-h][1-8]/.exec(san)?.[1] ?? /^([a-h])x/.exec(san)?.[1] ?? (san.startsWith("O-O-O") ? "queenside" : "kingside");
        lastSaid = `"${d}" after "${r.reply}" (${san})`;
        r = await runTurn(deps, sessionId, { text: d, alternatives: [d] });
      }
      const trace = r.toolCalls.find((t) => t.name === "make_move");
      if (!trace || trace.isError) {
        s.errors++;
        samples.push(`  [L${level}] ✗ "${said}" -> ${r.reply}`);
        continue;
      }
      s.moveReplies++;
      const words = r.reply.split(/\s+/).filter(Boolean).length;
      s.words.push(words);
      const remark = remarkOf(r.reply);
      if (remark) s.remarks[remark]++;
      if (COACHING.test(r.reply)) s.coaching.push(r.reply);
      const status = await tools.callTool("game_status", { gameId });
      const rec = r.reply;
      if (samples.length < 400 && remark) samples.push(`  [L${level}] ${remark.padEnd(6)} ${rec}`);
      over = r.gameOver || status.data.status !== "active";
      if (over) {
        const result = String(status.data.result ?? "");
        const points = result === "1-0" ? 1 : result === "1/2-1/2" ? 0.5 : 0;
        s.userPoints += points;
        samples.push(`  [L${level}] END    ${rec}`);
      }
    }
    if (!over) {
      // Unfinished after MAX_TURNS: scored by the material balance.
      const st = await tools.callTool("game_status", { gameId });
      const diff = Number((st.data.material as { white?: number; black?: number } | undefined)?.white ?? 0) - Number((st.data.material as { black?: number } | undefined)?.black ?? 0);
      s.userPoints += diff >= 3 ? 1 : diff <= -3 ? 0 : 0.5;
    }
    process.stdout.write(".");
  }
}

console.log(`\nmodel calls: ${modelCalls} (move turns should need none)`);
for (const t of [...new Set(modelTurns)].slice(0, 10)) console.log(`  model needed for: ${t}`);
console.log("");
console.log("level | games | user score | move replies | avg / max words | remarks: taunt / praise / ending | remark rate | coaching | errors");
const rows = LEVELS.map((level) => {
  const s = results[level];
  const avg = s.words.reduce((a, b) => a + b, 0) / Math.max(1, s.words.length);
  const remarks = s.remarks.taunt + s.remarks.praise + s.remarks.ending;
  const row = { level, games: s.games, userScore: `${s.userPoints}/${s.games}`, moveReplies: s.moveReplies, avgWords: +avg.toFixed(1), maxWords: Math.max(0, ...s.words), ...s.remarks, remarkRate: +(remarks / Math.max(1, s.moveReplies)).toFixed(2), coaching: s.coaching.length, errors: s.errors };
  console.log(`${level} | ${row.games} | ${row.userScore} | ${row.moveReplies} | ${row.avgWords} / ${row.maxWords} | ${row.taunt} / ${row.praise} / ${row.ending} | ${row.remarkRate} | ${row.coaching} | ${row.errors}`);
  return row;
});
for (const level of LEVELS) for (const c of results[level].coaching.slice(0, 5)) console.log(`  coaching at L${level}: ${c}`);
console.log("\nsample remarks:");
for (const line of samples.slice(0, 40)) console.log(line);

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "eval-results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `rival-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ games: GAMES, bestShare: BEST_SHARE, rows, samples, modelCalls, modelTurns }, null, 2));
console.log(`\nsaved ${file}`);
process.exit(0);
