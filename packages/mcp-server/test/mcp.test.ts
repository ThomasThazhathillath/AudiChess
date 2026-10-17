import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyse, bestMove, engineMove, topMoves } from "../src/chess/engine.js";
import { handleMcpRequest } from "../src/http.js";
import type { Deps } from "../src/server.js";
import { MemoryGameStore } from "../src/store.js";

// End-to-end through the real Streamable HTTP transport and real Stockfish, with an in-memory store.
// The client's fetch is routed straight into handleMcpRequest, exactly as the Lambda handler calls it.

const TOKEN = "test-token";
const URL_ = new URL("https://mcp.test/mcp");

let store: MemoryGameStore;
let deps: Deps;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { ...(res.structuredContent as Record<string, any>), isError: res.isError === true };
};

beforeEach(async () => {
  store = new MemoryGameStore();
  deps = { store, engine: { move: engineMove, best: bestMove, analyse, top: topMoves } };
  client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(URL_, {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    fetch: (input, init) => handleMcpRequest(new Request(input, init), deps, { token: TOKEN }),
  });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
});

describe("transport and auth", () => {
  it("lists all chess tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["analyze_position", "consider_move", "describe_square", "game_history", "game_status", "hint", "last_moves", "legal_moves", "list_pieces", "make_move", "new_game", "offer_draw", "read_board", "resign", "review_game", "set_level", "undo"].sort(),
    );
  });

  it("rejects missing token, foreign origins and GET", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" };
    expect((await handleMcpRequest(new Request(URL_, init), deps, { token: TOKEN })).status).toBe(401);
    const withOrigin = new Request(URL_, { ...init, headers: { ...init.headers, authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" } });
    expect((await handleMcpRequest(withOrigin, deps, { token: TOKEN })).status).toBe(403);
    const get = new Request(URL_, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await handleMcpRequest(get, deps, { token: TOKEN })).status).toBe(405);
  });
});

