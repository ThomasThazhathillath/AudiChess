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
  /** The same utterance heard by the page's chess-grammar recognizer ("pawn d four"), when it caught chess words. */
  chessHeard?: string;
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
        "Change how Alexa talks: chattiness ('talk less' -> brief, 'just the moves' -> minimal, 'talk more' / 'normal' -> chatty), voice accent, or speaking speed ('slower', 'faster', 'normal').",
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
  {
    toolSpec: {
      name: "ask_again",
      description:
        "Use when the user's words don't make sense as a move or a request (speech recognition garbled them), or for a greeting or small talk that needs no chess tool. Never use it to announce or invent moves. Put your whole short spoken reply in `reply`, worded freshly each time.",
      inputSchema: {
        json: {
          type: "object",
          properties: { reply: { type: "string", description: "What Alexa says, e.g. a short, friendly re-ask naming what you think you heard." } },
          required: ["reply"],
        },
      },
    },
  },
];

// Results of these tools carry facts; the model words the reply itself instead of reading out `speech`.
const FACT_TOOLS = new Set(["make_move", "new_game"]);

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

export const DEFAULT_CHATTINESS: Chattiness = "chatty";

const CHATTINESS_RULES: Record<Chattiness, string> = {
  minimal: "Chattiness: MINIMAL. Just the two moves, plus a few words only for checks, big captures, blunders, openings and the result.",
  brief: "Chattiness: BRIEF. The two moves plus at most one short remark when something is worth saying.",
  chatty:
    "Chattiness: CHATTY (default). The two moves plus one or two lines of real personality almost every turn: react, tease, talk about your plans or theirs. Two to three sentences in total.",
};

/**
 * What Alexa said lately that she must not say again: how replies started, how they ended, and any phrase of
 * four or more words used twice. Fed into the prompt so variety is enforced, not just requested.
 */
export function recentPhrases(turns: Session["turns"], lookback = 6): string[] {
  const replies = turns.filter((t) => t.role === "assistant").slice(-lookback).map((t) => t.text);
  const out = new Set<string>();
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  for (const r of replies) {
    const w = words(r);
    if (w.length >= 3) out.add(w.slice(0, 3).join(" "));
    const sentences = r.split(/(?<=[.!?])\s+/);
    const last = sentences[sentences.length - 1];
    if (sentences.length > 1 && words(last).length <= 8) out.add(words(last).join(" "));
  }
  const seen = new Map<string, number>();
  for (const r of replies) {
    const w = words(r);
    const grams = new Set<string>();
    for (let i = 0; i + 4 <= w.length; i++) grams.add(w.slice(i, i + 4).join(" "));
    for (const g of grams) seen.set(g, (seen.get(g) ?? 0) + 1);
  }
  for (const [g, n] of seen) if (n >= 2) out.add(g);
  return [...out].slice(-14);
}

/** The per-session part of the system prompt (the skill itself is static, so it can be cached). */
function sessionState(session: Session): string {
  let state: string;
  if (!session.gameId) state = "There is no game in progress. If the user wants to play, find out their colour and difficulty (ask once if they didn't say), then call new_game.";
  else if (session.gameOver) state = `The last game is over (the user played ${session.humanColor}). For questions about it call game_history; offer a rematch if they want to keep playing.`;
  else state = `A game is in progress: the user plays ${session.humanColor} against level ${session.level}. The game is selected automatically for every tool.`;
  const chattiness = CHATTINESS_RULES[session.chattiness ?? DEFAULT_CHATTINESS];
  const avoid = recentPhrases(session.turns);
  const variety = avoid.length ? `\nYou said these recently. Do not reuse them or start the same way: ${avoid.map((p) => `"${p}"`).join(", ")}.` : "";
  return `## Current state\n${state}\n${chattiness}${variety}\n\nReply with plain spoken sentences only.`;
}

/**
 * What is worth talking about after a move, most important first, from the server's facts.
 * The model gets the top few, so its personality goes where the game actually happened.
 */
