import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import { playHumanMove } from "./game.js";
import { spokenMove } from "./spoken.js";

/**
 * Turns what speech recognition heard into a legal move.
 *
 * Browsers mangle chess ("knight e4" -> "night forever", "bishop c4" -> "bishop see four"), so we
 *  1. parse each transcript with chess-aware homophone rules into a move spec and match it against
 *     the legal moves (stage A), and
 *  2. if that fails, rank every legal move by phonetic similarity to the transcripts (stage B).
 * Anything uncertain comes back as "confirm" so the assistant asks instead of guessing.
 */

export type Resolution =
  | { kind: "move"; san: string; via: "exact" | "spoken" | "phonetic"; heard?: string }
  | { kind: "confirm"; candidates: string[]; heard?: string; reason: "ambiguous" | "unclear" | "illegal" }
  | { kind: "none"; heard?: string };

// ---------- tokenizing ----------

type Token =
  | { t: "piece"; p: PieceSymbol }
  | { t: "file"; f: string }
  | { t: "rank"; r: string }
  | { t: "square"; sq: string }
  | { t: "capture" }
  | { t: "castle"; side?: "k" | "q" }
  | { t: "side"; side: "k" | "q" }
  | { t: "promote" }
  | { t: "word"; w: string };

const PIECE_WORDS: Record<string, PieceSymbol> = {
  knight: "n", knights: "n", night: "n", nights: "n", nite: "n", knite: "n", kite: "n", horse: "n", neigh: "n", nate: "n",
  nighty: "n", ninety: "n",
  bishop: "b", bishops: "b", bish: "b", bishup: "b", fish: "b", rishabh: "b", rishab: "b", wishup: "b",
  rook: "r", rooks: "r", rock: "r", rocks: "r", ruck: "r", brook: "r", roo: "r", look: "r", ruk: "r",
  rocky: "r", rok: "r", rocket: "r", rope: "r", rooked: "r", book: "r", bruk: "r", rukh: "r", rooke: "r", rookie: "r", roque: "r", rak: "r",
  pawan: "p", pavan: "p", pahn: "p",
  queen: "q", queens: "q", quinn: "q", green: "q", kween: "q",
  king: "k", kings: "k",
  pawn: "p", pawns: "p", pond: "p", porn: "p", paun: "p", prawn: "p", pon: "p", palm: "p", pun: "p", born: "p", upon: "p",
  poon: "p", pound: "p", worn: "p", warn: "p",
};

/** A piece fused with the file letter after it ("pondi three" = pawn d3, "bishopi four" = bishop b4). The file only counts before a rank. */
const PIECE_FILE_WORDS: Record<string, { p: PieceSymbol; f: string }> = {
  pondi: { p: "p", f: "d" }, pondy: { p: "p", f: "d" },
  // Amazon Transcribe (en-IN) hears a quick "pawn dee four" as "twenty four" and "pawn see four" as "Swansea 4".
  twenty: { p: "p", f: "d" }, swansea: { p: "p", f: "c" },
  // "pawn ee" fused into one word, across US and British accents ("Tawny for", "Poorly for" = pawn e4).
  tawny: { p: "p", f: "e" }, poorly: { p: "p", f: "e" }, pawny: { p: "p", f: "e" }, porny: { p: "p", f: "e" }, pony: { p: "p", f: "e" }, ponny: { p: "p", f: "e" },
  bishopi: { p: "b", f: "b" }, bishopy: { p: "b", f: "b" }, bishopbee: { p: "b", f: "b" },
};

/** Whole moves heard as one word ("Pondicherry" = pawn d three). */
const MOVE_WORDS: Record<string, { p: PieceSymbol; sq: string }> = {
  pondicherry: { p: "p", sq: "d3" }, pondycherry: { p: "p", sq: "d3" },
};

/** Squares heard as one word, only right after a piece ("night free" = knight f3). */
const PIECE_SQUARE_WORDS: Record<string, string> = { free: "f3" };

