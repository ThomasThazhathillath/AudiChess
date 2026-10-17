import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import {
  addressedToAlexa,
  answerToPending,
  quickMoveReply,
  routeQuestion,
  looksLikeMove,
  asksQuestion,
  chattinessCommand,
  cleanSpeech,
  dropRepeatedSentences,
  factsForModel,
  QUIET_THEMES,
  limitSentences,
  capWords,
  isFaintMove,
  LEVEL_NAMES,
  REASONING_LEAK,
  REFUSAL,
  attackedAnswer,
  saysMove,
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
      if (name === "make_move") return { isError: false, data: { speech: "You played pawn to e4. I play pawn to e5.", gameOver: false, fen: "x", yourMoveSpoken: "pawn to e4", engineMoveSpoken: "pawn to e5", commentary: {} } };
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

    // A move goes straight to the chess server: no model call (the fast path), a short deterministic reply.
    const second = scriptedConverse([]);
    const r2 = await runTurn({ ...deps, converse: second.converse }, "session-1", "pawn to e4");
    expect(calls[1]).toEqual({ name: "make_move", args: { move: "pawn to e4", gameId: "g-1", alternatives: ["pawn to e4"] } });
    expect(second.calls).toHaveLength(0);
    expect(r2.reply).toBe("You play pawn to e4, I play pawn to e5."); // template picked by the turn count (2)
    expect(r2.timings?.fastPath).toBe(true);

    const stored = await sessions.get("session-1");
    expect(stored!.turns.map((t) => t.text)).toEqual(["let's play, white, easy", "New game.", "pawn to e4", "You play pawn to e4, I play pawn to e5."]);
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

  it("still says both moves if the model goes silent", async () => {
    const sessions = new MemorySessionStore();
    await sessions.put({ sessionId: "session-3", gameId: "g-1", humanColor: "White", level: 3, turns: [], updatedAt: "", expiresAt: 0 });
    const { tools } = fakeTools();
    await sessions.put({ ...(await sessions.get("session-3"))!, chattiness: "chatty" });
    const s = scriptedConverse([say("<thinking>done</thinking>")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "session-3", "e4");
    expect(r.reply).toBe("Pawn to e4. I play pawn to e5.");
    // Chatty mode phrases the move with one model call that sees the facts, but no ids, FEN or ready-made sentence.
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].inferenceConfig?.temperature).toBe(0.3);
    const toolResult = (s.calls[0].messages!.at(-1)!.content![0] as any).toolResult;
    expect(JSON.parse(toolResult.content[0].text)).toMatchObject({ gameOver: false, yourMoveSpoken: "pawn to e4", engineMoveSpoken: "pawn to e5", commentary: {} });
    expect(JSON.parse(toolResult.content[0].text)).not.toHaveProperty("speech");
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
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-alt-1", {
      text: "Alexa, night forever",
      alternatives: ["Alexa night forever", "knight e4"],
    });
    expect(calls[0].args).toEqual({ move: "night forever", gameId: "g-1", alternatives: ["night forever", "knight e4"] });
    expect((await sessions.get("s-alt-1"))!.turns.at(-2)!.text).toBe("night forever");
    expect(r.toolCalls[0].args).not.toHaveProperty("alternatives");

    // A question goes to the model, which sees the alternatives as a hint (not stored in history).
    const q = scriptedConverse([use("game_history", {}), say("You opened with e4.")]);
    await runTurn({ converse: q.converse, tools, sessions, modelId: "m" }, "s-alt-1", { text: "what did I play first", alternatives: ["what did I play first", "what did I pay first"] });
    expect((q.calls[0].messages!.at(-1)!.content![0] as any).text).toBe('what did I play first\n(speech recognition alternatives: "what did I pay first")');
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
    // "Let's play chess" with no colour or level: the short fixed question, no model call.
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions: new MemorySessionStore(), modelId: "m" }, "s-q", "let's play chess");
    expect(r.reply).toBe("Sure! White or black? And easy, medium or hard?");
    expect(r.expectsReply).toBe(true);
    expect(r.usage.rounds).toBe(0);
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
    const s = scriptedConverse([use("game_history", {}), say("You opened with e4.")]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-temp", "what was my first move");
    expect(s.calls[0].inferenceConfig?.temperature).toBe(0);
    expect(s.calls[1].inferenceConfig?.temperature).toBe(0.3);
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

  it("never hands the model a better move, a warning or her own threats (no unasked coaching)", () => {
    const facts = factsForModel("make_move", { commentary: { yourMove: { quality: "inaccuracy", lossCp: 80, betterWas: "knight to c3" } } }, false, "chatty");
    expect((facts.commentary as any).yourMove).toEqual({ quality: "inaccuracy" });
    const bad = factsForModel("make_move", {
      commentary: { yourMove: { quality: "blunder", lossCp: 400, betterWas: "knight to c3" }, alerts: ["your rook on g6 is under attack by a pawn"], trend: "slipping", myMoveIdeas: ["attacks the knight on c3", "develops the bishop"] },
      moveFacts: { iCaptured: "bishop" },
    }, false, "chatty");
    expect((bad.commentary as any).yourMove).toEqual({ quality: "blunder" });
    expect(bad.commentary).not.toHaveProperty("alerts");
    expect(bad.commentary).not.toHaveProperty("trend");
    expect((bad.commentary as any).myMoveIdeas).toEqual(["develops the bishop"]);
    expect(bad).not.toHaveProperty("moveFacts");
    const withJab = factsForModel("make_move", { commentary: {} }, false, "chatty", 0, { mood: "taunt", event: "the user blundered", line: "Ouch! That was expensive.", examples: ["Ouch! That was expensive."] });
    expect(withJab.react).toMatchObject({ mood: "taunt", examples: ["Ouch! That was expensive."] });
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
    expect(big).toEqual(["the user is in check", "the user's move was a blunder (jab them for it; never say what was better)"]);
    // Warnings and her own threats are never talking points.
    expect(talkingPoints({ commentary: { alerts: ["your bishop on c4 is under attack by a pawn"], myMoveIdeas: ["attacks the knight on c3"] } }, 3)).toEqual([QUIET_THEMES[0]]);
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

  it("understands more natural answers", () => {
    expect(answerToPending("no, knight f3", ["Ne4", "Nf4"])).toBeUndefined(); // a new move, not a refusal
    expect(answerToPending("no, the other one", ["Ne4", "Nf4"])).toEqual({ pick: "Nf4" });
    expect(answerToPending("no", ["Ne4", "Nf4"])).toEqual({ no: true });
    expect(answerToPending("the one on b1", ["Nbd2", "Nfd2"])).toEqual({ pick: "Nbd2" });
    expect(answerToPending("f3", ["Nbd2", "Nfd2"])).toEqual({ pick: "Nfd2" });
    expect(answerToPending("the one on a7", ["R1a3", "R7a3"])).toEqual({ pick: "R7a3" }); // "the one" isn't rank 1
    expect(answerToPending("the c pawn", ["cxd5", "exd5"])).toEqual({ pick: "cxd5" });
    expect(answerToPending("kingside", ["O-O", "O-O-O"])).toEqual({ pick: "O-O" });
    expect(answerToPending("long", ["O-O", "O-O-O"])).toEqual({ pick: "O-O-O" });
    expect(answerToPending("queen side please", ["O-O", "O-O-O"])).toEqual({ pick: "O-O-O" });
    expect(answerToPending("the left one", ["Nfd2", "Nbd2"])).toEqual({ pick: "Nbd2" });
    expect(answerToPending("the right one", ["Nfd2", "Nbd2"])).toEqual({ pick: "Nfd2" });
    expect(answerToPending("the left one", ["Nfd7", "Nbd7"], "b")).toEqual({ pick: "Nfd7" }); // seen from Black's side
  });

  it("spots move attempts but not questions", () => {
    expect(looksLikeMove("rok E7")).toBe(true);
    expect(looksLikeMove("night takes", "knight takes f7")).toBe(true);
    expect(looksLikeMove("24")).toBe(true); // Transcribe en-IN: "pawn d4"
    expect(looksLikeMove("24", "2")).toBe(true); // with a partial as the second alternative (live bug)
    expect(looksLikeMove("Swansea 4")).toBe(true);
    expect(looksLikeMove("I am 24")).toBe(false);
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
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-yes", "yes yes");
    expect(seen[0]).toMatchObject({ move: "Re7", alternatives: [] });
    expect(s.calls).toHaveLength(0);
    expect(r.reply).toBe("Rook to e7; I answer pawn to a5.");
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

  it("'no, knight f3' is a fresh move, not a refusal", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-no-move");
    await sessions.put({ ...(await sessions.get("s-no-move"))!, pending: { candidates: ["Ne4", "Nf4"], asks: 1 } });
    const seen: Record<string, unknown>[] = [];
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (_n, args) => { seen.push(args); return { isError: false, data: { speech: "x", gameOver: false, yourMoveSpoken: "knight to f3", engineMoveSpoken: "pawn to d5", commentary: {} } }; },
    };
    const s = scriptedConverse([]);
    // A lower alternative that is just "no" (an older partial) must not win either.
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-no-move", { text: "no, knight f3", alternatives: ["no, knight f3", "no"] });
    expect(seen[0]).toMatchObject({ move: "no, knight f3" });
    expect(r.reply).toBe("Knight to f3; I answer pawn to d5.");
    expect((await sessions.get("s-no-move"))!.pending).toBeUndefined();
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
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-confirm", "night c three");
    expect(r.reply).toBe("Did you mean knight to c3?");
    expect(s.calls).toHaveLength(0);
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
    const s = scriptedConverse([]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-vosk", { text: "porn D4", alternatives: ["porn D4", "pond D4"], chessHeard: "alexa pawn d four" });
    expect(calls[0].args).toMatchObject({ move: "pawn d four", alternatives: ["pawn d four", "porn D4", "pond D4"] });
  });
});

describe("Phase 6: background speech, speed and shorter answers", () => {
  // Every line here is from the 2026-10-16 live game, heard without "Alexa" while a game was on.
  const BACKGROUND = ["Correct.", "Yeah.", "I.", "In the.", "Gala appeared in a coral.", "Then it's supposed to.", "I've been.", "Uh.", "born to be.", "are you", "Oh, I didn't get your last name."]; // "Could you name or so." was really "Could you tell me…": it reaches the model, which may ignore it

  it("drops background talk without calling the model or the board", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-bg");
    const { tools, calls } = fakeTools();
    for (const text of BACKGROUND) {
      const s = scriptedConverse([]);
      const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-bg", { text, woken: false });
      expect(r, text).toMatchObject({ ignored: true, reply: "" });
      expect(s.calls, text).toHaveLength(0);
    }
    expect(calls).toHaveLength(0);
    expect((await sessions.get("s-bg"))!.turns).toHaveLength(1); // nothing stored
  });

  it("still takes moves, questions and answers without the wake word", () => {
    const session = { sessionId: "x", gameId: "g", turns: [{ role: "assistant" as const, text: "White or black?" }], updatedAt: "", expiresAt: 0 };
    expect(addressedToAlexa(["pawn d4"], session)).toBe(true);
    expect(addressedToAlexa(["24"], session)).toBe(true);
    expect(addressedToAlexa(["What would you recommend"], session)).toBe(true);
    expect(addressedToAlexa(["What was your last move"], session)).toBe(true);
    expect(addressedToAlexa(["black"], session)).toBe(true); // answering her question
    expect(addressedToAlexa(["am I doing okay"], session)).toBe(true);
    expect(addressedToAlexa(["Uh, why did you choose the sur"], { ...session, turns: [] })).toBe(true); // live test: filler first
    const quiet = { ...session, turns: [{ role: "assistant" as const, text: "Knight to f3. I play d5." }] };
    expect(addressedToAlexa(["Correct."], quiet)).toBe(false);
    expect(addressedToAlexa(["Yeah."], quiet)).toBe(false);
    expect(addressedToAlexa(["Gala appeared in a coral."], quiet)).toBe(false);
  });

  it("answers an open-mic conversation without the wake word", () => {
    const quiet = { sessionId: "x", gameId: "g", turns: [{ role: "assistant" as const, text: "Knight to f3. I play d5." }], updatedAt: "", expiresAt: 0 };
    for (const text of ["hint", "Undo.", "what?", "thank you", "hello", "good game", "nice move"]) expect(addressedToAlexa([text], quiet), text).toBe(true);
    // Misheard moves mid-game get an answer instead of silence (live log: "14", "44", "Uh, is he is 5.").
    for (const text of ["14", "44", "34.", "Uh, is he is 5."]) expect(addressedToAlexa([text], quiet), text).toBe(true);
    expect(addressedToAlexa(["14"], { ...quiet, gameId: undefined })).toBe(false); // no game: just a number
    const castle = { ...quiet, pending: { candidates: ["O-O", "O-O-O"], asks: 1 } };
    expect(addressedToAlexa(["kingside"], castle)).toBe(true);
    // The 2026-10-17 game: dropped in silence, then repeated by the user 2-12 s later. Every reading counts now.
    const dropped = [["ok fine", "Nokia 5", "broken 5"], ["Vineet", "Queen 8"], ["K5"], ["1087"], ["sorry", "sorry ruk"], ["kaun si", "Pawan Singh 7"], ["pornh sex"], ["Bishop"]];
    for (const heard of dropped) expect(addressedToAlexa(heard, quiet), heard.join(" | ")).toBe(true);
    expect(addressedToAlexa(["Intex phone"], quiet)).toBe(false); // nothing chess in any reading: still background
    expect(addressedToAlexa(["ok fine", "Nokia 5"], { ...quiet, gameId: undefined })).toBe(false); // no game
    expect(looksLikeMove("Vineet", "Queen 8")).toBe(true);
    expect(looksLikeMove("kaun si", "Pawan Singh 7")).toBe(true);
    // Only faintly a move: asked again in a few words, without the model (it once guessed queen to e2).
    for (const heard of [["ok fine", "Nokia 5"], ["K5"], ["1087"], ["sorry", "sorry ruk"]]) expect(isFaintMove(heard, quiet), heard.join(" | ")).toBe(true);
    for (const heard of [["Vineet", "Queen 8"], ["hint"], ["what's 2 plus 2?"], ["my queen"], ["thank you"]]) expect(isFaintMove(heard, quiet), heard.join(" | ")).toBe(false);
  });

  it("routes plain commands and the board read-out without the model", () => {
    expect(routeQuestion("undo")).toEqual({ name: "undo", args: {} });
    expect(routeQuestion("Take back my last move.")).toEqual({ name: "undo", args: {} });
    expect(routeQuestion("can you redo the move?")).toBeUndefined();
    expect(routeQuestion("read the board")).toEqual({ name: "read_board", args: { format: "pieces" } });
    expect(routeQuestion("read me the board row by row")).toEqual({ name: "read_board", args: { format: "ranks" } });
    // The opponent's moves are her threat, not the user's hint (the qa eval got the user's best move for these).
    expect(routeQuestion("What would my opponent play next?")).toMatchObject({ name: "analyze_position", args: {}, note: expect.stringMatching(/threat/) });
    expect(routeQuestion("What are their best candidate moves?")).toMatchObject({ name: "analyze_position", args: {} });
    expect(routeQuestion("what's the best move?")?.name).toBe("hint");
    expect(routeQuestion("Announce every move my opponent makes.")).toBeUndefined(); // a request, not a question
    expect(routeQuestion("What move should I avoid?")).toMatchObject({ name: "analyze_position", note: expect.stringMatching(/AVOID/) });
    expect(routeQuestion("What is the best move for my knight?")).toEqual({ name: "hint", args: { count: 1, reveal: true, piece: "knight" } });
    expect(routeQuestion("Can you describe the current board?")).toEqual({ name: "read_board", args: { format: "pieces" } });
  });

  it("asks once more when the model refuses a chess question as 'cheating'", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-refuse");
    const { tools } = fakeTools();
    const s = scriptedConverse([
      use("answer", { reply: "Sorry, I can't give advice on how to attack your opponent's queen. That would be cheating." }),
      say("Yes: my knight on f6 guards the queen, and your bishop can take it."),
    ]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-refuse", "Can I remove the defender of their queen?");
    expect(s.calls).toHaveLength(2);
    expect(r.reply).toBe("Yes: my knight on f6 guards the queen, and your bishop can take it.");
    // Refused again: a neutral line, never "that would be cheating".
    const s2 = scriptedConverse([
      use("answer", { reply: "Sorry, I can't give advice on how to attack your opponent's queen. That would be cheating." }),
      say("Sorry, I can't give that away."),
    ]);
    const r2 = await runTurn({ converse: s2.converse, tools, sessions, modelId: "m" }, "s-refuse", "Can I remove the defender of their queen?");
    expect(r2.reply).toBe("I can't spot that from here. Ask me what's under attack or what I'm threatening, and I'll tell you.");
    expect(REFUSAL.test("Sorry, I can't give chess advice that helps you target my queen. That's cheating.")).toBe(true);
    expect(REFUSAL.test("Sorry, I can't alert you automatically. Ask me any time.")).toBe(false);
    expect(REFUSAL.test("Sorry, I can't reveal my long-term plan. That would spoil the fun!")).toBe(true);
    expect(REFUSAL.test("No, you can't castle: your king is in check.")).toBe(false);
    expect(REFUSAL.test("Sorry, I can't give you a direct answer that might help you win the game.")).toBe(true);
  });

  it("answers 'which of my pieces are under attack' straight from the facts", () => {
    expect(routeQuestion("Tell me which squares are under attack.")).toEqual({ name: "analyze_position", args: {}, answer: "attacked" });
    expect(routeQuestion("Alert me when a piece is undefended.")).toMatchObject({ answer: "attacked" });
    expect(routeQuestion("Is anything hanging?")).toMatchObject({ answer: "attacked" });
    expect(routeQuestion("Is my queen under attack?")).not.toHaveProperty("answer"); // one piece: the model answers yes or no
    expect(routeQuestion("Which of my opponent's pieces are attacked?")).not.toHaveProperty("answer");
    expect(attackedAnswer({ yourPiecesUnderAttack: [] })).toBe("Nothing of yours is under attack right now.");
    expect(attackedAnswer({ yourPiecesUnderAttack: [] }, true)).toBe("Nothing of yours is under attack right now. I won't call it out by myself, but ask me any time.");
    expect(attackedAnswer({ yourPiecesUnderAttack: ["queen on h5 (attacked by my pawn)", "bishop on c4 (attacked by my knight)"] }))
      .toBe("Your queen on h5 is attacked by my pawn, and your bishop on c4 by my knight.");
  });

  it("always says her move, even when the model leaves it out", async () => {
    const result = { yourMoveSpoken: "pawn to a3", engineMoveSpoken: "queen takes queen on d1", commentary: {} };
    expect(saysMove("Pawn to a3. A free piece? Don't mind if I do.", result)).toBe(false);
    expect(saysMove("Pawn to a3. I take your queen on d1. Thanks!", result)).toBe(true);
    expect(saysMove("Rook takes queen on d1. Nice.", { yourMoveSpoken: "rook takes queen on d1", engineMoveSpoken: "pawn takes rook on d1" })).toBe(false);
    expect(saysMove("Castles kingside. I castle too.", { yourMoveSpoken: "castles kingside", engineMoveSpoken: "castles kingside" })).toBe(true);
    // Through runTurn in chatty mode: the template replaces the reply that skipped her move.
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-move");
    await sessions.put({ ...(await sessions.get("s-move"))!, chattiness: "chatty" });
    const tools: ChessTools = { listTools: async () => MCP_TOOLS, callTool: async () => ({ isError: false, data: { ...result, gameOver: false } }) };
    const s = scriptedConverse([say("Pawn to a3. A free piece? Don't mind if I do.")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-move", "pawn a3");
    expect(r.reply).toMatch(/^Pawn to a3[.;,] .*queen takes queen on d1\./);
    // Chatty: the model only adds the reaction line after the template's moves.
    const s2 = scriptedConverse([say("A free piece? Don't mind if I do.")]);
    const r2 = await runTurn({ converse: s2.converse, tools, sessions, modelId: "m" }, "s-move", "pawn a3");
    expect(r2.reply).toMatch(/^(?:Pawn to a3|You play pawn to a3)[.;,] .*queen takes queen on d1\. A free piece\? Don't mind if I do\.$/);
  });

  it("never says a talking-point label out loud", () => {
    expect(cleanSpeech("Pawn to a3. I play pawn to f6. Quiet move.")).toBe("Pawn to a3. I play pawn to f6.");
    expect(cleanSpeech("Bishop to b5, check. I play king to d8. Nothing big happened.")).toBe("Bishop to b5, check. I play king to d8.");
    expect(cleanSpeech("That's a quiet move that keeps your options open.")).toBe("That's a quiet move that keeps your options open.");
  });

  it("never speaks the model's own reasoning", () => {
    expect(REASONING_LEAK.test("Okay, let's break this down. The user asked me to describe the current board.")).toBe(true);
    expect(REASONING_LEAK.test("I called the readboard function with format ranks.")).toBe(true);
    expect(REASONING_LEAK.test("You have king e1, queen d1. I have king e8.")).toBe(false);
  });

  it("lets the model ignore overheard words that got past the filter", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-ign");
    const { tools } = fakeTools();
    const s = scriptedConverse([use("ignore", {})]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-ign", { text: "what is he doing in the kitchen", woken: false });
    expect(r.ignored).toBe(true);
    const names = s.calls[0].toolConfig!.tools!.map((t: any) => t.toolSpec.name);
    expect(names).toContain("ignore");
    expect(names).not.toContain("ask_again");
    expect((s.calls[0].messages!.at(-1)!.content![0] as any).text).toContain("heard without the wake word");
  });

  it("never restarts a game in progress without restart words", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-restart");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("new_game", { color: "white", level: 2 }), say("We're mid-game.")]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-restart", "white and easy");
    expect(calls).toHaveLength(0);
    const s2 = scriptedConverse([use("new_game", { color: "white", level: 2 })]);
    const r2 = await runTurn({ converse: s2.converse, tools, sessions, modelId: "m" }, "s-restart", { text: "correct, white easy", woken: false });
    expect(r2.ignored).toBe(true);
    const s3 = scriptedConverse([use("new_game", { color: "white", level: 2 }), say("Fresh board!")]);
    await runTurn({ converse: s3.converse, tools, sessions, modelId: "m" }, "s-restart", "new game, white, easy");
    expect(calls).toHaveLength(1);
  });

  it("builds move replies without the model: moves first, then one jab, compliment or opening", () => {
    const base = { yourMoveSpoken: "knight to f3", engineMoveSpoken: "pawn to d5" };
    expect(quickMoveReply({ ...base, commentary: {} }, "brief", 0)).toBe("Knight to f3. I play pawn to d5.");
    // No unasked warnings or better moves any more (2026-10-17).
    expect(quickMoveReply({ ...base, commentary: { alerts: ["your bishop on c4 is under attack by a pawn"] } }, "brief", 0)).toBe("Knight to f3. I play pawn to d5.");
    expect(quickMoveReply({ ...base, commentary: { yourMove: { quality: "blunder", betterWas: "pawn to e4" } } }, "brief", 0, "Ouch! That was expensive.")).toBe("Knight to f3. I play pawn to d5. Ouch! That was expensive.");
    expect(quickMoveReply({ ...base, commentary: { opening: { name: "Zukertort Opening" } } }, "brief", 0, "Well played!")).toBe("Knight to f3. I play pawn to d5. Well played!");
    expect(quickMoveReply({ ...base, commentary: {} }, "minimal", 0, "Well played!")).toBe("Knight to f3. I play pawn to d5.");
    expect(quickMoveReply({ ...base, commentary: { opening: { name: "Zukertort Opening" } } }, "brief", 1)).toBe("Knight to f3; I answer pawn to d5. This is the Zukertort Opening.");
    expect(quickMoveReply({ ...base, commentary: { opening: { name: "Zukertort Opening" } } }, "minimal", 0)).toBe("Knight to f3. I play pawn to d5.");
    expect(quickMoveReply({ yourMoveSpoken: "queen to h7, checkmate", gameOverText: "Checkmate. You win!" }, "minimal", 0)).toBe("Queen to h7, checkmate. You win!");
  });

  it("confirms each move before playing it when asked to", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-cm");
    await sessions.put({ ...(await sessions.get("s-cm"))!, confirmMoves: true });
    const seen: Record<string, unknown>[] = [];
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (_n, args) => {
        seen.push(args);
        return args.preview
          ? { isError: false, data: { speech: "knight to f3?", preview: true, san: "Nf3", spoken: "knight to f3" } }
          : { isError: false, data: { yourMoveSpoken: "knight to f3", engineMoveSpoken: "pawn to d5", commentary: {} } };
      },
    };
    const deps = { converse: scriptedConverse([]).converse, tools, sessions, modelId: "m" };
    const r1 = await runTurn(deps, "s-cm", "night f3");
    expect(seen[0]).toMatchObject({ preview: true });
    expect(r1.reply).toBe("knight to f3?");
    expect(r1.expectsReply).toBe(true);
    const r2 = await runTurn(deps, "s-cm", "yes");
    expect(seen[1]).toMatchObject({ move: "Nf3", alternatives: [] });
    expect(seen[1]).not.toHaveProperty("preview");
    expect(r2.reply).toMatch(/^Knight to f3/);
  });

  it("never resigns or undoes on a question (the eval caught both)", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-guard");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("resign", {})]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-guard", "Can I resign?");
    expect(calls).toHaveLength(0);
    expect(r.reply).toBe('Do you want to resign this game? Say "I resign" to confirm.');
    const s2 = scriptedConverse([use("undo", {}), say("There's no redo, but you can play the move again.")]);
    const r2 = await runTurn({ converse: s2.converse, tools, sessions, modelId: "m" }, "s-guard", "Can you redo the move?");
    expect(calls).toHaveLength(0);
    expect(r2.toolCalls[0]).toMatchObject({ name: "undo", isError: true });
    const s3 = scriptedConverse([use("resign", {}), say("Good game!")]);
    await runTurn({ converse: s3.converse, tools, sessions, modelId: "m" }, "s-guard", "I resign");
    expect(calls.map((c) => c.name)).toEqual(["resign"]);
  });

  it("speaks general-knowledge answers word for word, short", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-ans");
    const { tools, calls } = fakeTools();
    const s = scriptedConverse([use("answer", { reply: "En passant lets a pawn capture another pawn that just jumped two squares past it. It must be done right away. It's rare. Fun, though." })]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-ans", "what is en passant");
    expect(calls).toHaveLength(0);
    expect(s.calls).toHaveLength(1);
    expect(r.reply).toBe("En passant lets a pawn capture another pawn that just jumped two squares past it. It must be done right away.");
  });
});

