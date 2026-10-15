import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { Chess, type Color, type Move } from "chess.js";
import * as z from "zod";
import {
  IllegalMoveError,
  describeSquare,
  legalMovesSpoken,
  material,
  moveToUci,
  piecesOf,
  playHumanMove,
  readBoard,
  replay,
  sideToMoveSpoken,
  spokenGameOver,
  statusOf,
  uciToObject,
} from "./chess/game.js";
import { LEVELS } from "./chess/engine.js";
import { colorName, spokenMove, spokenPieceList } from "./chess/spoken.js";
import type { GameRecord, GameStore, MoveRecord } from "./store.js";

export interface Engine {
  move(uciMoves: string[], level: number): Promise<string>;
  best(uciMoves: string[]): Promise<string>;
}

export interface Deps {
  store: GameStore;
  engine: Engine;
  now?: () => Date;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Every tool answers with a `speech` field (what the voice assistant should say) plus structured data. */
const ok = (data: { speech: string } & Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

const fail = (speech: string, extra: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ speech, ...extra }) }],
  structuredContent: { speech, ...extra },
  isError: true,
});

class UserFacingError extends Error {}

const gameIdSchema = z.string().min(1).describe("The gameId returned by new_game.");

const SERVER_INSTRUCTIONS = `Blind chess for voice assistants. The user cannot see a board.
Start with new_game, then pass its gameId to every other tool. make_move plays the user's move and returns
the engine's reply in the same call. Every result has a "speech" field: say it to the user (you may shorten it,
never invent moves or positions). Moves are SAN (Nf3, exd5, O-O, e8=Q) or UCI (g1f3). Every move is stored,
so game_history and last_moves can replay any game.`;