/** File words only count as a file when a rank follows ("see four"), so "a", "be", "see", "if" stay ordinary words otherwise. */
const FILE_WORDS: Record<string, string> = {
  a: "a", ay: "a", eh: "a", hey: "a", hay: "a",
  b: "b", be: "b", bee: "b", bea: "b", bi: "b",
  c: "c", see: "c", sea: "c", si: "c", cee: "c", she: "c",
  d: "d", dee: "d", de: "d", di: "d",
  e: "e", ee: "e", eat: "e", he: "e", ea: "e",
  f: "f", ef: "f", eff: "f", if: "f",
  g: "g", gee: "g", ji: "g", jee: "g", gi: "g",
  h: "h", aitch: "h", age: "h", each: "h", edge: "h", haitch: "h",
  // Spelled the radio way ("echo four", "knight bravo d2").
  alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f", golf: "g", hotel: "h",
};
const NATO = new Set(["alpha", "alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]);
/** File names that are never ordinary English, so they can name the file a piece comes from ("knight b d2"). */
const LETTER_NAMES = new Set([..."abcdefgh", "bee", "cee", "dee", "ee", "ef", "eff", "gee", "jee", "aitch", "haitch", ...NATO]);

/** Rank words. Ambiguous ones ("to", "for", "won") only count right after a file word. */
const RANK_WORDS: Record<string, string> = {
  "1": "1", one: "1", won: "1", wan: "1",
  "2": "2", two: "2", to: "2", too: "2",
  "3": "3", three: "3", tree: "3", free: "3", thee: "3",
  "4": "4", four: "4", for: "4", fore: "4", far: "4",
  "5": "5", five: "5", fife: "5", hive: "5",
  "6": "6", six: "6", sicks: "6", sex: "6", sick: "6",
  "7": "7", seven: "7",
  "8": "8", eight: "8", ate: "8", eit: "8",
};
const UNAMBIGUOUS_RANKS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "one", "two", "three", "four", "five", "six", "seven", "eight"]);

