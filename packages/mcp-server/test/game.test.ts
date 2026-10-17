import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  IllegalMoveError,
  describeSquare,
  legalMovesSpoken,
  material,
  playHumanMove,
  readBoard,
  replay,
  statusOf,
} from "../src/chess/game.js";
import { compactPieceList, spokenMove } from "../src/chess/spoken.js";

const play = (...sans: string[]) => {
  const c = new Chess();
  sans.forEach((s) => c.move(s));
  return c;
};

describe("spokenMove", () => {
  it("speaks quiet moves, captures, checks and castling", () => {
    const c = new Chess();
    expect(spokenMove(c.move("Nf3"))).toBe("knight to f3");
    expect(spokenMove(c.move("d5"))).toBe("pawn to d5");
    c.move("e4");
    expect(spokenMove(c.move("dxe4"))).toBe("pawn on d5 takes pawn on e4");
    c.move("Bb5");
    expect(spokenMove(c.move("c6"))).toBe("pawn to c6");
    expect(spokenMove(c.move("O-O"))).toBe("castles kingside");
    c.move("cxb5");
    expect(spokenMove(c.move("Nd4"))).toBe("knight to d4");
  });

  it("says check and checkmate", () => {
    const c = play("f3", "e5", "g4");
    expect(spokenMove(c.move("Qh4#"))).toBe("queen to h4, checkmate");
    const d = play("e4", "f5", "exf5", "g6");
    expect(spokenMove(d.move("Qh5"))).toBe("queen to h5");
    const e = play("e4", "f6", "d4", "g5");
    expect(spokenMove(e.move("Qh5#"))).toBe("queen to h5, checkmate");
  });

  it("names the origin square when SAN disambiguates", () => {
    const c = new Chess("4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1");
    expect(spokenMove(c.move("Nbd2"))).toBe("knight from b1 to d2");
  });

  it("speaks promotion and en passant", () => {
    const c = new Chess("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
    expect(spokenMove(c.move("b8=Q+"))).toBe("pawn to b8, promotes to queen, check");
    const ep = play("e4", "a6", "e5", "d5");
    expect(spokenMove(ep.move("exd6"))).toBe("pawn on e5 takes pawn en passant");
  });
});

describe("playHumanMove", () => {
  it("accepts SAN, sloppy SAN, castling with zeros and UCI", () => {
    const c = new Chess();
    expect(playHumanMove(c, "e4").san).toBe("e4");
    expect(playHumanMove(c, "e7e5").san).toBe("e5");
    expect(playHumanMove(c, "nf3").san).toBe("Nf3");
    expect(playHumanMove(c, "b8-c6").san).toBe("Nc6");
    expect(playHumanMove(c, "Bc4").san).toBe("Bc4");
    playHumanMove(c, "Nf6");
    expect(playHumanMove(c, "0-0").san).toBe("O-O");
  });

  it("does not treat a leading b as bishop", () => {
    const c = new Chess();
    expect(playHumanMove(c, "b4").san).toBe("b4");
  });

  it("rejects illegal moves with suggestions for the same square", () => {
    const c = new Chess();
    try {
      playHumanMove(c, "Nf4");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalMoveError);
      expect((e as IllegalMoveError).suggestions.some((s) => s.startsWith("Nf3") || s.startsWith("Nh3"))).toBe(true);
    }
  });
});

describe("position helpers", () => {
  it("replays UCI history and keeps repetition state", () => {
    const moves = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
    const c = replay(moves);
    expect(statusOf(c)).toEqual({ status: "draw", result: "1/2-1/2", reason: "threefold repetition" });
  });

  it("detects checkmate with the right result", () => {
    expect(statusOf(play("f3", "e5", "g4", "Qh4#"))).toMatchObject({ status: "checkmate", result: "0-1" });
  });

  it("describes squares and reads the board", () => {
    const c = new Chess();
    expect(describeSquare(c, "E1")).toBe("There is a white king on e1.");
    expect(describeSquare(c, "e4")).toBe("e4 is empty.");
    expect(() => describeSquare(c, "z9")).toThrow();
    expect(readBoard(c)).toBe("White has king e1, queen d1, rooks a1 and h1, bishops c1 and f1, knights b1 and g1, pawns a2 to h2. Black has king e8, queen d8, rooks a8 and h8, bishops c8 and f8, knights b8 and g8, pawns a7 to h7.");
    expect(readBoard(c, "pieces", "b")).toMatch(/^You have king e8, .*\. I have king e1, /);
    expect(readBoard(c, "ranks", "w")).toBe(
      "Rank 8: my rook a8, knight b8, bishop c8, queen d8, king e8, bishop f8, knight g8, rook h8. Rank 7: my pawns a7 to h7. " +
        "Ranks 6 to 3: empty. Rank 2: your pawns a2 to h2. Rank 1: your rook a1, knight b1, bishop c1, queen d1, king e1, bishop f1, knight g1, rook h1.",
    );
    const mixed = play("e4", "d5", "exd5");
    expect(readBoard(mixed, "ranks", "w")).toContain("Rank 5: your pawn d5.");
    expect(readBoard(mixed, "ranks", "b")).toContain("Rank 2: my pawns a2 to d2, pawns f2 to h2. ");
    expect(readBoard(mixed, "ranks", "b")).toContain("Rank 6: empty. Rank 5: my pawn d5. Ranks 4 to 3: empty.");
    expect(readBoard(new Chess("4k3/8/8/8/8/8/8/4K3 w - - 0 1"), "ranks")).toBe("Rank 8: black king e8. Ranks 7 to 2: empty. Rank 1: white king e1.");
  });

  it("lists legal moves for a piece and a square", () => {
    const c = new Chess();
    expect(legalMovesSpoken(c, { piece: "knight" }).moves.sort()).toEqual(["Na3", "Nc3", "Nf3", "Nh3"]);
    expect(legalMovesSpoken(c, { square: "e2" }).speech).toBe("The pawn on e2 can go to e3 or e4.");
    expect(legalMovesSpoken(c, { square: "e1" }).speech).toBe("The king on e1 can't move right now.");
    // One queen: captures first, squares only, five at most (the 47-word list from the 2026-10-17 game).
    const q = new Chess("4k3/7p/8/8/8/8/3Q4/4K3 w - - 0 1");
    const speech = legalMovesSpoken(q, { piece: "queen" }).speech;
    expect(speech).toMatch(/^Your queen can go to [a-h][1-8], [a-h][1-8], [a-h][1-8], [a-h][1-8] or [a-h][1-8], and \d+ more\.$/);
    const capture = new Chess("4k3/8/8/8/8/8/3Qp3/4K3 w - - 0 1");
    expect(legalMovesSpoken(capture, { piece: "queen" }).speech).toMatch(/^Your queen can take on e2, or go to /);
    expect(legalMovesSpoken(new Chess(), {}).speech).toMatch(/^You can play: .+, and 15 more\.$/);
  });

  it("reads pawns as ranges", () => {
    expect(compactPieceList([{ type: "p", square: "a2" }, { type: "p", square: "b2" }, { type: "p", square: "c2" }, { type: "p", square: "e4" }, { type: "p", square: "g2" }, { type: "p", square: "h2" }]))
      .toBe("pawns a2 to c2, g2, h2 and e4");
  });

  it("counts material", () => {
    const c = play("e4", "d5", "exd5");
    expect(material(c)).toMatchObject({ white: 39, black: 38, speech: "White is up 1 point of material." });
  });
});