describe("Phase 8: a rival, not a coach, and short replies (2026-10-17)", () => {
  it("caps any reply by words, at a sentence or a comma", () => {
    expect(capWords("One two three. Four five six.", 10)).toBe("One two three. Four five six.");
    expect(capWords("One two three. Four five six.", 4)).toBe("One two three.");
    const list = "Your queen can play: queen to c4, queen to b5, queen to a6, queen to e4, queen to f5, queen to g6, queen takes pawn on h7.";
    expect(capWords(list, 12)).toBe("Your queen can play: queen to c4, queen to b5.");
  });

  it("names the new strengths", () => {
    expect(LEVEL_NAMES[2]).toMatch(/easy, about 800/);
    expect(LEVEL_NAMES[4]).toMatch(/medium, about 1500/);
    expect(LEVEL_NAMES[6]).toMatch(/hard, about 2500/);
  });

  it("jabs a blunder on a move turn without any model call, and never warns", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-jab");
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async () => ({
        isError: false,
        data: {
          yourMoveSpoken: "bishop to a6", engineMoveSpoken: "pawn on b7 takes bishop on a6", gameOver: false,
          commentary: { yourMove: { quality: "blunder", lossCp: 320, betterWas: "knight to f3" }, alerts: ["your knight on c3 is under attack by a pawn"] },
          moveFacts: { yourPiece: "bishop", myPiece: "pawn", iCaptured: "bishop", materialChange: -3, materialBalance: -3, phase: "opening" },
        },
      }),
    };
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-jab", "bishop a6");
    expect(s.calls).toHaveLength(0);
    expect(r.reply).toMatch(/^Bishop to a6[.;,] .*pawn on b7 takes bishop on a6\. .+/);
    expect(r.reply).not.toMatch(/careful|under attack|was better|knight to f3/i);
    expect((await sessions.get("s-jab"))!.banter!.used).toHaveLength(1);
  });

  it("after an undo, 'what should I have played?' is the engine's best move here", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-undo");
    const calls: string[] = [];
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (name) => {
        calls.push(name);
        if (name === "undo") return { isError: false, data: { speech: "Took back bishop to a6. It's your move as White." } };
        if (name === "hint") return { isError: false, data: { speech: "The best move here, according to the engine, would be knight to f3." } };
        return { isError: false, data: { speech: "ok" } };
      },
    };
    const s = scriptedConverse([use("undo", {})]);
    await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-undo", "undo");
    expect((await sessions.get("s-undo"))!.justUndid).toBe(true);
    const r = await runTurn({ converse: scriptedConverse([]).converse, tools, sessions, modelId: "m" }, "s-undo", "what should I have played?");
    expect(calls).toEqual(["undo", "hint"]);
    expect(r.reply).toBe("The best move here, according to the engine, would be knight to f3.");
  });
});

