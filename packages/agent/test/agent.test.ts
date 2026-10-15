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

    const r1 = await runTurn(deps, "session-1", "let's play, white, easy");
    expect(r1).toMatchObject({ reply: "New game. Your move.", gameId: "g-1", gameOver: false });
    expect(calls[0]).toEqual({ name: "new_game", args: { color: "white", sessionId: "session-1" } });
    expect(first.calls[0].toolConfig?.toolChoice).toEqual({ auto: {} }); // no game yet: tools optional

    const second = scriptedConverse([use("make_move", { move: "e4", gameId: "made-up" }), say("<thinking>x</thinking>You played **e4**. I play e5.")]);
    const r2 = await runTurn({ ...deps, converse: second.converse }, "session-1", "pawn to e4");
    expect(calls[1]).toEqual({ name: "make_move", args: { move: "e4", gameId: "g-1", alternatives: ["pawn to e4"] } });
    expect(second.calls[0].toolConfig?.toolChoice).toEqual({ any: {} }); // game running: must use a tool
    expect(second.calls[1].toolConfig?.toolChoice).toEqual({ auto: {} });
    expect(r2.reply).toBe("You played e4. I play e5.");

    // The tool result sent back to the model carries no ids or FEN.
    const toolResult = (second.calls[1].messages!.at(-1)!.content![0] as any).toolResult;
    expect(JSON.parse(toolResult.content[0].text)).toEqual({ speech: "You played pawn to e4. I play pawn to e5.", gameOver: false });

    const stored = await sessions.get("session-1");
    expect(stored!.turns.map((t) => t.text)).toEqual(["let's play, white, easy", "New game. Your move.", "pawn to e4", "You played e4. I play e5."]);
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

describe("Phase 4: voice and conversation", () => {
  const gameSession = async (sessions: MemorySessionStore, id: string) =>
    sessions.put({ sessionId: id, gameId: "g-1", humanColor: "White", level: 3, turns: [{ role: "assistant", text: "Your move." }], updatedAt: "", expiresAt: 0 });

  it("strips the wake word and passes recognition alternatives to make_move only", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-alt-1");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("make_move", { move: "Ne4", alternatives: ["model made this up"] }), say("You played knight to e4.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-alt-1", {
      text: "Alexa, night forever",
      alternatives: ["Alexa night forever", "knight e4"],
    });
    expect(calls[0].args).toEqual({ move: "Ne4", gameId: "g-1", alternatives: ["night forever", "knight e4"] });
    // The model sees the alternatives as a hint, but they are not stored in history.
    expect((s.calls[0].messages!.at(-1)!.content![0] as any).text).toBe('night forever\n(speech recognition alternatives: "knight e4")');
    expect((await sessions.get("s-alt-1"))!.turns.at(-2)!.text).toBe("night forever");
    expect(r.toolCalls[0].args).not.toHaveProperty("alternatives");
  });

  it("changes chattiness, voice and speed locally without calling the chess server", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-pref");
    const { tools, calls } = fakeTools();
    const spoken: [string, string, number][] = [];
    const speak = async (text: string, voice: string, rate: number) => { spoken.push([text, voice, rate]); return "QUJD"; };
    const s = scriptedConverse([use("set_preferences", { chattiness: "minimal", voice: "british", speed: "slower" }), say("Okay, short and British it is.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m", speak }, "s-pref", "talk less, use a british voice and slow down");
    expect(calls).toHaveLength(0);
    const stored = (await sessions.get("s-pref"))!;
    expect(stored).toMatchObject({ chattiness: "minimal", voice: "Amy", rate: 85 });
    expect(r).toMatchObject({ voice: "Amy", audio: "QUJD" });
    expect(r.reply).toBe("Okay, I'll keep it short, and switching to my British voice, and I'll speak more slowly.");
    expect(s.calls).toHaveLength(1);
    expect(spoken[0]).toEqual([r.reply, "Amy", 85]);
    // The next turn's system prompt carries the new chattiness.
    const next = scriptedConverse([use("game_status", {}), say("Your move.")]);
    await runTurn({ converse: next.converse, tools, sessions, modelId: "m" }, "s-pref", "whose turn?");
    expect(next.calls[0].system!.map((b: any) => b.text ?? "").join(" ")).toContain("Chattiness: MINIMAL");
  });

  it("repeats the last reply word for word and does not add it to history", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-rep");
    const { tools } = fakeTools();
    const s = scriptedConverse([use("repeat_last", {})]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-rep", "repeat that");
    expect(r.reply).toBe("Sure. Your move.");
    expect(s.calls).toHaveLength(1); // no second model round
    expect((await sessions.get("s-rep"))!.turns).toHaveLength(1);
  });

  it("flags replies that end in a question so the page keeps listening", async () => {
    const { tools } = fakeTools();
    const s = scriptedConverse([say("Love to! White or black, and how tough should I be?")]);
    const r = await runTurn({ converse: s.converse, tools, sessions: new MemorySessionStore(), modelId: "m" }, "s-q", "let's play chess");
    expect(r.expectsReply).toBe(true);
    expect(r.usage.rounds).toBe(1);
  });

  it("uses temperature 0 for tool choice and a warmer one for phrasing", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-temp");
    const { tools } = fakeTools();
    const s = scriptedConverse([use("make_move", { move: "e4" }), say("You played e4.")]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-temp", "e4");
    expect(s.calls[0].inferenceConfig?.temperature).toBe(0);
    expect(s.calls[1].inferenceConfig?.temperature).toBe(0.6);
  });
});

