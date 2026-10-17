import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { LEVELS, engineMove, pickHumanlike, type Line } from "../src/chess/engine.js";

/** Small deterministic generator (mulberry32), so the statistics below don't flake. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A middlegame-like spread: one best move, a few near it, some inaccuracies, two blunders and a losing move.
const LINES: Line[] = [
  { move: "best", scoreCp: 40, pv: [] },
  { move: "near1", scoreCp: 30, pv: [] },
  { move: "near2", scoreCp: 20, pv: [] },
  { move: "ok1", scoreCp: -20, pv: [] },
  { move: "ok2", scoreCp: -40, pv: [] },
  { move: "dubious", scoreCp: -100, pv: [] },
  { move: "hangsKnight", scoreCp: -260, pv: [] },
  { move: "hangsRook", scoreCp: -460, pv: [] },
  { move: "walksIntoMate", scoreCp: -99990, pv: [] },
];

function stats(level: number, opening = false, n = 4000) {
  const rng = seeded(level * 7919);
  const style = LEVELS[level].human!;
  let loss = 0;
  let blunders = 0;
  const count = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const m = pickHumanlike(LINES, style, rng, opening);
    const l = LINES.find((x) => x.move === m)!;
    const lost = Math.min(2000, 40 - l.scoreCp);
    loss += lost;
    if (lost >= 150) blunders++;
    count.set(m, (count.get(m) ?? 0) + 1);
  }
  return { avgLoss: loss / n, blunderShare: blunders / n, count };
}

describe("human-like picker (levels 1-4)", () => {
  it("loses more centipawns the lower the level", () => {
    const avg = [1, 2, 3, 4].map((l) => stats(l).avgLoss);
    expect(avg[0]).toBeGreaterThan(avg[1]);
    expect(avg[1]).toBeGreaterThan(avg[2]);
    expect(avg[2]).toBeGreaterThan(avg[3]);
  });

  it("blunders at about its blunder rate or more, and almost never walks into mate", () => {
    for (const level of [1, 2, 3, 4]) {
      const s = stats(level);
      expect(s.blunderShare).toBeGreaterThanOrEqual(LEVELS[level].human!.blunderRate * 0.8);
      expect((s.count.get("walksIntoMate") ?? 0) / 4000).toBeLessThan(0.002);
    }
  });

  it("plays the opening cleanly: no blunders, lower temperature", () => {
    const s = stats(2, true);
    expect(s.count.get("hangsRook") ?? 0).toBeLessThan(40);
    expect(s.avgLoss).toBeLessThan(stats(2).avgLoss);
  });

  it("handles a single move, duplicates and mate scores", () => {
    expect(pickHumanlike([{ move: "only", scoreCp: -5, pv: [] }], LEVELS[1].human!, seeded(1))).toBe("only");
    const dup = [{ move: "a", scoreCp: 10, pv: [] }, { move: "a", scoreCp: 10, pv: [] }];
    expect(pickHumanlike(dup, LEVELS[2].human!, seeded(2))).toBe("a");
    const mate = [{ move: "mates", scoreCp: 99990, mate: 1, pv: [] }, { move: "quiet", scoreCp: 50, pv: [] }];
    let mates = 0;
    const rng = seeded(3);
    for (let i = 0; i < 500; i++) if (pickHumanlike(mate, LEVELS[4].human!, rng) === "mates") mates++;
    expect(mates).toBeGreaterThan(480); // a mate in one is found (the other move loses 2000+ cp)
    expect(() => pickHumanlike([], LEVELS[1].human!)).toThrow();
  });
});

describe("engine levels", () => {
  it("plays a legal move at every level, quickly for the weak ones", async () => {
    const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"];
    for (const level of [1, 2, 3, 4, 5, 8]) {
      const t = Date.now();
      const uci = await engineMove(moves, level);
      const chess = new Chess();
      for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
      expect(() => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })).not.toThrow();
      if (LEVELS[level].human) expect(Date.now() - t).toBeLessThan(2000);
    }
  }, 30_000);

  it("finds the mate in one even at the easy level", async () => {
    // Back-rank mate: Ra8#. Easy should take it nearly always (the other moves lose 2000+ cp).
    let found = 0;
    for (let i = 0; i < 5; i++) if ((await engineMove([], 2, "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")) === "a1a8") found++;
    expect(found).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it("labels the levels the user asks for", () => {
    expect(LEVELS[2].label).toMatch(/^easy, about 800/);
    expect(LEVELS[4].label).toMatch(/^medium, about 1500/);
    expect(LEVELS[6].label).toMatch(/^hard, about 2500/);
  });
});
