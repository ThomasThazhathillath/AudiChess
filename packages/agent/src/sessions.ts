import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

/** One spoken exchange. Only user text and the final spoken reply are kept; tool chatter is not. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export type Chattiness = "minimal" | "brief" | "chatty";

/** alexa_chess_sessions: one row per browser session. */
export interface Session {
  sessionId: string;
  gameId?: string;
  humanColor?: string;
  level?: number;
  gameOver?: boolean;
  /** A move question Alexa asked and the user hasn't answered: candidates as SAN, best first. */
  pending?: { candidates: string[]; asks: number };
  /** How much Alexa comments: "minimal" | "brief" (default) | "chatty". */
  chattiness?: Chattiness;
  /** Polly voice id, e.g. "Kajal". */
  voice?: string;
  /** Speaking rate as a percentage, 100 = normal. */
  rate?: number;
  /** Repeat each move back and play it only after a yes. */
  confirmMoves?: boolean;
  turns: Turn[];
  updatedAt: string;
  expiresAt: number;
}

export interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
}

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const MAX_TURNS = 20;

export function newSession(sessionId: string): Session {
  return { sessionId, turns: [], updatedAt: new Date().toISOString(), expiresAt: 0 };
}

export function touch(session: Session): Session {
  return {
    ...session,
    turns: session.turns.slice(-MAX_TURNS),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}

export class DynamoSessionStore implements SessionStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(private readonly table = process.env.SESSIONS_TABLE ?? "alexa_chess_sessions", client = new DynamoDBClient({})) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(sessionId: string) {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: { sessionId } }));
    return res.Item as Session | undefined;
  }

  async put(session: Session) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: session }));
  }
}

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, Session>();
  async get(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : undefined;
  }
  async put(session: Session) {
    this.sessions.set(session.sessionId, structuredClone(session));
  }
}
