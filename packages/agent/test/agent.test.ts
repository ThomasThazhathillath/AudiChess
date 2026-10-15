import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { cleanSpeech, runTurn, toBedrockTools, type AgentDeps } from "../src/agent.js";
import type { ChessTools, McpTool } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";

const MCP_TOOLS: McpTool[] = [
  { name: "new_game", description: "Start", inputSchema: { $schema: "x", type: "object", properties: { color: { type: "string" }, sessionId: { type: "string" } } } },
  { name: "make_move", description: "Move", inputSchema: { type: "object", properties: { gameId: { type: "string" }, move: { type: "string" } }, required: ["gameId", "move"] } },
  { name: "game_history", description: "History", inputSchema: { type: "object", properties: { gameId: { type: "string" } } } },
];

/** Fake Bedrock: replays scripted assistant messages and records each request. */
function scriptedConverse(script: ConverseCommandOutput["output"][]) {
  const calls: ConverseCommandInput[] = [];
  const converse = async (input: ConverseCommandInput) => {
    calls.push(structuredClone(input));
    const output = script.shift();
    const toolUse = output?.message?.content?.some((c) => "toolUse" in c);
    return { output, stopReason: toolUse ? "tool_use" : "end_turn" } as ConverseCommandOutput;
  };
  return { converse, calls };
}

function fakeTools() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const tools: ChessTools = {
    listTools: async () => MCP_TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "new_game") return { isError: false, data: { speech: "New game. Your move.", gameId: "g-1", humanColor: "White", level: 3 } };
      if (name === "make_move") return { isError: false, data: { speech: "You played pawn to e4. I play pawn to e5.", gameOver: false, fen: "x" } };
      return { isError: false, data: { speech: "ok" } };
    },
  };
  return { tools, calls };
}

const say = (text: string) => ({ message: { role: "assistant" as const, content: [{ text }] } });
const use = (name: string, input: Record<string, unknown>) => ({
  message: { role: "assistant" as const, content: [{ text: "<thinking>calling</thinking>" }, { toolUse: { toolUseId: `t-${name}`, name, input } }] },
});

describe("toBedrockTools", () => {
  it("hides ids the agent fills in and adds the recent-games flag", () => {
    const [newGame, makeMove, history] = toBedrockTools(MCP_TOOLS).map((t) => t.toolSpec!.inputSchema!.json as any);
    expect(newGame.properties.sessionId).toBeUndefined();
    expect(newGame.$schema).toBeUndefined();
    expect(makeMove.properties.gameId).toBeUndefined();
    expect(makeMove.required).toEqual(["move"]);
    expect(history.properties.listRecentGames.type).toBe("boolean");
  });
});

describe("runTurn", () => {
  it("starts a game, remembers it and injects gameId into later tool calls", async () => {
    const sessions = new MemorySessionStore();
    const { tools, calls } = fakeTools();
    const first = scriptedConverse([use("new_game", { color: "white" }), say("New game. Your move.")]);
    const deps: AgentDeps = { converse: first.converse, tools, sessions, modelId: "m" };

    const r1 = await runTurn(deps, "session-1", "let's play");
    expect(r1).toMatchObject({ reply: "New game. Your move.", gameId: "g-1", gameOver: false });
    expect(calls[0]).toEqual({ name: "new_game", args: { color: "white", sessionId: "session-1" } });
    expect(first.calls[0].toolConfig?.toolChoice).toEqual({ auto: {} }); // no game yet: tools optional

    const second = scriptedConverse([use("make_move", { move: "e4", gameId: "made-up" }), say("<thinking>x</thinking>You played **e4**. I play e5.")]);
    const r2 = await runTurn({ ...deps, converse: second.converse }, "session-1", "pawn to e4");
    expect(calls[1]).toEqual({ name: "make_move", args: { move: "e4", gameId: "g-1" } });
    expect(second.calls[0].toolConfig?.toolChoice).toEqual({ any: {} }); // game running: must use a tool
    expect(second.calls[1].toolConfig?.toolChoice).toEqual({ auto: {} });
    expect(r2.reply).toBe("You played e4. I play e5.");

    // The tool result sent back to the model carries no ids or FEN.
    const toolResult = (second.calls[1].messages!.at(-1)!.content![0] as any).toolResult;
    expect(JSON.parse(toolResult.content[0].text)).toEqual({ speech: "You played pawn to e4. I play pawn to e5.", gameOver: false });

    const stored = await sessions.get("session-1");
    expect(stored!.turns.map((t) => t.text)).toEqual(["let's play", "New game. Your move.", "pawn to e4", "You played e4. I play e5."]);
    expect(stored!.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("refuses board tools when no game exists, without calling the server", async () => {
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("make_move", { move: "e4" }), say("There's no game yet. Want to start one?")]);
    const r = await runTurn({ converse: s.converse, tools, sessions: new MemorySessionStore(), modelId: "m" }, "session-2", "e4");
    expect(calls).toHaveLength(0);
    expect(r.toolCalls[0]).toMatchObject({ name: "make_move", isError: true });
    expect(r.reply).toContain("no game");
  });

  it("falls back to the tool's own speech if the model goes silent", async () => {
    const sessions = new MemorySessionStore();
    await sessions.put({ sessionId: "session-3", gameId: "g-1", humanColor: "White", level: 3, turns: [], updatedAt: "", expiresAt: 0 });
    const { tools } = fakeTools();
    const s = scriptedConverse([use("make_move", { move: "e4" }), say("<thinking>done</thinking>")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "session-3", "e4");
    expect(r.reply).toBe("You played pawn to e4. I play pawn to e5.");
  });
});

describe("cleanSpeech", () => {
  it("strips reasoning tags and markdown", () => {
    expect(cleanSpeech("<thinking>plan</thinking> **Knight** to `f3`!\n\n")).toBe("Knight to f3!");
  });
});
