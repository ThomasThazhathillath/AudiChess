import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
  TokenUsage,
  Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { ChessTools, McpTool } from "./mcpClient.js";
import { type Chattiness, type Session, type SessionStore, newSession, touch } from "./sessions.js";
import { DEFAULT_VOICE, type Speak, VOICES } from "./voice.js";
import skill from "../skills/blind-chess/SKILL.md";

export type Converse = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

export interface AgentDeps {
  converse: Converse;
  tools: ChessTools;
  sessions: SessionStore;
  modelId: string;
  /** Text-to-speech; when absent the browser speaks the text itself. */
  speak?: Speak;
  /** Bedrock prompt caching for the static skill + tool list (default on). */
  promptCache?: boolean;
}

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  speech?: string;
}

export interface TurnInput {
  text: string;
  /** Speech-recognition alternatives for this utterance, best first (text is usually the first). */
  alternatives?: string[];
}

export interface TurnResult {
  reply: string;
  gameId?: string;
  gameOver: boolean;
  /** True when Alexa asked a question and expects an answer (the page keeps listening without the wake word). */
  expectsReply: boolean;
  toolCalls: ToolTrace[];
  /** base64 MP3 from Polly, when available. */
  audio?: string;
  voice: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; rounds: number };
}

const MAX_ROUNDS = 6;

// The agent fills these in itself, so the model never copies ids or long transcripts around.
const HIDDEN_ARGS = ["gameId", "sessionId", "alternatives"];
const LIST_RECENT_FLAG = "listRecentGames";

/** The skill body without its YAML frontmatter. */
const SKILL_BODY = skill.replace(/^---[\s\S]*?---\s*/, "");

// ---------- agent-local tools (preferences live in the session, not on the chess server) ----------

const LOCAL_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: "set_preferences",
      description:
        "Change how Alexa talks: chattiness ('talk less' -> minimal, 'talk more' -> chatty, normal -> brief), voice accent, or speaking speed ('slower', 'faster', 'normal').",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            chattiness: { type: "string", enum: ["minimal", "brief", "chatty"] },
            voice: { type: "string", enum: Object.keys(VOICES) },
            speed: { type: "string", enum: ["slower", "normal", "faster"] },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: "repeat_last",
      description: "Repeat Alexa's previous reply word for word ('repeat that', 'say that again', 'what did you say').",
      inputSchema: { json: { type: "object", properties: {} } },
    },
  },
];

/** MCP tool definitions -> Bedrock Converse toolSpecs, minus the arguments the agent fills in. */
export function toBedrockTools(tools: McpTool[]): Tool[] {
  const mcp = tools.map((t) => {
    const schema = structuredClone(t.inputSchema) as {
      properties?: Record<string, unknown>;
      required?: string[];
      [k: string]: unknown;
    };
    delete schema.$schema;
    for (const key of HIDDEN_ARGS) {
      delete schema.properties?.[key];
      if (schema.required) schema.required = schema.required.filter((r) => r !== key);
    }
    if (t.name === "new_game") {
      // No silent defaults: the model has to get colour and difficulty from the user (or a clear "whatever").
      schema.required = ["color", "level"];
      for (const key of ["color", "level"]) delete (schema.properties?.[key] as Record<string, unknown> | undefined)?.default;
    }
    if (t.name === "game_history") {
      schema.properties = {
        ...schema.properties,
        [LIST_RECENT_FLAG]: { type: "boolean", description: "true to list the user's recent games instead of the current one." },
      };
    }
    schema.type = "object";
    schema.properties ??= {};
    return {
      toolSpec: {
        name: t.name,
        description: (t.description ?? t.name).replace(/gameId[^.]*\./g, "").trim(),
        inputSchema: { json: schema as any },
      },
    } as Tool;
  });
  return [...mcp, ...LOCAL_TOOLS];
}

const CHATTINESS_RULES: Record<Chattiness, string> = {
  minimal: "Chattiness: MINIMAL. Say the moves and only remark on checks, captures of major pieces, blunders, openings and the result.",
  brief: "Chattiness: BRIEF (default). Moves plus at most one short, natural remark when something is worth saying.",
  chatty: "Chattiness: CHATTY. Moves plus a lively remark most turns: opening trivia, reactions, gentle teasing. Still at most three sentences.",
};

/** The per-session part of the system prompt (the skill itself is static, so it can be cached). */
function sessionState(session: Session): string {
  let state: string;
  if (!session.gameId) state = "There is no game in progress. If the user wants to play, find out their colour and difficulty (ask once if they didn't say), then call new_game.";
  else if (session.gameOver) state = `The last game is over (the user played ${session.humanColor}). Offer a rematch if they want to keep playing.`;
  else state = `A game is in progress: the user plays ${session.humanColor} against level ${session.level}. The game is selected automatically for every tool.`;
  const chattiness = CHATTINESS_RULES[session.chattiness ?? "brief"];
  return `## Current state\n${state}\n${chattiness}\n\nReply with plain spoken sentences only.`;
}

