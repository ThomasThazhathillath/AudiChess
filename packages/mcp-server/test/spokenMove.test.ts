import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { confirmQuestion, resolveSpokenMove, soundKey, tokenize, toSpec } from "../src/chess/spokenMove.js";

const after = (...sans: string[]) => {
  const c = new Chess();
  sans.forEach((s) => c.move(s));
  return c;
};

/** Plays nothing; just what the resolver decides for these transcripts (best first). */
const heard = (chess: Chess, ...alternatives: string[]) => resolveSpokenMove(chess, undefined, alternatives);

describe("stage A: homophones and spoken notation", () => {
  const start = new Chess();
  it.each([
    ["night f three", "Nf3"],
    ["knight to f3", "Nf3"],
    ["kite f3", "Nf3"],
    ["Alexa, knight c3 please", "Nc3"],
    ["g1 to f3", "Nf3"],
    ["g one f three", "Nf3"],
    ["pawn to eat four", "e4"],
    ["e for", "e4"],
    ["ee four", "e4"],
    ["porn e4", "e4"],
    ["E4", "e4"],
    ["d4", "d4"],
    ["pawn to dee four", "d4"],
    ["see four", "c4"],
    ["move my horse to a three", "Na3"],
    ["b four", "b4"],
    ["h3", "h3"],
  ])("start position: %s -> %s", (said, san) => {
    expect(heard(start, said)).toMatchObject({ kind: "move", san, via: "spoken" });
  });

  it("bishop see four", () => {
    expect(heard(after("e4", "e5"), "bishop see four")).toMatchObject({ kind: "move", san: "Bc4" });
  });

  it("pawn captures in several phrasings", () => {
    const c = after("e4", "d5");
    for (const said of ["e takes d5", "takes d5", "pawn takes d5", "exd5", "e x d5"]) {
      expect(heard(c, said)).toMatchObject({ kind: "move", san: "exd5" });
    }
  });

  it("queen takes be seven", () => {
    const c = new Chess("rnbqkbnr/pp2pppp/8/2pp4/8/1Q6/PPPPPPPP/RNB1KBNR w KQkq - 0 3");
    expect(heard(c, "queen takes be seven")).toMatchObject({ kind: "move", san: "Qxb7" });
  });

  it("castling by name", () => {
    const c = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(heard(c, "castle short")).toMatchObject({ kind: "move", san: "O-O" });
    expect(heard(c, "castles kingside")).toMatchObject({ kind: "move", san: "O-O" });
    expect(heard(c, "castle queen side")).toMatchObject({ kind: "move", san: "O-O-O" });
    expect(heard(c, "long castle")).toMatchObject({ kind: "move", san: "O-O-O" });
    expect(heard(c, "0-0")).toMatchObject({ kind: "move", san: "O-O" });
  });

  it("promotion defaults to queen and honours underpromotion", () => {
    const c = new Chess("8/4P3/8/8/8/8/k7/4K3 w - - 0 1");
    expect(heard(c, "e8")).toMatchObject({ kind: "move", san: "e8=Q" });
    expect(heard(c, "e eight queen")).toMatchObject({ kind: "move", san: "e8=Q" });
    expect(heard(c, "pawn to e8 promote to knight")).toMatchObject({ kind: "move", san: "e8=N" });
  });

  it("uses the second alternative when the first is unusable", () => {
    expect(heard(new Chess(), "night forever", "knight f3")).toMatchObject({ kind: "move", san: "Nf3" });
  });

  it("does not read ordinary words as squares", () => {
    expect(toSpec(tokenize("I see a knight"))).toBeUndefined();
  });
});

describe("stage B: garbled speech", () => {
  it("'night forever' becomes a knight move to e4 when that is the only knight-e4/f4 option", () => {
    const c = after("d4", "d5", "Nc3", "Nf6");
    const r = heard(c, "night forever");
    expect(r.kind === "move" || r.kind === "confirm").toBe(true);
    const sans = r.kind === "move" ? [r.san] : r.kind === "confirm" ? r.candidates : [];
    expect(sans[0]).toBe("Ne4");
  });

  it("asks rather than guessing when two moves sound alike", () => {
    const c = new Chess("4k3/8/8/8/8/8/8/3NKN2 w - - 0 1"); // knights on d1 and f1
    const r = heard(c, "night e tree");
    expect(r.kind).toBe("confirm");
  });

  it("never plays a different move when a clearly illegal move was said", () => {
    const r = heard(new Chess(), "knight to f5");
    expect(r.kind).not.toBe("move");
    if (r.kind === "confirm") expect(r.reason).toBe("illegal");
  });

  it("gives up on noise", () => {
    expect(heard(new Chess(), "what a lovely day").kind).toBe("none");
  });

  it("sound keys fold common spellings", () => {
    expect(soundKey("night")).toBe(soundKey("knight"));
    expect(soundKey("e4")).toBe(soundKey("ee four"));
  });
});

describe("the assistant's own reading", () => {
  it("plays exact SAN when there is no speech", () => {
    expect(resolveSpokenMove(new Chess(), "Nf3", [])).toMatchObject({ kind: "move", san: "Nf3", via: "exact" });
  });

  it("agrees with speech when both say the same move", () => {
    expect(resolveSpokenMove(new Chess(), "Nf3", ["night f three"])).toMatchObject({ kind: "move", san: "Nf3" });
  });

  it("speech wins over a model guess that does not match it", () => {
    expect(resolveSpokenMove(new Chess(), "Nf3", ["knight c3"])).toMatchObject({ kind: "move", san: "Nc3" });
  });

  it("accepts raw words passed as the move", () => {
    expect(resolveSpokenMove(after("e4", "e5"), "bishop to see four", [])).toMatchObject({ kind: "move", san: "Bc4" });
  });

  it("phrases a confirmation question", () => {
    const c = new Chess("4k3/8/8/8/8/8/8/3NKN2 w - - 0 1");
    const q = confirmQuestion(c, { kind: "confirm", candidates: ["Ne3", "Nde3"].filter((s) => {
      try { new Chess(c.fen()).move(s); return true; } catch { return false; }
    }), heard: "night e tree", reason: "ambiguous" });
    expect(q).toMatch(/^I heard "night e tree"\. Did you mean knight from/);
  });
});