export function talkingPoints(result: Record<string, unknown>, max = 2, seed = 0): string[] {
  const c = (result.commentary ?? {}) as {
    opening?: { name: string; reachedBy: string };
    yourMove?: { quality: string; betterWas?: string };
    yourMoveIdeas?: string[];
    myMoveIdeas?: string[];
    position?: string;
    swing?: { direction: string };
    trend?: string;
    material?: string;
    alerts?: string[];
  };
  const points: string[] = [];
  if (typeof result.gameOverText === "string") points.push(`the game is over: ${result.gameOverText}`);
  if (result.inCheck) points.push("the user is in check");
  const q = c.yourMove?.quality;
  if (q === "blunder" || q === "mistake") points.push(`the user's move was a ${q}${c.yourMove?.betterWas ? ` (better was ${c.yourMove.betterWas}; only mention if it fits)` : ""}`);
  if (c.swing) points.push(`the game just swung ${c.swing.direction}`);
  if (c.opening) points.push(`new opening reached by ${c.opening.reachedBy}: ${c.opening.name}`);
  if (c.alerts?.length) points.push(`warn them: ${c.alerts[0]}`);
  const captures = [...(c.yourMoveIdeas ?? []).filter((i) => i.startsWith("captures")).map((i) => `the user ${i}`), ...(c.myMoveIdeas ?? []).filter((i) => i.startsWith("captures")).map((i) => `my move ${i}`)];
  points.push(...captures);
  if (c.material) points.push(c.material);
  if (c.position) points.push(`assessment changed: ${c.position}`);
  if (q === "best" && (c.swing || c.position)) points.push("the user found the best move in a sharp spot");
  const castles = [...(c.yourMoveIdeas ?? []), ...(c.myMoveIdeas ?? [])].some((i) => i.startsWith("castles"));
  if (castles) points.push("someone castled");
  if (c.trend && c.trend !== "steady") points.push(`the user's position has been ${c.trend} over the last few moves`);
  const ideas = (c.myMoveIdeas ?? []).filter((i) => !i.startsWith("captures") && !i.startsWith("castles"));
  if (ideas.length) points.push(`my move ${ideas[0]}`);
  if (points.length === 0) points.push(QUIET_THEMES[Math.abs(seed) % QUIET_THEMES.length]);
  return points.slice(0, max);
}

/** Different kinds of remark for quiet moves, rotated so one stock line can't take over. */
export const QUIET_THEMES = [
  "quiet move: tease the user lightly about their move or style",
  "quiet move: share a thought about what you are planning, without naming a piece you haven't moved",
  "quiet move: react to the pace or mood of the game",
  "quiet move: a short compliment or a playful challenge",
  "quiet move: comment on how the opening is developing",
  "quiet move: just the two moves, with a few words of reaction at most",
];

const sentenceWords = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean));

/**
 * Drops sentences (never the first, never one announcing this turn's moves) that mostly repeat a sentence from
 * the last few replies: word overlap of 0.7 or more of the shorter sentence.
 */
export function dropRepeatedSentences(reply: string, recentReplies: string[], keep: string[] = [], threshold = 0.7): string {
  const past = recentReplies.flatMap((r) => r.split(/(?<=[.!?])\s+/)).map(sentenceWords).filter((w) => w.size >= 3);
  const protectedPhrases = keep.filter(Boolean).map((k) => k.toLowerCase());
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s, i) => {
    if (i === 0) return true;
    if (protectedPhrases.some((p) => s.toLowerCase().includes(p))) return true;
    const w = sentenceWords(s);
    if (w.size < 3) return true;
    return !past.some((p) => {
      let common = 0;
      for (const x of w) if (p.has(x)) common++;
      return common / Math.min(w.size, p.size) >= threshold;
    });
  });
  return kept.join(" ");
}

/**
 * What the model sees of a tool result. Ids and FEN are useless to it. For moves and new games the server's
 * ready-made `speech` sentence is removed: read out every turn it made Alexa sound like a template, so the model
 * gets the facts (spoken moves, what's worth saying) and words the reply itself.
 */