export function createChessServer(deps: Deps): McpServer {
  const { store, engine } = deps;
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

  const server = new McpServer(
    { name: "alexa_chess", version: "1.0.0", title: "Alexa Chess (blind chess)" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ---------- helpers ----------

  async function load(gameId: string): Promise<{ game: GameRecord; moves: MoveRecord[]; chess: Chess }> {
    const game = await store.getGame(gameId);
    if (!game) throw new UserFacingError(`I can't find a game with id ${gameId}. Start a new game first.`);
    const moves = await store.getMoves(gameId);
    return { game, moves, chess: replay(moves.map((m) => m.uci)) };
  }

  async function record(game: GameRecord, chess: Chess, move: Move, by: "human" | "engine"): Promise<MoveRecord> {
    const ply = chess.history().length;
    const rec: MoveRecord = {
      gameId: game.gameId,
      ply,
      moveNumber: Math.ceil(ply / 2),
      color: move.color,
      by,
      san: move.san,
      uci: moveToUci(move),
      spoken: spokenMove(move),
      fenAfter: move.after,
      timestamp: now(),
    };
    await store.addMove(rec);
    return rec;
  }

  async function playEngine(game: GameRecord, chess: Chess): Promise<MoveRecord> {
    const uci = await engine.move(
      chess.history({ verbose: true }).map((m) => moveToUci(m)),
      game.level,
    );
    const move = chess.move(uciToObject(uci));
    return record(game, chess, move, "engine");
  }

  async function saveState(game: GameRecord, chess: Chess, extra: Partial<GameRecord> = {}): Promise<GameRecord> {
    const s = statusOf(chess);
    const patch: Partial<GameRecord> = {
      fen: chess.fen(),
      plyCount: chess.history().length,
      status: s.status,
      result: s.result,
      reason: s.reason,
      updatedAt: now(),
      ...extra,
    };
    await store.updateGame(game.gameId, patch);
    return { ...game, ...patch };
  }

  function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    return fn().catch((err: unknown) => {
      if (err instanceof IllegalMoveError) {
        return fail(`${err.message} Some legal options: ${err.suggestions.join("; ")}.`, { suggestions: err.suggestions });
      }
      if (err instanceof UserFacingError) return fail(err.message);
      console.error(JSON.stringify({ level: "error", msg: "tool failed", error: String(err), stack: (err as Error)?.stack }));
      return fail("Sorry, something went wrong on the chess server. Please try again.");
    });
  }

  const levelList = Object.entries(LEVELS).map(([k, v]) => `${k} = ${v.label}`).join(", ");

  // ---------- tools ----------

  server.registerTool(
    "new_game",
    {
      title: "Start a new game",
      description: `Start a new blind chess game against Stockfish. Levels: ${levelList}. If the user plays black, the engine's first move is included.`,
      inputSchema: z.object({
        color: z.enum(["white", "black", "random"]).default("white").describe("The user's side."),
        level: z.number().int().min(1).max(8).default(3).describe("Engine strength 1-8."),
        sessionId: z.string().optional().describe("Optional caller session id to link the game to."),
      }),
    },
    ({ color, level, sessionId }) =>
      guard(async () => {
        const humanColor: Color = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color === "white" ? "w" : "b";
        const chess = new Chess();
        let game: GameRecord = {
          gameId: randomUUID(),
          humanColor,
          level,
          status: "active",
          fen: chess.fen(),
          plyCount: 0,
          sessionId,
          createdAt: now(),
          updatedAt: now(),
        };
        await store.putGame(game);
        let speech = `New game started. You are ${colorName(humanColor)}, and I'm playing at level ${level}, ${LEVELS[level].label}.`;
        let engineMoveRec: MoveRecord | undefined;
        if (humanColor === "b") {
          engineMoveRec = await playEngine(game, chess);
          game = await saveState(game, chess);
          speech += ` I open with ${engineMoveRec.spoken}. Your move.`;
        } else {
          speech += " Your move.";
        }
        return ok({ speech, gameId: game.gameId, humanColor: colorName(humanColor), level, engineMove: engineMoveRec?.san, fen: chess.fen() });
      }),
  );

  server.registerTool(
    "make_move",
    {
      title: "Play a move",
      description:
        "Play the user's move, then the engine replies in the same call. Accepts SAN (Nf3, exd5, O-O, e8=Q) or UCI (g1f3, e7e8q). Illegal moves return legal suggestions.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        move: z.string().min(2).describe("The user's move in SAN or UCI."),
      }),
    },
    ({ gameId, move }) =>
      guard(async () => {
        let { game, chess } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError(`That game is already over (${game.status}). Start a new game to play again.`);

        // Catch up if a previous engine reply was lost.
        if (chess.turn() !== game.humanColor) await playEngine(game, chess);

        const human = playHumanMove(chess, move);
        const humanRec = await record(game, chess, human, "human");
        let speech = `You played ${humanRec.spoken}.`;
        let engineRec: MoveRecord | undefined;

        if (statusOf(chess).status === "active") {
          engineRec = await playEngine(game, chess);
          speech += ` I play ${engineRec.spoken}.`;
        }
        game = await saveState(game, chess);
        const over = spokenGameOver(chess, game.humanColor);
        if (over) speech += ` ${over}`;
        else if (chess.inCheck()) speech += " You're in check.";

        return ok({
          speech,
          yourMove: humanRec.san,
          engineMove: engineRec?.san,
          status: game.status,
          result: game.result,
          gameOver: game.status !== "active",
          inCheck: chess.inCheck(),
          moveNumber: chess.moveNumber(),
          fen: chess.fen(),
        });
      }),
  );

  server.registerTool(
    "legal_moves",
    {
      title: "List legal moves",
      description: "List the user's legal moves, optionally only for one square (e.g. g1) or one piece type (e.g. knight).",
      inputSchema: z.object({
        gameId: gameIdSchema,
        square: z.string().regex(/^[a-hA-H][1-8]$/).optional(),
        piece: z.string().optional().describe("pawn, knight, bishop, rook, queen or king"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, square, piece }) =>
      guard(async () => {
        const { chess } = await load(gameId);
        const res = legalMovesSpoken(chess, { square, piece });
        return ok({ speech: res.speech, moves: res.moves });
      }),
  );

  server.registerTool(
    "describe_square",
    {
      title: "What is on a square",
      description: "Say which piece, if any, stands on a square.",
      inputSchema: z.object({ gameId: gameIdSchema, square: z.string().describe("A square such as e4.") }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, square }) =>
      guard(async () => {
        const { chess } = await load(gameId);
        try {
          return ok({ speech: describeSquare(chess, square) });
        } catch (e) {
          throw new UserFacingError((e as Error).message);
        }
      }),
  );

  server.registerTool(
    "list_pieces",
    {
      title: "List pieces",
      description: "List where one side's pieces are, or find a piece type (e.g. 'where is the black queen').",
      inputSchema: z.object({
        gameId: gameIdSchema,
        color: z.enum(["white", "black"]),
        piece: z.string().optional().describe("Optional piece type to filter: pawn, knight, bishop, rook, queen, king"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, color, piece }) =>
      guard(async () => {
        const { chess } = await load(gameId);
        let pieces = piecesOf(chess, color === "white" ? "w" : "b");
        if (piece) {
          const letter = ({ pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" } as Record<string, string>)[
            piece.toLowerCase().replace(/s$/, "")
          ];
          pieces = pieces.filter((p) => p.type === letter);
          if (pieces.length === 0) return ok({ speech: `${color === "white" ? "White" : "Black"} has no ${piece} left.` });
        }
        return ok({ speech: `${color === "white" ? "White" : "Black"} has ${spokenPieceList(pieces)}.`, pieces });
      }),
  );

  server.registerTool(
    "read_board",
    {
      title: "Read the whole board",
      description: "Read out the full position, grouped by side and piece (default) or rank by rank.",
      inputSchema: z.object({ gameId: gameIdSchema, format: z.enum(["pieces", "ranks"]).default("pieces") }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, format }) =>
      guard(async () => {
        const { game, chess } = await load(gameId);
        return ok({ speech: `${readBoard(chess, format)} ${sideToMoveSpoken(chess, game.humanColor)}`, fen: chess.fen() });
      }),
  );

  server.registerTool(
    "last_moves",
    {
      title: "Repeat recent moves",
      description: "Repeat the most recent moves (default the last two half-moves: yours and mine).",
      inputSchema: z.object({ gameId: gameIdSchema, count: z.number().int().min(1).max(20).default(2) }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, count }) =>
      guard(async () => {
        const { moves } = await load(gameId);
        if (moves.length === 0) return ok({ speech: "No moves have been played yet.", moves: [] });
        const recent = moves.slice(-count);
        const speech = recent
          .map((m) => `Move ${m.moveNumber}, ${m.by === "human" ? "you" : "I"} played ${m.spoken}.`)
          .join(" ");
        return ok({ speech, moves: recent.map((m) => ({ ply: m.ply, by: m.by, san: m.san })) });
      }),
  );

  server.registerTool(
    "game_status",
    {
      title: "Game status",
      description: "Whose turn it is, move number, check, material balance and whether the game is over.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game, chess } = await load(gameId);
        const mat = material(chess);
        const over = game.status === "resigned" ? "You resigned this game." : spokenGameOver(chess, game.humanColor);
        const speech = over
          ? `${over} ${mat.speech}`
          : `Move ${chess.moveNumber()}. ${sideToMoveSpoken(chess, game.humanColor)} ${mat.speech}`;
        return ok({ speech, status: game.status, result: game.result, moveNumber: chess.moveNumber(), material: mat, fen: chess.fen() });
      }),
  );

  server.registerTool(
    "hint",
    {
      title: "Suggest a move",
      description: "Ask the engine at full strength for the best move for the user. Does not play it.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game, chess } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError("The game is over, so there's nothing to suggest.");
        const uci = await engine.best(chess.history({ verbose: true }).map((m) => moveToUci(m)));
        const move = new Chess(chess.fen()).move(uciToObject(uci));
        return ok({ speech: `You could try ${spokenMove(move)}.`, san: move.san });
      }),
  );

  server.registerTool(
    "undo",
    {
      title: "Take back",
      description: "Take back the user's last move (and the engine's reply to it).",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { destructiveHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game, moves } = await load(gameId);
        const lastHuman = [...moves].reverse().find((m) => m.by === "human");
        if (!lastHuman) throw new UserFacingError("There's no move of yours to take back.");
        const removed = moves.filter((m) => m.ply >= lastHuman.ply);
        await store.deleteMoves(gameId, removed.map((m) => m.ply));
        const chess = replay(moves.filter((m) => m.ply < lastHuman.ply).map((m) => m.uci));
        await saveState(game, chess, { status: "active", result: undefined, reason: undefined });
        return ok({ speech: `Took back ${lastHuman.spoken}. ${sideToMoveSpoken(chess, game.humanColor)}`, fen: chess.fen() });
      }),
  );

  server.registerTool(
    "resign",
    {
      title: "Resign",
      description: "Resign the current game.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { destructiveHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError("That game is already over.");
        const result = game.humanColor === "w" ? "0-1" : "1-0";
        await store.updateGame(gameId, { status: "resigned", result, reason: "resignation", updatedAt: now() });
        return ok({ speech: "You resigned. Good game! Say new game whenever you want a rematch.", result });
      }),
  );

  server.registerTool(
    "game_history",
    {
      title: "Game history",
      description: "Full move history of a game (PGN and spoken). Without a gameId, lists recent games.",
      inputSchema: z.object({ gameId: gameIdSchema.optional(), limit: z.number().int().min(1).max(20).default(5) }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, limit }) =>
      guard(async () => {
        if (!gameId) {
          const games = await store.listGames(limit);
          if (games.length === 0) return ok({ speech: "There are no saved games yet.", games: [] });
          const speech = games
            .map((g, i) => `${i + 1}: you played ${colorName(g.humanColor)} at level ${g.level}, ${g.plyCount} half-moves, ${g.status === "active" ? "still in progress" : `${g.status}, ${g.result}`}.`)
            .join(" ");
          return ok({ speech: `Your recent games. ${speech}`, games });
        }
        const { game, moves, chess } = await load(gameId);
        chess.setHeader("Event", "Alexa Chess");
        chess.setHeader("White", game.humanColor === "w" ? "You" : `Stockfish level ${game.level}`);
        chess.setHeader("Black", game.humanColor === "b" ? "You" : `Stockfish level ${game.level}`);
        chess.setHeader("Date", game.createdAt.slice(0, 10).replace(/-/g, "."));
        if (game.result) chess.setHeader("Result", game.result);
        const byNumber = new Map<number, MoveRecord[]>();
        for (const m of moves) byNumber.set(m.moveNumber, [...(byNumber.get(m.moveNumber) ?? []), m]);
        const spoken = [...byNumber.entries()].map(([n, ms]) => `${n}. ${ms.map((m) => `${colorName(m.color)} ${m.spoken}`).join(", ")}.`);
        const speech = moves.length ? `${moves.length} half-moves. ${spoken.join(" ")}` : "No moves have been played yet.";
        return ok({ speech, pgn: chess.pgn(), status: game.status, result: game.result, moves });
      }),
  );

  return server;
}
