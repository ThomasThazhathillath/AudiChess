import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { runTurn, type AgentDeps } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";
import { QUESTIONS } from "../eval/questions.js";

// Simulated hands-free games: spoken moves (with the mishearings seen from Chrome and Transcribe), background
// chatter heard without "Alexa", and questions from the user's list, all through the real agent.
//   (packages/mcp-server: PORT=3011 npm run dev)   then   npm run sim -- [--games 3] [--moves 20] [--seed 1]
// Reports move accuracy, how much background got through, question answer rate and latency per turn type.

const args = process.argv.slice(2);
const opt = (name: string, d: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : d);
const GAMES = Number(opt("games", "3"));
const MOVES = Number(opt("moves", "20"));
let seed = Number(opt("seed", "7"));
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-south-1" });
const tools = new McpChessTools(process.env.MCP_URL ?? "http://127.0.0.1:3011/mcp", async () => "local");
const sessions = new MemorySessionStore();
const deps: AgentDeps = {
  converse: (input) => bedrock.send(new ConverseCommand(input)),
  tools,
  sessions,
  modelId: process.env.MODEL_ID ?? "global.amazon.nova-2-lite-v1:0",
};

// Heard in real games, or typical room noise: none of it is for Alexa.
const BACKGROUND = [
  "Correct.", "Yeah.", "I.", "In the.", "Gala appeared in a coral.", "Then it's supposed to.", "born to be.", "Uh.",
  "haan ji main aa raha hoon", "call me back later", "what's for dinner tonight", "it's raining outside",
  "turn off the TV please", "okay okay", "no no no I told you yesterday", "where did I keep my phone",
  "the meeting is at five", "Mummy, I'm coming", "that's what she said", "hmm",
];
// Questions that change the game are left out: the simulation keeps playing the same game.
const SKIP = /new game|play as|against a|make the move|move my knight|castle kingside for me|undo|redo|restart|pause|resume|resign|offer a draw|accept a draw|rematch|take back|handicap|speak more slowly|confirm each move|easier moves|aggressively|defensively|stronger opponent|beginner\?$/i;
const ASKABLE = QUESTIONS.filter((q) => !SKIP.test(q.text) && !["game_over", "no_game"].includes(q.scenario));