const CAPTURE_WORDS = new Set(["takes", "take", "captures", "capture", "x", "eats", "by", "taking", "takes?"]);
const CASTLE_WORDS = new Set(["castle", "castles", "castling", "castled"]);
const KING_SIDE = new Set(["kingside", "short"]);
const QUEEN_SIDE = new Set(["queenside", "long"]);
const PROMOTE_WORDS = new Set(["promote", "promotes", "promoting", "promotion", "equals", "becomes"]);
const FILLERS = new Set([
  "alexa", "alexia", "alexis", "lexa", "um", "uh", "please", "okay", "ok", "i", "ill", "i'll", "will", "play", "move",
  "my", "the", "go", "let's", "lets", "put", "then", "and", "now", "just", "on", "at", "from", "square", "piece",
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/0-0-0|o-o-o/g, " castle queenside ")
    .replace(/0-0|o-o/g, " castle kingside ")
    .replace(/\b(?:wish|which|wich|bish|bitch|fish) (?:up|op|ap)\b/g, "bishop")
    // "on the queen's side" arrives as "queens side" once the apostrophe is gone.
    .replace(/\bkings? side\b/g, "kingside")
    .replace(/\bqueens? side\b/g, "queenside")
    .replace(/([a-h])\s*-\s*([a-h])/g, "$1 $2")
    // A spelled letter ("e for elephant", "d as in delta") is one letter: "e for" must not become e4 here.
    .replace(/\b([a-h]) (?:for|as in|like) (?!(?:one|two|three|four|five|six|seven|eight)\b)[a-z]{3,}\b/g, "$1")
    .replace(/[^a-z0-9=+#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sound-alike prefixes for the piece names, for words nobody listed ("rukh", "rocketh", "nighty"). */
const FUZZY_PIECES: [RegExp, PieceSymbol][] = [
  [/^(?:ro+[ckq]|ru+[ckq]|rou?k|rop|roo)/, "r"],
  [/^(?:bi?sh|wi?sh|rishab|bis[hs]?o)/, "b"],
  [/^(?:kni|ni[gt]h?|nyt|nait)/, "n"],
  [/^(?:pa+[wn]|po+[nrw]|pau|pah)/, "p"],
  [/^(?:qui|kwi|kwe|quee)/, "q"],
];
export function fuzzyPiece(word: string): PieceSymbol | undefined {
  return FUZZY_PIECES.find(([re]) => re.test(word))?.[1];
}

/** A word that could end a move: a square ("e7"), a file+rank pair ("see four") or a lone rank. */
function looksLikeSquare(w: string): boolean {
  const x = w.replace(/[+#]+$/, "");
  return /^[a-h][1-8]$/.test(x) || x in RANK_WORDS || x in FILE_WORDS || x === "even";
}

export function tokenize(text: string): Token[] {
  const words = normalize(text).split(" ").filter(Boolean);
  const out: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[+#]+$/, "");
    const next = words[i + 1];
    if (!w) continue;
    // "93" / "933": "knighty three", with the file lost
    const ninety = /^9([1-8])\1?$/.exec(w);
    if (ninety) {
      out.push({ t: "piece", p: "n" }, { t: "rank", r: ninety[1] });
      continue;
    }
    // "24" / "25": a quick "pawn dee four" written as a number (Amazon Transcribe en-IN)
    const twenty = /^2([1-8])$/.exec(w);
    if (twenty && out.length === 0) {
      out.push({ t: "piece", p: "p" }, { t: "square", sq: `d${twenty[1]}` });
      continue;
    }
    // Fused tokens: "e4", "nf3", "exd5", "g1f3", "e8=q"
    const fused = /^([nbrqk])?([a-h])?(x)?([a-h][1-8])(?:=?([nbrq]))?$/.exec(w);
    if (fused && w.length >= 2) {
      if (fused[1]) out.push({ t: "piece", p: fused[1] as PieceSymbol });
      if (fused[2]) out.push({ t: "file", f: fused[2] });
      if (fused[3]) out.push({ t: "capture" });
      out.push({ t: "square", sq: fused[4] });
      if (fused[5]) out.push({ t: "promote" }, { t: "piece", p: fused[5] as PieceSymbol });
      continue;
    }
    const uci = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/.exec(w);
    if (uci) {
      out.push({ t: "square", sq: uci[1] }, { t: "square", sq: uci[2] });
      if (uci[3]) out.push({ t: "promote" }, { t: "piece", p: uci[3] as PieceSymbol });
      continue;
    }
    if (w in FILE_WORDS && next !== undefined && next.replace(/[+#]+$/, "") in RANK_WORDS) {
      out.push({ t: "square", sq: FILE_WORDS[w] + RANK_WORDS[next.replace(/[+#]+$/, "")] });
      i++;
      continue;
    }
    if (w in FILE_WORDS && next !== undefined && CAPTURE_WORDS.has(next) && (w.length <= 2 || NATO.has(w))) {
      out.push({ t: "file", f: FILE_WORDS[w] }); // "e takes d5", "echo takes delta five"
      continue;
    }
    // The file the moving piece comes from, when two can reach the square: "knight b d2", "knight bravo d2",
    // "the c pawn takes d5" (not "a pawn": that's English), or after the square: "knight to d2 of b", "from the f file".
    if (LETTER_NAMES.has(w)) {
      const bare = (s?: string) => (s ?? "").replace(/[+#]+$/, "");
      const squareNext = next !== undefined && (/^[a-h][1-8]$/.test(bare(next)) || (bare(next) in FILE_WORDS && bare(words[i + 2]) in RANK_WORDS));
      const beforePiece = w !== "a" && next !== undefined && next in PIECE_WORDS && !out.some((t) => t.t === "piece" || t.t === "capture");
      const afterSquare = out.some((t) => t.t === "square") && ["of", "from", "the", "on"].includes(words[i - 1] ?? "");
      if ((out[out.length - 1]?.t === "piece" && squareNext) || beforePiece || afterSquare) {
        out.push({ t: "file", f: FILE_WORDS[w] });
        continue;
      }
    }
    if (w in MOVE_WORDS) { out.push({ t: "piece", p: MOVE_WORDS[w].p }, { t: "square", sq: MOVE_WORDS[w].sq }); continue; }
    if (w in PIECE_FILE_WORDS) {
      const { p, f } = PIECE_FILE_WORDS[w];
      out.push({ t: "piece", p });
      const r = next?.replace(/[+#]+$/, "");
      if (r !== undefined && r in RANK_WORDS) {
        out.push({ t: "square", sq: f + RANK_WORDS[r] });
        i++;
      }
      continue;
    }
    if (w in PIECE_SQUARE_WORDS && out[out.length - 1]?.t === "piece") { out.push({ t: "square", sq: PIECE_SQUARE_WORDS[w] }); continue; }
    if (w in PIECE_WORDS) { out.push({ t: "piece", p: PIECE_WORDS[w] }); continue; }
    // "even" is how "e1" arrives in Indian English ("rooked even check").
    if (w === "even" || w === "evan") { out.push({ t: "square", sq: "e1" }); continue; }
    // An unknown word that sounds like a piece, in front of any square ("rocky", "rocket", "ruknam"): the piece slot.
    if (!out.some((t) => t.t === "piece" || t.t === "square") && w.length >= 3 && words.slice(i + 1).some(looksLikeSquare)) {
      const p = fuzzyPiece(w);
      if (p) { out.push({ t: "piece", p }); continue; }
    }
    if (CAPTURE_WORDS.has(w)) { out.push({ t: "capture" }); continue; }
    if (CASTLE_WORDS.has(w)) { out.push({ t: "castle" }); continue; }
    if (KING_SIDE.has(w)) { out.push({ t: "side", side: "k" }); continue; }
    if (QUEEN_SIDE.has(w)) { out.push({ t: "side", side: "q" }); continue; }
    if (PROMOTE_WORDS.has(w) || w === "=") { out.push({ t: "promote" }); continue; }
    if (UNAMBIGUOUS_RANKS.has(w)) { out.push({ t: "rank", r: RANK_WORDS[w] }); continue; }
    if (FILLERS.has(w) || w === "to" || w === "too" || w === "for" || w === "check" || w === "mate" || w === "checkmate") continue;
    out.push({ t: "word", w });
  }
  return out;
}

// ---------- stage A: spec matching ----------

interface MoveSpec {
  piece?: PieceSymbol;
  from?: string;
  fromFile?: string;
  to?: string;
  /** Only the rank was heard ("knighty three"). */
  toRank?: string;
  capture?: boolean;
  /** "takes the knight": the piece taken, when it is named after the capture word. */
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  /** "any": "castle" with no side named; asked about when both sides are legal. */
  castle?: "k" | "q" | "any";
}

export function toSpec(tokens: Token[]): MoveSpec | undefined {
  const spec: MoveSpec = {};
  const squares: string[] = [];
  const castleTok = tokens.find((t) => t.t === "castle");
  if (castleTok) {
    const side = tokens.find((t): t is Extract<Token, { t: "side" }> => t.t === "side")?.side ?? "any";
    return { castle: side };
  }
  let promoteNext = false;
  let rank: string | undefined;
  for (const tok of tokens) {
    switch (tok.t) {
      case "piece":
        if (promoteNext || squares.length > 0) {
          // A piece named after the destination is a promotion ("e8 queen") unless it's the moving piece's name.
          if (tok.p !== "p" && tok.p !== "k" && (promoteNext || spec.piece === undefined || spec.piece === "p")) spec.promotion = tok.p;
        } else if (spec.capture) spec.captured ??= tok.p;
        else if (!spec.piece) spec.piece = tok.p;
        promoteNext = false;
        break;
      case "rank": rank ??= tok.r; break;
      case "file": spec.fromFile = tok.f; break;
      case "square": squares.push(tok.sq); break;
      case "capture": spec.capture = true; break;
      case "promote": promoteNext = true; break;
      default: break;
    }
  }
  if (squares.length === 0) {
    if (spec.captured) return spec; // "takes the knight"
    if (spec.piece && rank) return { ...spec, toRank: rank }; // "knighty three"
    return undefined;
  }
  if (squares.length >= 2) {
    spec.from = squares[squares.length - 2];
    spec.to = squares[squares.length - 1];
  } else spec.to = squares[0];
  return spec;
}

export function matchSpec(chess: Chess, spec: MoveSpec): Move[] {
  const legal = chess.moves({ verbose: true });
  if (spec.castle) return legal.filter((m) => m.piece === "k" && (spec.castle === "any" ? /[kq]/.test(m.flags) : m.flags.includes(spec.castle!)));
  let pool = spec.to ? legal.filter((m) => m.to === spec.to) : spec.toRank ? legal.filter((m) => m.to[1] === spec.toRank) : legal;
  if (spec.captured) pool = pool.filter((m) => m.captured === spec.captured);
  if (spec.from) pool = pool.filter((m) => m.from === spec.from);
  if (spec.fromFile) pool = pool.filter((m) => m.from[0] === spec.fromFile);
  if (spec.piece) pool = pool.filter((m) => m.piece === spec.piece);
  if (spec.promotion) pool = pool.filter((m) => m.promotion === spec.promotion);
  else if (pool.some((m) => m.promotion)) pool = pool.filter((m) => !m.promotion || m.promotion === "q");
  if (!spec.piece && !spec.from && spec.to && pool.length > 1) {
    // "e4" / "takes d5" with no piece named: pawns first, as people say it.
    const pawns = pool.filter((m) => m.piece === "p");
    if (pawns.length) pool = pawns;
  }
  return pool;
}

/** "pawn d2" when that pawn stands on d2: the user named where it is, not where it goes. */
function movesFrom(chess: Chess, spec: MoveSpec): Move[] {
  if (!spec.piece || !spec.to || spec.from || spec.captured) return [];
  const here = chess.get(spec.to as Square);
  if (!here || here.color !== chess.turn() || here.type !== spec.piece) return [];
  return chess.moves({ square: spec.to as Square, verbose: true });
}

/**
 * Every way to read one transcript, likeliest first. "bishop four" / "bishopi four" may also be
 * "b4" with the letter heard as a bishop.
 */
export function readSpecs(text: string): MoveSpec[] {
  const specs: MoveSpec[] = [];
  const primary = toSpec(tokenize(text));
  if (primary) specs.push(primary);
  const asLetter = /\bbish(?:op)?(?:i|y|bee)?\s+(\S+)/.exec(normalize(text));
  if (asLetter && UNAMBIGUOUS_RANKS.has(asLetter[1])) {
    const pawn = toSpec(tokenize(`pawn b${RANK_WORDS[asLetter[1]]}`));
    if (pawn) specs.push(pawn);
  }
  return specs;
}

/** Central destinations first, so a two-way question offers the likelier moves (kingside castling before queenside). */
function byCentre(moves: Move[]): Move[] {
  const off = (m: Move) => (m.flags.includes("k") ? -1 : Math.abs(m.to.charCodeAt(0) - "d".charCodeAt(0) - 0.5));
  return [...moves].sort((a, b) => off(a) - off(b) || a.san.localeCompare(b.san));
}

// ---------- stage B: phonetic ranking ----------

const LETTER_SOUNDS: Record<string, string> = { a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "ef", g: "jee", h: "aych" };
// Fixed sound codes so "four", "for" and "4" all key the same way.
const NUMBER_SOUNDS: Record<string, string> = {
  "1": "wun", one: "wun", won: "wun",
  "2": "tu", two: "tu", too: "tu",
  "3": "thri", three: "thri", tree: "thri",
  "4": "for", four: "for", fore: "for",
  "5": "faiv", five: "faiv",
  "6": "siks", six: "siks",
  "7": "sevn", seven: "sevn",
  "8": "eit", eight: "eit", ate: "eit",
};

/** Rough sound-alike key: letters and digits spelled out, common English spellings folded. */
export function soundKey(text: string): string {
  const words = normalize(text)
    .split(" ")
    .filter((w) => w && !FILLERS.has(w) && w !== "to")
    .flatMap((w) => {
      const sq = /^([a-h])([1-8])$/.exec(w);
      if (sq) return [LETTER_SOUNDS[sq[1]], NUMBER_SOUNDS[sq[2]]];
      if (w.length === 1 && LETTER_SOUNDS[w]) return [LETTER_SOUNDS[w]];
      if (NUMBER_SOUNDS[w]) return [NUMBER_SOUNDS[w]];
      return [w];
    });
  return words
    .join("")
    .replace(/kn/g, "n")
    .replace(/igh/g, "ai")
    .replace(/ght/g, "t")
    .replace(/ph/g, "f")
    .replace(/wr/g, "r")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/ee|ea|ie/g, "i")
    .replace(/oo|ou/g, "u")
    .replace(/aw|au/g, "o")
    .replace(/[^a-z]/g, "")
    .replace(/(.)\1+/g, "$1");
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * How well a candidate move's sound key matches what was heard. Like similarity(), but extra sounds
 * trailing after the move ("night for|ever") cost only a quarter each, since recognizers often glue
 * words on the end.
 */
export function matchScore(candidate: string, heard: string): number {
  if (!candidate || !heard) return 0;
  const n = candidate.length;
  const m = heard.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (candidate[i - 1] === heard[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  let best = Infinity;
  for (let j = 0; j <= m; j++) best = Math.min(best, prev[j] + 0.25 * (m - j));
  return Math.max(similarity(candidate, heard), 1 - best / Math.max(n, 1));
}

const PIECE_SPOKEN: Record<PieceSymbol, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/** Ways a person might say a legal move. */
export function spokenForms(m: Move): string[] {
  if (m.flags.includes("k")) return ["castle kingside", "castle short", "castles"];
  if (m.flags.includes("q")) return ["castle queenside", "castle long"];
  const forms: string[] = [];
  const promo = m.promotion ? ` ${PIECE_SPOKEN[m.promotion]}` : "";
  if (m.piece === "p") {
    if (m.captured) forms.push(`${m.from[0]} takes ${m.to}${promo}`, `pawn takes ${m.to}${promo}`, `takes ${m.to}${promo}`);
    else forms.push(`${m.to}${promo}`, `pawn ${m.to}${promo}`);
  } else {
    const p = PIECE_SPOKEN[m.piece];
    forms.push(`${p} ${m.to}`);
    if (m.captured) forms.push(`${p} takes ${m.to}`);
  }
  return forms;
}

function phoneticRank(chess: Chess, transcripts: string[]): { san: string; score: number }[] {
  const keys = transcripts.map((t, i) => ({ key: soundKey(t), weight: 1 - i * 0.05 })).filter((k) => k.key.length > 1);
  if (keys.length === 0) return [];
  return chess
    .moves({ verbose: true })
    .map((m) => {
      let best = 0;
      for (const form of spokenForms(m)) {
        const fk = soundKey(form);
        for (const { key, weight } of keys) best = Math.max(best, matchScore(fk, key) * weight);
      }
      return { san: m.san, score: best };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------- the resolver ----------

function trySan(chess: Chess, text: string): Move | undefined {
  try {
    return playHumanMove(new Chess(chess.fen()), text);
  } catch {
    return undefined;
  }
}

const AUTO_PLAY = 0.8;
const AUTO_MARGIN = 0.1;
const CONFIRM_MIN = 0.45;

/**
 * @param move  the assistant's own reading of the move (SAN/UCI or words), may be empty
 * @param heard raw speech-recognition alternatives, best first
 */
// ---------- accents: sound-alike letters and numbers ----------

/** File letters that speech recognition confuses across accents ("a 6" for e6, "S3" for f3, "v" for b or d). */
const FILE_SWAPS: Record<string, string[]> = {
  a: ["e"], e: ["a"], i: ["e"], b: ["d"], d: ["b"], v: ["b", "d"], p: ["b", "d"], t: ["d"], s: ["f", "c"], z: ["c"], j: ["g"], x: ["e"],
};
/** Letters spelled out with a word ("E for elephant", "echo", "delta"). */
const SPELLED: Record<string, string> = {
  elephant: "e", echo: "e", egg: "e", apple: "a", alpha: "a", ant: "a", ball: "b", boy: "b", bravo: "b", cat: "c", charlie: "c",
  dog: "d", delta: "d", fox: "f", foxtrot: "f", frank: "f", golf: "g", goat: "g", hotel: "h", hat: "h",
};
/** Rank words as different accents come out of recognition. */
const RANK_ALIASES: Record<string, string> = {
  sex: "six", sax: "six", sikh: "six", sick: "six", seeks: "six", sects: "six", fix: "six", sax6: "six",
  ate: "eight", eat: "eight", tree: "three", free: "three", fore: "four", far: "four", won: "one", fife: "five", hive: "five",
};

/**
 * Other ways the same words might have been meant, for when nothing legal matched as heard: spelled letters
 * ("e for elephant 6"), rank words ("takes sex" = takes six) and confusable file letters (a/e, b/d, s→f...).
 */
/** The swaps seen most in real recognition ("a 6" for e6, "S3" for f3): strong enough to override an illegal reading. */
const STRONG_SWAPS: Record<string, string[]> = { a: ["e"], e: ["a"], s: ["f"] };

export function accentVariants(text: string, strongOnly = false): string[] {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b([a-h]) (?:for|as in|like) [a-z]+\b/g, "$1")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SPELLED[w] ?? RANK_ALIASES[w] ?? w);
  const out = new Set<string>([base.join(" ")]);
  base.forEach((w, i) => {
    const fused = /^([a-z])([1-8])$/.exec(w);
    const letter = fused ? fused[1] : w.length === 1 ? w : undefined;
    const rankNext = fused || (i + 1 < base.length && /^([1-8]|one|two|three|four|five|six|seven|eight)$/.test(base[i + 1]));
    if (!letter || !rankNext) return;
    for (const swap of (strongOnly ? STRONG_SWAPS : FILE_SWAPS)[letter] ?? []) {
      const copy = [...base];
      copy[i] = fused ? `${swap}${fused[2]}` : swap;
      out.add(copy.join(" "));
    }
  });
  out.delete(text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim());
  return [...out].slice(0, 12);
}

export function resolveSpokenMove(chess: Chess, move: string | undefined, heard: string[] = []): Resolution {
  const first = resolveAsHeard(chess, move, heard);
  if (first.kind === "move") return first;
  // Not sure as heard: try how other accents' letters and numbers come out. Those readings come first (a spelled
  // "foxtrot" is strong evidence), and the player is asked, never auto-played.
  const found: string[] = [];
  // An understood but illegal move ("porn pics D4" where no pawn reaches d4) only yields to the strong swaps: a weak
  // b/d swap would turn it into a different legal move (b4) the player never said.
  const strongOnly = first.kind === "confirm" && first.reason === "illegal";
  for (const text of [...new Set(heard.map((h) => h.trim()).filter(Boolean))].slice(0, 3)) {
    for (const variant of accentVariants(text, strongOnly)) {
      const r = resolveAsHeard(chess, undefined, [variant]);
      if (r.kind === "move" && !found.includes(r.san)) found.push(r.san);
    }
  }
  if (found.length === 0) return first;
  if (first.kind === "none") return { kind: "confirm", candidates: found.slice(0, 2), heard: first.heard, reason: found.length > 1 ? "ambiguous" : "unclear" };
  // A board question ("Which rook: the one on c7, or the one on e1?") stays as it is: the words can't settle it.
  const moves = first.candidates.map((s) => new Chess(chess.fen()).move(s));
  const whichPiece = moves.length === 2 && moves[0].piece === moves[1].piece && moves[0].to === moves[1].to;
  if (whichPiece || isCastleChoice(moves)) return first;
  // Otherwise an accent reading that is a clear legal move beats a vaguer sound-alike guess.
  const candidates = [...found, ...first.candidates].filter((s, i, all) => all.indexOf(s) === i).slice(0, 2);
  return { kind: "confirm", candidates, heard: first.heard, reason: "unclear" };
}

function resolveAsHeard(chess: Chess, move: string | undefined, heard: string[] = []): Resolution {
  const alternatives = [...new Set(heard.map((h) => h.trim()).filter(Boolean))].slice(0, 5);
  const modelMove = move?.trim() ? trySan(chess, move.trim()) : undefined;
  const heardLabel = alternatives[0];

  // Stage A over the alternatives (and the model's text when it's words, not SAN).
  const sources = alternatives.length ? alternatives : move ? [move] : [];
  const weights = new Map<string, number>();
  // Readings worth asking about but never auto-played: "a6" when only a bishop can go there, "knighty
  // three" with several knights able to reach the third rank, "pawn d2" naming where the pawn stands.
  const unsure = new Set<string>();
  let saidIllegalMove = false;
  sources.forEach((text, i) => {
    const specs = readSpecs(text);
    if (specs.length === 0) return;
    const perSpec = specs.map((spec) => byCentre(matchSpec(chess, spec)));
    // Take the readings in turn so a two-way question offers one move from each.
    const matches: Move[] = [];
    for (let k = 0; perSpec.some((ms) => k < ms.length); k++) {
      for (const ms of perSpec) if (ms[k] && !matches.some((m) => m.san === ms[k].san)) matches.push(ms[k]);
    }
    if (matches.length === 1) {
      const spec = specs[perSpec.findIndex((ms) => ms.length > 0)];
      const bareSquare = !spec.castle && !spec.piece && !spec.from && !spec.captured && matches[0].piece !== "p";
      if (bareSquare || spec !== specs[0]) unsure.add(matches[0].san);
      // The best-ranked transcript that names a move speaks for it: lower alternatives (older partials, n-best
      // runners-up) can't outvote it by agreeing with each other ("knight f3" final, two "knight c3" partials).
      else weights.set(matches[0].san, Math.max(weights.get(matches[0].san) ?? 0, 1 - i * 0.2));
    } else if (matches.length > 1) matches.forEach((m) => unsure.add(m.san));
    else {
      const from = movesFrom(chess, specs[0]);
      if (from.length) byCentre(from).forEach((m) => unsure.add(m.san));
      else if (i === 0) saidIllegalMove = true;
    }
  });

  if (alternatives.length === 0 && modelMove) return { kind: "move", san: modelMove.san, via: "exact" };

  if (weights.size === 0 && unsure.size > 0) {
    const candidates = modelMove && unsure.has(modelMove.san) ? [modelMove.san, ...[...unsure].filter((s) => s !== modelMove.san)] : [...unsure];
    const reason = saidIllegalMove ? "illegal" : candidates.length > 1 ? "ambiguous" : "unclear";
    return { kind: "confirm", candidates: candidates.slice(0, 2), heard: heardLabel, reason };
  }

  if (weights.size > 0) {
    const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
    const [bestSan, bestW] = ranked[0];
    if (modelMove && weights.has(modelMove.san) && bestW - weights.get(modelMove.san)! < 0.25) {
      return { kind: "move", san: modelMove.san, via: "spoken", heard: heardLabel };
    }
    const runnerUp = ranked[1];
    if (runnerUp && bestW - runnerUp[1] < 0.15) {
      return { kind: "confirm", candidates: [bestSan, runnerUp[0]], heard: heardLabel, reason: "ambiguous" };
    }
    return { kind: "move", san: bestSan, via: "spoken", heard: heardLabel };
  }

  const ranked = phoneticRank(chess, alternatives.length ? alternatives : move ? [move] : []);

  if (modelMove) {
    // The assistant understood something our rules didn't. Trust it only if it sounds like what was heard.
    const own = ranked.find((r) => r.san === modelMove.san)?.score ?? 0;
    if (!saidIllegalMove && own >= 0.6) return { kind: "move", san: modelMove.san, via: "phonetic", heard: heardLabel };
    const others = ranked.filter((r) => r.san !== modelMove.san && r.score >= CONFIRM_MIN).slice(0, 1).map((r) => r.san);
    return { kind: "confirm", candidates: [modelMove.san, ...others], heard: heardLabel, reason: saidIllegalMove ? "illegal" : "unclear" };
  }

  if (ranked.length === 0 || ranked[0].score < CONFIRM_MIN) return { kind: "none", heard: heardLabel };
  const [top, second] = ranked;
  if (!saidIllegalMove && top.score >= AUTO_PLAY && (!second || top.score - second.score >= AUTO_MARGIN)) {
    return { kind: "move", san: top.san, via: "phonetic", heard: heardLabel };
  }
  const close = ranked.filter((r) => r.score >= Math.max(CONFIRM_MIN, top.score - 0.08)).slice(0, 2).map((r) => r.san);
  return { kind: "confirm", candidates: close, heard: heardLabel, reason: saidIllegalMove ? "illegal" : close.length > 1 ? "ambiguous" : "unclear" };
}

/** Both castles offered for a bare "castle": a board question the words can't settle. */
export function isCastleChoice(moves: Move[]): boolean {
  return moves.length === 2 && moves.every((m) => m.piece === "k" && /[kq]/.test(m.flags)) && moves[0].flags !== moves[1].flags;
}

/** "Did you mean knight to e4, or knight to f4?" */
export function confirmQuestion(chess: Chess, r: Extract<Resolution, { kind: "confirm" }>, why?: string): string {
  const moves = r.candidates.map((san) => new Chess(chess.fen()).move(san));
  if (isCastleChoice(moves)) return "Castle which way: kingside, or queenside?";
  // Same piece, same destination: only the starting square differs, so ask exactly that.
  if (moves.length === 2 && moves[0].piece === moves[1].piece && moves[0].to === moves[1].to && moves[0].from !== moves[1].from) {
    const name = PIECE_SPOKEN[moves[0].piece];
    return `Which ${name}: the one on ${moves[0].from}, or the one on ${moves[1].from}?`;
  }
  const spoken = moves.map((m) => spokenMove(m));
  const heard = r.heard?.trim().replace(/[.!?]+$/, "");
  const lead =
    r.reason === "illegal"
      ? heard && heard.split(/\s+/).length <= 8 && !/^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/.test(heard)
        ? `I heard "${heard}": that isn't possible${why ? `, ${why}` : " here"}.`
        : `That move isn't possible${why ? `: ${why}` : " here"}.`
      : heard ? `I heard "${heard}".` : "I'm not sure I caught that.";
  return spoken.length > 1 ? `${lead} Did you mean ${spoken[0]}, or ${spoken[1]}?` : `${lead} Did you mean ${spoken[0]}?`;
}
