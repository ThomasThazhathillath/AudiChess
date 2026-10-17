import { describe, expect, it } from "vitest";
import { ENDINGS, PRAISE, TAUNTS, pickBanter, type BanterState } from "../src/banter.js";

const turn = (over: { quality?: string; swing?: string; trend?: string; mine?: string[]; yours?: string[] }, facts: Record<string, unknown> = {}) => ({
  commentary: {
    yourMove: over.quality ? { quality: over.quality } : undefined,
    swing: over.swing ? { direction: over.swing } : undefined,
    trend: over.trend,
    myMoveIdeas: over.mine ?? [],
    yourMoveIdeas: over.yours ?? [],
  },
  moveFacts: { materialChange: 0, materialBalance: 0, phase: "middlegame", ...facts },
});
const fixed = (x: number) => () => x;
const has = (pool: readonly string[], line?: string) => !!line && pool.includes(line);

describe("pickBanter", () => {
  it("jabs a blunder, and a gift when she took the piece", () => {
    const b = pickBanter(turn({ quality: "blunder" }), undefined, "g", fixed(0)).banter!;
    expect(b.mood).toBe("taunt");
    expect(has(TAUNTS.blunder, b.line)).toBe(true);
    const gift = pickBanter(turn({ quality: "blunder" }, { iCaptured: "knight", materialChange: -3 }), undefined, "g", fixed(0)).banter!;
    expect(has(TAUNTS.gift, gift.line)).toBe(true);
    const queen = pickBanter(turn({ quality: "mistake" }, { iCaptured: "queen", materialChange: -9 }), undefined, "g", fixed(0.99)).banter!;
    expect([...TAUNTS.gift, ...TAUNTS.giftQueen]).toContain(queen.line);
  });

  it("compliments a won piece, a fork and a strong move", () => {
    expect(has(PRAISE.tactic, pickBanter(turn({ quality: "best" }, { youCaptured: "rook", materialChange: 5 }), undefined, "g", fixed(0)).banter?.line)).toBe(true);
    expect(has(PRAISE.fork, pickBanter(turn({ quality: "best", yours: ["forks the queen on b6 and the rook on f6"] }), undefined, "g", fixed(0)).banter?.line)).toBe(true);
    // ...but not when she took the forking piece straight away.
    expect(has(PRAISE.fork, pickBanter(turn({ quality: "best", yours: ["forks the queen on b6 and the rook on f6"] }, { iTookYourPiece: true }), undefined, "g", fixed(0)).banter?.line)).toBe(false);
    const strong = pickBanter(turn({ quality: "best", swing: "your way" }, { wasInCheck: true }), undefined, "g", fixed(0)).banter!;
    expect(strong.mood).toBe("praise");
    expect(has(PRAISE.defense, strong.line)).toBe(true);
  });

  it("only uses fact-specific lines when the fact is true", () => {
    // A knight line only after a knight move, a second-check line only after two checks in a row.
    const odd = pickBanter(turn({ quality: "inaccuracy" }, { yourPiece: "bishop" }), undefined, "g", fixed(0.999)).banter!;
    expect(TAUNTS.oddKnight).not.toContain(odd.line);
    let state: BanterState | undefined;
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = pickBanter(turn({}, { iGaveCheck: true }), state, "g", fixed(0.999));
      state = { ...r.state, quiet: 5 }; // keep minor remarks allowed
      if (r.banter) lines.push(r.banter.line);
    }
    expect(TAUNTS.checkAgain).not.toContain(lines[0]);
    expect(lines.every((l) => [...TAUNTS.check, ...TAUNTS.checkAgain].includes(l))).toBe(true);
  });

  it("spaces remarks out: a blunder waits one move, flavour lines three, the game's end never", () => {
    let r = pickBanter(turn({}, { iGaveCheck: true }), undefined, "g", fixed(0));
    expect(r.banter).toBeDefined();
    r = pickBanter(turn({ quality: "blunder" }), r.state, "g", fixed(0));
    expect(r.banter).toBeUndefined(); // right after a remark: even a blunder waits
    r = pickBanter(turn({ quality: "blunder" }), r.state, "g", fixed(0));
    expect(r.banter).toBeDefined();
    r = pickBanter(turn({}), r.state, "g", fixed(0));
    r = pickBanter(turn({}), r.state, "g", fixed(0));
    expect(pickBanter(turn({}, { iGaveCheck: true }), r.state, "g", fixed(0)).banter).toBeUndefined(); // 2 quiet: not yet
    r = pickBanter(turn({}), r.state, "g", fixed(0));
    expect(pickBanter(turn({}, { iGaveCheck: true }), r.state, "g", fixed(0)).banter).toBeDefined(); // 3 quiet
    expect(pickBanter(turn({}, { winner: "me" }), { ...r.state, quiet: 0 }, "g", fixed(0)).banter).toBeDefined();
  });

  it("never repeats a line within a game, and starts fresh in a new game", () => {
    let state: BanterState | undefined;
    const said: string[] = [];
    for (let i = 0; i < TAUNTS.blunder.length; i++) {
      const r = pickBanter(turn({ quality: "blunder" }), state ? { ...state, quiet: 1 } : undefined, "g", fixed(0));
      state = r.state;
      said.push(r.banter!.line);
    }
    expect(new Set(said).size).toBe(TAUNTS.blunder.length);
    expect(pickBanter(turn({ quality: "blunder" }), state, "g2", fixed(0)).state.used).toHaveLength(1);
  });

  it("says nothing on a quiet move", () => {
    const r = pickBanter(turn({ quality: "good" }), undefined, "g", fixed(0));
    expect(r.banter).toBeUndefined();
    expect(r.state.quiet).toBe(4);
  });

  it("ends the game with a line for each result", () => {
    const win = pickBanter(turn({}, { winner: "you" }), undefined, "g", fixed(0)).banter!;
    expect(win.mood).toBe("ending");
    expect(win.line).toBe(`${PRAISE.mate[0]} ${ENDINGS.youWin[0]}`);
    expect(ENDINGS.iWin).toContain(pickBanter(turn({}, { winner: "me" }), undefined, "g", fixed(0)).banter!.line);
    expect(ENDINGS.draw).toContain(pickBanter(turn({}, { winner: "draw" }), undefined, "g", fixed(0)).banter!.line);
  });

  it("keeps every line short and free of advice", () => {
    const all = [...Object.values(TAUNTS), ...Object.values(PRAISE), ...Object.values(ENDINGS)].flat();
    for (const line of all) {
      expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(10);
      expect(line, line).not.toMatch(/\b(you should|try|consider|careful)\b/i);
    }
  });
});
