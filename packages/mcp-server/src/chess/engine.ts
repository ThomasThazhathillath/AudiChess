import { createRequire } from "node:module";

// Stockfish 19 "lite single-threaded" WASM. On Lambda it comes from the alexa_chess_stockfish layer
// (/opt/nodejs/node_modules, on NODE_PATH); locally from the stockfish devDependency.
const nodeRequire = createRequire(import.meta.url);

interface StockfishInstance {
  processCommand(cmd: string): void;
  listener?: (line: string) => void;
}

/**
 * How a weak level picks its move: every legal move is scored by a shallow full-strength search, then one is drawn
 * with weight exp(-loss / temperature). With probability `blunderRate` it plays a move losing 150-900 centipawns
 * instead (a hung piece, a missed tactic): the way 500-1500 players actually lose games.
 */
export interface HumanStyle {
  depth: number;
  temperature: number;
  blunderRate: number;
}

export interface LevelConfig {
  label: string;
  movetimeMs: number;
  /** Stockfish's own limiter, for levels inside its range (UCI_Elo 1320-3190). */
  uciElo?: number;
  /** The human-like picker, for levels below Stockfish's floor (its weakest setting plays far above 800). */
  human?: HumanStyle;
}

/**
 * Difficulty 1-8. Stockfish 19 can't play below about 1320 (the UCI_Elo minimum; Skill 0 is about the same), and the
 * old levels 2-3 (Skill 3 / 6) were as strong as levels 5 and 7 (2026-10-17). Levels 1-4 use the human-like picker,
 * 5-7 Stockfish's Elo limiter. Tuned with scripts/calibrate.ts (docs/PLAN.md, Phase 8).
 * Round 1 (ACPL per level): 232, 183, 105, 73, then UCI_Elo 2000 = 72, 2500 = 55, 2800 = 21. Stockfish's limiter plays
 * far below its number with the lite network at these move times, so levels 5-7 use higher UCI_Elo values.
 * Round 2 (these settings, medium then at T 50): 193, 146, 101, 54, 39, 40, 37; every level beat the one below.
 */
export const LEVELS: Record<number, LevelConfig> = {
  1: { label: "beginner, about 500", human: { depth: 3, temperature: 260, blunderRate: 0.18 }, movetimeMs: 500 },
  2: { label: "easy, about 800", human: { depth: 5, temperature: 140, blunderRate: 0.08 }, movetimeMs: 500 },
  3: { label: "casual, about 1100", human: { depth: 6, temperature: 90, blunderRate: 0.045 }, movetimeMs: 600 },
  4: { label: "medium, about 1500", human: { depth: 8, temperature: 52, blunderRate: 0.022 }, movetimeMs: 700 },
  5: { label: "challenging, about 2000", uciElo: 2600, movetimeMs: 800 },
  6: { label: "hard, about 2500", uciElo: 2850, movetimeMs: 1000 },
  7: { label: "expert, about 2800", uciElo: 3100, movetimeMs: 1000 },
  8: { label: "maximum strength", movetimeMs: 1000 },
};

/** Moves the picker scores at once: Stockfish clamps MultiPV to the number of legal moves. */
const ALL_MOVES_PV = 64;

let engine: StockfishInstance | undefined;
let queue: Promise<unknown> = Promise.resolve();

function getEngine(): StockfishInstance {
  if (!engine) {
    const init = nodeRequire("stockfish") as (variant: string) => StockfishInstance;
    engine = init("lite-single");
    engine.processCommand("uci");
  }
  return engine;
}

export interface SearchResult {
  best: string;
  /** Score for the side to move, in centipawns (mate scores folded into +/-100000 - plies). */
  scoreCp?: number;
  /** Moves to mate for the side to move (negative: getting mated). */
  mate?: number;
}

/**
 * Runs one UCI search: the setup commands, then `isready`, and only after `readyok` the `go` command. Output
 * before `readyok` belongs to an earlier search and is ignored (a stray line once made a fork position's best
 * move "Kd1"). Searches are serialized: the engine is single-threaded.
 */
