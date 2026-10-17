import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  endsWithHandback,
  engineMoveMissing,
  estimateCost,
  factsOnly,
  isMadeUpClaim,
  pickMove,
  repeatedFirstWords,
  repeatedPhrases,
  sentences,
  spokenSan,
  squaresIn,
  ungroundedSquares,
  type EvalTurn,
} from "../scripts/converse-eval.js";

const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 2 };
const turn = (user: string, reply: string, toolCalls: EvalTurn["toolCalls"] = [], ms = 1000, toolResults: EvalTurn["toolResults"] = []): EvalTurn => ({
  user,
  alternatives: [],
  reply,
  toolCalls,
  toolResults,
  ms,
  usage,
});

describe("conversation metrics", () => {
  it("finds 3-word phrases shared by different replies, not within one", () => {
    const r = repeatedPhrases(["You played e4. I play e5. Your move.", "You played Nf3! I play Nc6. Your move.", "Fine. Your move."]);
    // Moves and squares are masked, so a fixed template shows up even when the moves differ.
    expect(r.map((p) => p.phrase)).toContain("you played <move>");
    expect(r.map((p) => p.phrase)).toContain("i play <move>");
    expect(r.find((p) => p.phrase === "<move> your move")).toEqual({ phrase: "<move> your move", replies: 2 });
    expect(repeatedPhrases(["your move your move"])).toEqual([]);
    expect(repeatedPhrases(["Nice move, I like it.", "nice move I like that"])).toEqual([
      { phrase: "move i like", replies: 2 },
      { phrase: "nice move i", replies: 2 },
    ]);
  });

  it("detects hand-back endings", () => {
    expect(endsWithHandback("I play e5. Your move.")).toBe(true);
    expect(endsWithHandback("Knight to c6. Your turn!")).toBe(true);
    expect(endsWithHandback("Bishop c5. Over to you.")).toBe(true);
    expect(endsWithHandback("Your move was clever. I take on d4.")).toBe(false);
  });

  it("splits sentences and counts repeated openers", () => {
    expect(sentences("One. Two! Three? ")).toEqual(["One.", "Two!", "Three?"]);
    expect(repeatedFirstWords(["Nice, e4.", "nice move", "Okay.", "Great."])).toEqual([{ word: "nice", replies: 2 }]);
  });

  it("flags move claims only when no move was made", () => {
    expect(isMadeUpClaim("You played e4 and I play e5.", [])).toBe(true);
    expect(isMadeUpClaim("I'll play the Sicilian.", [{ name: "game_history", isError: false }])).toBe(true);
    expect(isMadeUpClaim("You played e4. I play e5.", [{ name: "make_move", isError: false }])).toBe(false);
    expect(isMadeUpClaim("I respond with e5.", [{ name: "make_move", isError: true }])).toBe(true);
    expect(isMadeUpClaim("Hello there!", [])).toBe(false);
  });

  it("checks squares in the reply against the turn's facts", () => {
    expect(squaresIn("Knight to f3, then Bxa6 and e8=Q")).toEqual(["f3", "a6", "e8"]);
    const facts = [JSON.stringify({ speech: "You played pawn to e4. I play pawn to e5.", engineMove: "e5" })];
    expect(ungroundedSquares("You played e4. I answer with pawn to d4.", ["pawn e4", ...facts])).toEqual(["d4"]);
    expect(ungroundedSquares("You played e4, I play e5.", ["pawn e4", ...facts])).toEqual([]);
    expect(factsOnly({ fen: "r1bqkb1r/8 w - - 0 1", gameId: "9da81b77-e4a1", speech: "c3", nested: { id: "b1" } })).toEqual({ speech: "c3", nested: {} });
  });

  it("notices when the engine's reply goes unsaid", () => {
    expect(engineMoveMissing("You played d4. Your move.", "Nd7")).toBe(true);
    expect(engineMoveMissing("I go knight to d7.", "Nd7")).toBe(false);
    expect(engineMoveMissing("I castle queenside.", "O-O-O")).toBe(false);
    expect(engineMoveMissing("I play rook to a1.", "O-O")).toBe(true);
    expect(engineMoveMissing("Promoting on e8!", "e8=Q+")).toBe(false);
  });

  it("speaks SAN the way a user would", () => {
    expect(spokenSan("Nxe5+")).toBe("knight takes e5");
    expect(spokenSan("dxe4")).toBe("pawn takes e4");
    expect(spokenSan("Rfe1")).toBe("rook to e1");
    expect(spokenSan("O-O-O")).toBe("castle queenside");
    expect(spokenSan("e8=Q#")).toBe("pawn to e8 promote to queen");
  });

  it("picks a legal scripted move, a recapture first, or any legal move", () => {
    const queue = [
      { say: "night free|knight f3", san: ["Nf3"] },
      { say: "pawn d3", san: ["d3"] },
    ];
    expect(pickMove(["d3", "a3", "Nf3"], queue, "e5")).toEqual({ say: "night free|knight f3", san: ["Nf3"] });
    expect(queue).toHaveLength(1);
    expect(pickMove(["exd5", "d3", "Nf3"], queue, "exd5")).toEqual({ say: "pawn takes d5", san: ["exd5"] });
    expect(queue).toHaveLength(1);
    expect(pickMove(["Kf1", "Ke2+"], queue, "Bb4+")).toEqual({ say: "king to f1", san: ["Kf1"] });
    expect(pickMove([], queue)).toBeUndefined();
  });

  it("estimates cost with discounted cache reads", () => {
    expect(estimateCost({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 }, { inPerM: 1, outPerM: 2 })).toBeCloseTo(3.25);
    expect(estimateCost(usage, undefined)).toBeUndefined();
  });

  it("summarises a run", () => {
    const m = computeMetrics(
      [
        turn("e4", "You played e4. I play d5. Your move.", [{ name: "make_move", args: {}, isError: false }], 1000, [
          { name: "make_move", isError: false, data: { speech: "You played pawn to e4. I play pawn to e5.", engineMove: "e5" } },
        ]),
        turn("hello", "You played well. I play on. Your move.", [], 3000),
        turn("zzz", "Sorry?", [{ name: "make_move", args: { move: "zzz" }, isError: true }], 2000),
      ],
      "global.amazon.nova-2-lite-v1:0",
    );
    expect(m.handbackEndingPct).toBeCloseTo(66.7);
    expect(m.madeUpClaims.count).toBe(1);
    expect(m.madeUpClaims.list[0].turn).toBe(2);
    expect(m.toolErrors.count).toBe(1);
    expect(m.latencyMs).toMatchObject({ avg: 2000, p50: 2000, max: 3000 });
    expect(m.tokens.inputTokens).toBe(3000);
    expect(m.costUsd?.total).toBeCloseTo((3000 * 0.35 + 300 * 2.95) / 1e6, 4); // billed ap-south-1 prices
    expect(m.ungroundedSquares.list.map((u) => u.squares)).toEqual([["d5"]]);
    expect(m.engineMoveNotSaid.list).toMatchObject([{ turn: 1, engineMove: "e5" }]);
    expect(m.repeatedFirstWords).toEqual([{ word: "you", replies: 2 }]);
  });
});