export function factsForModel(name: string, content: Record<string, unknown>, isError: boolean, chattiness: Chattiness, seed = 0): Record<string, unknown> {
  const { gameId: _g, fen: _f, ...rest } = content;
  if (isError || !FACT_TOOLS.has(name) || content.needsConfirmation) return rest;
  const { speech: _s, yourMove: _y, engineMove: _e, ...facts } = rest;
  if (name === "new_game") {
    // Without this the model once "opened with pawn to d4" for a user playing White.
    const firstMove = typeof content.engineMoveSpoken === "string"
      ? `I (Alexa, playing ${content.humanColor === "White" ? "Black" : "White"}) opened with ${content.engineMoveSpoken}`
      : "none: the user plays White and moves first. Do not announce any move of yours.";
    return { ...facts, firstMove, instruction: "Announce the new game in your own words: their colour, the level name, and the first move only if I made one." };
  }
  // "Better was …" after every small inaccuracy became a nagging refrain; keep it for real mistakes.
  const commentary = { ...((facts.commentary as Record<string, unknown>) ?? {}) };
  const yourMove = commentary.yourMove as { quality?: string; betterWas?: string } | undefined;
  if (yourMove && yourMove.quality !== "mistake" && yourMove.quality !== "blunder") commentary.yourMove = { quality: yourMove.quality };
  return { ...facts, commentary, sayAboutThisTurn: talkingPoints(content, chattiness === "chatty" ? 2 : 1, seed) };
}

/** Spoken replies must stay short enough to follow by ear: keep the first `max` sentences. */
export function limitSentences(text: string, max: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.length <= max ? text : sentences.slice(0, max).join(" ");
}

const SENTENCE_LIMIT: Record<Chattiness, number> = { minimal: 2, brief: 3, chatty: 4 };

/** "talk more" / "talk less" / "just the moves": unambiguous, so no model call (it once picked game_status). */
export function chattinessCommand(text: string): Chattiness | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:please )?(?:talk|chat) (?:a bit |a little |a lot )?more(?: please)?$|^be (?:more )?chatty$/.test(t)) return "chatty";
  if (/^(?:please )?(?:talk|chat) (?:a bit |a little )?less(?: please)?$|^(?:keep it|be) (?:short|brief)$/.test(t)) return "brief";
  if (/^(?:just|only) (?:say )?(?:the )?moves(?: please)?$|^be quiet(?:er)?$/.test(t)) return "minimal";
  return undefined;
}

