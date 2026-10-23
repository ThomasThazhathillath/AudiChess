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
import { VOICES, sonicVoice } from "./voice.js";
import { decodeMove } from "./guessMove.js";
import { type Banter, pickBanter } from "./banter.js";
import skill from "../skills/blind-chess/SKILL.md";

export type Converse = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

export interface AgentDeps {
  converse: Converse;
  tools: ChessTools;
  sessions: SessionStore;
  modelId: string;
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
  /**
   * false when the page heard this in conversation mode, without "Alexa": it may be background talk (TV, someone
   * else in the room), so anything that isn't clearly for Alexa is ignored silently. Default true.
   */
  woken?: boolean;
}

export interface TurnResult {
  /** True when the utterance was background talk: nothing is said and the page keeps listening. */
  ignored?: boolean;
  /** Where the time went, in milliseconds. */
  timings?: { modelMs: number; toolMs: number; totalMs: number; fastPath: boolean };
  reply: string;
  gameId?: string;
  gameOver: boolean;
  /** True when Alexa asked a question and expects an answer (the page keeps listening without the wake word). */
  expectsReply: boolean;
  toolCalls: ToolTrace[];
  /** The Nova 2 Sonic voice the page speaks with ("amy"). */
  voice: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; rounds: number };
}

// Three model rounds at most: in the eval it once looped through six tool calls (11.8 s) on one question.
const MAX_ROUNDS = 3;

// The agent fills these in itself, so the model never copies ids or long transcripts around. fen/setupMoves are
// for tests and puzzles, preview for confirm-before-playing: never the model's choice.
const HIDDEN_ARGS = ["gameId", "sessionId", "alternatives", "fen", "setupMoves", "preview"];
const LIST_RECENT_FLAG = "listRecentGames";

/** The skill body without its YAML frontmatter. */
const SKILL_BODY = skill.replace(/^---[\s\S]*?---\s*/, "");

// ---------- agent-local tools (preferences live in the session, not on the chess server) ----------

