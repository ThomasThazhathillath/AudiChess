import { createRequire } from "node:module";

// Stockfish 19 "lite single-threaded" WASM. On Lambda it comes from the alexa_chess_stockfish layer
// (/opt/nodejs/node_modules, on NODE_PATH); locally from the stockfish devDependency.
const nodeRequire = createRequire(import.meta.url);

interface StockfishInstance {
  processCommand(cmd: string): void;
  listener?: (line: string) => void;
}

/** Difficulty 1-8. 1-3 use Stockfish's Skill Level (weakest), 4-8 use calibrated Elo. */
export const LEVELS: Record<number, { label: string; skill?: number; elo?: number; movetimeMs: number }> = {
  1: { label: "beginner", skill: 0, movetimeMs: 150 },
  2: { label: "novice", skill: 3, movetimeMs: 200 },
  3: { label: "casual", skill: 6, movetimeMs: 250 },
  4: { label: "club player, about 1400", elo: 1400, movetimeMs: 400 },
  5: { label: "intermediate, about 1700", elo: 1700, movetimeMs: 500 },
  6: { label: "strong club player, about 2000", elo: 2000, movetimeMs: 600 },
  7: { label: "expert, about 2400", elo: 2400, movetimeMs: 800 },
  8: { label: "maximum strength", movetimeMs: 1000 },
};

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

function strengthCommands(level: number): string[] {
  const cfg = LEVELS[level] ?? LEVELS[4];
  if (cfg.elo) {
    return [
      "setoption name Skill Level value 20",
      "setoption name UCI_LimitStrength value true",
      `setoption name UCI_Elo value ${cfg.elo}`,
    ];
  }
  return [
    "setoption name UCI_LimitStrength value false",
    `setoption name Skill Level value ${cfg.skill ?? 20}`,
  ];
}

/** The engine's reply for the given level. `uciMoves` is the full game so far from the start position. */
export async function engineMove(uciMoves: string[], level: number, startFen?: string): Promise<string> {
  const cfg = LEVELS[level] ?? LEVELS[4];
  const r = await search(
    [
      ...strengthCommands(level),
      "ucinewgame",
      positionCommand(uciMoves, startFen),
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
export function topMoves(fen: string, count = 3, movetimeMs = 600): Promise<Line[]> {
  const lines = new Map<number, Line>();
  return runUci(
    [...strengthCommands(8), `setoption name MultiPV value ${count}`, "ucinewgame", `position fen ${fen}`],
    `go depth 14 movetime ${movetimeMs}`,
    movetimeMs + 10_000,
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
    () => {
      getEngine().processCommand("setoption name MultiPV value 1"); // every other search expects one line
      return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
    },
  );
}
