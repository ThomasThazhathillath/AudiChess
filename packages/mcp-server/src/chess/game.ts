import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { PIECE_NAMES, colorName, joinAnd, spokenMove, spokenPieceList, spokenSquare } from "./spoken.js";

export type GameStatus = "active" | "checkmate" | "stalemate" | "draw" | "resigned";
export type GameResult = "1-0" | "0-1" | "1/2-1/2";

const PIECE_WORDS: Record<string, PieceSymbol> = {
  pawn: "p", pawns: "p", knight: "n", knights: "n", night: "n", horse: "n",
  bishop: "b", bishops: "b", rook: "r", rooks: "r", castle: "r",
  queen: "q", queens: "q", king: "k",
};

const PIECE_VALUES: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Rebuilds a position by replaying moves (UCI strings) so repetition/50-move draws are detected correctly. */
export function replay(uciMoves: string[]): Chess {
  const chess = new Chess();
  for (const uci of uciMoves) {
    chess.move(uciToObject(uci));
  }
  return chess;
}

export function uciToObject(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

export const moveToUci = (m: Move): string => `${m.from}${m.to}${m.promotion ?? ""}`;

export class IllegalMoveError extends Error {
  constructor(message: string, readonly suggestions: string[]) {
    super(message);
  }
}

/**
 * Accepts SAN ("Nf3", "exd5", "O-O", "e8=Q"), common variants ("0-0", "nf3", "Ng1f3")
 * and UCI / long algebraic ("g1f3", "e7e8q", "e2-e4"). Throws IllegalMoveError with
 * spoken suggestions when the move can't be played.
 */
export function playHumanMove(chess: Chess, input: string): Move {
  const raw = input.trim();
  const candidates = new Set<string>([raw]);
  const castle = raw.replace(/0/g, "O").toUpperCase();
  if (/^O-O(-O)?[+#]?$/.test(castle)) candidates.add(castle);
  // "nf3" -> "Nf3" (never touch a leading "b": it may be the b-file)
  if (/^[nrqk][a-h]?[1-8]?x?[a-h][1-8]/.test(raw)) candidates.add(raw[0].toUpperCase() + raw.slice(1));

  // chess.js is forgiving: "a6" becomes Ba6 when no pawn can go there. A bare square means a pawn,
  // so a move by a different piece than the one named is not what the user said.
  const named = namedPiece(raw);
  for (const san of candidates) {
    try {
      const m = chess.move(san);
      if (named && m.piece !== named) {
        chess.undo();
        continue;
      }
      return m;
    } catch {
      /* try the next form */
    }
  }

  const uci = raw.toLowerCase().replace(/[-x\s=]/g, "");
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (m) {
    try {
      return chess.move({ from: m[1], to: m[2], promotion: m[3] ?? "q" });
    } catch {
      /* fall through to suggestions */
    }
  }

  throw new IllegalMoveError(`${raw} is not a legal move here.`, suggestMoves(chess, raw));
}

/** The piece a SAN-ish input names: "Nf3" → n, "e4"/"D4"/"exd5" → p, castling or anything else → undefined. */
function namedPiece(raw: string): string | undefined {
  if (/^[a-hA-H][1-8]/.test(raw) || /^[a-h]x[a-h][1-8]/.test(raw)) return "p"; // "B4" from speech is the b4 square
  if (/^[NBRQK]/.test(raw)) return raw[0].toLowerCase();
  if (/^[nrqk][a-h]?[1-8]?x?[a-h][1-8]/.test(raw)) return raw[0];
  return undefined;
}

/** Legal alternatives that share the target square or piece type with what was asked for. */
export function suggestMoves(chess: Chess, raw: string): string[] {
  const legal = chess.moves({ verbose: true });
  const squares = raw.toLowerCase().match(/[a-h][1-8]/g) ?? [];
  const target = squares[squares.length - 1];
  const pieceLetter = /^[NBRQK]/.exec(raw)?.[0].toLowerCase() as PieceSymbol | undefined;
  // Most specific first: same piece to the same square, then same piece anywhere, then anything to that square.
  const filters: ((m: Move) => boolean)[] = [];
  if (pieceLetter && target) filters.push((m) => m.piece === pieceLetter && m.to === target);
  if (pieceLetter) filters.push((m) => m.piece === pieceLetter);
  if (target) filters.push((m) => m.to === target);
  let pool: Move[] = [];
  for (const f of filters) {
    pool = legal.filter(f);
    if (pool.length) break;
  }
  if (pool.length === 0) pool = legal;
  return pool.slice(0, 6).map((m) => `${m.san} (${spokenMove(m)})`);
}

export function statusOf(chess: Chess): { status: GameStatus; result?: GameResult; reason?: string } {
  if (chess.isCheckmate()) {
    return { status: "checkmate", result: chess.turn() === "w" ? "0-1" : "1-0", reason: "checkmate" };
  }
  if (chess.isStalemate()) return { status: "stalemate", result: "1/2-1/2", reason: "stalemate" };
  if (chess.isInsufficientMaterial()) return { status: "draw", result: "1/2-1/2", reason: "insufficient material" };
  if (chess.isThreefoldRepetition()) return { status: "draw", result: "1/2-1/2", reason: "threefold repetition" };
  if (chess.isDrawByFiftyMoves()) return { status: "draw", result: "1/2-1/2", reason: "the fifty move rule" };
  return { status: "active" };
}

export function spokenGameOver(chess: Chess, humanColor: Color): string | undefined {
  const s = statusOf(chess);
  if (s.status === "active") return undefined;
  if (s.status === "checkmate") {
    const winner: Color = s.result === "1-0" ? "w" : "b";
    return winner === humanColor ? "Checkmate. You win!" : "Checkmate. I win this time.";
  }
  return `The game is a draw by ${s.reason}.`;
}

export function piecesOf(chess: Chess, color: Color): { type: PieceSymbol; square: Square }[] {
  return chess
    .board()
    .flat()
    .filter((p): p is NonNullable<typeof p> => p !== null && p.color === color)
    .map((p) => ({ type: p.type, square: p.square }));
}

export function readBoard(chess: Chess, format: "pieces" | "ranks" = "pieces"): string {
  if (format === "pieces") {
    return `White has ${spokenPieceList(piecesOf(chess, "w"))}. Black has ${spokenPieceList(piecesOf(chess, "b"))}.`;
  }
  const lines: string[] = [];
  const board = chess.board(); // board[0] is rank 8
  board.forEach((row, i) => {
    const rank = 8 - i;
    const occupied = row
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => `${colorName(p.color).toLowerCase()} ${PIECE_NAMES[p.type]} on ${spokenSquare(p.square)}`);
    lines.push(`Rank ${rank}: ${occupied.length ? occupied.join(", ") : "empty"}.`);
  });
  return lines.join(" ");
}

export function describeSquare(chess: Chess, square: string): string {
  const sq = square.toLowerCase() as Square;
  if (!/^[a-h][1-8]$/.test(sq)) throw new Error(`${square} is not a square. Use a file a to h and a rank 1 to 8.`);
  const p = chess.get(sq);
  return p ? `There is a ${colorName(p.color).toLowerCase()} ${PIECE_NAMES[p.type]} on ${sq}.` : `${sq} is empty.`;
}

export function legalMovesSpoken(chess: Chess, opts: { square?: string; piece?: string }): { speech: string; moves: string[] } {
  let moves = chess.moves({ verbose: true });
  let subject = "You";
  if (opts.square) {
    const sq = opts.square.toLowerCase();
    moves = moves.filter((m) => m.from === sq);
    const p = chess.get(sq as Square);
    subject = p ? `The ${PIECE_NAMES[p.type]} on ${sq}` : `Nothing on ${sq}`;
  } else if (opts.piece) {
    const type = PIECE_WORDS[opts.piece.toLowerCase()] ?? (opts.piece.toLowerCase() as PieceSymbol);
    moves = moves.filter((m) => m.piece === type);
    subject = `Your ${PIECE_NAMES[type] ?? opts.piece}s`;
  }
  if (moves.length === 0) return { speech: `${subject} can't move right now.`, moves: [] };
  const list = moves.map((m) => spokenMove(m));
  const shown = list.slice(0, 12);
  const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : "";
  return { speech: `${subject} can play: ${joinAnd(shown)}${more}.`, moves: moves.map((m) => m.san) };
}

export function material(chess: Chess): { white: number; black: number; speech: string } {
  let white = 0;
  let black = 0;
  for (const p of chess.board().flat()) {
    if (!p) continue;
    if (p.color === "w") white += PIECE_VALUES[p.type];
    else black += PIECE_VALUES[p.type];
  }
  const diff = white - black;
  const speech =
    diff === 0 ? "Material is even." : `${diff > 0 ? "White" : "Black"} is up ${Math.abs(diff)} point${Math.abs(diff) === 1 ? "" : "s"} of material.`;
  return { white, black, speech };
}

export function sideToMoveSpoken(chess: Chess, humanColor: Color): string {
  const yours = chess.turn() === humanColor;
  const check = chess.inCheck() ? " You are in check." : "";
  return yours ? `It's your move as ${colorName(humanColor)}.${check}` : `It's my move as ${colorName(chess.turn())}.`;
}