const PIECE = { N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" } as Record<string, string>;
const RANK_WORD = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** How a person says the move, and sometimes how speech recognition writes it back. */
function spoken(san: string): string {
  const s = san.replace(/[+#]$/, "");
  if (s === "O-O") return pick(["castle kingside", "castles king side", "castle short"]);
  if (s === "O-O-O") return pick(["castle queenside", "castles queen side", "castle long"]);
  const m = /^([NBRQK])?([a-h])?([1-8])?(x)?([a-h])([1-8])(=([NBRQ]))?$/.exec(s);
  if (!m) return s;
  const [, p, fromFile, , cap, f, r, , promo] = m;
  const sq = `${f}${r}`;
  const piece = p ? PIECE[p] : "pawn";
  const mangledPiece = p === "N" ? pick(["knight", "night", "knight"]) : !p ? pick(["pawn", "pawn", "porn", "pond"]) : piece;
  const square = pick([sq, `${f} ${r}`, `${f} ${RANK_WORD[Number(r)]}`, sq]);
  const verb = cap ? pick(["takes", "takes", "captures"]) : pick(["to", "", ""]);
  let say = [mangledPiece, p && fromFile ? `from ${fromFile}` : !p && cap ? `on ${fromFile}` : "", verb, square].filter(Boolean).join(" ");
  if (!p && !cap && f === "d" && rand() < 0.5) say = `2${r}`; // Transcribe: "pawn dee four" -> "24"
  if (promo) say += ` promote to ${PIECE[promo]}`;
  return say.replace(/\s+/g, " ").trim();
}

interface Turn { kind: "move" | "background" | "question" | "confirm"; text: string; woken: boolean; ms: number; ok: boolean; reply: string; note?: string }

async function playGame(g: number): Promise<Turn[]> {
  const sessionId = `sim-${g}-${Date.now()}`;
  const color = g % 2 === 0 ? "white" : "black";
  const r = await tools.callTool("new_game", { color, level: 2 + (g % 3), sessionId });
  const gameId = String(r.data.gameId);
  await sessions.put({ sessionId, gameId, humanColor: color === "white" ? "White" : "Black", level: 2, gameOver: false, turns: [], updatedAt: "", expiresAt: 0 });
  const turns: Turn[] = [];
  const say = async (kind: Turn["kind"], text: string, woken: boolean) => {
    const t = Date.now();
    const res = await runTurn(deps, sessionId, { text: woken ? `Alexa, ${text}` : text, alternatives: [woken ? `Alexa, ${text}` : text], woken });
    return { res, ms: Date.now() - t };
  };

  for (let i = 0; i < MOVES; i++) {
    // Background chatter now and then, never with the wake word.
    if (rand() < 0.35) {
      const text = pick(BACKGROUND);
      const { res, ms } = await say("background", text, false);
      turns.push({ kind: "background", text, woken: false, ms, ok: res.ignored === true, reply: res.reply });
    }
    // A question now and then, mostly in conversation mode.
    if (rand() < 0.3) {
      const q = pick(ASKABLE);
      const woken = rand() < 0.3;
      const { res, ms } = await say("question", q.text, woken);
      turns.push({ kind: "question", text: q.text, woken, ms, ok: !res.ignored && res.reply.length > 0, reply: res.reply, note: res.toolCalls.map((c) => c.name).join(",") });
    }
    // The move: the engine's best half the time, otherwise a random legal move.
    const hist = await tools.callTool("game_history", { gameId });
    if (hist.data.status !== "active") break;
    const legal = (await tools.callTool("legal_moves", { gameId })).data.moves as string[];
    if (!legal?.length) break;
    const san = rand() < 0.5 ? String(((await tools.callTool("hint", { gameId })).data.options as any[])?.[0]?.san ?? pick(legal)) : pick(legal);
    const before = ((hist.data.moves as unknown[]) ?? []).length;
    const text = spoken(san);
    const woken = rand() < 0.25;
    let { res, ms } = await say("move", text, woken);
    let note = "";
    if (res.toolCalls.some((c) => c.name === "make_move") && /Did you mean|Which /.test(res.reply)) {
      // Asked to confirm: answer like a person would (yes, or the right piece's square).
      note = `asked: ${res.reply}`;
      const again = await say("confirm", "yes", false);
      ms += again.ms;
      res = again.res;
    }
    const after = await tools.callTool("game_history", { gameId });
    const moves = (after.data.moves as { san: string; by: string }[]) ?? [];
    const played = moves.slice(before).find((m) => m.by === "human")?.san;
    const ok = played?.replace(/[+#]$/, "") === san.replace(/[+#]$/, "");
    turns.push({ kind: "move", text: `${text} (${san})`, woken, ms, ok, reply: res.reply, note: ok ? note : `${note} played ${played ?? "nothing"}` });
    console.log(`g${g} ${ok ? "ok " : "BAD"} ${String(ms).padStart(5)}ms ${woken ? "ALEXA " : "      "}${text} (${san}) -> ${res.reply}${note ? `  [${note}]` : ""}`);
    if (res.gameOver) break;
  }
  for (const t of turns.filter((x) => x.kind !== "move")) {
    console.log(`g${g} ${t.ok ? "ok " : "BAD"} ${String(t.ms).padStart(5)}ms ${t.kind.padEnd(10)} ${t.woken ? "ALEXA " : ""}${t.text} -> ${t.reply || "(ignored)"}${t.note ? `  [${t.note}]` : ""}`);
  }
  return turns;
}

const all: Turn[] = [];
for (let g = 0; g < GAMES; g++) all.push(...(await playGame(g)));

const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
console.log("\nturn type    count   ok      p50 ms   p90 ms");
for (const kind of ["move", "background", "question"] as const) {
  const ts = all.filter((t) => t.kind === kind);
  const ok = ts.filter((t) => t.ok).length;
  console.log(`${kind.padEnd(12)} ${String(ts.length).padStart(5)}   ${String(ts.length ? Math.round((100 * ok) / ts.length) : 0).padStart(3)}%   ${String(pctl(ts.map((t) => t.ms), 0.5)).padStart(6)}   ${String(pctl(ts.map((t) => t.ms), 0.9)).padStart(6)}`);
}
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "eval-results", `sim-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(all, null, 2));
console.log(`wrote ${out}`);
process.exit(0);