/** Nova sometimes wraps its reasoning in <thinking> tags; that must never be spoken. */
export function cleanSpeech(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<\/?(response|answer)>/g, "")
    .replace(/[*_#`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips a leading wake word so "Alexa, knight f3" reaches the model as "knight f3". */
export function stripWakeWord(text: string): string {
  return text.replace(/^\s*(hey\s+)?(alexa|alexia|alexis|a lexa)[\s,.!:]*/i, "").trim();
}

function handleLocalTool(name: string, args: Record<string, unknown>, session: Session): { session: Session; data: Record<string, unknown> } {
  if (name === "repeat_last") {
    const last = [...session.turns].reverse().find((t) => t.role === "assistant")?.text;
    return { session, data: { speech: last ? `Sure. ${last}` : "I haven't said anything yet!", repeat: true } };
  }
  const next = { ...session };
  const changes: string[] = [];
  if (typeof args.chattiness === "string" && args.chattiness in CHATTINESS_RULES) {
    next.chattiness = args.chattiness as Chattiness;
    changes.push(next.chattiness === "minimal" ? "I'll keep it short" : next.chattiness === "chatty" ? "I'll chat a bit more" : "back to normal chatter");
  }
  if (typeof args.voice === "string" && VOICES[args.voice]) {
    next.voice = VOICES[args.voice].id;
    changes.push(`switching to my ${args.voice.replace(/\b\w/g, (c) => c.toUpperCase())} voice`);
  }
  if (args.speed === "slower") { next.rate = Math.max(75, (session.rate ?? 100) - 15); changes.push("I'll speak more slowly"); }
  if (args.speed === "faster") { next.rate = Math.min(125, (session.rate ?? 100) + 15); changes.push("I'll speak a little faster"); }
  if (args.speed === "normal") { next.rate = 100; changes.push("normal speed again"); }
  return { session: next, data: { speech: changes.length ? `Okay, ${changes.join(", and ")}.` : "Okay." } };
}

export async function runTurn(deps: AgentDeps, sessionId: string, input: TurnInput | string): Promise<TurnResult> {
  const { text: rawText, alternatives = [] } = typeof input === "string" ? { text: input } : input;
  const userText = stripWakeWord(rawText) || rawText.trim();
  const heard = [...new Set([userText, ...alternatives.map(stripWakeWord)].filter(Boolean))].slice(0, 5);

  let session = (await deps.sessions.get(sessionId)) ?? newSession(sessionId);
  const toolCalls: ToolTrace[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 0 };
  const cache = deps.promptCache !== false;
  const bedrockTools = toBedrockTools(await deps.tools.listTools());
  const tools = bedrockTools; // Nova rejects cache points inside toolConfig, so only the system prompt is cached

  // Recognition alternatives help the model read garbled moves; they are not kept in history.
  const altHint = heard.length > 1 ? `\n(speech recognition alternatives: ${heard.slice(1).map((h) => `"${h}"`).join(", ")})` : "";
  const messages: Message[] = [
    ...session.turns.map((t) => ({ role: t.role, content: [{ text: t.text }] }) as Message),
    { role: "user", content: [{ text: userText + altHint }] },
  ];

  let reply = "";
  let repeated = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await deps.converse({
      modelId: deps.modelId,
      system: cache
        ? [{ text: SKILL_BODY }, { cachePoint: { type: "default" } }, { text: sessionState(session) }]
        : [{ text: `${SKILL_BODY}\n\n${sessionState(session)}` }],
      messages,
      // During a game the first round must call a tool: otherwise the model may "play" a move from memory
      // of earlier turns without the server ever seeing it.
      toolConfig: {
        tools,
        toolChoice: round === 0 && session.gameId && !session.gameOver ? { any: {} } : { auto: {} },
      },
      // Precise when choosing tools, more natural when phrasing the reply.
      inferenceConfig: { temperature: round === 0 ? 0 : 0.6, maxTokens: 500 },
    });
    usage.rounds++;
    addUsage(usage, res.usage);
    const message = res.output?.message;
    if (!message?.content) break;
    messages.push(message);

    const toolUses = message.content.filter((c): c is ContentBlock.ToolUseMember => "toolUse" in c && !!c.toolUse);
    const text = cleanSpeech(message.content.map((c) => ("text" in c && c.text ? c.text : "")).join(" "));

    if (res.stopReason !== "tool_use" || toolUses.length === 0) {
      reply = text;
      break;
    }

    const results: ContentBlock[] = [];
    for (const { toolUse } of toolUses) {
      const name = toolUse.name!;
      const args = { ...((toolUse.input as Record<string, unknown>) ?? {}) };
      const listRecent = args[LIST_RECENT_FLAG] === true;
      delete args[LIST_RECENT_FLAG];
      for (const key of HIDDEN_ARGS) delete args[key];

      let content: Record<string, unknown>;
      let isError = false;
      if (LOCAL_TOOLS.some((t) => t.toolSpec?.name === name)) {
        const r = handleLocalTool(name, args, session);
        session = r.session;
        content = r.data;
        if (name === "repeat_last") repeated = true;
      } else {
        if (name === "new_game") args.sessionId = sessionId;
        else if (session.gameId && !(name === "game_history" && listRecent)) args.gameId = session.gameId;
        if (name === "make_move" && heard.length) args.alternatives = heard;

        const missing = name === "new_game" ? missingGameChoices(session, userText) : [];
        if (missing.length) {
          // Models love silent defaults; make sure the user actually chose.
          isError = true;
          content = { speech: `Before starting, ask the user for their ${missing.join(" and ")} in one short, friendly question.` };
        } else if (!session.gameId && name !== "new_game" && name !== "game_history") {
          isError = true;
          content = { speech: "There is no game in progress yet. Ask the user if they want to start one, and with which colour and difficulty." };
        } else {
          const r = await deps.tools.callTool(name, args);
          isError = r.isError;
          content = r.data;
        }
      }

      // Track the game this session is playing.
      if (name === "new_game" && !isError && typeof content.gameId === "string") {
        session = { ...session, gameId: content.gameId, humanColor: String(content.humanColor), level: Number(content.level), gameOver: false };
      } else if (name === "make_move" && !isError) {
        session = { ...session, gameOver: content.gameOver === true };
      } else if (name === "set_level" && !isError) {
        session = { ...session, level: Number(content.level) };
      } else if (name === "resign" && !isError) {
        session = { ...session, gameOver: true };
      } else if (name === "undo" && !isError) {
        session = { ...session, gameOver: false };
      }

      const traceArgs = { ...args };
      delete traceArgs.alternatives;
      toolCalls.push({ name, args: traceArgs, isError, speech: typeof content.speech === "string" ? content.speech : undefined });
      const { gameId: _g, fen: _f, ...forModel } = content; // the model has no use for ids or FEN
      results.push({
        toolResult: {
          toolUseId: toolUse.toolUseId!,
          content: [{ text: JSON.stringify(forModel) }],
          status: isError ? "error" : "success",
        },
      });
    }
    messages.push({ role: "user", content: results });

    // Preference changes and "repeat that" are answered directly: word for word, and one model call cheaper.
    const recent = toolCalls.slice(-toolUses.length);
    if (toolUses.every(({ toolUse }) => LOCAL_TOOLS.some((t) => t.toolSpec?.name === toolUse.name))) {
      reply = recent.map((t) => t.speech).filter(Boolean).join(" ");
      break;
    }
  }

  if (!reply) {
    // Model ran out of rounds or said nothing: fall back to the last tool's own words.
    reply = [...toolCalls].reverse().find((t) => t.speech)?.speech ?? "Sorry, I didn't catch that. Could you say it again?";
  }

  if (!repeated) session.turns = [...session.turns, { role: "user", text: userText }, { role: "assistant", text: reply }];
  await deps.sessions.put(touch(session));

  const voice = session.voice ?? DEFAULT_VOICE;
  const audio = deps.speak ? await deps.speak(reply, voice, session.rate ?? 100) : undefined;
  return {
    reply,
    gameId: session.gameId,
    gameOver: session.gameOver === true,
    expectsReply: asksQuestion(reply),
    toolCalls,
    audio,
    voice,
    usage,
  };
}

const COLOUR_WORDS = /\b(white|black|random|either|any colou?r|whatever|you (pick|choose|decide)|surprise me|doesn'?t matter|same as before|rematch)\b/i;
const LEVEL_WORDS =
  /\b(easy|easier|medium|hard|harder|beginner|casual|gentle|relaxed|normal|intermediate|challenging|club|strong|expert|grandmaster|full strength|max(imum)?|level \w+|whatever|you (pick|choose|decide)|doesn'?t matter|same as before|rematch|don'?t hold back)\b/i;

/** Which of colour / difficulty the user hasn't mentioned in this or their previous utterance. */
export function missingGameChoices(session: Session, userText: string): string[] {
  const previousUser = [...session.turns].reverse().find((t) => t.role === "user")?.text ?? "";
  const said = `${previousUser} ${userText}`;
  const missing: string[] = [];
  if (!COLOUR_WORDS.test(said)) missing.push("colour (white or black)");
  if (!LEVEL_WORDS.test(said)) missing.push("difficulty (easy, medium, hard or full strength)");
  return missing;
}

function addUsage(total: TurnResult["usage"], u?: TokenUsage) {
  total.inputTokens += u?.inputTokens ?? 0;
  total.outputTokens += u?.outputTokens ?? 0;
  total.cacheReadTokens += u?.cacheReadInputTokens ?? 0;
  total.cacheWriteTokens += u?.cacheWriteInputTokens ?? 0;
}

/**
 * True when the reply really waits for an answer ("White or black?"), so the page may listen without the
 * wake word. A routine "Your move?" doesn't count: the wake word stays required, as the user chose.
 */
export function asksQuestion(reply: string): boolean {
  // Look at the last two sentences: "How tough should I be? Choose easy, medium or hard." still waits for an answer.
  const tail = reply.trim().split(/(?<=[.!?])\s+/).slice(-2);
  const routine = /^(so,? )?(and )?(what('s| is| will be)? )?(your|ur) (next )?move\?$|^what would you like to (play|do)( next)?\?$|^your turn\?$/i;
  return tail.some((s) => /\?$/.test(s) && !routine.test(s));
}
