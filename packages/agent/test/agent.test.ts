import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import {
  answerToPending,
  looksLikeMove,
  asksQuestion,
  chattinessCommand,
  cleanSpeech,
  dropRepeatedSentences,
  factsForModel,
  QUIET_THEMES,
  limitSentences,
  recentPhrases,
  runTurn,
  talkingPoints,
  toBedrockTools,
  type AgentDeps,
} from "../src/agent.js";
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
    expect(r1).toMatchObject({ reply: "New game.", gameId: "g-1", gameOver: false }); // "Your move." is trimmed
    expect(calls[0]).toEqual({ name: "new_game", args: { color: "white", sessionId: "session-1" } });
    expect(first.calls[0].toolConfig?.toolChoice).toEqual({ auto: {} }); // no game yet: tools optional

    const second = scriptedConverse([use("make_move", { move: "e4", gameId: "made-up" }), say("<thinking>x</thinking>You played **e4**. I play e5.")]);
    const r2 = await runTurn({ ...deps, converse: second.converse }, "session-1", "pawn to e4");
    expect(calls[1]).toEqual({ name: "make_move", args: { move: "e4", gameId: "g-1", alternatives: ["pawn to e4"] } });
    expect(second.calls[0].toolConfig?.toolChoice).toEqual({ tool: { name: "make_move" } }); // a move attempt: no small-talk escape
    expect(second.calls[1].toolConfig?.toolChoice).toEqual({ auto: {} });
    expect(r2.reply).toBe("You played e4. I play e5.");

    // The tool result sent back to the model carries facts, but no ids, FEN or ready-made sentence.
    const toolResult = (second.calls[1].messages!.at(-1)!.content![0] as any).toolResult;
    expect(JSON.parse(toolResult.content[0].text)).toEqual({
      gameOver: false,
      commentary: {},
      sayAboutThisTurn: [QUIET_THEMES[2]], // seeded by the turn count (2 turns stored so far)
    });

    const stored = await sessions.get("session-1");
    expect(stored!.turns.map((t) => t.text)).toEqual(["let's play, white, easy", "New game.", "pawn to e4", "You played e4. I play e5."]);
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

const gameSession = async (sessions: MemorySessionStore, id: string) =>
  sessions.put({ sessionId: id, gameId: "g-1", humanColor: "White", level: 3, turns: [{ role: "assistant", text: "Your move." }], updatedAt: "", expiresAt: 0 });

describe("Phase 4: voice and conversation", () => {

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
    expect(r.reply).toBe("Okay, just the moves from now on, and switching to my British voice, and I'll speak more slowly.");
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

  it("spots a question even when the reply keeps talking after it", () => {
    expect(
      asksQuestion(
        "Got it, you're playing black! Now, how tough should I be? You can choose easy, medium, hard, or full strength. If you're not sure, I can pick a comfortable level for you.",
      ),
    ).toBe(true);
    expect(asksQuestion("Knight to f3. Your move?")).toBe(false);
    expect(asksQuestion("Pawn to e4, I reply e5.")).toBe(false);
  });

  it("uses temperature 0 for tool choice and a warmer one for phrasing", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-temp");
    const { tools } = fakeTools();
    const s = scriptedConverse([use("make_move", { move: "e4" }), say("You played e4.")]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-temp", "e4");
    expect(s.calls[0].inferenceConfig?.temperature).toBe(0);
    expect(s.calls[1].inferenceConfig?.temperature).toBe(0.8);
  });
});

