import type { Color, Move, PieceSymbol, Square } from "chess.js";

// Everything here turns chess data into short phrases meant to be read aloud.

export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export const PIECE_PLURALS: Record<PieceSymbol, string> = {
  p: "pawns",
  n: "knights",
  b: "bishops",
  r: "rooks",
  q: "queens",
  k: "king",
};

export const colorName = (c: Color): string => (c === "w" ? "White" : "Black");

/** "e4" -> "e4". Kept as a function so the TTS spelling can be tuned in one place. */
export const spokenSquare = (sq: Square | string): string => sq.toLowerCase();

/**
 * Spoken description of a move, e.g.
 *   Nf3      -> "knight to f3"
 *   exd5     -> "pawn on e4 takes pawn on d5"
 *   Nxe5     -> "knight takes bishop on e5"
 *   Nbd7     -> "knight from b8 to d7"
 *   O-O      -> "castles kingside"
 *   e8=Q#    -> "pawn to e8, promotes to queen, checkmate"
 */
export function spokenMove(move: Move): string {
  let text: string;
  if (move.flags.includes("k")) {
    text = "castles kingside";
  } else if (move.flags.includes("q")) {
    text = "castles queenside";
  } else {
    const piece = PIECE_NAMES[move.piece];
    // SAN only names the origin when the move would otherwise be ambiguous (or for pawn captures).
    const disambiguated = move.piece !== "p" && /^[NBRQK][a-h1-8]{1,2}x?[a-h][1-8]/.test(move.san);
    if (move.captured) {
      const victim = move.flags.includes("e") ? "pawn en passant" : `${PIECE_NAMES[move.captured]} on ${spokenSquare(move.to)}`;
      const origin = move.piece === "p" || disambiguated ? ` on ${spokenSquare(move.from)}` : "";
      text = `${piece}${origin} takes ${victim}`;
    } else {
      text = disambiguated
        ? `${piece} from ${spokenSquare(move.from)} to ${spokenSquare(move.to)}`
        : `${piece} to ${spokenSquare(move.to)}`;
    }
    if (move.promotion) text += `, promotes to ${PIECE_NAMES[move.promotion]}`;
  }
  if (move.san.endsWith("#")) text += ", checkmate";
  else if (move.san.endsWith("+")) text += ", check";
  return text;
}

/** "White: king on g1, queen on d1, rooks on a1 and f1, ..." */
export function spokenPieceList(pieces: { type: PieceSymbol; square: Square }[]): string {
  const order: PieceSymbol[] = ["k", "q", "r", "b", "n", "p"];
  const parts: string[] = [];
  for (const type of order) {
    const squares = pieces.filter((p) => p.type === type).map((p) => spokenSquare(p.square)).sort();
    if (squares.length === 0) continue;
    const name = squares.length === 1 ? PIECE_NAMES[type] : PIECE_PLURALS[type];
    parts.push(`${name} on ${joinAnd(squares)}`);
  }
  return parts.length ? parts.join("; ") : "no pieces";
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