function runUci<T>(setup: string[], go: string, timeoutMs: number, onInfo: (line: string) => void, onBest: (best: string) => T): Promise<T> {
  const run = () =>
    new Promise<T>((resolve, reject) => {
      const sf = getEngine();
      let ready = false;
      const timer = setTimeout(() => {
        sf.processCommand("stop");
        reject(new Error("Stockfish timed out"));
      }, timeoutMs);
      sf.listener = (line: string) => {
        if (!ready) {
          if (line.trim() === "readyok") {
            ready = true;
            setTimeout(() => sf.processCommand(go), 0); // not from inside the engine's own output callback
          }
          return;
        }
        if (line.startsWith("info")) return onInfo(line);
        const m = /^bestmove (\S+)/.exec(line);
        if (!m) return;
        clearTimeout(timer);
        sf.listener = undefined;
        try {
          resolve(onBest(m[1]));
        } catch (err) {
          reject(err);
        }
      };
      for (const cmd of setup) sf.processCommand(cmd);
      sf.processCommand("isready");
    });
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** One search: the best move and the last reported score. `commands` ends with the `go` command. */
function search(commands: string[], timeoutMs: number): Promise<SearchResult> {
  let scoreCp: number | undefined;
  let mate: number | undefined;
  return runUci(
    commands.slice(0, -1),
    commands[commands.length - 1],
    timeoutMs,
    (line) => {
      const info = / score (cp|mate) (-?\d+)/.exec(line);
      if (!info) return;
      if (info[1] === "cp") { scoreCp = Number(info[2]); mate = undefined; }
      else { mate = Number(info[2]); scoreCp = Math.sign(mate || -1) * (100000 - Math.abs(mate) * 10); }
    },
    (best) => {
      if (best === "(none)") throw new Error("No legal moves");
      return { best, scoreCp, mate };
    },
  );
}

/** "position startpos moves …", or from a set-up position (FEN) for games that did not start from the beginning. */
function positionCommand(uciMoves: string[], startFen?: string): string {
  const moves = uciMoves.length ? ` moves ${uciMoves.join(" ")}` : "";
  return startFen ? `position fen ${startFen}${moves}` : `position startpos${moves}`;
}

/**
 * Strength options for one search. MultiPV is reset first every time: a timed-out MultiPV search once left it at 3
 * for the searches after it. `skill` overrides the level (0 = Stockfish's weakest, the picker's fallback).
 */
function strengthCommands(level: number, skill?: number): string[] {
  const cfg = LEVELS[level] ?? LEVELS[4];
  if (cfg.uciElo && skill === undefined) {
    return [
      "setoption name MultiPV value 1",
      "setoption name Skill Level value 20",
      "setoption name UCI_LimitStrength value true",
      `setoption name UCI_Elo value ${cfg.uciElo}`,
    ];
  }
  return [
    "setoption name MultiPV value 1",
    "setoption name UCI_LimitStrength value false",
    `setoption name Skill Level value ${skill ?? 20}`,
  ];
}

/**
 * Picks a weak level's move from the engine's scored lines (side to move's scores, any order): weight
 * exp(-loss / T) per move, loss = best score minus its score, capped at 2000 cp. With probability `blunderRate` a
 * move losing 150-900 cp is played instead, when there is one. `opening`: T halved and no blunders, so the first
 * moves look like a person who knows how to start a game.
 */
export function pickHumanlike(lines: Line[], style: HumanStyle, rng: () => number = Math.random, opening = false): string {
  const unique = [...new Map(lines.map((l) => [l.move, l])).values()];
  if (unique.length === 0) throw new Error("No candidate moves");
  const best = Math.max(...unique.map((l) => l.scoreCp));
  const loss = (l: Line) => Math.min(2000, Math.max(0, best - l.scoreCp));
  if (!opening && rng() < style.blunderRate) {
    const pool = unique.filter((l) => loss(l) >= 150 && loss(l) <= 900);
    if (pool.length) return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))].move;
  }
  const t = opening ? style.temperature / 2 : style.temperature;
  const weights = unique.map((l) => Math.exp(-loss(l) / t));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < unique.length; i++) {
    r -= weights[i];
    if (r <= 0) return unique[i].move;
  }
  return unique[unique.length - 1].move;
}