describe("Phase 5: lively, non-repeating conversation", () => {
  it("drops the robotic hand-over tag but keeps real sentences", () => {
    expect(cleanSpeech("Knight to f3, I answer d5. Your move.")).toBe("Knight to f3, I answer d5.");
    expect(cleanSpeech("Ooh, cheeky! It's your turn!")).toBe("Ooh, cheeky!");
    expect(cleanSpeech("Bold choice, over to you")).toBe("Bold choice.");
    expect(cleanSpeech("Your move.")).toBe("Your move."); // nothing else to say: keep it
    expect(cleanSpeech("Is that your move?")).toBe("Is that your move?");
    // The stock closing questions that replaced "Your move." in the first eval run.
    expect(cleanSpeech("Pawn to h3, solid. My bishop goes to e7. What will you play next?")).toBe("Pawn to h3, solid. My bishop goes to e7.");
    expect(cleanSpeech("Knight takes, ouch! What'll you do now?")).toBe("Knight takes, ouch!");
    expect(cleanSpeech("I castled. So, what's your next move?")).toBe("I castled.");
    expect(cleanSpeech("Hello! Let's get back to our game. Your move, please.")).toBe("Hello! Let's get back to our game.");
    expect(cleanSpeech("Your bishop is attacked. How will you defend it?")).toBe("Your bishop is attacked. How will you defend it?");
  });

  it("keeps replies short and handles chattiness commands without the model", async () => {
    expect(limitSentences("One. Two! Three? Four. Five.", 3)).toBe("One. Two! Three?");
    expect(limitSentences("Just one.", 3)).toBe("Just one.");
    expect(chattinessCommand("talk more")).toBe("chatty");
    expect(chattinessCommand("Talk less please.")).toBe("brief");
    expect(chattinessCommand("just the moves")).toBe("minimal");
    expect(chattinessCommand("speak more slowly")).toBeUndefined();

    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-chat");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-chat", "Alexa, talk more");
    expect(s.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(r.reply).toBe("Okay, I'll chat away.");
    expect((await sessions.get("s-chat"))!.chattiness).toBe("chatty");
  });

  it("hides 'better was' for small inaccuracies", () => {
    const facts = factsForModel("make_move", { commentary: { yourMove: { quality: "inaccuracy", lossCp: 80, betterWas: "knight to c3" } } }, false, "chatty");
    expect((facts.commentary as any).yourMove).toEqual({ quality: "inaccuracy" });
    const bad = factsForModel("make_move", { commentary: { yourMove: { quality: "blunder", lossCp: 400, betterWas: "knight to c3" } } }, false, "chatty");
    expect((bad.commentary as any).yourMove.betterWas).toBe("knight to c3");
  });

  it("collects openers, closers and repeated phrases to avoid", () => {
    const turns = [
      { role: "user" as const, text: "e4" },
      { role: "assistant" as const, text: "You played pawn to e4. I play pawn to e6. We're off to a good start." },
      { role: "user" as const, text: "nf3" },
      { role: "assistant" as const, text: "You played knight to f3. I play pawn to d5. We're off to a good start." },
    ];
    const avoid = recentPhrases(turns);
    expect(avoid).toContain("you played pawn");
    expect(avoid).toContain("we're off to a good start");
    expect(avoid).toContain("off to a good");
  });

  it("picks what's worth saying, most important first", () => {
    const big = talkingPoints({
      inCheck: true,
      commentary: { yourMove: { quality: "blunder", betterWas: "knight to e2" }, opening: { name: "French Defense", reachedBy: "my move" }, myMoveIdeas: ["captures a bishop"] },
    });
    expect(big).toEqual(["the user is in check", "the user's move was a blunder (better was knight to e2; only mention if it fits)"]);
    const quiet = { commentary: { myMoveIdeas: [], alerts: [] } };
    expect(talkingPoints(quiet)).toEqual([QUIET_THEMES[0]]);
    expect(talkingPoints(quiet, 2, 1)).toEqual([QUIET_THEMES[1]]);
    expect(talkingPoints(quiet, 2, QUIET_THEMES.length)).toEqual([QUIET_THEMES[0]]);
  });

  it("drops repeated sentences but keeps the first and this turn's moves", () => {
    const recent = ["Pawn to e4. Your queen on d1 is still waiting for her moment."];
    expect(dropRepeatedSentences("Knight to f3. Your queen on d1 is still waiting for her moment.", recent)).toBe("Knight to f3.");
    expect(dropRepeatedSentences("Your queen on d1 is still waiting for her moment.", recent)).toBe("Your queen on d1 is still waiting for her moment.");
    expect(dropRepeatedSentences("Bold! I move pawn to e4 again. Fresh remark here.", recent, ["pawn to e4"])).toBe("Bold! I move pawn to e4 again. Fresh remark here.");
  });

  it("catches dash-style hand-overs", () => {
    expect(cleanSpeech("Nice one. Your turn—what's next?")).toBe("Nice one.");
    expect(cleanSpeech("Nice one. Your turn - what's next?")).toBe("Nice one.");
    expect(cleanSpeech("Nice one. What's next?")).toBe("Nice one.");
  });

  it("understands answers to a move question", () => {
    expect(answerToPending("yes yes", ["Ne4", "Nf4"])).toEqual({ pick: "Ne4" });
    expect(answerToPending("Yeah", ["Ne4"])).toEqual({ pick: "Ne4" });
    expect(answerToPending("the second one", ["Ne4", "Nf4"])).toEqual({ pick: "Nf4" });
    expect(answerToPending("nope", ["Ne4", "Nf4"])).toEqual({ no: true });
    expect(answerToPending("see", ["Rce7", "Ree7"])).toEqual({ pick: "Rce7" });
    expect(answerToPending("the one on e", ["Rce7", "Ree7"])).toEqual({ pick: "Ree7" });
    expect(answerToPending("knight f3", ["Ne4", "Nf4"])).toBeUndefined(); // a fresh move, not an answer
  });

  it("spots move attempts but not questions", () => {
    expect(looksLikeMove("rok E7")).toBe(true);
    expect(looksLikeMove("night takes", "knight takes f7")).toBe(true);
    expect(looksLikeMove("what did you play last")).toBe(false);
    expect(looksLikeMove("which pawn is attacked on e5")).toBe(false);
    expect(looksLikeMove("hello")).toBe(false);
  });

  it("plays the candidate when the user just says yes, without asking again", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-yes");
    await sessions.put({ ...(await sessions.get("s-yes"))!, pending: { candidates: ["Re7"], asks: 1 } });
    const seen: Record<string, unknown>[] = [];
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (_n, args) => { seen.push(args); return { isError: false, data: { speech: "x", gameOver: false, yourMoveSpoken: "rook to e7", engineMoveSpoken: "pawn to a5", commentary: {} } }; },
    };
    const s = scriptedConverse([use("make_move", { move: "something else" }), say("Rook to e7, nice. I answer pawn to a5.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-yes", "yes yes");
    expect(seen[0]).toMatchObject({ move: "Re7", alternatives: [] });
    expect(s.calls[0].toolConfig?.toolChoice).toEqual({ tool: { name: "make_move" } });
    expect(r.reply).toContain("Rook to e7");
    expect((await sessions.get("s-yes"))!.pending).toBeUndefined();
  });

  it("answers 'no' locally and clears the question", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-no");
    await sessions.put({ ...(await sessions.get("s-no"))!, pending: { candidates: ["Re7"], asks: 1 } });
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-no", "no");
    expect(r.reply).toBe("Okay, scrap that. Say your move again.");
    expect(s.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("plays the likeliest reading when the same question would be asked twice", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-twice");
    await sessions.put({ ...(await sessions.get("s-twice"))!, pending: { candidates: ["Re7", "Ra7"], asks: 1 } });
    const seen: Record<string, unknown>[] = [];
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (_n, args) => {
        seen.push(args);
        return args.move === "Re7"
          ? { isError: false, data: { speech: "x", gameOver: false, yourMoveSpoken: "rook to e7", commentary: {} } }
          : { isError: false, data: { speech: "Did you mean rook to e7, or rook to a7?", needsConfirmation: true, candidates: ["Re7", "Ra7"] } };
      },
    };
    const s = scriptedConverse([use("make_move", { move: "rocky e7" }), say("Rook to e7.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-twice", "rocky seven");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ move: "Re7", alternatives: [] });
    expect(r.reply).toMatch(/^I took that as rook to e7; say undo if that's wrong\./);
  });

  it("survives a request with no text", async () => {
    const { tools } = fakeTools();
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions: new MemorySessionStore(), modelId: "m" }, "s-empty", { text: undefined as unknown as string });
    expect(r.reply).toMatch(/didn't catch/);
  });

  it("speaks a confirmation question word for word and stops", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-confirm");
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async () => ({ isError: false, data: { speech: "Did you mean knight to c3?", needsConfirmation: true } }),
    };
    const s = scriptedConverse([use("make_move", { move: "Nc3" }), say("Did you mean knight to c3? If so, I'll reply knight to c6.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-confirm", "night c three");
    expect(r.reply).toBe("Did you mean knight to c3?");
    expect(s.calls).toHaveLength(1);
  });

  it("gives the model facts instead of a ready-made sentence for moves", () => {
    const content = { speech: "You played e4. I play e5.", gameId: "g", fen: "x", yourMove: "e4", engineMove: "e5", yourMoveSpoken: "pawn to e4", engineMoveSpoken: "pawn to e5", commentary: {} };
    const facts = factsForModel("make_move", content, false, "chatty");
    expect(facts).not.toHaveProperty("speech");
    expect(facts).not.toHaveProperty("gameId");
    expect(facts).toMatchObject({ yourMoveSpoken: "pawn to e4", engineMoveSpoken: "pawn to e5" });
    expect(facts.sayAboutThisTurn).toBeInstanceOf(Array);
    // Confirmations and other tools keep their exact wording.
    expect(factsForModel("make_move", { speech: "Did you mean knight to e4?", needsConfirmation: true }, false, "chatty")).toHaveProperty("speech");
    expect(factsForModel("read_board", { speech: "White: king on e1." }, false, "chatty")).toHaveProperty("speech");
  });

  it("answers garbled speech with ask_again, and never lets it claim a move", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-ask");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("ask_again", { reply: "Hmm, was that pawn to d4?" })]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-ask", "ondifo");
    expect(calls).toHaveLength(0);
    expect(r.reply).toBe("Hmm, was that pawn to d4?");
    expect(s.calls).toHaveLength(1); // answered without a second model call

    const s2 = scriptedConverse([use("ask_again", { reply: "You played e4 and I play e5." })]);
    const r2 = await runTurn({ converse: s2.converse, tools, sessions, modelId: "m" }, "s-ask", "hello");
    expect(r2.reply).toBe("Sorry, I didn't quite catch that. Could you say it again?");
  });

  it("forces a tool after the game is over, so post-game answers are grounded", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-over");
    const stored = (await sessions.get("s-over"))!;
    await sessions.put({ ...stored, gameOver: true });
    const { tools } = fakeTools();
    const s = scriptedConverse([use("game_history", {}), say("You slipped on move nine.")]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-over", "how could I have played better");
    expect(s.calls[0].toolConfig?.toolChoice).toEqual({ any: {} });
  });

  it("puts the chess-grammar hearing first for make_move", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-vosk");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("make_move", { move: "d4" }), say("Pawn to d4.")]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-vosk", { text: "porn D4", alternatives: ["porn D4", "pond D4"], chessHeard: "alexa pawn d four" });
    expect(calls[0].args.alternatives).toEqual(["pawn d four", "porn D4", "pond D4"]);
    const firstUserMsg = s.calls[0].messages!.at(-1)!.content![0].text!;
    expect(firstUserMsg).toContain('(chess hearing: "pawn d four")');
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

  it("asks the missing choice itself, so the model can't claim a game started", async () => {
    const { tools, calls } = fakeTools();
    const sessions = new MemorySessionStore();
    // Live bug: blocked new_game, then the model said "New game started" and the next move hit the old game.
    const s = scriptedConverse([use("new_game", { color: "white", level: 2 }), say("New game started. You are White. Your move.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-lie", "I'll play as white");
    expect(calls).toHaveLength(0);
    expect(r.reply).toBe("Great! And how tough should I be: easy, medium, hard, or full strength?");
    expect(r.expectsReply).toBe(true);
    expect(r.gameId).toBeUndefined();
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