describe("decide, don't ask (live site feedback, 2026-10-16)", () => {
  /** A chess server that is unsure about the first reading, then plays whatever exact SAN it's given. */
  function unsureTools(first: Record<string, unknown>, isError = false) {
    const seen: Record<string, unknown>[] = [];
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (name, args) => {
        seen.push({ name, ...args });
        if (name === "legal_moves") return { isError: false, data: { moves: ["Nf3", "Nc3", "e4"] } };
        if (name === "make_move" && seen.filter((s) => s.name === "make_move").length === 1) return { isError, data: first };
        return { isError: false, data: { yourMoveSpoken: args.move === "Nf3" ? "knight to f3" : "knight to c3", engineMoveSpoken: "pawn to d5", commentary: {} } };
      },
    };
    return { tools, seen };
  }

  it("plays the best reading of unclear words instead of asking", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-took");
    const { tools, seen } = unsureTools({ speech: "I heard \"night S3\". Did you mean knight to f3?", needsConfirmation: true, candidates: ["Nf3"], doubt: "unclear" });
    const r = await runTurn({ converse: scriptedConverse([]).converse, tools, sessions, modelId: "m" }, "s-took", "night S3");
    expect(seen[1]).toMatchObject({ name: "make_move", move: "Nf3", alternatives: [] });
    expect(r.reply).toBe('Taking "night S3" as knight to f3; say undo if not. I play pawn to d5.');
    expect((await sessions.get("s-took"))!.pending).toBeUndefined();
  });

  it("lets the model pick between two readings, then plays it", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-two");
    const { tools, seen } = unsureTools({ needsConfirmation: true, candidates: ["Nc3", "Nf3"], doubt: "ambiguous" });
    const s = scriptedConverse([say('{"san": "Nf3"}')]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-two", "night ef three");
    expect((s.calls[0].messages![0].content![0] as any).text).toContain("legal moves (SAN): Nc3, Nf3");
    expect(seen.at(-1)).toMatchObject({ name: "make_move", move: "Nf3" });
    expect(r.reply).toMatch(/^Taking "night ef three" as knight to f3/);
  });

  it("says once why an understood move is illegal, and plays nothing", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-illegal");
    const { tools, seen } = unsureTools({ needsConfirmation: true, candidates: ["Nxd4"], doubt: "illegal", why: "none of your pawns can reach d4" });
    const r = await runTurn({ converse: scriptedConverse([]).converse, tools, sessions, modelId: "m" }, "s-illegal", "pawn d4");
    expect(seen.filter((x) => x.name === "make_move")).toHaveLength(1);
    expect(r.reply).toBe('I heard "pawn d4": that isn\'t possible, none of your pawns can reach d4.');
    expect((await sessions.get("s-illegal"))!.pending).toBeUndefined();
  });

  it("still asks a board question: which rook", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-which");
    const { tools } = unsureTools({ speech: "Which rook: the one on c7, or the one on e1?", needsConfirmation: true, candidates: ["Rce7", "Ree7"], doubt: "which" });
    const r = await runTurn({ converse: scriptedConverse([]).converse, tools, sessions, modelId: "m" }, "s-which", "rook e7");
    expect(r.reply).toBe("Which rook: the one on c7, or the one on e1?");
  });

  it("decodes garbled words with the model when the matcher found nothing", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-garble");
    const { tools, seen } = unsureTools({ speech: "I didn't catch a legal move there." }, true);
    const s = scriptedConverse([say('{"san": "Nf3"}')]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-garble", "92 S3");
    expect(seen.map((x) => x.name)).toEqual(["make_move", "legal_moves", "make_move"]);
    expect(r.reply).toMatch(/^Taking "92 S3" as knight to f3; say undo if not\./);
  });
});