describe("playing a game", () => {
  it("plays moves, gets engine replies and stores every move", async () => {
    const game = await call("new_game", { color: "white", level: 1 });
    expect(game.isError).toBe(false);
    expect(game.speech).toContain("You are White");

    const r1 = await call("make_move", { gameId: game.gameId, move: "e4" });
    expect(r1.isError).toBe(false);
    expect(r1.yourMove).toBe("e4");
    expect(r1.engineMove).toBeTruthy();
    expect(r1.speech).toMatch(/^You played pawn to e4\. I play .+\./);

    const r2 = await call("make_move", { gameId: game.gameId, move: "Nf3" });
    expect(r2.isError).toBe(false);

    const moves = store.moves.get(game.gameId)!;
    expect(moves.map((m) => m.ply)).toEqual([1, 2, 3, 4]);
    expect(moves.map((m) => m.by)).toEqual(["human", "engine", "human", "engine"]);
    expect(moves[0]).toMatchObject({ san: "e4", uci: "e2e4", moveNumber: 1, color: "w", spoken: "pawn to e4" });
    expect(store.games.get(game.gameId)!.plyCount).toBe(4);

    const last = await call("last_moves", { gameId: game.gameId, count: 2 });
    expect(last.speech).toMatch(/^Move 2, you played knight to f3\. Move 2, I played /);

    const history = await call("game_history", { gameId: game.gameId });
    expect(history.pgn).toContain("1. e4");
    expect(history.moves).toHaveLength(4);
  }, 30_000);

  it("engine opens when the user plays black", async () => {
    const game = await call("new_game", { color: "black", level: 2 });
    expect(game.engineMove).toBeTruthy();
    expect(store.moves.get(game.gameId)).toHaveLength(1);
    expect(game.speech).toContain("I open with");
  }, 30_000);

  it("explains illegal moves without recording anything", async () => {
    const game = await call("new_game", { color: "white", level: 1 });
    const bad = await call("make_move", { gameId: game.gameId, move: "Ke2" });
    expect(bad.isError).toBe(true);
    expect(bad.speech).toBe("That move isn't possible: e2 is occupied by your own pawn.");
    expect(store.moves.get(game.gameId) ?? []).toHaveLength(0);
  }, 30_000);

  it("answers board questions, hint, undo and resign", async () => {
    const game = await call("new_game", { color: "white", level: 1 });
    await call("make_move", { gameId: game.gameId, move: "e4" });

    expect((await call("describe_square", { gameId: game.gameId, square: "e4" })).speech).toBe("There is a white pawn on e4.");
    expect((await call("list_pieces", { gameId: game.gameId, color: "black", piece: "queen" })).speech).toBe("Black has queen on d8.");
    expect((await call("read_board", { gameId: game.gameId })).speech).toContain("It's your move as White.");
    expect((await call("legal_moves", { gameId: game.gameId, piece: "knight" })).moves.length).toBeGreaterThan(0);
    expect((await call("game_status", { gameId: game.gameId })).speech).toMatch(/^Move 2\. It's your move as White\./);
    expect((await call("hint", { gameId: game.gameId })).speech).toMatch(/^Try /);

    const undo = await call("undo", { gameId: game.gameId });
    expect(undo.speech).toContain("Took back pawn to e4");
    expect(store.moves.get(game.gameId)).toHaveLength(0);

    const resign = await call("resign", { gameId: game.gameId });
    expect(resign.result).toBe("0-1");
    expect((await call("make_move", { gameId: game.gameId, move: "e4" })).isError).toBe(true);

    const list = await call("game_history", {});
    expect(list.games).toHaveLength(1);
  }, 30_000);

  it("reports unknown games politely", async () => {
    const r = await call("read_board", { gameId: "nope" });
    expect(r.isError).toBe(true);
    expect(r.speech).toContain("can't find a game");
  });
});

describe("conversation features", () => {
  /** Engine that plays a fixed script of UCI replies (analysis stays real Stockfish). */
  const scriptEngine = (...replies: string[]) => {
    deps.engine = { ...deps.engine, move: async () => replies.shift() ?? (await engineMove([], 1)) };
  };

  it("names the opening the engine's reply creates (the Sicilian)", async () => {
    scriptEngine("c7c5");
    const game = await call("new_game", { color: "white", level: 3 });
    const r = await call("make_move", { gameId: game.gameId, move: "e4" });
    expect(r.engineMove).toBe("c5");
    expect(r.commentary.opening).toEqual({ name: "Sicilian Defense", reachedBy: "my move" });
    expect(r.commentary.yourMove.quality).toMatch(/best|good/);
    expect(store.moves.get(game.gameId)![1].opening).toBe("Sicilian Defense");
    expect((await call("game_status", { gameId: game.gameId })).speech).toContain("Sicilian Defense");
  }, 30_000);

  it("flags a blunder and says what was better", async () => {
    scriptEngine("e7e5", "d8h4");
    const game = await call("new_game", { color: "white", level: 3 });
    await call("make_move", { gameId: game.gameId, move: "e4" });
    // 2.Qh5?? is not a blunder, but 2.Ba6?? hangs a bishop for nothing.
    const r = await call("make_move", { gameId: game.gameId, move: "Ba6" });
    expect(r.commentary.yourMove.quality).toMatch(/mistake|blunder/);
    expect(r.commentary.yourMove.betterWas).toBeTruthy();
    const rec = store.moves.get(game.gameId)!.find((m) => m.san === "Ba6")!;
    expect(rec.quality).toMatch(/mistake|blunder/);
    expect(rec.bestSan).toBeTruthy();
    expect(typeof rec.evalCp).toBe("number");
  }, 30_000);

  it("matches misheard speech through alternatives", async () => {
    scriptEngine("e7e5");
    const game = await call("new_game", { color: "white", level: 3 });
    const r = await call("make_move", { gameId: game.gameId, move: "night f three", alternatives: ["night f three", "knight f3"] });
    expect(r.isError).toBe(false);
    expect(r.yourMove).toBe("Nf3");
  }, 30_000);

  it("asks for confirmation instead of guessing, and records nothing", async () => {
    const game = await call("new_game", { color: "white", level: 3 });
    const r = await call("make_move", { gameId: game.gameId, move: "knight to f5", alternatives: ["knight to f5"] });
    expect(r.isError).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.speech).toMatch(/Did you mean/);
    expect(store.moves.get(game.gameId) ?? []).toHaveLength(0);
  }, 30_000);

  it("changes difficulty mid-game", async () => {
    const game = await call("new_game", { color: "white", level: 3 });
    const r = await call("set_level", { gameId: game.gameId, level: 6 });
    expect(r).toMatchObject({ level: 6, previousLevel: 3, direction: "stronger" });
    expect(store.games.get(game.gameId)!.level).toBe(6);
  });
});

