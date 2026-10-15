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

/** Runs one UCI search and resolves with the best move and the last reported score. Searches are serialized: the engine is single-threaded. */
function search(commands: string[], timeoutMs: number): Promise<SearchResult> {
  const run = () =>
    new Promise<SearchResult>((resolve, reject) => {
      const sf = getEngine();
      let scoreCp: number | undefined;
      let mate: number | undefined;
      const timer = setTimeout(() => {
        sf.processCommand("stop");
        reject(new Error("Stockfish timed out"));
      }, timeoutMs);
      sf.listener = (line: string) => {
        const info = / score (cp|mate) (-?\d+)/.exec(line);
        if (info && line.startsWith("info")) {
          if (info[1] === "cp") { scoreCp = Number(info[2]); mate = undefined; }
          else { mate = Number(info[2]); scoreCp = Math.sign(mate || -1) * (100000 - Math.abs(mate) * 10); }
          return;
        }
        const m = /^bestmove (\S+)/.exec(line);
        if (!m) return;
        clearTimeout(timer);
        sf.listener = undefined;
        if (m[1] === "(none)") reject(new Error("No legal moves"));
        else resolve({ best: m[1], scoreCp, mate });
      };
      for (const cmd of commands) sf.processCommand(cmd);
    });
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
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
export async function engineMove(uciMoves: string[], level: number): Promise<string> {
  const cfg = LEVELS[level] ?? LEVELS[4];
  const r = await search(
    [
      ...strengthCommands(level),
      "ucinewgame",
      `position startpos${uciMoves.length ? ` moves ${uciMoves.join(" ")}` : ""}`,
      `go movetime ${cfg.movetimeMs}`,
    ],
    cfg.movetimeMs + 10_000,
  );
  return r.best;
}

/** Full-strength suggestion for the side to move (used by the hint tool). */
export async function bestMove(uciMoves: string[]): Promise<string> {
  const r = await search(
    [
      ...strengthCommands(8),
      `position startpos${uciMoves.length ? ` moves ${uciMoves.join(" ")}` : ""}`,
      "go depth 12 movetime 1500",
    ],
    12_000,
  );
  return r.best;
}

/** Quick full-strength evaluation of the position after `uciMoves`, for commentary (≈100–400 ms). */
export function analyse(uciMoves: string[], depth = 10): Promise<SearchResult> {
  return search(
    [
      ...strengthCommands(8),
      `position startpos${uciMoves.length ? ` moves ${uciMoves.join(" ")}` : ""}`,
      `go depth ${depth} movetime 400`,
    ],
    8_000,
  );
}
