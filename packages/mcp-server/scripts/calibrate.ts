import { mkdirSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { LEVELS, analyse, engineMove } from "../src/chess/engine.js";

// How strong each level really plays. Self-play between neighbouring levels, judged by full-strength analysis:
//   - average centipawn loss (ACPL) and blunders (a move losing 300+ cp) per game, for each level;
//   - the score of each level against the one below (it must win clearly) and the Elo gap that implies;
//   - the time per move, which must stay well under a second on Lambda.
// Human ACPL bands to aim for (rough public figures): ~800: 120+, ~1100: ~90, ~1500: 60-70, ~2000: ~40, ~2500: 20-25.
//
//   npx tsx scripts/calibrate.ts [--games 6] [--levels 1,2,3,4,5,6,7] [--timing] [--max-plies 160]

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GAMES = Number(opt("games", "6"));
const LEVEL_LIST = opt("levels", "1,2,3,4,5,6,7").split(",").map(Number);
const MAX_PLIES = Number(opt("max-plies", "160"));
const ANALYSIS_DEPTH = 10;
const CAP = 1000; // centipawn loss per move is capped: a missed mate is not worth 100000

/** Score for the side to move after `moves`, centipawns (mate folded in by the engine, capped here). */
async function evalNow(moves: string[]): Promise<number> {
  const r = await analyse(moves, undefined, ANALYSIS_DEPTH);
  return Math.max(-5000, Math.min(5000, r.scoreCp ?? 0));
}

if (args.includes("--timing")) {
  const positions = [
    [],
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"],
    ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "c1g5", "f8e7", "e2e3", "e8g8", "g1f3", "b8d7"],
  ];
  for (const level of LEVEL_LIST) {
    const ms: number[] = [];
    for (const p of positions) {
      const t = Date.now();
      await engineMove(p, level);
      ms.push(Date.now() - t);
    }
    console.log(`level ${level} (${LEVELS[level].label}): ${ms.join(", ")} ms`);
  }
  process.exit(0);
}

interface LevelStats { moves: number; lossSum: number; blunders: number; games: number; moveMs: number }
const stats = new Map<number, LevelStats>();
const statOf = (l: number) => {
  if (!stats.has(l)) stats.set(l, { moves: 0, lossSum: 0, blunders: 0, games: 0, moveMs: 0 });
  return stats.get(l)!;
};

/** One game; returns 1 / 0.5 / 0 for White. Adjudicated when one side is 10 pawns up for 4 plies running. */
async function play(white: number, black: number): Promise<number> {
  const chess = new Chess();
  const moves: string[] = [];
  let before = await evalNow(moves);
  let lopsided = 0;
  statOf(white).games++;
  statOf(black).games++;
  for (let ply = 0; ply < MAX_PLIES && !chess.isGameOver(); ply++) {
    const level = chess.turn() === "w" ? white : black;
    const t = Date.now();
    const uci = await engineMove(moves, level);
    const st = statOf(level);
    st.moveMs += Date.now() - t;
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    moves.push(uci);
    const after = chess.isCheckmate() ? -5000 : chess.isGameOver() ? 0 : await evalNow(moves);
    const loss = Math.min(CAP, Math.max(0, before - -after));
    st.moves++;
    st.lossSum += loss;
    if (loss >= 300) st.blunders++;
    before = after;
    lopsided = Math.abs(after) >= 1000 ? lopsided + 1 : 0;
    if (lopsided >= 4) {
      const sideToMoveWins = after > 0;
      const whiteToMove = chess.turn() === "w";
      return sideToMoveWins === whiteToMove ? 1 : 0;
    }
  }
  if (chess.isCheckmate()) return chess.turn() === "w" ? 0 : 1;
  if (chess.isGameOver()) return 0.5;
  // Move cap: a clear advantage counts as a win, otherwise a draw.
  const whiteEval = chess.turn() === "w" ? before : -before;
  return whiteEval > 300 ? 1 : whiteEval < -300 ? 0 : 0.5;
}

const pairs: { low: number; high: number; score: number; games: number }[] = [];
const started = Date.now();
for (let i = 0; i + 1 < LEVEL_LIST.length; i++) {
  const low = LEVEL_LIST[i];
  const high = LEVEL_LIST[i + 1];
  let score = 0;
  for (let g = 0; g < GAMES; g++) {
    const highIsWhite = g % 2 === 0;
    const r = await play(highIsWhite ? high : low, highIsWhite ? low : high);
    score += highIsWhite ? r : 1 - r;
    process.stdout.write(highIsWhite ? (r === 1 ? "W" : r === 0 ? "L" : "D") : r === 0 ? "W" : r === 1 ? "L" : "D");
  }
  pairs.push({ low, high, score, games: GAMES });
  console.log(`  level ${high} vs ${low}: ${score}/${GAMES}`);
}

/** Elo gap implied by a score fraction, clamped so a 100% score reads as "400+". */
const eloGap = (s: number) => {
  const p = Math.min(0.97, Math.max(0.03, s));
  return Math.round(-400 * Math.log10(1 / p - 1));
};

console.log(`\n${((Date.now() - started) / 60000).toFixed(1)} min`);
console.log("level | label | games | ACPL | blunders/game | ms/move");
const levelRows = LEVEL_LIST.map((l) => {
  const s = statOf(l);
  const row = { level: l, label: LEVELS[l].label, games: s.games, acpl: Math.round(s.lossSum / Math.max(1, s.moves)), blundersPerGame: +(s.blunders / Math.max(1, s.games)).toFixed(1), msPerMove: Math.round(s.moveMs / Math.max(1, s.moves)) };
  console.log(`${row.level} | ${row.label} | ${row.games} | ${row.acpl} | ${row.blundersPerGame} | ${row.msPerMove}`);
  return row;
});
console.log("\npair | score of the stronger | implied Elo gap");
for (const p of pairs) console.log(`${p.high} vs ${p.low} | ${p.score}/${p.games} | ${p.score === p.games ? "400+" : eloGap(p.score / p.games)}`);

mkdirSync("eval-results", { recursive: true });
const file = `eval-results/calibration-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), games: GAMES, levels: LEVELS, results: levelRows, pairs }, null, 2));
console.log(`\nsaved ${file}`);
process.exit(0);