const LOCAL_TOOLS: Tool[] = [
  {
    toolSpec: {
      name: "set_preferences",
      description:
        "Change how Alexa talks: chattiness ('talk less' -> brief, 'just the moves' -> minimal, 'talk more' / 'normal' -> chatty) or voice accent. Her speaking speed can't be changed.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            chattiness: { type: "string", enum: ["minimal", "brief", "chatty"] },
            voice: { type: "string", enum: Object.keys(VOICES) },
            confirmMoves: { type: "boolean", description: "true: repeat each move back and play it only after a yes ('confirm each move before playing it')." },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: "answer",
      description:
        "Answer from general chess knowledge when no board fact is needed: rules (en passant, castling rules, stalemate, fifty-move rule), opening ideas in general, how to improve, what a fork is, and features this game doesn't have (there is no clock, no redo, no pause: the game simply waits). Never state anything about the current position here; use the board tools for that. Put the short spoken answer in `reply`.",
      inputSchema: {
        json: {
          type: "object",
          properties: { reply: { type: "string", description: "What Alexa says: one or two short spoken sentences." } },
          required: ["reply"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "ignore",
      description:
        "Stay silent: the words were clearly NOT meant for you (someone talking to another person, a phone call, TV, a stray word). Any question about chess, this game, the rules, time, or you is for you: answer it instead. When in doubt, answer.",
      inputSchema: { json: { type: "object", properties: {} } },
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

/** Board tools whose `speech` already is the precise answer: spoken as is, without a second model call. */
const DIRECT_SPEECH = new Set(["describe_square", "list_pieces", "legal_moves", "read_board", "hint", "consider_move", "undo", "resign", "set_level", "offer_draw"]);
/** Of those, the ones whose words also answer a yes/no question ("can you describe the board?" is a read-out request). */
const ANSWERS_YES_NO = new Set(["describe_square", "hint", "consider_move", "undo", "resign", "set_level", "offer_draw", "read_board", "list_pieces"]);
const YES_NO = /^\s*(?:is|are|am|was|were|does|do|did|has|have|should|could|can|would|will|may)\b/i;

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

// Brief by default: on 2026-10-16 the user said she "just keeps talking" and answers took too long.
export const DEFAULT_CHATTINESS: Chattiness = "brief";

const CHATTINESS_RULES: Record<Chattiness, string> = {
  minimal: "Chattiness: MINIMAL. Moves only; answers in one short sentence.",
  brief: "Chattiness: BRIEF (default). One or two short sentences. Answer exactly what was asked, most important fact first, and stop. No lists of options unless they asked for several.",
  chatty:
    "Chattiness: CHATTY. The two moves plus one short line of personality: a jab when they slip or you win material, a compliment when they play well. Three short sentences at most, never advice.",
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

/** How strong each level is, for "how strong are you / what's your rating" (Stockfish settings in engine.ts). */
export const LEVEL_NAMES: Record<number, string> = {
  1: "beginner, about 500 Elo", 2: "easy, about 800 Elo", 3: "casual, about 1100 Elo", 4: "medium, about 1500 Elo",
  5: "challenging, about 2000 Elo", 6: "hard, about 2500 Elo", 7: "expert, about 2800 Elo", 8: "full-strength Stockfish, far stronger than any human",
};

/** The per-session part of the system prompt (the skill itself is static, so it can be cached). */
function sessionState(session: Session): string {
  let state: string;
  if (!session.gameId) state = "There is no game in progress. If the user wants to play, find out their colour and difficulty (ask once if they didn't say), then call new_game.";
  else if (session.gameOver) state = `The last game is over (the user played ${session.humanColor}). For questions about it call game_history; offer a rematch if they want to keep playing.`;
  else state = `A game is in progress: the user plays ${session.humanColor} against you at level ${session.level} (${LEVEL_NAMES[session.level ?? 3] ?? "casual"}). The game is selected automatically for every tool.`;
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
  // No warnings, threats or better moves here: unasked coaching "takes the fun out of chess" (2026-10-17). What she
  // attacks stays her secret; the user hears it only by asking.
  const points: string[] = [];
  if (typeof result.gameOverText === "string") points.push(`the game is over: ${result.gameOverText}`);
  if (result.inCheck) points.push("the user is in check");
  const q = c.yourMove?.quality;
  if (q === "blunder" || q === "mistake") points.push(`the user's move was a ${q} (jab them for it; never say what was better)`);
  if (c.swing) points.push(`the game just swung ${c.swing.direction}`);
  if (c.opening) points.push(`new opening reached by ${c.opening.reachedBy}: ${c.opening.name}`);
  const captures = [...(c.yourMoveIdeas ?? []).filter((i) => i.startsWith("captures")).map((i) => `the user ${i}`), ...(c.myMoveIdeas ?? []).filter((i) => i.startsWith("captures")).map((i) => `my move ${i}`)];
  points.push(...captures);
  if (c.material) points.push(c.material);
  if (c.position) points.push(`assessment changed: ${c.position}`);
  if (q === "best" && (c.swing || c.position)) points.push("the user found the best move in a sharp spot");
  const castles = [...(c.yourMoveIdeas ?? []), ...(c.myMoveIdeas ?? [])].some((i) => i.startsWith("castles"));
  if (castles) points.push("someone castled");
  const ideas = (c.myMoveIdeas ?? []).filter((i) => !THREAT_IDEA.test(i) && !i.startsWith("captures") && !i.startsWith("castles"));
  if (ideas.length) points.push(`my move ${ideas[0]}`);
  if (points.length === 0) points.push(QUIET_THEMES[Math.abs(seed) % QUIET_THEMES.length]);
  return points.slice(0, max);
}

/** Move ideas that would warn the user ("attacks the knight on c3", "forks ..."): never volunteered. */
const THREAT_IDEA = /^(attacks|forks)\b/;

/** Different kinds of remark for quiet moves, rotated so one stock line can't take over. */
// No "quiet move:" label any more: the model said "Quiet move." out loud (converse eval, 2026-10-17).
export const QUIET_THEMES = [
  "nothing big happened: tease the user lightly about their move or style",
  "nothing big happened: a playful word about the game so far, giving nothing away about your plans",
  "nothing big happened: react to the pace or mood of the game",
  "nothing big happened: a short compliment or a playful challenge",
  "nothing big happened: comment on how the opening is developing",
  "nothing big happened: just the two moves, with a few words of reaction at most",
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
export function factsForModel(name: string, content: Record<string, unknown>, isError: boolean, chattiness: Chattiness, seed = 0, banter?: Banter): Record<string, unknown> {
  const { gameId: _g, fen: _f, ...rest } = content;
  if (isError || !FACT_TOOLS.has(name) || content.needsConfirmation) return rest;
  const { speech: _s, yourMove: _y, engineMove: _e, moveFacts: _m, ...facts } = rest;
  if (name === "new_game") {
    // Without this the model once "opened with pawn to d4" for a user playing White.
    const firstMove = typeof content.engineMoveSpoken === "string"
      ? `I (Alexa, playing ${content.humanColor === "White" ? "Black" : "White"}) opened with ${content.engineMoveSpoken}`
      : "none: the user plays White and moves first. Do not announce any move of yours.";
    return { ...facts, firstMove, instruction: "Announce the new game in your own words: their colour, the level name (as \"easy level\", never \"I'm easy\"), and the first move only if I made one." };
  }
  // A rival, not a coach (2026-10-17): no better move, no warnings about attacked pieces, no "you've been slipping",
  // and none of her own threats. The user asks for those when they want them.
  const commentary = { ...((facts.commentary as Record<string, unknown>) ?? {}) };
  const yourMove = commentary.yourMove as { quality?: string } | undefined;
  if (yourMove) commentary.yourMove = { quality: yourMove.quality };
  delete commentary.alerts;
  delete commentary.trend;
  if (Array.isArray(commentary.myMoveIdeas)) commentary.myMoveIdeas = (commentary.myMoveIdeas as string[]).filter((i) => !THREAT_IDEA.test(i));
  const react = banter
    ? { react: { mood: banter.mood, because: banter.event, examples: banter.examples, instruction: "Add one short line in this spirit, at most 10 words; an example may be used word for word. Never advice or warnings." } }
    : {};
  return { ...facts, commentary, sayAboutThisTurn: talkingPoints(content, chattiness === "chatty" ? 2 : 1, seed), ...react };
}

/** Spoken replies must stay short enough to follow by ear: keep the first `max` sentences. */
export function limitSentences(text: string, max: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.length <= max ? text : sentences.slice(0, max).join(" ");
}

// Like a person across the board, never a monologue (2026-10-17): the moves plus one line; answers in two sentences.
const SENTENCE_LIMIT: Record<Chattiness, number> = { minimal: 2, brief: 2, chatty: 3 };
/** Answers to questions; "explain everything" lifts the limit. */
const ANSWER_LIMIT: Record<Chattiness, number> = { minimal: 1, brief: 2, chatty: 2 };
/** Words per reply at most, whatever produced it (direct tool speech included), unless they asked for everything. */
export const WORD_LIMIT = { move: 30, answer: 35 };
const WANTS_DETAIL = /\b(everything|in detail|detailed|all (?:of )?(?:my|the|your)|every|whole|full|row by row|rank by rank|aloud|read (?:out|all|me)|list all|step by step)\b/i;

/**
 * Keeps whole sentences while they fit in `max` words. A first sentence that is longer by itself (a list) is cut at
 * its last comma inside the limit, so it still ends cleanly.
 */
export function capWords(text: string, max: number): string {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  if (words(text) <= max) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let n = 0;
  for (const s of sentences) {
    if (n + words(s) > max) break;
    kept.push(s);
    n += words(s);
  }
  if (kept.length) return kept.join(" ");
  const head = sentences[0].split(/\s+/).slice(0, max).join(" ");
  const comma = head.lastIndexOf(",");
  return `${(comma > 0 ? head.slice(0, comma) : head).replace(/[\s,;:]+$/, "")}.`;
}

/** "talk more" / "talk less" / "just the moves": unambiguous, so no model call (it once picked game_status). */
export function chattinessCommand(text: string): Chattiness | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(?:please )?(?:talk|chat) (?:a bit |a little |a lot )?more(?: please)?$|^be (?:more )?chatty$|^(?:can you |could you |please )?explain (?:every|each|all your|your) moves?(?: please)?\??$/.test(t)) return "chatty";
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
/**
 * A chess question refused as "cheating" or "a strategic advantage" (the qa eval, 2026-10-17: "Tell me which squares
 * are under attack" -> "Sorry, I can't… that's a strategic advantage I can't give away"). She is their opponent, but
 * the player is blind: answering is the game.
 */
export const REFUSAL = {
  test: (text: string) =>
    /\bI (?:can'?t|cannot|won'?t|am not allowed to|must not)\s+(?:give|tell|reveal|share|help|answer|describe|provide|advise|say)\b/i.test(text) ||
    (/\b(?:can'?t|cannot|won'?t|not allowed)\b/i.test(text) &&
      /\b(?:strategic|advantage|cheat\w*|coaching|spoil the fun|against the rules|unfair|give (?:that |it )?away)\b/i.test(text)),
};
/** Said with every routed analysis answer: the model kept treating help for its opponent as cheating. */
const EYES_NOTE = "You are the player's eyes as well as their opponent: they cannot see the board, so answer exactly what they asked from these facts. Telling them about attacked pieces, threats or plans is part of the game, never cheating.";

/**
 * "Which of my pieces are under attack?", "is anything hanging?", "alert me when a piece is undefended": answered
 * straight from analyze_position's facts, no model (it refused these as "a strategic advantage", 2026-10-17).
 */
export function attackedAnswer(content: Record<string, unknown>, alert = false): string {
  // "Alert me when…": there are no automatic alerts (unasked warnings are off), so say how to get them.
  const tail = alert ? " I won't call it out by myself, but ask me any time." : "";
  return attackedNow(content) + tail;
}

function attackedNow(content: Record<string, unknown>): string {
  const list = Array.isArray(content.yourPiecesUnderAttack) ? (content.yourPiecesUnderAttack as string[]) : [];
  if (!list.length) return "Nothing of yours is under attack right now.";
  // "queen on h5 (attacked by my pawn)" -> "Your queen on h5 is attacked by my pawn, and your bishop on c4 by my knight."
  const parts = list.slice(0, 3).map((p) => /^(\w+) on ([a-h][1-8]) \(attacked by my (\w+)\)$/.exec(p));
  if (parts.some((m) => !m)) return `Under attack: your ${list.slice(0, 3).join(", your ")}.`;
  const [first, ...rest] = parts as RegExpExecArray[];
  const more = rest.map((m) => `your ${m[1]} on ${m[2]} by my ${m[3]}`);
  return `Your ${first[1]} on ${first[2]} is attacked by my ${first[3]}${more.length ? `, and ${more.join(", and ")}` : ""}.`;
}
const REFUSAL_NUDGE = "That reply refused a fair question. The player cannot see the board and asking is how they play: answer it from the facts above in one or two short sentences.";
/** The model talking about the conversation instead of to the player: its reasoning, not an answer. */
export const REASONING_LEAK = /\b(?:the user (?:asked|asks|wants|is asking|said|is playing)|I called the|let'?s break this down|the tool'?s (?:response|output)|per the golden rules|called the \w+ (?:function|tool))\b/i;

/** Nova sometimes wraps its reasoning in <thinking> tags; that must never be spoken. */
export function cleanSpeech(text: string): string {
  const cleaned = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<\/?(response|answer)>/g, "")
    .replace(/[*_#`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // "... Your move." on every turn is the most robotic thing she says; the ring already shows it's their turn.
  // A talking-point label said out loud ("Quiet move.", "Nothing big happened.") goes too.
  let trimmed = cleaned
    .replace(HAND_OVER, "")
    .replace(/(?:^|(?<=[.!?]\s))(?:(?:a|another|just a) )?(?:quiet move|nothing big happened)[.!]?(?=\s|$)/gi, "")
    .replace(/[\s,;:-]+$/, "")
    .trim();
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

/** The letter or number a SAN names its piece's starting square by: "b" in Nbd2, "1" in R1e2, "e" in exd5. */
const disambiguator = (san: string) => /^(?:[NBRQK]([a-h]|[1-8])x?|([a-h])x)[a-h][1-8]/.exec(san)?.slice(1).find(Boolean);

/**
 * What the user said to the question "Did you mean X, or Y?" / "Which rook?" / "Castle which way?": yes, no,
 * first/second, kingside/queenside, left/right, or the file/rank/square that tells the candidates apart.
 * Anything else is a fresh utterance (undefined), including "no, knight f3": a new move, not a refusal.
 * @param humanColor "b" when the player sits on Black's side, so "left" is the h-file side.
 */
export function answerToPending(text: string, candidates: string[], humanColor?: string): { pick: string } | { no: true } | undefined {
  const t = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || candidates.length === 0) return undefined;
  const no = /^(?:no|nope|nah|neither|none|wrong|cancel|never ?mind)\b ?(.*)$/.exec(t);
  if (no) {
    const rest = no[1].trim();
    if (candidates.length > 1 && /^(?:i meant )?(?:the )?(?:other|second|2nd|last)(?: one)?$/.test(rest)) return { pick: candidates[1] };
    if (rest && looksLikeMove(rest)) return undefined;
    return { no: true };
  }
  if (/^(?:(?:yes|yeah|yep|yup|yah|ya|sure|ok|okay|correct|right|exactly|that one|that's it|thats it|do it|go ahead|please)(?: |$))+$/.test(t)) return { pick: candidates[0] };
  if (candidates.length > 1) {
    if (candidates.includes("O-O") && candidates.includes("O-O-O")) {
      if (/\b(?:king ?side|kings side|short|king)\b/.test(t)) return { pick: "O-O" };
      if (/\b(?:queen ?side|queens side|long|queen)\b/.test(t)) return { pick: "O-O-O" };
    }
    if (/^(?:the )?(?:first|1st|one|former)(?: one)?$/.test(t)) return { pick: candidates[0] };
    if (/^(?:the )?(?:second|2nd|two|other|latter|last)(?: one)?$/.test(t)) return { pick: candidates[1] };
    // "the left one" / "the one on the right", as the player sees the board.
    const files = candidates.map(disambiguator);
    const side = /\b(left|right)\b/.exec(t)?.[1];
    if (side && files.every((f) => f && /[a-h]/.test(f)) && new Set(files).size === candidates.length) {
      const order = [...candidates].sort((a, b) => disambiguator(a)!.localeCompare(disambiguator(b)!));
      const towardA = (side === "left") === (humanColor !== "b");
      return { pick: towardA ? order[0] : order[order.length - 1] };
    }
    // "the one on b1" / "c file" / "from e": the letter or number the SAN disambiguates by ("the one" isn't rank 1).
    const words = new Set(t.replace(/\b(?:the|that) one\b/g, " ").split(" ").filter(Boolean).flatMap((w) => (/^[a-h][1-8]$/.test(w) ? [w[0], w[1]] : [w])));
    const hits = candidates.filter((san) => {
      const d = disambiguator(san);
      if (!d) return false;
      return (FILE_SPOKEN[d] ?? RANK_SPOKEN[d] ?? []).some((w) => words.has(w));
    });
    if (hits.length === 1 && words.size <= 5) return { pick: hits[0] };
  }
  return undefined;
}

const QUESTION_WORDS = /\b(what|which|why|how|where|who|whom|when|can you|could you|can i|could i|should i|may i|am i|is it|is this|is that|is my|are my|if i|would|tell me|explain|did you|do you|are you|is there|repeat|undo|resign|hint)\b/i;
const SQUARE_ISH = /\b[a-h]\s?[1-8]\b|\b[a-h]\s(?:one|two|three|four|five|six|seven|eight|for|tree|free)\b|\b(?:castle|castles|castling|takes|take)\b|^\W*2[1-8]\W*$|\b(?:twenty|swansea)\s(?:[1-8]|one|two|three|four|five|six|seven|eight)\b/i;

/** A question by its first word: "Is square f7 occupied?", "Does my knight…", "Should I castle?" (never a move). */
const QUESTION_START = /^\s*(is|are|am|was|were|does|do|did|has|have|had|should|shall|could|can|would|will|may|might|must|why|what|which|where|who|how|when|tell|explain|describe|read|show|list|give|repeat)\b/i;

/** Speech that is clearly a move attempt: it must go to make_move, never to small talk (ask_again). */
export function looksLikeMove(...heard: string[]): boolean {
  const first = heard[0] ?? "";
  if (QUESTION_WORDS.test(first) || QUESTION_START.test(first) || /\?\s*$/.test(first)) return false;
  // Each alternative on its own: "24" (pawn d4) is only move-shaped as a whole utterance. Accents also give a piece
  // name plus a mangled square ("night S3", "night ef three", "92 S3").
  return heard.some((h) => !!h && (SQUARE_ISH.test(h) || PIECE_THEN_RANK.test(h) || PIECE_TAKES_PIECE.test(h) || /^\W*9[1-8]\s+[a-z]{1,2}\s?[1-8]\W*$/i.test(h)));
}
// A bare rank counts too: "Queen 8" was an alternative of a dropped "Vineet" (2026-10-17 log), "Pawan Singh 7" of "kaun si".
// A piece word may run into the next sound ("pornh sex" = pawn h6, dropped in silence on 2026-10-17).
// Chrome's "pawn" in the 2026-10-17 game: pwn, pont, phone, font ("phone h8", "Sore pwn to E3", "font text phone").
const PIECE_THEN_RANK = /\b(?:knight|night|nite|pawn|porn|pond|pont|pwn|pawan|phone|font|bishop|rook|rock|ruk|queen|king|horse)\w*.*(?:\b[a-z]{1,2}\s?[1-8]|\b[1-8]\b|\b(?:one|two|three|four|five|six|seven|eight|sex|tree|free)\b)/i;
/** "Knight takes pawn" with no square, as Chrome writes it ("night text phone", "font text phone"): a capture by name. */
const PIECE_TAKES_PIECE = /\b(?:knight|night|nite|pawn|porn|pond|pont|pwn|pawan|font|bishop|rook|rock|ruk|queen|king|horse)\w*\s+(?:takes|take|text|texts|tax|tex|x|captures)\s+(?:the |my |your )?(?:knight|night|pawn|porn|pond|pwn|phone|font|bishop|rook|rock|queen|king)\w*\b/i;
/** Something chess-shaped somewhere in an alternative: a piece or its sound-alike, a digit ("Nokia 5", "K5", "1087") or "six". */
const MOVE_HINT = /\b(?:knight|night|nite|pawn|porn|pond|pont|pwn|pawan|bishop|rook|rock|ruk|queen|king|horse|castle)\w*|[1-8]|\b(?:sex|six|sikh)\b/i;

/** Strips a leading wake word so "Alexa, knight f3" reaches the model as "knight f3". */
export function stripWakeWord(text: string): string {
  return text.replace(/^\s*(hey\s+)?(alexa|alexia|alexis|a lexa)[\s,.!:]*/i, "").trim();
}

// ---------- conversation mode: is this for Alexa at all? ----------

const CHESS_WORDS =
  /\b(alexa|chess|game|games|move|moves|moved|play|played|playing|pawn|pawns|knight|knights|bishop|bishops|rook|rooks|queen|queens|king|kings|castle|castling|check|checkmate|mate|stalemate|draw|resign|undo|take ?back|hint|suggest|suggestion|recommend|best|worst|board|square|squares|piece|pieces|position|opening|endgame|middlegame|threat|threatening|attack|attacking|attacked|defend|capture|captured|takes|fork|pin|pinned|skewer|sacrifice|trade|exchange|promote|promotion|passant|rating|elo|strong|strength|level|easy|medium|hard|harder|easier|beginner|expert|grandmaster|white|black|winning|losing|win|lose|ahead|material|blunder|mistake|mess(?:ed)? up|evaluation|engine|clock|time|timer|seconds|minutes|running low|repetition|threefold|fifty|opposition|scenario|repeat|slower|faster|louder|talk|quiet|explain|rules?|legal|illegal|rematch|restart|pause|resume|save|analy[sz]e|review|teach|learn|practice|improve|puzzle|quiz|tactic|tactics|safe|trouble|missing|trap|center|centre|gambit|defen[cs]e|variation|scholar|opponent)\b/i;
const FOR_ALEXA = /^(what|where|which|why|how|who|when|is|are|am|can|could|should|would|will|do|does|did|was|were|give|tell|show|read|describe|repeat|say|explain|let'?s|let me|i want|i'd like|please|help)\b/i;
const SHORT_ANSWER = /^(yes|yeah|yep|yup|no|nope|nah|sure|okay|ok|correct|right|exactly|haan|han|nahi|first|second|the first|the second|that one|do it|go ahead|cancel|never ?mind|white|black|random|easy|medium|hard|whatever|you (?:pick|choose|decide)|kingside|queenside|king side|queen side|short|long|left|right|the left|the right)\b/i;
/** One-word requests that are clearly for her in an open-mic conversation ("hint", "undo"). */
const COMMAND_WORD = /^(hint|undo|take ?back|repeat|again|help|resign|board|status|rematch|louder|slower|faster|pardon|what)\W*$/i;
/** Greetings and thanks: a person talking to her, so she answers like one. */
const SOCIAL = /^(hi|hello|hey there|hiya|good (?:morning|afternoon|evening|night)|thanks|thank you|thank you so much|cheers|good game|gg|well played|nice (?:move|one|try|game)|good move|great move|wow|oh no|oops|how are you|how's it going|what's up|bye|goodbye)\b/i;

/**
 * Speech heard without "Alexa" (the open mic: no wake word needed) is acted on only when it is plausibly for her: a
 * move, chess words, a question or request to her, a greeting, or an answer to the question she just asked.
 * Everything else ("Correct.", "Gala appeared in a coral", "I.", someone on the phone) is dropped without a model call.
 */
export function addressedToAlexa(heard: string[], session: Session): boolean {
  return addressedLevel(heard, session) !== "no";
}

/**
 * "yes": clearly for Alexa (a move, chess words, an answer to her question): handled as if she was woken.
 * "maybe": a generic question with no chess words ("what is he doing"): the model decides, with `ignore` available.
 * "no": background, dropped without a model call.
 */
export function addressedLevel(heard: string[], session: Session): "yes" | "maybe" | "no" {
  // "Uh, why did you choose that?": fillers first, then decide (live test, 2026-10-16).
  const text = (heard[0] ?? "").trim().replace(/^(?:(?:uh+|um+|hmm+|ok(?:ay)?|so|and|well|hey|acha|achha|haan|arey?)[\s,.!]+)+/i, "");
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "no";
  if (looksLikeMove(...heard)) return "yes";
  const lastReply = [...session.turns].reverse().find((t) => t.role === "assistant")?.text ?? "";
  const waitingForAnswer = !!session.pending || asksQuestion(lastReply);
  if (waitingForAnswer && SHORT_ANSWER.test(text) && words.length <= 6) return "yes";
  if (COMMAND_WORD.test(text) || SOCIAL.test(text)) return "yes";
  // Mid-game, a short phrase with a number or a piece in ANY reading is a move she misheard ("14", "is he is 5", and
  // from 2026-10-17: "ok fine" / "Nokia 5", "K5", "1087", "sorry" / "sorry ruk"): answer it, never drop it. 8 of the
  // 9 silent drops that day were repeated by the user seconds later.
  if (session.gameId && !session.gameOver && words.length <= 5 && heard.some((h) => MOVE_HINT.test(h))) return "yes";
  if (heard.some((h) => CHESS_WORDS.test(h))) return words.length >= 2 || waitingForAnswer ? "yes" : "no";
  return FOR_ALEXA.test(text) && words.length >= 3 ? "maybe" : "no";
}

/**
 * A move heard only faintly: a short phrase whose best reading has no chess in it, but another reading or a stray
 * number does ("ok fine" | "Nokia 5", "K5", "1087", "sorry" | "sorry ruk"). She asks for it again in a few words,
 * with no model call: the model once "played" queen to e2 from "Nokia 5" (2026-10-17 browser test).
 */
export function isFaintMove(heard: string[], session: Session): boolean {
  const text = (heard[0] ?? "").trim();
  if (!session.gameId || session.gameOver || session.pending || !text) return false;
  if (looksLikeMove(...heard) || QUESTION_WORDS.test(text) || QUESTION_START.test(text) || /\?\s*$/.test(text)) return false;
  if (COMMAND_WORD.test(text) || SOCIAL.test(text) || CHESS_WORDS.test(text)) return false;
  return text.split(/\s+/).length <= 5 && heard.some((h) => MOVE_HINT.test(h));
}
const FAINT_REASK = ["Sorry, I didn't catch your move. Say it again?", "Say that move once more?"];

// ---------- question router: the common questions skip the model's tool choice ----------

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, "2": 2, "3": 3, several: 3, top: 3, few: 3, some: 3 };
/** "A small hint", "without revealing", "don't tell me the move": the only ways to ask for a hidden hint. */
const DONT_REVEAL = /\b(small|little|tiny|subtle|vague|gentle)\b.*\bhint\b|without (?:revealing|giving|telling)|don'?t (?:tell|reveal|give away|say)|not the (?:answer|move)|puzzle|quiz/i;

/**
 * The tool (and arguments) for questions whose tool is unambiguous, so no model call is needed to pick it.
 * hint and consider_move answers are then spoken as is (no model at all); analysis answers get one phrasing call.
 * Anything not matched here goes to the model as usual.
 */
export function routeQuestion(text: string): { name: string; args: Record<string, unknown>; phrase?: boolean; note?: string; hide?: string[]; answer?: "attacked" } | undefined {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  // Commands with one meaning: no model call (a bare "undo" took 1.3 s through the model on 2026-10-17).
  if (/^(?:please )?(?:undo|take (?:it |that )?back|take back (?:my |that |the )?(?:last )?move|undo (?:that|my (?:last )?move|the last move))(?: please)?[.!]*$/.test(t)) return { name: "undo", args: {} };
  // The opponent's next move, plan or best moves is my threat (analysis), never the user's hint: "What would my
  // opponent play next?" got "The best move here … would be pawn to d3", the user's own move (qa eval, 2026-10-17).
  const asks = QUESTION_START.test(t) || /\?\s*$/.test(t); // not "announce every move my opponent makes"
  // Their own pieces under attack, in general (not one named piece, not mine): straight from the facts.
  if (!/\b(?:my opponent|opponent'?s|your (?:pieces|queen|king|rook|bishop|knight))\b/.test(t) && !/\bmy (?:queen|king|rook|bishop|knight|pawn)\b/.test(t) &&
    /\b(?:which|what|any|anything|squares?|pieces?)\b.*\b(?:under attack|attacked|hanging|undefended|en prise|threatened)\b|\balert me\b.*\b(?:undefended|hanging|attack\w*)\b/.test(t)) {
    return { name: "analyze_position", args: {}, answer: "attacked" };
  }
  if (asks && /\b(?:my opponent|the opponent|opponent'?s|they|their)\b/.test(t) && /\b(?:play|move|moves|candidate|respond|reply)\b/.test(t) && !/\b[a-h]\s?[1-8]\b|castl/.test(t)) {
    // "Their best candidate moves" was still answered with the user's bestMoves: say whose moves are meant.
    // The note alone didn't stop "Your best candidate moves are…": the user's own best moves are left out.
    return { name: "analyze_position", args: {}, note: "This question is about YOUR (Alexa's) moves as the user's opponent: answer from `threat`.", hide: ["bestMoves"] };
  }
  // The board: the short read-out unless they ask row by row (the model picked "ranks" once: 153 words).
  if (/\b(?:read|tell me|describe|say) (?:me )?(?:out )?(?:the )?(?:current |whole |full |entire )?board\b|\bwhere are (?:all )?(?:the )?pieces\b|\bwhat(?:'s| is) on the board\b/.test(t)) {
    return { name: "read_board", args: { format: /\b(?:row|rank)s?\b/.test(t) ? "ranks" : "pieces" } };
  }
  // A puzzle from this position: the best move, kept hidden, framed by the model as a puzzle.
  if (/\b(puzzle|quiz me)\b/.test(t)) return { name: "hint", args: { count: 1, reveal: false }, phrase: true };
  // "The safest / most aggressive / easiest move": the top three, and the model picks the one that fits.
  if (/\b(safest|most aggressive|aggressive move|easiest|simplest|grandmaster (?:play|move)|solid move|quiet move)\b/.test(t)) {
    return { name: "hint", args: { count: 3, reveal: true }, phrase: true };
  }
  // "What move should I avoid?" got the best move (qa eval): it asks for the risk, never a move to play.
  if (asks && /\b(avoid|worst move|shouldn'?t (?:play|do|move)|not (?:to )?play|bad move)\b/.test(t)) {
    return { name: "analyze_position", args: {}, note: "They ask what to AVOID: name the risk from the facts in one sentence (a piece of theirs left hanging, my threat). Never suggest a move to play.", hide: ["bestMoves"] };
  }
  if (!/\b(avoid|worst|shouldn'?t|not play|bad move)\b/.test(t) && /\b(hint|suggest|suggestion|recommend|what should i (?:play|do|move)|what(?:'s| is) (?:my |the )?best (?:move|option|play)|(?:my |the )?(?:best|top) (?:\w+ )?moves|what would you play|what would a grandmaster play|what move should i)\b/.test(t)) {
    const count = /\b(two|three|2|3|several|top|few|some)\b.*\bmoves\b|\bmoves\b.*\b(two|three|2|3)\b/.exec(t);
    const n = count ? NUMBER_WORDS[count[1] ?? count[2]] ?? 3 : 1;
    const reveal = !DONT_REVEAL.test(t);
    // "The best move for my knight": that piece's moves only ("pawn to d3" was the answer to it in the qa eval).
    const piece = /\b(?:for|with) (?:my |the |your )?(knight|bishop|rook|queen|king|pawn)s?\b|\bmy (knight|bishop|rook|queen|king|pawn)'?s? best move\b/.exec(t);
    return { name: "hint", args: { count: reveal ? n : 1, reveal, ...(piece ? { piece: piece[1] ?? piece[2] } : {}) } };
  }
  // "Can I castle?", "can I move my king to e2?", "what happens if I take on d5?", "is knight g5 safe?": a concrete
  // move (a square or castling) checked without playing it.
  // Rules in general ("can I castle while in check?", "through an attacked square?") are not about this position.
  const aboutRules = /\b(while|ever|through|in general|normally|rule|rules|allowed to|after (?:moving|my king)|if my king has)\b/.test(t);
  if (!aboutRules && /\b(can i|could i|may i|am i allowed|why can'?t i|is it legal|what happens if i|what if i|should i|is it safe to|would it be safe to|if i (?:play|move|take|capture))\b/.test(t) && /\b(castle|castling|[a-h]\s?[1-8])\b/.test(t)) {
    return { name: "consider_move", args: { move: text } };
  }
  if (/\b(would have happened|should have played|had played|could have played|did i (?:mess|blunder|make a mistake)|(?:was|is) (?:my|that) (?:last )?move (?:good|bad|ok|okay|a mistake|a blunder|the best)|biggest (?:blunder|mistake)|first mistake|where did i go wrong|best move i missed|why did you (?:play|move|do)|explain your (?:last )?move|analy[sz]e (?:the|my|this) game|how have i been (?:doing|playing)|mistake, an inaccuracy or a blunder)\b/.test(t)) {
    return { name: "review_game", args: {} };
  }
  // The move list: "first move of the game", "the moves so far", "the notation".
  if (/\b(first move of the game|move sequence|moves so far|all the moves|read the moves|game notation|the notation|pgn|three moves ago|two moves ago|moves ago|whole game)\b/.test(t)) {
    return { name: "game_history", args: {}, phrase: true };
  }
  if (!aboutRules && /\b(lost|captured|been taken|taken so far|trapped|stuck|can'?t move|misplaced|worst piece|least active|most active|inactive|exchange|trade|stalemate|promote my pawn|pawn promote|promote safely|in check|checkmate|mate in|threat|threaten|threatening|under attack|attacking|attacked|hanging|undefended|pinned|a pin|fork|skewer|tactic|winning|losing|who(?:'s| is) better|better position|evaluation|eval|material|ahead|behind|trouble|missing|weakness|weak|passed pawn|isolated|doubled|open file|centre|center|developed|development|king safety|endgame|what opening|which opening|name of (?:this|the) opening|planning|plan|trap|is my king safe|am i doing(?: okay| ok| well)?|can i win)\b/.test(t)) {
    return { name: "analyze_position", args: {} };
  }
  if (/\b(last move|last two moves|last (?:three|five|few) moves|which piece moved|what did (?:you|i) just play|what was (?:your|my) last move)\b/.test(t)) {
    const n = /\b(three|five|few)\b/.exec(t)?.[1];
    return { name: "last_moves", args: { count: n === "three" ? 6 : n === "five" || n === "few" ? 10 : 2 } };
  }
  return undefined;
}

/** "What should I have played?", "what was the right move?", "what was better?" (after an undo: the hint). */
const SHOULD_HAVE = /\b(should (?:i )?have played|should i have (?:played|done|moved)|what (?:was|would have been) (?:the )?(?:right|best|better|correct) (?:move|play)|what was better|better move|what would the engine (?:play|have played))\b/i;

/** Resigning only on a clear statement, never on a question ("can I resign?"). */
const RESIGN_WORDS = /^(?:ok(?:ay)?,? )?(?:yes,? )?(?:i (?:resign|give up|quit|surrender|concede)|resign|i want to resign|i'?d like to resign|let me resign|i'?ll resign)\b(?!.*\?)/i;

/**
 * Accent-proof fallback for a move the spoken-move matcher couldn't place: the model gets only the legal moves and
 * what speech recognition heard, and names the legal move that sounds closest, or none. `among` narrows it to the
 * matcher's candidates. The caller plays it and says so ("Taking 'night S3' as knight to f3; say undo if not").
 */
export async function guessLegalMove(
  deps: AgentDeps,
  gameId: string,
  heard: string[],
  reason: string | undefined,
  timings: { modelMs: number; toolMs: number },
  usage: TurnResult["usage"],
  among?: string[],
): Promise<{ san: string } | undefined> {
  let t = Date.now();
  let legal = among ?? [];
  if (!among) {
    const lm = await deps.tools.callTool("legal_moves", { gameId });
    timings.toolMs += Date.now() - t;
    legal = Array.isArray(lm.data.moves) ? (lm.data.moves as unknown[]).map(String) : [];
  }
  if (legal.length === 0) return undefined;
  t = Date.now();
  const { san, usage: used } = await decodeMove(deps.converse, deps.modelId, heard, legal, reason);
  timings.modelMs += Date.now() - t;
  usage.rounds++;
  addUsage(usage, used);
  return san ? { san } : undefined; // played straight away by the caller, which announces it in words
}

/** A restart mid-game needs the words for it: a stray "correct" once started a new game over a game in progress. */
const RESTART_WORDS = /\b(new game|start (?:over|again|afresh)|restart|rematch|play again|another game|fresh game|reset|from the (?:start|beginning)|start a new)\b/i;

/**
 * The answer to her "White or black? And easy, medium or hard?" right after the user asked for a new game: "white
 * easy" has no restart words of its own, but it is that restart (dropped as background talk, 2026-10-23 live game).
 */
function answersRestart(session: Session): boolean {
  const [user, assistant] = [...session.turns].slice(-2);
  return user?.role === "user" && RESTART_WORDS.test(user.text) && assistant?.role === "assistant" && asksQuestion(assistant.text);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Whether a reply says her move: its square (counted twice when the user's move went to the same square, as in a
 * recapture) or "castle". True when she didn't move (game over after the user's move).
 */
export function saysMove(reply: string, result: Record<string, unknown>): boolean {
  const mine = typeof result.engineMoveSpoken === "string" ? result.engineMoveSpoken : "";
  if (!mine) return true;
  if (/castles/.test(mine)) return /\bcastl/i.test(reply);
  const square = (s: string) => s.match(/[a-h][1-8]/g)?.at(-1);
  const sq = square(mine);
  if (!sq) return true;
  const times = reply.toLowerCase().split(sq).length - 1;
  return times >= (square(String(result.yourMoveSpoken ?? "")) === sq ? 2 : 1);
}

/**
 * A move turn without a model call: the two moves, plus one line when something happened: the game's end, a jab or
 * a compliment (banter.ts), or else a new opening. Never a warning or a better move (2026-10-17: 13 of 81 replies
 * were "Careful, your … is under attack"). Used for brief/minimal chattiness; chatty mode lets the model phrase it.
 */
export function quickMoveReply(result: Record<string, unknown>, chattiness: Chattiness, seed = 0, banter?: string): string {
  const yours = String(result.yourMoveSpoken ?? "");
  const mine = typeof result.engineMoveSpoken === "string" ? result.engineMoveSpoken : "";
  const forms = mine
    ? [`${capitalize(yours)}. I play ${mine}.`, `${capitalize(yours)}; I answer ${mine}.`, `You play ${yours}, I play ${mine}.`, `${capitalize(yours)}. My move: ${mine}.`]
    : [`${capitalize(yours)}.`];
  const reply = forms[Math.abs(seed) % forms.length];
  const c = (result.commentary ?? {}) as { opening?: { name: string } };
  const line = chattiness === "minimal" ? "" : banter ? ` ${banter}` : "";
  if (typeof result.gameOverText === "string" && result.gameOverText) {
    // "…promotes to queen, checkmate. Checkmate. I win this time." said it twice.
    const over = /checkmate\.$/.test(reply) ? result.gameOverText.replace(/^Checkmate\.\s*/, "") : result.gameOverText;
    return `${reply} ${over}${line}`;
  }
  if (chattiness === "minimal") return reply;
  if (line) return `${reply}${line}`;
  if (c.opening?.name) return `${reply} This is the ${c.opening.name}.`;
  return reply;
}

function handleLocalTool(name: string, args: Record<string, unknown>, session: Session): { session: Session; data: Record<string, unknown> } {
  if (name === "ignore") return { session, data: { speech: "", ignored: true } };
  if (name === "answer") {
    const reply = typeof args.reply === "string" ? cleanSpeech(args.reply) : "";
    return { session, data: { speech: reply && !MADE_UP_MOVE.test(reply) ? reply : "Sorry, I'm not sure about that one." } };
  }
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
  if (typeof args.confirmMoves === "boolean") {
    next.confirmMoves = args.confirmMoves;
    changes.push(args.confirmMoves ? "I'll repeat each move and wait for your yes" : "I'll play your moves straight away");
  }
  return { session: next, data: { speech: changes.length ? `Okay, ${changes.join(", and ")}.` : "Okay." } };
}

export async function runTurn(deps: AgentDeps, sessionId: string, input: TurnInput | string): Promise<TurnResult> {
  const started = Date.now();
  const timings = { modelMs: 0, toolMs: 0, totalMs: 0, fastPath: false };
  const { text: rawIn, alternatives = [], chessHeard: rawChess, woken = true } = typeof input === "string" ? ({ text: input } as TurnInput) : input;
  const rawText = typeof rawIn === "string" ? rawIn : ""; // a request without text once crashed stripWakeWord
  const userText = stripWakeWord(rawText) || rawText.trim();
  const heard = [...new Set([userText, ...alternatives.map(stripWakeWord)].filter(Boolean))].slice(0, 5);
  // The chess-grammar reading ("pawn d four") is the most reliable for moves, so it leads what make_move gets.
  const chessHeard = rawChess ? stripWakeWord(rawChess) : "";
  const moveHeard = chessHeard ? [...new Set([chessHeard, ...heard])].slice(0, 5) : heard;

  let session = (await deps.sessions.get(sessionId)) ?? newSession(sessionId);
  const toolCalls: ToolTrace[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, rounds: 0 };
  const silent = (): TurnResult => ({
    ignored: true,
    reply: "",
    gameId: session.gameId,
    gameOver: session.gameOver === true,
    expectsReply: false,
    toolCalls,
    voice: sonicVoice(session.voice),
    usage,
    timings: { ...timings, totalMs: Date.now() - started },
  });

  // Conversation mode (no "Alexa"): background talk never reaches the model or the board. Speech that is clearly
  // for Alexa (a move, chess words, an answer to her question) is handled as if she had been called by name.
  const level = woken ? "yes" : addressedLevel(moveHeard, session);
  if (level === "no") return silent();
  const unsure = level === "maybe";

  const cache = deps.promptCache !== false;
  const allTools = toBedrockTools(await deps.tools.listTools());
  // "ignore" is offered only when it may be background talk; otherwise garbled words are re-asked (ask_again).
  // The model over-used ignore for real questions ("am I in check") when it was always offered.
  const tools = allTools.filter((t) => (unsure ? t.toolSpec?.name !== "ask_again" : t.toolSpec?.name !== "ignore"));

  // Recognition alternatives help the model read garbled words; they are not kept in history.
  const altHint =
    (heard.length > 1 ? `\n(speech recognition alternatives: ${heard.slice(1).map((h) => `"${h}"`).join(", ")})` : "") +
    (chessHeard ? `\n(chess hearing: "${chessHeard}")` : "") +
    (unsure ? "\n(heard without the wake word: call ignore only if this was clearly said to someone else; questions about chess, the game, time or you are for you)" : "");

  // "yes" / "the second one" / "c file" after a "Did you mean…?" or "Which rook?" is answered here, not by the model.
  // The best transcript decides: a lower alternative ("no", an older partial) must not turn "no, knight f3" into a refusal.
  const answerTo = (h: string) => answerToPending(h, session.pending!.candidates, session.humanColor);
  const pendingAnswer =
    session.pending && session.gameId && !session.gameOver
      ? answerTo(heard[0] ?? "") ?? (looksLikeMove(heard[0] ?? "") ? undefined : heard.slice(1).map(answerTo).find(Boolean))
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
  } else if (!woken && isFaintMove(moveHeard, session)) {
    reply = FAINT_REASK[session.turns.length % FAINT_REASK.length];
  }
  let repeated = false;
  let ignored = false;
  let templated = false; // a deterministic move reply: already short, never trimmed
  let direct = false; // a tool's own words spoken as the answer: never trimmed (board read-outs are long)
  const spokenMoves: string[] = []; // this turn's announced moves, protected from dropRepeatedSentences
  let confirmSpeech = ""; // set when make_move needs confirmation: spoken verbatim
  let lastMove: Record<string, unknown> | undefined; // this turn's played move (make_move result), for the move guard
  let lastRemark: string | undefined; // this turn's jab or compliment
  let chattyMoves = ""; // chatty move turn: the announced moves; the model's line is the reaction after them
  let askChoices = ""; // set when new_game was blocked: we ask ourselves, so the model can't claim a game started

  // "Let's play chess" without colour and level: ask the short fixed question ourselves, no model call.
  if (!reply && (!session.gameId || session.gameOver) && /\b(play|game|chess|start)\b/i.test(userText) && missingGameChoices(session, userText).length === 2) {
    reply = choicesQuestion(["colour", "difficulty"]);
    askChoices = reply;
  }

  const command = chattinessCommand(userText);
  if (command) {
    const r = handleLocalTool("set_preferences", { chattiness: command }, session);
    session = r.session;
    reply = String(r.data.speech);
    toolCalls.push({ name: "set_preferences", args: { chattiness: command }, isError: false, speech: reply });
  }

  /** Runs one tool (chess server or agent-local), keeps the session in step, and records the trace. */
  async function runTool(name: string, rawArgs: Record<string, unknown>): Promise<{ content: Record<string, unknown>; isError: boolean }> {
    const args = { ...rawArgs };
    const listRecent = args[LIST_RECENT_FLAG] === true;
    delete args[LIST_RECENT_FLAG];
    for (const key of HIDDEN_ARGS) delete args[key];
    // The model hid the move for "what is the safest move?": only the user's own words may ask for a hidden hint.
    if (name === "hint" && args.reveal === false && !DONT_REVEAL.test(userText)) args.reveal = true;
    // Rank by rank is three times longer: only when they said "row" or "rank".
    if (name === "read_board" && !/\b(?:row|rank)s?\b/i.test(userText)) args.format = "pieces";

    let content: Record<string, unknown>;
    let isError = false;
    if (LOCAL_TOOLS.some((t) => t.toolSpec?.name === name)) {
      const r = handleLocalTool(name, args, session);
      session = r.session;
      content = r.data;
      if (name === "repeat_last") repeated = true;
      if (name === "ignore") ignored = true;
    } else {
      if (name === "new_game") args.sessionId = sessionId;
      else if (session.gameId && !(name === "game_history" && listRecent)) args.gameId = session.gameId;
      if (name === "make_move" && moveHeard.length) args.alternatives = moveHeard;
      if (name === "make_move" && forcedMove) { args.move = forcedMove; args.alternatives = []; } // exact SAN: nothing left to guess
      else if (name === "make_move" && session.confirmMoves) args.preview = true;

      const missing = name === "new_game" ? missingGameChoices(session, userText) : [];
      const restartMidGame = name === "new_game" && !!session.gameId && !session.gameOver && !RESTART_WORDS.test(heard.join(" ")) && !answersRestart(session);
      // Game-ending and history-changing tools need the words for it: in the eval "Can I resign?" resigned the game
      // and "Can you redo the move?" took a move back.
      const unsureResign = name === "resign" && !RESIGN_WORDS.test(userText);
      const wrongUndo = name === "undo" && /\bredo\b/i.test(userText);
      if (unsureResign) {
        isError = true;
        askChoices = "Do you want to resign this game? Say \"I resign\" to confirm.";
        content = { speech: askChoices };
      } else if (wrongUndo) {
        isError = true;
        content = { speech: "There's no redo here. Tell the user they can simply play the move again, or say undo to take a move back." };
      } else if (restartMidGame) {
        isError = true;
        content = { speech: "A game is in progress. Only start a new game if the user clearly asks for a new game or a restart; otherwise answer what they actually said." };
        if (!woken) ignored = true; // overheard words must never wipe out a game
      } else if (missing.length) {
        // Models love silent defaults; make sure the user actually chose.
        isError = true;
        askChoices = choicesQuestion(missing, `${[...session.turns].reverse().find((t) => t.role === "user")?.text ?? ""} ${userText}`);
        content = { speech: askChoices };
      } else if (!session.gameId && name !== "new_game" && name !== "game_history") {
        isError = true;
        content = { speech: "There is no game in progress yet. Ask the user if they want to start one, and with which colour and difficulty." };
      } else {
        const t = Date.now();
        let r = await deps.tools.callTool(name, args);
        // Second question about the same move: stop asking and play the likeliest reading (undo is one word away).
        const top = Array.isArray(r.data.candidates) ? String(r.data.candidates[0]) : "";
        if (name === "make_move" && !forcedMove && !r.isError && r.data.needsConfirmation === true && top && session.pending?.candidates.includes(top)) {
          r = await deps.tools.callTool(name, { ...args, move: top, alternatives: [], preview: false });
          guessed = true;
        }
        timings.toolMs += Date.now() - t;
        isError = r.isError;
        content = r.data;
      }
    }

    // Track the game this session is playing.
    if (name === "new_game" && !isError && typeof content.gameId === "string") {
      session = { ...session, gameId: content.gameId, humanColor: String(content.humanColor), level: Number(content.level), gameOver: false, pending: undefined, banter: undefined, justUndid: false };
    } else if (name === "make_move" && !isError) {
      const asked = content.needsConfirmation === true && Array.isArray(content.candidates);
      const previewed = content.preview === true && typeof content.san === "string";
      session = {
        ...session,
        justUndid: asked || previewed ? session.justUndid : false,
        gameOver: content.gameOver === true,
        pending: asked
          ? { candidates: (content.candidates as unknown[]).map(String), asks: (session.pending?.asks ?? 0) + 1 }
          : previewed ? { candidates: [String(content.san)], asks: 0 } : undefined,
      };
    } else if (name === "set_level" && !isError) {
      session = { ...session, level: Number(content.level) };
    } else if ((name === "resign" || (name === "offer_draw" && content.accepted === true)) && !isError) {
      session = { ...session, gameOver: true };
    } else if (name === "undo" && !isError) {
      session = { ...session, gameOver: false, pending: undefined, justUndid: true };
    }

    const traceArgs = { ...args };
    delete traceArgs.alternatives;
    toolCalls.push({ name, args: traceArgs, isError, speech: typeof content.speech === "string" ? content.speech : undefined });
    if ((name === "make_move" || name === "new_game") && !isError) {
      for (const k of ["yourMoveSpoken", "engineMoveSpoken"]) if (typeof content[k] === "string") spokenMoves.push(content[k] as string);
    }
    if (name === "make_move" && !isError && typeof content.yourMoveSpoken === "string") lastMove = content;
    if (name === "make_move" && !isError && (content.needsConfirmation === true || content.preview === true) && typeof content.speech === "string") {
      confirmSpeech = content.speech;
    }
    return { content, isError };
  }

  // ---------- fast path: a move needs no model at all ----------
  // The chess server resolves the spoken move and answers in words; the model only adds personality in chatty
  // mode. This was ~2 s of the reply time in the 2026-10-16 live game.
  const chattiness = session.chattiness ?? DEFAULT_CHATTINESS;
  let startRound = 0;
  if (!reply && session.gameId && !session.gameOver && (forcedMove || looksLikeMove(...moveHeard))) {
    timings.fastPath = true;
    let { content, isError } = await runTool("make_move", { move: forcedMove || moveHeard[0] });
    // Decide instead of asking: "Did you mean…? Did you mean…?" loops made the live site feel deaf. Unclear words
    // are played as their best reading ("say undo if not"); a clearly illegal move gets one sentence of why; only a
    // board question ("Which rook?") is still asked. Asking stays on when the player turned on confirm-each-move.
    let tookAs = false;
    const heardSaid = moveHeard[0].replace(/[.!?]+$/, "");
    const playBest = async (san: string) => {
      forcedMove = san; // exact SAN: the server plays it without re-reading the words
      confirmSpeech = "";
      ({ content, isError } = await runTool("make_move", { move: san }));
      tookAs = !isError;
    };
    if (!isError && content.needsConfirmation === true && !session.confirmMoves && !forcedMove) {
      const doubt = String(content.doubt ?? "");
      const candidates = Array.isArray(content.candidates) ? (content.candidates as unknown[]).map(String) : [];
      if (doubt === "illegal") {
        const why = typeof content.why === "string" && content.why ? `, ${content.why}` : "";
        reply = `I heard "${heardSaid}": that isn't possible${why}.`;
        session = { ...session, pending: undefined };
        confirmSpeech = "";
      } else if (doubt !== "which" && candidates.length) {
        const pick = candidates.length === 1 ? candidates[0] : ((await guessLegalMove(deps, session.gameId!, moveHeard, undefined, timings, usage, candidates))?.san ?? candidates[0]);
        await playBest(pick);
      }
    } else if (isError && !forcedMove) {
      // Words that named no recognisable move: the model picks the legal move that sounds closest, if any.
      // A move attempt always gets an answer, wake word or not (silence here made the live site feel deaf).
      const understood = typeof content.reason === "string" && content.reason; // a real move that just isn't legal
      const guess = understood ? undefined : await guessLegalMove(deps, session.gameId!, moveHeard, undefined, timings, usage);
      if (guess) await playBest(guess.san);
    }
    // A jab or a compliment when something happened (never in "just the moves" mode).
    const played = !isError && !reply && !confirmSpeech && typeof content.yourMoveSpoken === "string";
    const remark = played && chattiness !== "minimal" ? pickBanter(content, session.banter, session.gameId) : undefined;
    if (remark) session = { ...session, banter: remark.state };
    lastRemark = remark?.banter?.line;
    if (isError) {
      reply = typeof content.speech === "string" ? content.speech : "Sorry, I didn't catch a legal move. Could you say it again?";
    } else if (reply) {
      // already answered (an illegal move, said once)
    } else if (confirmSpeech) {
      reply = confirmSpeech; // a board question, or confirm-each-move
    } else if (tookAs) {
      const yours = String(content.yourMoveSpoken ?? "");
      const quick = quickMoveReply(content, chattiness === "chatty" ? "brief" : chattiness, 0, remark?.banter?.line);
      // Quote the words only when they were a short garble ("pornhd sex"); a long quote made the reply a speech.
      const said = heardSaid.split(/\s+/).length <= 3 ? `"${heardSaid}"` : "that";
      reply = `Taking ${said} as ${yours}; say undo if not.${quick.slice(capitalize(yours).length + 1)}`;
      templated = true;
    } else if (chattiness !== "chatty") {
      reply = quickMoveReply(content, chattiness, session.turns.length, remark?.banter?.line);
      templated = true;
    } else {
      // Chatty: the moves from the template, the model adds only the reaction. Phrasing the whole turn, it once left
      // out her move or the user's (converse eval, 2026-10-17), and a blind player must hear both.
      chattyMoves = quickMoveReply(content, "minimal", session.turns.length);
      const id = `fast${Date.now()}`;
      const facts = { ...factsForModel("make_move", content, false, chattiness, session.turns.length, remark?.banter), instruction: "Both moves are already announced. Reply with ONE short reaction line only, at most 10 words: no moves, no advice, no warnings." };
      messages.push({ role: "assistant", content: [{ toolUse: { toolUseId: id, name: "make_move", input: { move: forcedMove || moveHeard[0] } } }] });
      messages.push({ role: "user", content: [{ toolResult: { toolUseId: id, content: [{ text: JSON.stringify(facts) }], status: "success" } }] });
      startRound = 1;
    }
  }

  // ---------- routed questions: the tool is obvious, so the model doesn't have to choose it ----------
  if (!reply && !ignored && startRound === 0 && !unsure && session.gameId && !session.gameOver) {
    // Right after an undo the mistake is gone from the history: "what should I have played?" is the best move here.
    const route = session.justUndid && SHOULD_HAVE.test(userText) ? { name: "hint", args: { count: 1, reveal: true } as Record<string, unknown>, phrase: false } : routeQuestion(userText);
    if (route) {
      timings.fastPath = true;
      const { content, isError } = await runTool(route.name, route.args);
      if (!isError && "answer" in route && route.answer === "attacked") {
        reply = attackedAnswer(content, /\b(?:alert|warn|tell me when|let me know when)\b/i.test(userText));
        direct = true;
      } else if (isError || (DIRECT_SPEECH.has(route.name) && !route.phrase)) {
        reply = typeof content.speech === "string" ? content.speech : "";
        direct = true;
      } else {
        // One model call to answer the question from the facts.
        const id = `route${Date.now()}`;
        messages.push({ role: "assistant", content: [{ toolUse: { toolUseId: id, name: route.name, input: route.args as any } }] });
        const facts = factsForModel(route.name, content, false, chattiness, session.turns.length);
        for (const key of ("hide" in route ? route.hide : undefined) ?? []) delete facts[key];
        const note = "note" in route && route.note ? `${route.note} ${EYES_NOTE}` : route.name === "analyze_position" ? EYES_NOTE : undefined;
        messages.push({ role: "user", content: [{ toolResult: { toolUseId: id, content: [{ text: JSON.stringify(note ? { note, ...facts } : facts) }], status: "success" } }] });
        startRound = 1;
      }
    }
  }

  for (let round = startRound; !reply && !ignored && round < MAX_ROUNDS; round++) {
    const t = Date.now();
    const res = await deps.converse({
      modelId: deps.modelId,
      system: cache
        ? [{ text: SKILL_BODY }, { cachePoint: { type: "default" } }, { text: sessionState(session) }]
        : [{ text: `${SKILL_BODY}\n\n${sessionState(session)}` }],
      messages,
      // Once a game exists the first round must call a tool: otherwise the model may "play" a move from memory,
      // or invent analysis. `answer` covers rules and general chess knowledge, ask_again / ignore the rest.
      toolConfig: { tools, toolChoice: round === 0 && (session.gameId || !woken) ? { any: {} } : { auto: {} } },
      // Precise when choosing tools, a little lively when phrasing the reply.
      // 0.6 invented passed pawns and opening traps in the eval. 200 tokens: a spoken reply is two sentences.
      inferenceConfig: { temperature: round === 0 ? 0 : 0.3, maxTokens: 200 },
    });
    timings.modelMs += Date.now() - t;
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
      const { content, isError } = await runTool(name, (toolUse.input as Record<string, unknown>) ?? {});
      const moved = name === "make_move" && !isError && typeof content.yourMoveSpoken === "string" && chattiness !== "minimal";
      const remark = moved ? pickBanter(content, session.banter, session.gameId) : undefined;
      if (remark) session = { ...session, banter: remark.state };
      if (remark) lastRemark = remark.banter?.line;
      const forModel = factsForModel(name, content, isError, chattiness, session.turns.length, remark?.banter);
      results.push({ toolResult: { toolUseId: toolUse.toolUseId!, content: [{ text: JSON.stringify(forModel) }], status: isError ? "error" : "success" } });
    }
    messages.push({ role: "user", content: results });
    if (ignored) break;

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
    // Local tools (preferences, repeat, answer) and board tools whose result is already the exact answer are
    // spoken word for word: one model call (about a second) cheaper.
    const recent = toolCalls.slice(-toolUses.length);
    // Only on the model's first pick: after a detour through other tools, a bare list of king moves no longer
    // answers "can my king capture this piece?", so the model phrases it.
    // A yes/no question ("can my pawn move two squares?") needs a yes or no, not a raw list: the model phrases it,
    // except for tools that already answer yes/no or name the piece (consider_move, describe_square, hint).
    const isLocal = (n: string) => LOCAL_TOOLS.some((t) => t.toolSpec?.name === n);
    const yesNo = YES_NO.test(userText);
    const speakAsIs = (n: string) => round === 0 && DIRECT_SPEECH.has(n) && (!yesNo || ANSWERS_YES_NO.has(n));
    if (toolUses.every(({ toolUse }) => isLocal(toolUse.name!) || speakAsIs(toolUse.name!))) {
      const said = recent.map((t) => t.speech).filter(Boolean).join(" ");
      if (said) {
        reply = said;
        direct = toolUses.every(({ toolUse }) => DIRECT_SPEECH.has(toolUse.name!)); // the model's own answers stay trimmed
        break;
      }
    }
  }

  if (ignored) {
    await deps.sessions.put(touch(session)); // e.g. a pending question stays pending
    return silent();
  }

  // One more round when the model refused a chess question it had the facts for (at most once, about a second).
  if (reply && REFUSAL.test(reply) && toolCalls.some((t) => !t.isError) && usage.rounds > 0) {
    const t = Date.now();
    const res = await deps.converse({
      modelId: deps.modelId,
      system: [{ text: `${SKILL_BODY}\n\n${sessionState(session)}` }],
      messages: [...messages.filter((m, i) => i < messages.length - 1 || m.role !== "assistant"), { role: "assistant", content: [{ text: reply }] }, { role: "user", content: [{ text: REFUSAL_NUDGE }] }],
      toolConfig: { tools, toolChoice: { auto: {} } },
      inferenceConfig: { temperature: 0, maxTokens: 200 },
    });
    timings.modelMs += Date.now() - t;
    usage.rounds++;
    addUsage(usage, res.usage);
    const retry = cleanSpeech((res.output?.message?.content ?? []).map((c) => ("text" in c && c.text ? c.text : "")).join(" "));
    // Refused twice (a question the facts can't answer, like "remove the defender of their queen"): honest and
    // neutral, never "that would be cheating".
    reply = retry && !REFUSAL.test(retry) ? retry : "I can't spot that from here. Ask me what's under attack or what I'm threatening, and I'll tell you.";
  }
  // Nova 2 Lite once spoke its reasoning without <thinking> tags ("Okay, let's break this down. The user asked me
  // to describe the board. I called the readboard function…", 170 words): never say that; use the tool's own words.
  if (reply && REASONING_LEAK.test(reply)) reply = "";
  if (!reply) {
    // Model ran out of rounds or said nothing: fall back to the last tool's own words.
    reply = [...toolCalls].reverse().find((t) => t.speech)?.speech ?? "Sorry, I didn't catch that. Could you say it again?";
  }

  // Short for the ear. Move turns: the two moves and a remark. Answers: a few sentences, unless they asked for
  // everything; read-outs (board, legal moves, the move list) stay whole.
  if (!repeated && !askChoices && !confirmSpeech && !templated && !direct) {
    const done = new Set(toolCalls.filter((t) => !t.isError).map((t) => t.name));
    if (done.has("make_move") || done.has("new_game")) {
      reply = dropRepeatedSentences(reply, session.turns.filter((t) => t.role === "assistant").slice(-4).map((t) => t.text), spokenMoves);
      reply = limitSentences(reply, SENTENCE_LIMIT[chattiness]);
    } else if (!WANTS_DETAIL.test(userText) && !["read_board", "legal_moves", "game_history", "last_moves"].some((n) => done.has(n))) {
      reply = limitSentences(reply, ANSWER_LIMIT[chattiness]);
    }
  }

  if (chattyMoves) {
    // The model's reaction after the template's moves: short ("A free piece? Don't mind if I do."), never moves.
    const line = capWords(limitSentences(reply, 2), 12);
    const own = line && !MADE_UP_MOVE.test(line) && !/\b[a-h][1-8]\b/.test(line) ? line : lastRemark;
    reply = own ? `${chattyMoves} ${own}` : chattyMoves;
    templated = true;
  }
  // A blind player must hear her move: the model once said only "Pawn to a3. A free piece? Don't mind if I do."
  // (converse eval, 2026-10-17). A phrased move reply that leaves it out becomes the template, with the same jab.
  if (lastMove && !templated && !confirmSpeech && !saysMove(reply, lastMove)) reply = quickMoveReply(lastMove, "brief", 0, lastRemark);

  if (guessed && spokenMoves[0] && !confirmSpeech) reply = `I took that as ${spokenMoves[0]}; say undo if that's wrong. ${reply}`;

  // Never a monologue, whatever produced the reply (direct tool speech and templates too), unless they asked for a
  // read-out: the board, a side's pieces, or "everything".
  const readOut = WANTS_DETAIL.test(userText) || toolCalls.some((t) => !t.isError && (t.name === "read_board" || t.name === "list_pieces"));
  if (!repeated && !readOut) {
    const moveTurn = toolCalls.some((t) => !t.isError && t.name === "make_move");
    reply = capWords(reply, moveTurn ? WORD_LIMIT.move : WORD_LIMIT.answer);
  }

  if (!repeated) session.turns = [...session.turns, { role: "user", text: userText }, { role: "assistant", text: reply }];
  await deps.sessions.put(touch(session));

  timings.totalMs = Date.now() - started;
  return {
    reply,
    gameId: session.gameId,
    gameOver: session.gameOver === true,
    expectsReply: asksQuestion(reply),
    toolCalls,
    voice: sonicVoice(session.voice),
    usage,
    timings,
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

function choicesQuestion(missing: string[], said = ""): string {
  const colour = missing.some((m) => m.startsWith("colour"));
  const level = missing.some((m) => m.startsWith("difficulty"));
  // Short on purpose: a long list of levels made the user answer over her (2026-10-16 live test).
  if (colour && level) return "Sure! White or black? And easy, medium or hard?";
  if (colour) return "Sure! White or black?";
  // Echo the colour they chose, so "Can I play as Black?" gets a yes before the next question.
  const picked = /\bblack\b/i.test(said) ? "Black" : /\bwhite\b/i.test(said) ? "White" : "";
  return `${picked ? `Sure, you'll play ${picked}!` : "Great!"} Easy, medium or hard?`;
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
