import type { Chess } from "chess.js";
import openings from "../../data/openings.json" with { type: "json" };

// Opening names from the lichess chess-openings dataset (CC0), keyed by position so transpositions count.
const BY_POSITION = openings as Record<string, string>;

const positionKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

export function openingAt(fen: string): string | undefined {
  return BY_POSITION[positionKey(fen)];
}

/** The deepest named opening the game has passed through, and the ply where it was reached. */
export function currentOpening(chess: Chess): { name: string; ply: number } | undefined {
  const history = chess.history({ verbose: true });
  for (let i = history.length - 1; i >= 0; i--) {
    const name = openingAt(history[i].after);
    if (name) return { name, ply: i + 1 };
  }
  return undefined;
}
