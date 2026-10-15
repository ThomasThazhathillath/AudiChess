import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestMove, engineMove } from "../src/chess/engine.js";
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
  deps = { store, engine: { move: engineMove, best: bestMove } };
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
      ["describe_square", "game_history", "game_status", "hint", "last_moves", "legal_moves", "list_pieces", "make_move", "new_game", "read_board", "resign", "undo"].sort(),
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
    expect(bad.speech).toContain("not a legal move");
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
    expect((await call("hint", { gameId: game.gameId })).speech).toMatch(/^You could try /);

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