describe("question router", () => {
  it("sends the common questions straight to their tool", () => {
    expect(routeQuestion("What would you recommend")).toEqual({ name: "hint", args: { count: 1, reveal: true } });
    expect(routeQuestion("what are my three best moves")).toEqual({ name: "hint", args: { count: 3, reveal: true } });
    expect(routeQuestion("give me a small hint without revealing the answer")).toEqual({ name: "hint", args: { count: 1, reveal: false } });
    expect(routeQuestion("can I castle kingside")).toEqual({ name: "consider_move", args: { move: "can I castle kingside" } });
    expect(routeQuestion("can I move my king to e2")?.name).toBe("consider_move");
    expect(routeQuestion("what happens if I take on d5")?.name).toBe("consider_move");
    expect(routeQuestion("am I in check")?.name).toBe("analyze_position");
    expect(routeQuestion("is my queen under attack")?.name).toBe("analyze_position");
    expect(routeQuestion("who is better")?.name).toBe("analyze_position");
    expect(routeQuestion("did I mess up")?.name).toBe("review_game");
    expect(routeQuestion("why did you play that")?.name).toBe("review_game");
    expect(routeQuestion("what was your last move")).toEqual({ name: "last_moves", args: { count: 2 } });
    expect(routeQuestion("repeat the last five moves")).toEqual({ name: "last_moves", args: { count: 10 } });
    // Left to the model: no single obvious tool.
    expect(routeQuestion("what is en passant")).toBeUndefined();
    expect(routeQuestion("what did I play first")).toBeUndefined();
    expect(routeQuestion("should I exchange queens")?.name).toBe("analyze_position");
    // Found by the 305-question eval:
    expect(routeQuestion("Can I castle while in check?")).toBeUndefined(); // a rule, not this position
    expect(routeQuestion("Can I castle through an attacked square?")).toBeUndefined();
    expect(routeQuestion("What move should I avoid?")?.name).toBe("analyze_position"); // not a hint: the risk
    expect(routeQuestion("What is the safest move?")).toEqual({ name: "hint", args: { count: 3, reveal: true }, phrase: true });
    expect(routeQuestion("Which of my pieces is misplaced?")?.name).toBe("analyze_position");
    expect(routeQuestion("Is my rook trapped?")?.name).toBe("analyze_position");
    expect(routeQuestion("Which pieces has my opponent lost?")?.name).toBe("analyze_position");
    expect(routeQuestion("Which pieces do I have left?")).toBeUndefined(); // list_pieces, chosen by the model
    expect(routeQuestion("What was the first move of the game?")).toEqual({ name: "game_history", args: {}, phrase: true });
  });

  it("answers a routed hint without any model call", async () => {
    const sessions = new MemorySessionStore();
    await gameSession(sessions, "s-route");
    const tools: ChessTools = {
      listTools: async () => MCP_TOOLS,
      callTool: async (name, args) => ({ isError: false, data: { speech: `Try knight to f3. (${name} ${JSON.stringify(args)})` } }),
    };
    const s = scriptedConverse([]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-route", "what should I play");
    expect(s.calls).toHaveLength(0);
    expect(r.reply).toBe('Try knight to f3. (hint {"count":1,"reveal":true,"gameId":"g-1"})');
  });
});

describe("new game choices", () => {
  it("blocks new_game until colour and difficulty were said", async () => {
    const { tools, calls } = fakeTools();
    const sessions = new MemorySessionStore();
    const s = scriptedConverse([use("new_game", { color: "white", level: 3 }), say("White or black, and how tough?")]);
    const r = await runTurn({ converse: s.converse, tools, sessions, modelId: "m" }, "s-choice", "I want a game");
    expect(calls).toHaveLength(0);
    expect(r.reply).toBe("Sure! White or black? And easy, medium or hard?");
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
    expect(r.reply).toBe("Sure, you'll play White! Easy, medium or hard?");
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
