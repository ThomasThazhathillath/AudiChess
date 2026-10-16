import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  alertsFor,
  classifyMove,
  describeEval,
  evalSwing,
  evalTrend,
  hangingPieces,
  materialBalance,
  moveIdeas,
  spokenMaterial,
} from "../src/chess/analysis.js";
import { currentOpening, openingAt } from "../src/chess/openings.js";

describe("move quality", () => {
  it("grades by centipawn loss", () => {
    expect(classifyMove(30, 25, false).quality).toBe("best");
    expect(classifyMove(30, -10, false).quality).toBe("good");
    expect(classifyMove(30, -60, false).quality).toBe("inaccuracy");
    expect(classifyMove(30, -200, false).quality).toBe("mistake");
    expect(classifyMove(30, -500, false).quality).toBe("blunder");
    expect(classifyMove(30, -500, true).quality).toBe("best");
  });
  it("is lenient once the game is decided", () => {
    expect(classifyMove(1500, 900, false).quality).toBe("inaccuracy");
  });
  it("describes evaluations", () => {
    expect(describeEval(10)).toBe("roughly equal");
    expect(describeEval(-200)).toBe("Black is clearly better");
    expect(describeEval(0, 3)).toBe("White has a forced mate");
  });
});

describe("threats and ideas", () => {
  it("spots an undefended attacked piece", () => {
    const c = new Chess("4k3/8/8/3p4/2B5/8/8/4K3 w - - 0 1"); // bishop c4 attacked by pawn d5
    expect(hangingPieces(c, "w")[0]).toMatchObject({ piece: "b", square: "c4", attackedBy: "p" });
    expect(alertsFor(c, "w")[0]).toBe("your bishop on c4 is under attack by a pawn");
  });
  it("describes a developing capture with check", () => {
    const c = new Chess();
    ["e4", "e5", "Nf3", "d6", "Bc4", "Bg4"].forEach((m) => c.move(m));
    const m = c.move("Bxf7+");
    expect(moveIdeas(m, c)).toEqual(expect.arrayContaining(["captures a pawn", "gives check"]));
    const d = new Chess();
    expect(moveIdeas(d.move("Nf3"), d)).toContain("develops the knight");
  });
});

describe("game flow facts", () => {
  it("only reports real swings", () => {
    expect(evalSwing(undefined, 300)).toBeUndefined();
    expect(evalSwing(20, 90)).toBeUndefined();
    expect(evalSwing(20, 250)).toEqual({ cp: 230, direction: "your way" });
    expect(evalSwing(50, -200)).toEqual({ cp: -250, direction: "my way" });
  });

  it("reads a trend from the last few evaluations", () => {
    expect(evalTrend([0, 10])).toBeUndefined();
    expect(evalTrend([0, 40, 90, 160])).toBe("improving");
    expect(evalTrend([50, 0, -80, -120])).toBe("slipping");
    expect(evalTrend([500, 0, 20, 10, 30])).toBe("steady"); // only the last four count
  });

  it("counts material from the user's side", () => {
    const c = new Chess();
    expect(materialBalance(c, "w")).toBe(0);
    c.move("e4"); c.move("d5"); c.move("exd5");
    expect(materialBalance(c, "w")).toBe(1);
    expect(materialBalance(c, "b")).toBe(-1);
    expect(spokenMaterial(1)).toBe("you're up a pawn");
    expect(spokenMaterial(-3)).toBe("I'm up 3 points");
    expect(spokenMaterial(0)).toBe("material is level");
  });
});

describe("openings", () => {
  it("names common openings, transpositions included", () => {
    const c = new Chess();
    ["e4", "c5"].forEach((m) => c.move(m));
    expect(currentOpening(c)).toEqual({ name: "Sicilian Defense", ply: 2 });
    ["Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"].forEach((m) => c.move(m));
    expect(currentOpening(c)?.name).toBe("Sicilian Defense: Najdorf Variation");
    expect(openingAt(new Chess().fen())).toBeUndefined();
  });
});
