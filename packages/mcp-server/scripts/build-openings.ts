import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";

// Builds data/openings.json (position -> opening name) from the lichess chess-openings TSVs
// (https://github.com/lichess-org/chess-openings, CC0 / public domain).
//   npx tsx scripts/build-openings.ts <dir with a.tsv..e.tsv>

const dir = process.argv[2];
if (!dir) throw new Error("usage: build-openings.ts <tsv dir>");

const byPosition: Record<string, string> = {};
let rows = 0;
for (const file of readdirSync(dir).filter((f) => /^[a-e]\.tsv$/.test(f)).sort()) {
  const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.split("\t");
    if (!eco || !name || !pgn) continue;
    const chess = new Chess();
    chess.loadPgn(pgn);
    const key = positionKey(chess.fen());
    byPosition[key] ??= name; // first (most common) name wins on transpositions
    rows++;
  }
}

/** FEN without the move counters, so transpositions match. */
function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

writeFileSync(new URL("../data/openings.json", import.meta.url), JSON.stringify(byPosition));
console.log(`${rows} lines -> ${Object.keys(byPosition).length} positions`);