// Only as its own sentence or trailing clause: "... d5. Your move." / "Bold choice, over to you" (not "Is that your move?").
// Also the stock closing questions the model reaches for instead: "What will you play next?", "What'll you do?".
const HAND_OVER = new RegExp(
  String.raw`(?:^|(?<=[.!?,;]))\s*(?:` +
    String.raw`(?:so,? |and )?(?:it'?s |now it'?s )?(?:your (?:move|turn)|over to you|back to you|your go)(?:,? please)?[.!?]*` +
    String.raw`|(?:so,? |and |now,? )?(?:what (?:will|would|'ll) you|what'll you|what do you want to|what are you going to|how will you|how are you going to) (?:play|do|try|respond|answer)(?: next| now| here)?\?` +
    String.raw`|(?:so,? )?what(?:'s| is) your (?:next )?(?:move|plan)\?` +
    String.raw`|(?:(?:so|and|now)[,\s]+)?(?:(?:it'?s )?your (?:move|turn)|over to you)\s*[—–-]+\s*(?:what(?:'s| is) (?:next|your (?:next )?(?:move|plan))|what now|what will you (?:play|do))\?` +
    String.raw`|(?:(?:so|and|now)[,\s]+)?what(?:'s| is) next\?` +
    String.raw`)$`,
  "i",
);
const MADE_UP_MOVE = /\b(i play|i'll play|i played|you played|i respond|i answer|my reply is)\b/i;

/** Nova sometimes wraps its reasoning in <thinking> tags; that must never be spoken. */
export function cleanSpeech(text: string): string {
  const cleaned = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<\/?(response|answer)>/g, "")
    .replace(/[*_#`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // "... Your move." on every turn is the most robotic thing she says; the ring already shows it's their turn.
  let trimmed = cleaned.replace(HAND_OVER, "").replace(/[\s,;:-]+$/, "").trim();
  if (trimmed && !/[.!?]$/.test(trimmed)) trimmed += ".";
  return trimmed.length >= 3 ? trimmed : cleaned;
}

const FILE_SPOKEN: Record<string, string[]> = {
  a: ["a", "ay", "eh", "hey"], b: ["b", "be", "bee"], c: ["c", "see", "sea", "cee"], d: ["d", "dee"],
  e: ["e", "ee", "he"], f: ["f", "ef", "eff"], g: ["g", "gee"], h: ["h", "age", "aitch"],
};
const RANK_SPOKEN: Record<string, string[]> = {
  "1": ["1", "one"], "2": ["2", "two"], "3": ["3", "three"], "4": ["4", "four"],
  "5": ["5", "five"], "6": ["6", "six"], "7": ["7", "seven"], "8": ["8", "eight"],
};

/**
 * What the user said to the question "Did you mean X, or Y?" / "Which rook?": yes, no, first/second, or the
 * file/rank that tells the candidates apart. Anything else is a fresh utterance (undefined).
 */
export function answerToPending(text: string, candidates: string[]): { pick: string } | { no: true } | undefined {
  const t = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || candidates.length === 0) return undefined;
  if (/^(?:no|nope|nah|neither|none|wrong|cancel|never ?mind)(?: .*)?$/.test(t)) return { no: true };
  if (/^(?:(?:yes|yeah|yep|yup|yah|ya|sure|ok|okay|correct|right|exactly|that one|that's it|thats it|do it|go ahead|please)(?: |$))+$/.test(t)) return { pick: candidates[0] };
  if (candidates.length > 1) {
    if (/^(?:the )?(?:first|1st|one|former)(?: one)?$/.test(t)) return { pick: candidates[0] };
    if (/^(?:the )?(?:second|2nd|two|other|latter|last)(?: one)?$/.test(t)) return { pick: candidates[1] };
    // "the one on c" / "c file" / "from e": the letter or number the SAN disambiguates by.
    const words = new Set(t.split(" "));
    const hits = candidates.filter((san) => {
      const d = /^[NBRQK]([a-h]|[1-8])x?[a-h][1-8]/.exec(san)?.[1];
      if (!d) return false;
      return (FILE_SPOKEN[d] ?? RANK_SPOKEN[d] ?? []).some((w) => words.has(w));
    });
    if (hits.length === 1 && words.size <= 5) return { pick: hits[0] };
  }
  return undefined;
}

const QUESTION_WORDS = /\b(what|which|why|how|where|who|whom|when|can you|could you|tell me|explain|did you|do you|are you|is there|repeat|undo|resign|hint)\b/i;
const SQUARE_ISH = /\b[a-h]\s?[1-8]\b|\b[a-h]\s(?:one|two|three|four|five|six|seven|eight|for|tree|free)\b|\b(?:castle|castles|castling|takes|take)\b/i;

/** Speech that is clearly a move attempt: it must go to make_move, never to small talk (ask_again). */
export function looksLikeMove(...heard: string[]): boolean {
  const text = heard.filter(Boolean).join(" | ");
  return !QUESTION_WORDS.test(heard[0] ?? "") && SQUARE_ISH.test(text);
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
  if (name === "ask_again") {
    const reply = typeof args.reply === "string" ? cleanSpeech(args.reply) : "";
    // This tool never touches the board, so it must not be a back door for "playing" moves from memory.
    const safe = reply && !MADE_UP_MOVE.test(reply) ? reply : "Sorry, I didn't quite catch that. Could you say it again?";
    return { session, data: { speech: safe } };
  }
  const next = { ...session };
  const changes: string[] = [];
  if (typeof args.chattiness === "string" && args.chattiness in CHATTINESS_RULES) {
    next.chattiness = args.chattiness as Chattiness;
    changes.push(next.chattiness === "minimal" ? "just the moves from now on" : next.chattiness === "chatty" ? "I'll chat away" : "I'll keep it short");
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
  const { text: rawIn, alternatives = [], chessHeard: rawChess } = typeof input === "string" ? { text: input } : input;
  const rawText = typeof rawIn === "string" ? rawIn : ""; // a request without text once crashed stripWakeWord
  const userText = stripWakeWord(rawText) || rawText.trim();
  const heard = [...new Set([userText, ...alternatives.map(stripWakeWord)].filter(Boolean))].slice(0, 5);
  // The chess-grammar reading ("pawn d four") is the most reliable for moves, so it leads what make_move gets.
  const chessHeard = rawChess ? stripWakeWord(rawChess) : "";
  const moveHeard = chessHeard ? [...new Set([chessHeard, ...heard])].slice(0, 5) : heard;

  let session = (await deps.sessions.get(sessionId)) ?? newSession(sessionId);
  const toolCalls: ToolTrace[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 0 };
  const cache = deps.promptCache !== false;
  const bedrockTools = toBedrockTools(await deps.tools.listTools());
  const tools = bedrockTools; // Nova rejects cache points inside toolConfig, so only the system prompt is cached

  // Recognition alternatives help the model read garbled moves; they are not kept in history.
  const altHint =
    (heard.length > 1 ? `\n(speech recognition alternatives: ${heard.slice(1).map((h) => `"${h}"`).join(", ")})` : "") +
    (chessHeard ? `\n(chess hearing: "${chessHeard}")` : "");

  // "yes" / "the second one" / "c file" after a "Did you mean…?" or "Which rook?" is answered here, not by the model.
  const pendingAnswer =
    session.pending && session.gameId && !session.gameOver
      ? heard.map((h) => answerToPending(h, session.pending!.candidates)).find(Boolean)
      : undefined;
  let forcedMove = "";
  let guessed = false; // we asked twice and still weren't sure: played the likeliest reading
  const modelText = pendingAnswer && "pick" in pendingAnswer ? `Play the move ${pendingAnswer.pick}.` : userText;
  if (pendingAnswer && "pick" in pendingAnswer) forcedMove = pendingAnswer.pick;
  const messages: Message[] = [
    ...session.turns.map((t) => ({ role: t.role, content: [{ text: t.text }] }) as Message),
    { role: "user", content: [{ text: modelText + (forcedMove ? "" : altHint) }] },
  ];

  let reply = "";
  if (pendingAnswer && "no" in pendingAnswer) {
    session = { ...session, pending: undefined };
    reply = "Okay, scrap that. Say your move again.";
  } else if (!userText && !chessHeard) {
    reply = "Sorry, I didn't catch that. Could you say it again?";
  }
  let repeated = false;
  const spokenMoves: string[] = []; // this turn's announced moves, protected from dropRepeatedSentences
  let confirmSpeech = ""; // set when make_move needs confirmation: spoken verbatim
  let askChoices = ""; // set when new_game was blocked: we ask ourselves, so the model can't claim a game started

  const command = chattinessCommand(userText);
  if (command) {
    const r = handleLocalTool("set_preferences", { chattiness: command }, session);
    session = r.session;
    reply = String(r.data.speech);
    toolCalls.push({ name: "set_preferences", args: { chattiness: command }, isError: false, speech: reply });
  }

  for (let round = 0; !reply && round < MAX_ROUNDS; round++) {
    const res = await deps.converse({
      modelId: deps.modelId,
      system: cache
        ? [{ text: SKILL_BODY }, { cachePoint: { type: "default" } }, { text: sessionState(session) }]
        : [{ text: `${SKILL_BODY}\n\n${sessionState(session)}` }],
      messages,
      // Once a game exists the first round must call a tool: otherwise the model may "play" a move from memory,
      // or invent analysis of a finished game. ask_again covers garbled speech and small talk.
      toolConfig: {
        tools,
        toolChoice:
          round === 0 && session.gameId
            ? !session.gameOver && (forcedMove || looksLikeMove(...moveHeard)) ? { tool: { name: "make_move" } } : { any: {} }
            : { auto: {} },
      },
      // Precise when choosing tools, lively when phrasing the reply.
      inferenceConfig: { temperature: round === 0 ? 0 : 0.8, maxTokens: 500 },
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
        if (name === "make_move" && moveHeard.length) args.alternatives = moveHeard;
        if (name === "make_move" && forcedMove) { args.move = forcedMove; args.alternatives = []; } // exact SAN: nothing left to guess

        const missing = name === "new_game" ? missingGameChoices(session, userText) : [];
        if (missing.length) {
          // Models love silent defaults; make sure the user actually chose.
          isError = true;
          askChoices = choicesQuestion(missing);
          content = { speech: askChoices };
        } else if (!session.gameId && name !== "new_game" && name !== "game_history") {
          isError = true;
          content = { speech: "There is no game in progress yet. Ask the user if they want to start one, and with which colour and difficulty." };
        } else {
          let r = await deps.tools.callTool(name, args);
          // Second question about the same move: stop asking and play the likeliest reading (undo is one word away).
          const top = Array.isArray(r.data.candidates) ? String(r.data.candidates[0]) : "";
          if (name === "make_move" && !forcedMove && !r.isError && r.data.needsConfirmation === true && top && session.pending?.candidates.includes(top)) {
            r = await deps.tools.callTool(name, { ...args, move: top, alternatives: [] });
            guessed = true;
          }
          isError = r.isError;
          content = r.data;
        }
      }

      // Track the game this session is playing.
      if (name === "new_game" && !isError && typeof content.gameId === "string") {
        session = { ...session, gameId: content.gameId, humanColor: String(content.humanColor), level: Number(content.level), gameOver: false };
      } else if (name === "make_move" && !isError) {
        const asked = content.needsConfirmation === true && Array.isArray(content.candidates);
        session = {
          ...session,
          gameOver: content.gameOver === true,
          pending: asked ? { candidates: (content.candidates as unknown[]).map(String), asks: (session.pending?.asks ?? 0) + 1 } : undefined,
        };
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
      if ((name === "make_move" || name === "new_game") && !isError) {
        for (const k of ["yourMoveSpoken", "engineMoveSpoken"]) if (typeof content[k] === "string") spokenMoves.push(content[k] as string);
      }
      const forModel = factsForModel(name, content, isError, session.chattiness ?? DEFAULT_CHATTINESS, session.turns.length);
      if (name === "make_move" && !isError && content.needsConfirmation === true && typeof content.speech === "string") confirmSpeech = content.speech;
      results.push({
        toolResult: {
          toolUseId: toolUse.toolUseId!,
          content: [{ text: JSON.stringify(forModel) }],
          status: isError ? "error" : "success",
        },
      });
    }
    messages.push({ role: "user", content: results });

    // A blocked new_game once came back as "New game started, level 2" with no game behind it,
    // so the user's next move went to their previous game. Ask the missing choice word for word.
    if (askChoices) {
      reply = askChoices;
      break;
    }
    // A confirmation question is spoken exactly as the server wrote it: the model once added a predicted move.
    if (confirmSpeech) {
      reply = confirmSpeech;
      break;
    }

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

  // Conversation turns stay short for the ear; factual read-outs (board, legal moves, repeat) are left whole.
  if (!repeated && !askChoices && !confirmSpeech) {
    const done = new Set(toolCalls.filter((t) => !t.isError).map((t) => t.name));
    if (done.has("make_move") || done.has("new_game")) {
      reply = dropRepeatedSentences(reply, session.turns.filter((t) => t.role === "assistant").slice(-4).map((t) => t.text), spokenMoves);
      reply = limitSentences(reply, SENTENCE_LIMIT[session.chattiness ?? DEFAULT_CHATTINESS]);
    } else if (done.has("game_history") || done.has("ask_again")) reply = limitSentences(reply, 5);
  }

  if (guessed && spokenMoves[0] && !confirmSpeech) reply = `I took that as ${spokenMoves[0]}; say undo if that's wrong. ${reply}`;

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

function choicesQuestion(missing: string[]): string {
  const colour = missing.some((m) => m.startsWith("colour"));
  const level = missing.some((m) => m.startsWith("difficulty"));
  if (colour && level) return "Love to! Would you like white or black, and how tough should I be: easy, medium, hard, or full strength?";
  if (colour) return "Sure! Would you like to play white or black?";
  return "Great! And how tough should I be: easy, medium, hard, or full strength?";
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
  // Any question counts, wherever it is: the model often adds "You can choose easy, medium or hard.
  // If you're not sure, I can pick for you." after asking, and that still waits for an answer.
  // A reply that ends by handing the move back ("... Your move?") is just a turn, not a question.
  const sentences = reply.trim().split(/(?<=[.!?])\s+/);
  const routine = /^(so,? )?(and )?(what('s| is| will be)? )?(your|ur) (next )?move[?.!]$|^what would you like to (play|do)( next)?[?.!]$|^your turn[?.!]$/i;
  if (routine.test(sentences[sentences.length - 1])) return false;
  return sentences.some((s) => /\?["')]*$/.test(s));
}
