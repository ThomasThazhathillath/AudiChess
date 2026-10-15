import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { PIECE_NAMES, spokenSquare } from "./spoken.js";

// Facts for the assistant's commentary. The server decides what is true; the model only phrases it.

export type MoveQuality = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/**
 * Classifies the user's move from evaluations (centipawns, from the user's point of view)
 * before and after it. Losses matter less once the game is already decided.
 */
export function classifyMove(beforeCp: number, afterCp: number, playedBest: boolean): { quality: MoveQuality; lossCp: number } {
  const lossCp = Math.max(0, Math.round(beforeCp - afterCp));
  if (playedBest || lossCp <= 15) return { quality: "best", lossCp };
  const decided = Math.abs(beforeCp) > 600 && Math.abs(afterCp) > 600 && Math.sign(beforeCp) === Math.sign(afterCp);
  if (lossCp <= 60) return { quality: "good", lossCp };
  if (lossCp <= 120 || decided) return { quality: "inaccuracy", lossCp };
  if (lossCp <= 300) return { quality: "mistake", lossCp };
  return { quality: "blunder", lossCp };
}

/** "White is clearly better", from a centipawn score for White. */
export function describeEval(cpForWhite: number, mate?: number): string {
  if (mate !== undefined && mate !== 0) return `${mate > 0 ? "White" : "Black"} has a forced mate`;
  const a = Math.abs(cpForWhite);
  const side = cpForWhite > 0 ? "White" : "Black";
  if (a < 40) return "roughly equal";
  if (a < 120) return `${side} is slightly better`;
  if (a < 300) return `${side} is clearly better`;
  return `${side} is winning`;
}

/** Pieces of `color` that are attacked and either undefended or attacked by something cheaper. Most valuable first. */
export function hangingPieces(chess: Chess, color: Color): { piece: PieceSymbol; square: Square; attackedBy: PieceSymbol }[] {
  const enemy: Color = color === "w" ? "b" : "w";
  const out: { piece: PieceSymbol; square: Square; attackedBy: PieceSymbol }[] = [];
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== color || p.type === "k") continue;
      const attackers = chess.attackers(p.square, enemy);
      if (attackers.length === 0) continue;
      const cheapest = attackers
        .map((sq) => chess.get(sq)!.type)
        .sort((a, b) => VALUE[a] - VALUE[b])[0];
      const defended = chess.attackers(p.square, color).length > 0;
      if (!defended || VALUE[cheapest] < VALUE[p.type]) out.push({ piece: p.type, square: p.square, attackedBy: cheapest });
    }
  }
  return out.sort((a, b) => VALUE[b.piece] - VALUE[a.piece]);
}

/** Short factual notes about a move, e.g. "develops the knight", "captures a bishop", "gives check". */
export function moveIdeas(move: Move, chessAfter: Chess): string[] {
  const ideas: string[] = [];
  if (move.flags.includes("k") || move.flags.includes("q")) ideas.push("castles to safety");
  if (move.captured) ideas.push(`captures a ${PIECE_NAMES[move.captured]}`);
  if (move.promotion) ideas.push(`promotes to a ${PIECE_NAMES[move.promotion]}`);
  if (move.san.endsWith("#")) ideas.push("delivers checkmate");
  else if (move.san.endsWith("+")) ideas.push("gives check");
  const homeRank = move.color === "w" ? "1" : "8";
  if ((move.piece === "n" || move.piece === "b") && move.from[1] === homeRank) ideas.push(`develops the ${PIECE_NAMES[move.piece]}`);
  if (move.piece === "p" && (move.to === "d4" || move.to === "e4" || move.to === "d5" || move.to === "e5")) ideas.push("stakes a claim in the centre");
  if (move.piece === "q" && chessAfter.history().length < 12) ideas.push("brings the queen out early");
  // Threats the moved piece creates against more valuable or undefended targets.
  const enemy: Color = move.color === "w" ? "b" : "w";
  const targets = hangingPieces(chessAfter, enemy).filter((h) => chessAfter.attackers(h.square, move.color).includes(move.to));
  if (targets.length) ideas.push(`attacks the ${PIECE_NAMES[targets[0].piece]} on ${spokenSquare(targets[0].square)}`);
  return ideas;
}

/** Warnings for the user after the engine's move: their own pieces left en prise. */
export function alertsFor(chess: Chess, userColor: Color): string[] {
  if (chess.isGameOver()) return [];
  return hangingPieces(chess, userColor)
    .slice(0, 2)
    .map((h) => `your ${PIECE_NAMES[h.piece]} on ${spokenSquare(h.square)} is under attack by a ${PIECE_NAMES[h.attackedBy]}`);
}

/** Converts a side-to-move score to White's point of view. */
export const forWhite = (cp: number, sideToMove: Color) => (sideToMove === "w" ? cp : -cp);
