// Generates infra/transcribe/vocabulary.txt (Amazon Transcribe custom vocabulary, table format) and checks it
// against Transcribe's phrase rules. SoundsLike/IPA are no longer supported, so those columns stay empty.
//   node scripts/build-vocabulary.mjs          write the file
//   node scripts/build-vocabulary.mjs --check  only validate the committed file
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../infra/transcribe/vocabulary.txt", import.meta.url));
const FILES = "abcdefgh".split("");
const RANKS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

/** [phrase (hyphen-joined, no digits), DisplayAs or ""] */
export function entries() {
  const rows = [];
  const add = (phrase, display = "") => rows.push([phrase, display]);
  add("alexa", "Alexa");
  for (const w of ["pawn", "knight", "bishop", "rook", "queen", "king"]) add(w);
  for (const w of ["takes", "castle", "castles", "castling", "kingside", "queenside", "promote", "promotes", "check", "checkmate", "resign", "undo", "stalemate", "draw"]) add(w);
  add("en-passant", "en passant");
  add("king-side", "kingside");
  add("queen-side", "queenside");
  for (const w of ["chess", "black", "white", "easy", "medium", "hard", "beginner", "expert", "grandmaster", "random", "level", "difficulty", "new-game", "play", "board", "rematch"]) add(w);
  // Hinglish filler the speaker sometimes mixes in.
  for (const w of ["aur", "haan", "nahi", "acha", "theek", "chalo", "bas"]) add(w);
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) add(`${FILES[f]}-${RANKS[r]}`, `${FILES[f]}${r + 1}`);
  }
  // Captures ("takes e-six"): accents turned "e six" into "sex" and "a 6" on the live site.
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) add(`takes-${FILES[f]}-${RANKS[r]}`, `takes ${FILES[f]}${r + 1}`);
  }
  // Whole moves ("pawn d-four"): short commands lost the piece and file without these ("pawn d4" came back as "24").
  for (const p of ["pawn", "knight", "bishop", "rook", "queen", "king"]) {
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) add(`${p}-${FILES[f]}-${RANKS[r]}`, `${p} ${FILES[f]}${r + 1}`);
    }
  }
  return rows;
}

const SPELLED = /^[a-z]+(-[a-z]+)*$/;

/** Returns a list of problems (empty when the table is valid). */
export function validate(text) {
  const problems = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines[0] !== "Phrase\tSoundsLike\tIPA\tDisplayAs") problems.push("header must be Phrase<TAB>SoundsLike<TAB>IPA<TAB>DisplayAs");
  const seen = new Set();
  lines.slice(1).forEach((line, i) => {
    const at = `row ${i + 2}`;
    const cols = line.split("\t");
    if (cols.length !== 4) return problems.push(`${at}: needs 4 tab-separated columns (${JSON.stringify(line)})`);
    const [phrase, sounds, ipa] = cols;
    if (!SPELLED.test(phrase)) problems.push(`${at}: phrase ${JSON.stringify(phrase)} must be lowercase words joined by single hyphens, no digits`);
    if (sounds || ipa) problems.push(`${at}: SoundsLike and IPA must stay empty`);
    if (seen.has(phrase)) problems.push(`${at}: duplicate phrase ${phrase}`);
    seen.add(phrase);
  });
  return problems;
}

export const build = () => ["Phrase\tSoundsLike\tIPA\tDisplayAs", ...entries().map(([p, d]) => `${p}\t\t\t${d}`)].join("\n") + "\n";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const text = readFileSync(OUT, "utf8");
    const problems = validate(text);
    if (text !== build()) problems.push("vocabulary.txt is out of date: run node scripts/build-vocabulary.mjs");
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    console.log(`vocabulary ok: ${text.split("\n").filter(Boolean).length - 1} phrases`);
  } else {
    const text = build();
    const problems = validate(text);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT} (${text.split("\n").filter(Boolean).length - 1} phrases)`);
  }
}