describe("new game choices", () => {
  it("blocks new_game until colour and difficulty were said", async () => {
    const { tools, calls } = fakeTools();
    const sessions = new MemorySessionStore();
    const s = scriptedConverse([use("new_game", { color: "white", level: 3 }), say("White or black, and how tough?")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-choice", "let's play chess");
    expect(calls).toHaveLength(0);
    expect(r.toolCalls[0]).toMatchObject({ name: "new_game", isError: true });
    expect(r.expectsReply).toBe(true);

    // Answer split over two utterances still counts.
    const s2 = scriptedConverse([say("And how tough should I be?")]);
    await runTurn({ converse: s2.converse, tools, sessions, modelId: "m" }, "s-choice", "black please");
    const s3 = scriptedConverse([use("new_game", { color: "black", level: 4 }), say("New game!")]);
    await runTurn({ converse: s3.converse, tools, sessions, modelId: "m" }, "s-choice", "medium");
    expect(calls).toEqual([{ name: "new_game", args: { color: "black", level: 4, sessionId: "s-choice" } }]);
  });
});

describe("asksQuestion", () => {
  it("treats real questions as follow-ups but not routine 'your move?'", async () => {
    const { asksQuestion } = await import("../src/agent.js");
    expect(asksQuestion("Love to! White or black, and how tough should I be?")).toBe(true);
    expect(asksQuestion("I heard night forever. Did you mean knight to e4?")).toBe(true);
    expect(asksQuestion("You played e4. I play c5. Your move?")).toBe(false);
    expect(asksQuestion("I play d5. What's your next move?")).toBe(false);
    expect(asksQuestion("Nice. What would you like to play?")).toBe(false);
    expect(asksQuestion("You played e4. Your move.")).toBe(false);
    expect(asksQuestion("Do you want white or black, and how tough should I be? Choose from easy, medium, hard, or full strength.")).toBe(true);
    expect(asksQuestion("Did you enjoy that? Anyway, I play e5. Your move.")).toBe(false);
  });

  it("marks the static skill for prompt caching", async () => {
    const { tools } = fakeTools();
    const s = scriptedConverse([say("Hi!")]);
    await runTurn({ converse: s.converse, tools, sessions: new MemorySessionStore(), modelId: "m" }, "s-cache", "hello");
    const req = s.calls[0];
    expect(req.system![1]).toEqual({ cachePoint: { type: "default" } });
    expect(req.system![2].text).toContain("## Current state");
    expect(req.toolConfig!.tools!.some((t: any) => t.cachePoint)).toBe(false);
  });
});