/** The engine's reply for the given level. `uciMoves` is the full game so far from the start position. */
export async function engineMove(uciMoves: string[], level: number, startFen?: string, rng: () => number = Math.random): Promise<string> {
  const cfg = LEVELS[level] ?? LEVELS[4];
  const position = positionCommand(uciMoves, startFen);
  if (cfg.human) {
    try {
      const lines = await multiPv(
        [...strengthCommands(8), `setoption name MultiPV value ${ALL_MOVES_PV}`, "ucinewgame", position],
        `go depth ${cfg.human.depth} movetime ${cfg.movetimeMs}`,
        cfg.movetimeMs + 10_000,
      );
      if (lines.length) return pickHumanlike(lines, cfg.human, rng, uciMoves.length < 12);
    } catch {
      // Fall back to Stockfish's weakest setting below: a move is better than none.
    }
  }
  const r = await search(
    [
      ...(cfg.human ? strengthCommands(level, 0) : strengthCommands(level)),
      "ucinewgame",
      position,
      `go movetime ${cfg.movetimeMs}`,
    ],
    cfg.movetimeMs + 10_000,
  );
  return r.best;
}

/** Full-strength suggestion for the side to move (used by the hint tool). */
export async function bestMove(uciMoves: string[], startFen?: string): Promise<string> {
  const r = await search(
    [
      ...strengthCommands(8),
      positionCommand(uciMoves, startFen),
      "go depth 12 movetime 1500",
    ],
    12_000,
  );
  return r.best;
}

/** Quick full-strength evaluation of the position after `uciMoves`, for commentary (≈100–400 ms). */
export function analyse(uciMoves: string[], startFen?: string, depth = 10): Promise<SearchResult> {
  return search(
    [
      ...strengthCommands(8),
      positionCommand(uciMoves, startFen),
      `go depth ${depth} movetime 400`,
    ],
    8_000,
  );
}

export interface Line {
  /** First move of the line (UCI). */
  move: string;
  /** Score for the side to move, centipawns (mates folded in as in SearchResult). */
  scoreCp: number;
  mate?: number;
  /** Principal variation, UCI. */
  pv: string[];
}

/**
 * The engine's top `count` moves for any position (FEN), full strength, with scores and lines (MultiPV).
 * Used for "what are my three best moves", threats (the opponent's best move in the same position) and
 * "what happens if". Returns [] for positions without legal moves.
 */
export function topMoves(fen: string, count = 3, movetimeMs = 600, searchMoves?: string[]): Promise<Line[]> {
  // `searchmoves` limits the search to some moves (UCI), e.g. one piece's: "the best move for my knight".
  const only = searchMoves?.length ? ` searchmoves ${searchMoves.join(" ")}` : "";
  return multiPv(
    [...strengthCommands(8), `setoption name MultiPV value ${count}`, "ucinewgame", `position fen ${fen}`],
    `go depth 14 movetime ${movetimeMs}${only}`,
    movetimeMs + 10_000,
  );
}

/** One MultiPV search: the last exact score and line for each rank, best first. `setup` sets MultiPV itself. */
function multiPv(setup: string[], go: string, timeoutMs: number): Promise<Line[]> {
  const lines = new Map<number, Line>();
  return runUci(
    setup,
    go,
    timeoutMs,
    (line) => {
      // Only exact scores: bound lines (lowerbound/upperbound) come from aspiration windows and can rank badly.
      if (!/ multipv (\d+)/.test(line) || !/ pv /.test(line) || / (lower|upper)bound/.test(line)) return;
      const k = Number(/ multipv (\d+)/.exec(line)![1]);
      const sc = / score (cp|mate) (-?\d+)/.exec(line);
      if (!sc) return;
      const mate = sc[1] === "mate" ? Number(sc[2]) : undefined;
      const scoreCp = mate !== undefined ? Math.sign(mate || -1) * (100000 - Math.abs(mate) * 10) : Number(sc[2]);
      const pv = line.split(" pv ")[1].trim().split(/\s+/);
      lines.set(k, { move: pv[0], scoreCp, mate, pv });
    },
    (best) => {
      getEngine().processCommand("setoption name MultiPV value 1"); // every other search expects one line
      if (best === "(none)") return [];
      return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
    },
  );
}