describe("questions about the position", () => {
  const scriptEngine = (...replies: string[]) => {
    deps.engine = { ...deps.engine, move: async () => replies.shift() ?? (await engineMove([], 1)) };
  };

  it("finds a fork and a mate in one, with best moves and my threat", async () => {
    const fork = await call("new_game", { color: "white", level: 1, fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1" });
    const a = await call("analyze_position", { gameId: fork.gameId });
    expect(a.isError).toBe(false);
    expect(a.tactics.forks[0]).toMatchObject({ san: "Nc7+", targets: expect.arrayContaining(["king", "rook on a8"]) });
    expect(a.bestMoves[0].san).toBe("Nc7+");
    expect(a.toMove).toBe("you");

    // In check: every way out is listed by kind (the model once said the king had no escape when Ke2 was legal).
    const check = await call("new_game", { color: "white", level: 1, setupMoves: ["e4", "e5", "f3", "Qh4+"] });
    const c = await call("analyze_position", { gameId: check.gameId });
    expect(c.youAreInCheck).toBe(true);
    expect(c.waysOutOfCheck).toEqual({ kingMoves: ["king to e2"], captureTheChecker: [], blocks: ["pawn to g3"], checkedBy: ["my queen on h4"] });

    const mate = await call("new_game", { color: "white", level: 1, fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1" });
    const m = await call("analyze_position", { gameId: mate.gameId });
    expect(m.tactics.mateInOne).toContain("rook to a8, checkmate");
    expect(m.evaluation.mateIn).toBe(1);
    expect(m.evaluation.says).toBe("you have a forced mate in 1");
  }, 30_000);

  it("explains illegal moves: pins, attacked squares, blocked pieces, castling", async () => {
    const pin = await call("new_game", { color: "white", level: 1, fen: "4k3/8/8/8/1b6/8/3N4/4K3 w - - 0 1" });
    const p = await call("consider_move", { gameId: pin.gameId, move: "knight to f3" });
    expect(p).toMatchObject({ legal: false });
    expect(p.reason).toMatch(/pinned to your king by my bishop on b4/);

    const king = await call("new_game", { color: "white", level: 1, fen: "4k3/8/8/8/8/8/4r3/K7 w - - 0 1" });
    expect((await call("consider_move", { gameId: king.gameId, move: "king to b2" })).reason).toMatch(/b2 is attacked by my rook on e2/);

    const start = await call("new_game", { color: "white", level: 1 });
    expect((await call("consider_move", { gameId: start.gameId, move: "castle kingside" })).reason).toMatch(/bishop on f1 and knight on g1/);
    expect((await call("consider_move", { gameId: start.gameId, move: "bishop to c4" })).reason).toMatch(/blocked by your pawn on e2/);
    const ok = await call("consider_move", { gameId: start.gameId, move: "pawn e4" });
    expect(ok).toMatchObject({ legal: true, san: "e4" });
    expect(ok.myBestReply).toBeTruthy();
    expect(store.moves.get(start.gameId) ?? []).toHaveLength(0); // nothing was played
    // A piece but no square: where it can go, and which square they mean.
    const which = await call("consider_move", { gameId: start.gameId, move: "What happens if I move my knight?" });
    expect(which.speech).toBe("Your knights can play: knight to a3, knight to c3, knight to f3 and knight to h3. Which square do you have in mind?");

    // An illegal move: the reason, then the nearest legal reading as a question.
    const r = await call("make_move", { gameId: start.gameId, move: "bishop to c4", alternatives: ["bishop to c4"] });
    // What was heard comes first, so a mishearing is obvious to the player.
    expect(r.speech).toBe(`I heard "bishop to c4": that isn't possible, your bishop on f1 is blocked by your pawn on e2. Did you mean pawn to c4?`);
    const nonsense = await call("make_move", { gameId: start.gameId, move: "queen to h8", alternatives: ["queen to h8"] });
    expect(nonsense.speech).toMatch(/^I heard "queen to h8": that isn't possible, .*queen.*\. Did you mean /);
    // Live site, 1.d4 e6: "pawn takes e6" (and its mishearing "a 6") must get a reason, not silence.
    const live = await call("new_game", { color: "white", level: 1, setupMoves: ["d4", "e6"] });
    const e6 = await call("make_move", { gameId: live.gameId, move: "pawn takes e6", alternatives: ["pawn takes e6"] });
    expect(e6.speech).toBe(`I heard "pawn takes e6": that isn't possible, none of your pawns can reach e6.`);
    const a6 = await call("make_move", { gameId: live.gameId, move: "Bw takes a 6.", alternatives: ["Bw takes a 6."] });
    expect(a6.speech).toBe(`I heard "Bw takes a 6": that isn't possible, there's nothing on a6 to take.`);
  }, 30_000);

  it("hints: one move by default, three on request, or only the piece", async () => {
    const g = await call("new_game", { color: "white", level: 1 });
    const one = await call("hint", { gameId: g.gameId });
    expect(one.options).toHaveLength(1);
    expect(one.speech).toMatch(/^Try /);
    expect((await call("hint", { gameId: g.gameId, count: 3 })).options).toHaveLength(3);
    const vague = await call("hint", { gameId: g.gameId, reveal: false });
    expect(vague.speech).toMatch(/^Look at your /);
    expect(vague.speech).not.toMatch(/[a-h][1-8]/);
  }, 30_000);

  it("sets up a game from moves, reviews it, and declines an early draw", async () => {
    scriptEngine("b7a6");
    const g = await call("new_game", { color: "white", level: 1, setupMoves: ["e4", "e5", "Nf3", "Nc6"] });
    expect(store.moves.get(g.gameId)).toHaveLength(4);
    expect((await call("last_moves", { gameId: g.gameId })).speech).toMatch(/knight to f3.*knight to c6/);
    await call("make_move", { gameId: g.gameId, move: "Ba6" });
    const review = await call("review_game", { gameId: g.gameId });
    expect(review.mistakes[0]).toMatchObject({ moveNumber: 3, move: "bishop to a6" });
    expect(review.biggestMistake.betterWas).toBeTruthy();
    const draw = await call("offer_draw", { gameId: g.gameId });
    expect(draw.accepted).toBe(false);
  }, 60_000);
});
