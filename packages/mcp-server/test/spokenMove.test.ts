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

// Mishearings from a real Chrome en-IN game.
describe("en-IN mishearings", () => {
  // 1.e4 e6 2.Nf3 d5 3.Nc3 d4: the d2 pawn can only go to d3.
  const french = () => after("e4", "e6", "Nf3", "d5", "Nc3", "d4");

  it.each([
    ["porn e4", "e4"],
    ["pond e4", "e4"],
    ["poon e4", "e4"],
    ["pound e4", "e4"],
    ["pondy 4", "d4"],
    ["pondi four", "d4"],
    ["pondi e4", "e4"],
    ["night free", "Nf3"],
    ["nighty f3", "Nf3"],
  ])("start position: %s -> %s", (said, san) => {
    expect(heard(new Chess(), said)).toMatchObject({ kind: "move", san, via: "spoken" });
  });

  it.each([
    ["Pondicherry", "d3"],
    ["pondi 3", "d3"],
    ["pondy three", "d3"],
  ])("pawn to d3: %s -> %s", (said, san) => {
    expect(heard(french(), said)).toMatchObject({ kind: "move", san });
  });

  it("'porn D2' names the pawn's square: asks about d3", () => {
    expect(heard(french(), "porn D2")).toMatchObject({ kind: "confirm", candidates: ["d3"] });
  });

  it("'porn D2' with two pawn moves offers both", () => {
    expect(heard(new Chess(), "porn D2")).toMatchObject({ kind: "confirm", candidates: ["d3", "d4"] });
  });

  it("'porn pics D4' is still never played as the knight capture", () => {
    expect(heard(french(), "porn pics D4", "porn pics", "D4")).toMatchObject({ kind: "confirm", candidates: ["Nxd4"], reason: "illegal" });
  });

  it.each([
    [["93", "nighty"]],
    [["933", "nighty"]],
    [["nighty 3"]],
    [["ninety three"]],
  ])("knight with only a rank heard asks: %j", (alts) => {
    expect(heard(new Chess(), ...alts)).toMatchObject({ kind: "confirm", candidates: ["Nc3", "Nf3"], reason: "ambiguous" });
  });

  it("knight with only a rank heard plays the one knight move to that rank", () => {
    const c = new Chess("4k3/8/8/8/8/7P/8/4K1N1 w - - 0 1"); // Ng1, h3 taken
    expect(heard(c, "93", "nighty")).toMatchObject({ kind: "move", san: "Nf3" });
  });

  it("the assistant's guess is offered first when only a rank was heard", () => {
    expect(resolveSpokenMove(new Chess(), "Nh3", ["93", "nighty"])).toMatchObject({ kind: "confirm", candidates: ["Nh3", "Nc3"] });
  });

  it("'Bishop 4' asks between the bishop and the b-pawn", () => {
    expect(heard(after("e4", "e5"), "Bishop 4")).toMatchObject({ kind: "confirm", candidates: ["Bc4", "b4"], reason: "ambiguous" });
  });

  it("'bishopi 4' asks between Bb4 and b4 when both are legal", () => {
    const c = after("d4", "e6", "Bd2", "a6");
    expect(heard(c, "bishopi 4")).toMatchObject({ kind: "confirm", candidates: ["Bb4", "b4"] });
  });

  it("'bishopi 4' asks about b4 rather than playing it when no bishop can go there", () => {
    expect(heard(after("e4", "e5"), "bishopi 4")).toMatchObject({ kind: "confirm", candidates: ["b4"], reason: "unclear" });
  });

  it.each([["take night"], ["takes knight"], ["take the knight"]])("'%s' plays the only knight capture", (said) => {
    expect(heard(after("e4", "e6", "Nf3", "d5", "Nc3", "d4", "Nxd4"), said)).toMatchObject({ kind: "move", san: "Qxd4" });
  });

  it("'takes knight' asks when two pieces can take one", () => {
    const c = after("d4", "e5", "dxe5", "Nc6", "Nf3", "Nd4"); // Nf3 and Qd1 both hit d4
    expect(heard(c, "takes knight")).toMatchObject({ kind: "confirm", candidates: ["Nxd4", "Qxd4"], reason: "ambiguous" });
  });

  it("'take the queen' never plays a move when no queen can be taken", () => {
    expect(heard(after("e4", "e6", "Nf3", "d5", "Nc3", "d4", "Nxd4", "Qxd4"), "take the queen").kind).not.toBe("move");
  });

  it("a named capturer narrows a capture by type", () => {
    const c = after("d4", "e5", "dxe5", "Nc6", "Nf3", "Nd4");
    expect(heard(c, "queen takes knight")).toMatchObject({ kind: "move", san: "Qxd4" });
  });

  it("'free' is only f3 right after a piece", () => {
    expect(toSpec(tokenize("I am free"))).toBeUndefined();
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

  // Live bugs: a bare square that no pawn can reach was silently played by the only piece that could.
  it("asks before playing a piece move when only a square was said", () => {
    expect(resolveSpokenMove(after("e4", "e6"), "a6", ["let's play A6", "let's play six"])).toMatchObject({ kind: "confirm", candidates: ["Ba6"] });
    expect(resolveSpokenMove(after("e4", "e6"), "a6", [])).not.toMatchObject({ kind: "move" });
  });

  it("asks when a pawn was named but only a knight can take there", () => {
    const c = after("e4", "e6", "Nf3", "d5", "Nc3", "d4");
    expect(resolveSpokenMove(c, "D4", ["porn pics D4", "porn pics", "D4"])).toMatchObject({ kind: "confirm", candidates: ["Nxd4"], reason: "illegal" });
  });

  it("still plays a bare square for a pawn, even capitalised", () => {
    expect(resolveSpokenMove(new Chess(), "E4", ["E4"])).toMatchObject({ kind: "move", san: "e4" });
    expect(resolveSpokenMove(new Chess(), "B4", [])).toMatchObject({ kind: "move", san: "b4" });
  });

  it("'let's play six' alone is not a move", () => {
    expect(heard(after("e4", "e6"), "let's play six").kind).not.toBe("move");
  });

  it("phrases a confirmation question", () => {
    const c = new Chess("4k3/8/8/8/8/8/8/3NKN2 w - - 0 1");
    const q = confirmQuestion(c, { kind: "confirm", candidates: ["Ne3", "Nde3"].filter((s) => {
      try { new Chess(c.fen()).move(s); return true; } catch { return false; }
    }), heard: "night e tree", reason: "ambiguous" });
    expect(q).toMatch(/^I heard "night e tree"\. Did you mean knight from/);
  });
});
