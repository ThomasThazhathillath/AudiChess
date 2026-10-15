import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { GameResult, GameStatus } from "./chess/game.js";

/** alexa_chess_games: one row per game. */
export interface GameRecord {
  gameId: string;
  humanColor: "w" | "b";
  level: number;
  status: GameStatus;
  result?: GameResult;
  reason?: string;
  fen: string;
  plyCount: number;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** alexa_chess_moves: one row per half-move, keyed by gameId + ply (1-based). */
export interface MoveRecord {
  gameId: string;
  ply: number;
  moveNumber: number;
  color: "w" | "b";
  by: "human" | "engine";
  san: string;
  uci: string;
  spoken: string;
  fenAfter: string;
  timestamp: string;
}

export interface GameStore {
  getGame(gameId: string): Promise<GameRecord | undefined>;
  putGame(game: GameRecord): Promise<void>;
  updateGame(gameId: string, patch: Partial<Omit<GameRecord, "gameId">>): Promise<void>;
  listGames(limit: number): Promise<GameRecord[]>;
  getMoves(gameId: string): Promise<MoveRecord[]>;
  /** Fails if that ply already exists, so a retried or duplicated request can't record a move twice. */
  addMove(move: MoveRecord): Promise<void>;
  deleteMoves(gameId: string, plies: number[]): Promise<void>;
}

export class DynamoGameStore implements GameStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly gamesTable = process.env.GAMES_TABLE ?? "alexa_chess_games",
    private readonly movesTable = process.env.MOVES_TABLE ?? "alexa_chess_moves",
    client = new DynamoDBClient({}),
  ) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async getGame(gameId: string) {
    const res = await this.db.send(new GetCommand({ TableName: this.gamesTable, Key: { gameId } }));
    return res.Item as GameRecord | undefined;
  }

  async putGame(game: GameRecord) {
    await this.db.send(new PutCommand({ TableName: this.gamesTable, Item: game }));
  }

  async updateGame(gameId: string, patch: Partial<Omit<GameRecord, "gameId">>) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    await this.db.send(
      new UpdateCommand({
        TableName: this.gamesTable,
        Key: { gameId },
        UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(", ")}`,
        ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
      }),
    );
  }

  async listGames(limit: number) {
    // Small hackathon-scale table: a scan sorted in memory is fine.
    const res = await this.db.send(new ScanCommand({ TableName: this.gamesTable }));
    return ((res.Items ?? []) as GameRecord[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async getMoves(gameId: string) {
    const moves: MoveRecord[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.movesTable,
          KeyConditionExpression: "gameId = :g",
          ExpressionAttributeValues: { ":g": gameId },
          ScanIndexForward: true,
          ExclusiveStartKey,
        }),
      );
      moves.push(...((res.Items ?? []) as MoveRecord[]));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return moves;
  }

  async addMove(move: MoveRecord) {
    await this.db.send(
      new PutCommand({
        TableName: this.movesTable,
        Item: move,
        ConditionExpression: "attribute_not_exists(ply)",
      }),
    );
  }

  async deleteMoves(gameId: string, plies: number[]) {
    if (plies.length === 0) return;
    await this.db.send(
      new BatchWriteCommand({
        RequestItems: {
          [this.movesTable]: plies.map((ply) => ({ DeleteRequest: { Key: { gameId, ply } } })),
        },
      }),
    );
  }
}

/** In-memory store for tests and local runs. */
export class MemoryGameStore implements GameStore {
  readonly games = new Map<string, GameRecord>();
  readonly moves = new Map<string, MoveRecord[]>();

  async getGame(gameId: string) {
    const g = this.games.get(gameId);
    return g ? { ...g } : undefined;
  }
  async putGame(game: GameRecord) {
    this.games.set(game.gameId, { ...game });
  }
  async updateGame(gameId: string, patch: Partial<Omit<GameRecord, "gameId">>) {
    const g = this.games.get(gameId);
    if (g) this.games.set(gameId, { ...g, ...patch });
  }
  async listGames(limit: number) {
    return [...this.games.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }
  async getMoves(gameId: string) {
    return [...(this.moves.get(gameId) ?? [])].sort((a, b) => a.ply - b.ply);
  }
  async addMove(move: MoveRecord) {
    const list = this.moves.get(move.gameId) ?? [];
    if (list.some((m) => m.ply === move.ply)) throw new Error(`Move ${move.ply} already recorded`);
    list.push({ ...move });
    this.moves.set(move.gameId, list);
  }
  async deleteMoves(gameId: string, plies: number[]) {
    this.moves.set(gameId, (this.moves.get(gameId) ?? []).filter((m) => !plies.includes(m.ply)));
  }
}
