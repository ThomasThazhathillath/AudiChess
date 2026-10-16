import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { confirmQuestion, fuzzyPiece, resolveSpokenMove } from "../src/chess/spokenMove.js";

// Transcripts below are what Chrome (en-IN) really heard in a live game on 2026-10-16.
const heard = (chess: Chess, ...alternatives: string[]) => resolveSpokenMove(chess, undefined, alternatives);

const oneRook = new Chess("k7/8/8/8/8/8/8/4R2K w - - 0 1"); // only Re1 can go to e7
const twoRooks = new Chess("k7/2R5/8/8/8/8/8/4R2K w - - 0 1"); // Rc7 and Re1 can both go to e7

describe("rook mishearings from a real game", () => {
  it.each(["rok E7", "Rock E7", "Rocky e7", "ruk e seven", "rooked E7", "rocket e7", "book e7"])("one rook can reach e7: %s plays it without asking", (said) => {
    expect(heard(oneRook, said)).toMatchObject({ kind: "move", san: "Re7" });
  });

  it("a lone rank is enough when one rook move fits", () => {
    expect(heard(new Chess("7k/8/8/8/8/8/8/R6K w - - 0 1"), "rocket 8")).toMatchObject({ kind: "move", san: "Ra8+" });
  });

  it("'even' is e1 in Indian English", () => {
    expect(heard(twoRooks, "even to E7")).toMatchObject({ kind: "move", san: "Ree7" });
  });

  it("two rooks reach the square: asks which one, by square", () => {
    const r = heard(twoRooks, "ruk is want to E7");
    expect(r.kind).toBe("confirm");
    if (r.kind === "confirm") expect(confirmQuestion(twoRooks, r)).toMatch(/^Which rook: the one on (c7|e1), or the one on (c7|e1)\?$/);
  });
});

describe("other mishearings", () => {
  it("wish up / Rishabh are bishops", () => {
    const c = new Chess("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    c.move("e5");
    expect(heard(c, "wish up c4")).toMatchObject({ kind: "move", san: "Bc4" });
    expect(heard(c, "Rishabh c4")).toMatchObject({ kind: "move", san: "Bc4" });
  });

  it("fuzzyPiece covers sound-alike prefixes", () => {
    expect(fuzzyPiece("rukhs")).toBe("r");
    expect(fuzzyPiece("nighty")).toBe("n");
    expect(fuzzyPiece("table")).toBeUndefined();
  });
});
