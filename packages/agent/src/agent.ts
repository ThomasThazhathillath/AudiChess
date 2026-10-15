import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
  Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { ChessTools, McpTool } from "./mcpClient.js";
import { type Session, type SessionStore, newSession, touch } from "./sessions.js";
import skill from "../skills/blind-chess/SKILL.md";

export type Converse = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

export interface AgentDeps {
  converse: Converse;
  tools: ChessTools;
  sessions: SessionStore;
  modelId: string;
}

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  speech?: string;
}

export interface TurnResult {
  reply: string;
  gameId?: string;
  gameOver: boolean;
  toolCalls: ToolTrace[];
}

const MAX_ROUNDS = 6;

// The agent tracks the current game itself, so the model never has to copy a UUID around.
const HIDDEN_ARGS = ["gameId", "sessionId"];
const LIST_RECENT_FLAG = "listRecentGames";

/** The skill body without its YAML frontmatter. */
const SKILL_BODY = skill.replace(/^---[\s\S]*?---\s*/, "");

/** MCP tool definitions -> Bedrock Converse toolSpecs, minus the arguments the agent fills in. */
export function toBedrockTools(tools: McpTool[]): Tool[] {
  return tools.map((t) => {
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
}

function systemPrompt(session: Session): string {
  let state: string;
  if (!session.gameId) state = "There is no game in progress. If the user wants to play or says a move, start one with new_game.";
  else if (session.gameOver) state = `The last game is over (the user played ${session.humanColor}). Offer a new game if they want to keep playing.`;
  else state = `A game is in progress: the user plays ${session.humanColor} against level ${session.level}. The game is selected automatically for every tool.`;
  return `${SKILL_BODY}\n\n## Current state\n${state}\n\nReply with plain spoken sentences only.`;
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

export async function runTurn(deps: AgentDeps, sessionId: string, userText: string): Promise<TurnResult> {
  let session = (await deps.sessions.get(sessionId)) ?? newSession(sessionId);
  const toolCalls: ToolTrace[] = [];
  const bedrockTools = toBedrockTools(await deps.tools.listTools());

  const messages: Message[] = [
    ...session.turns.map((t) => ({ role: t.role, content: [{ text: t.text }] }) as Message),
    { role: "user", content: [{ text: userText }] },
  ];

  let reply = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await deps.converse({
      modelId: deps.modelId,
      system: [{ text: systemPrompt(session) }],
      messages,
      // During a game the first round must call a tool: otherwise the model may "play" a move from memory
      // of earlier turns without the server ever seeing it.
      toolConfig: {
        tools: bedrockTools,
        toolChoice: round === 0 && session.gameId && !session.gameOver ? { any: {} } : { auto: {} },
      },
      inferenceConfig: { temperature: 0, maxTokens: 600 },
    });
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
      if (name === "new_game") args.sessionId = sessionId;
      else if (session.gameId && !(name === "game_history" && listRecent)) args.gameId = session.gameId;

      let content: Record<string, unknown>;
      let isError: boolean;
      if (!session.gameId && name !== "new_game" && name !== "game_history") {
        isError = true;
        content = { speech: "There is no game in progress yet. Ask the user if they want to start one." };
      } else {
        const r = await deps.tools.callTool(name, args);
        isError = r.isError;
        content = r.data;
      }

      // Track the game this session is playing.
      if (name === "new_game" && !isError && typeof content.gameId === "string") {
        session = { ...session, gameId: content.gameId, humanColor: String(content.humanColor), level: Number(content.level), gameOver: false };
      } else if (name === "make_move" && !isError) {
        session = { ...session, gameOver: content.gameOver === true };
      } else if (name === "resign" && !isError) {
        session = { ...session, gameOver: true };
      } else if (name === "undo" && !isError) {
        session = { ...session, gameOver: false };
      }

      toolCalls.push({ name, args, isError, speech: typeof content.speech === "string" ? content.speech : undefined });
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
  }

  if (!reply) {
    // Model ran out of rounds or said nothing: fall back to the last tool's own words.
    reply = [...toolCalls].reverse().find((t) => t.speech)?.speech ?? "Sorry, I didn't catch that. Could you say it again?";
  }

  session.turns = [...session.turns, { role: "user", text: userText }, { role: "assistant", text: reply }];
  await deps.sessions.put(touch(session));
  return { reply, gameId: session.gameId, gameOver: session.gameOver === true, toolCalls };
}
