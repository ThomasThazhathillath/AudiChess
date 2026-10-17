import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { Chess, type Color, type Move, type Square } from "chess.js";
import * as z from "zod";
import {
  IllegalMoveError,
  describeSquare,
  legalMovesSpoken,
  material,
  moveToUci,
  piecesOf,
  playHumanMove,
  suggestMoves,
  readBoard,
  replay,
  sideToMoveSpoken,
  spokenGameOver,
  statusOf,
  uciToObject,
} from "./chess/game.js";
import { LEVELS, type Line, type SearchResult } from "./chess/engine.js";
import {
  activity,
  castleWhy,
  centre,
  control,
  development,
  explainIllegal,
  forks,
  kingSafety,
  lostPieces,
  nullMoveFen,
  openFiles,
  other,
  pawnStructure,
  phase,
  pins,
  shots,
} from "./chess/insight.js";
import {
  alertsFor,
  classifyMove,
  describeEval,
  evalSwing,
  evalTrend,
  forWhite,
  hangingPieces,
  materialBalance,
  moveIdeas,
  spokenMaterial,
  type MoveQuality,
} from "./chess/analysis.js";
import { currentOpening } from "./chess/openings.js";
import { confirmQuestion, isCastleChoice, readSpecs, resolveSpokenMove } from "./chess/spokenMove.js";
import { PIECE_NAMES, colorName, spokenMove, spokenPieceList } from "./chess/spoken.js";
import type { GameRecord, GameStore, MoveRecord } from "./store.js";

export interface Engine {
  move(uciMoves: string[], level: number, startFen?: string): Promise<string>;
  best(uciMoves: string[], startFen?: string): Promise<string>;
  /** Quick full-strength evaluation for commentary. */
  analyse(uciMoves: string[], startFen?: string): Promise<SearchResult>;
  /** Top moves with scores for any position (MultiPV), for analysis questions. */
  top(fen: string, count?: number, movetimeMs?: number): Promise<Line[]>;
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

/** Chess notation rather than spoken words ("Ke2", "exd5", "O-O"). */
const SAN_LIKE = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?|[a-h][1-8][a-h][1-8][qrbn]?)[+#]?$/;

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
    return { game, moves, chess: replay(moves.map((m) => m.uci), game.startFen) };
  }

  async function record(
    game: GameRecord,
    chess: Chess,
    move: Move,
    by: "human" | "engine",
    extra: Pick<MoveRecord, "evalCp" | "quality" | "bestSan" | "opening" | "lossCp"> = {},
  ): Promise<MoveRecord> {
    const ply = chess.history().length;
    const rec: MoveRecord = {
      gameId: game.gameId,
      ply,
      moveNumber: Number(move.before.split(" ")[5]) || Math.ceil(ply / 2),
      color: move.color,
      by,
      san: move.san,
      uci: moveToUci(move),
      spoken: spokenMove(move),
      fenAfter: move.after,
      timestamp: now(),
      ...extra,
    };
    await store.addMove(rec);
    return rec;
  }

  async function playEngine(game: GameRecord, chess: Chess): Promise<{ rec: MoveRecord; move: Move }> {
    const uci = await engine.move(uciHistory(chess), game.level, game.startFen);
    const openingBefore = currentOpening(chess)?.name;
    const move = chess.move(uciToObject(uci));
    const opening = currentOpening(chess)?.name;
    const rec = await record(game, chess, move, "engine", opening && opening !== openingBefore ? { opening } : {});
    return { rec, move };
  }

  const uciHistory = (chess: Chess) => chess.history({ verbose: true }).map((m) => moveToUci(m));

  /** Evaluation failures must never block a move: commentary is optional. */
  async function tryAnalyse(chess: Chess, startFen?: string): Promise<SearchResult | undefined> {
    try {
      return await engine.analyse(uciHistory(chess), startFen);
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "analysis failed", error: String(err) }));
      return undefined;
    }
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
        // Two options at most: a list of six read aloud was the most annoying thing in the 2026-10-16 live game.
        const top = err.suggestions.slice(0, 2).map((s) => s.replace(/^\S+ \((.*)\)$/, "$1"));
        return fail(`${err.message}${top.length ? ` You could play ${top.join(" or ")}.` : ""}`, { suggestions: err.suggestions.slice(0, 2), ...(err.reason ? { reason: err.reason } : {}) });
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
        fen: z.string().optional().describe("Start from this position instead of the normal start (puzzles, tests)."),
        setupMoves: z.array(z.string()).max(200).optional().describe("Moves (SAN or UCI) to play first, recorded as the game so far."),
      }),
    },
    ({ color, level, sessionId, fen, setupMoves }) =>
      guard(async () => {
        const humanColor: Color = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color === "white" ? "w" : "b";
        let chess: Chess;
        try {
          chess = new Chess(fen);
        } catch (e) {
          throw new UserFacingError(`That position isn't valid: ${(e as Error).message}`);
        }
        let game: GameRecord = {
          gameId: randomUUID(),
          humanColor,
          level,
          status: "active",
          fen: chess.fen(),
          ...(fen ? { startFen: chess.fen() } : {}),
          plyCount: 0,
          sessionId,
          createdAt: now(),
          updatedAt: now(),
        };
        await store.putGame(game);
        // A set-up history (tests, "continue from this game"): recorded like real moves, no engine analysis.
        for (const m of setupMoves ?? []) {
          let move: Move;
          try {
            move = playHumanMove(chess, m);
          } catch {
            throw new UserFacingError(`Setup move ${m} isn't legal at ply ${chess.history().length + 1}.`);
          }
          await record(game, chess, move, move.color === humanColor ? "human" : "engine");
        }
        if (fen || setupMoves?.length) game = await saveState(game, chess);
        let speech = `New game started. You are ${colorName(humanColor)}, and I'm playing at level ${level}, ${LEVELS[level].label}.`;
        let engineMoveRec: MoveRecord | undefined;
        if (chess.turn() !== humanColor && statusOf(chess).status === "active") {
          engineMoveRec = (await playEngine(game, chess)).rec;
          game = await saveState(game, chess);
          speech += ` I ${chess.history().length === 1 ? "open with" : "play"} ${engineMoveRec.spoken}. Your move.`;
        } else {
          speech += " Your move.";
        }
        return ok({
          speech,
          gameId: game.gameId,
          humanColor: colorName(humanColor),
          level,
          levelName: LEVELS[level].label,
          engineMove: engineMoveRec?.san,
          engineMoveSpoken: engineMoveRec?.spoken,
          fen: chess.fen(),
        });
      }),
  );

  server.registerTool(
    "make_move",
    {
      title: "Play a move",
      description:
        "Play the user's move, then the engine replies in the same call. Pass your best reading of the move as SAN (Nf3, exd5, O-O, e8=Q). The server also matches mis-heard speech ('night forever') to legal moves. If unsure it returns needsConfirmation with candidates: ask the user, then call again with the chosen SAN. The result includes commentary facts: opening reached, quality of the user's move, ideas behind the engine's reply, threats.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        move: z.string().min(1).describe("Your best reading of the user's move: SAN or UCI preferred, raw words accepted."),
        alternatives: z.array(z.string()).max(5).optional().describe("Raw speech-recognition transcripts, best first."),
        preview: z.boolean().optional().describe("Only work out which move was meant; don't play it (confirm-before-playing mode)."),
      }),
    },
    ({ gameId, move, alternatives, preview }) =>
      guard(async () => {
        let { game, moves, chess } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError(`That game is already over (${game.status}). Start a new game to play again.`);

        // Catch up if a previous engine reply was lost.
        if (chess.turn() !== game.humanColor) await playEngine(game, chess);

        const resolution = resolveSpokenMove(chess, move, alternatives ?? []);
        if (resolution.kind === "confirm") {
          const spec = resolution.reason === "illegal" ? [move, ...(alternatives ?? [])].map((t) => readSpecs(t)[0]).find((s) => s && (s.to || s.castle)) : undefined;
          const why = spec ? explainIllegal(chess, game.humanColor, { to: spec.to, piece: spec.piece, from: spec.from, castle: spec.castle, capture: spec.capture }) : undefined;
          const speech = confirmQuestion(chess, resolution, why);
          // `doubt` lets the assistant decide instead of asking: "unclear"/"ambiguous" words can be resolved to the best
          // guess, "illegal" means the words named a real move that can't be played (`why`), "which" is a board question.
          const ms = resolution.candidates.map((s) => new Chess(chess.fen()).move(s));
          const which = (ms.length === 2 && ms[0].piece === ms[1].piece && ms[0].to === ms[1].to) || isCastleChoice(ms);
          const spokenCandidates = ms.map((m) => spokenMove(m));
          return ok({ speech, needsConfirmation: true, candidates: resolution.candidates, spokenCandidates, heard: resolution.heard, doubt: which ? "which" : resolution.reason, why });
        }
        if (resolution.kind === "none") {
          const said = resolution.heard ?? move;
          // Say why, when the words named a piece and a square ("your bishop on c1 is blocked by your pawn on d2").
          const spec = [move, ...(alternatives ?? [])].map((t) => readSpecs(t)[0]).find((s) => s && (s.to || s.castle));
          const reason = spec ? explainIllegal(chess, game.humanColor, { to: spec.to, piece: spec.piece, from: spec.from, castle: spec.castle, capture: spec.capture }) : undefined;
          const words = String(said).trim().split(/\s+/).length;
          // Repeat what was heard, so a mishearing ("a 6" for e6) is obvious to the player.
          const heardSaid = String(said).trim().replace(/[.!?]+$/, "");
          const quotable = words <= 8 && !SAN_LIKE.test(heardSaid); // notation ("Ke2") isn't what the player said
          const message = reason
            ? quotable ? `I heard "${heardSaid}": that isn't possible, ${reason}.` : `That move isn't possible: ${reason}.`
            : quotable ? `I heard "${heardSaid}", but that isn't a legal move here.` : "I didn't catch a legal move there.";
          // Castling has its own reason; other moves get related suggestions (same piece or square) when there are any.
          throw new IllegalMoveError(message, spec?.castle ? [] : suggestMoves(chess, spec ? `${spec.piece ? spec.piece.toUpperCase() : ""}${spec.to ?? ""}` : move), reason);
        }
        if (preview) {
          const m = new Chess(chess.fen()).move(resolution.san);
          return ok({ speech: `${spokenMove(m)}?`, preview: true, san: m.san, spoken: spokenMove(m) });
        }

        // Earlier evaluations (user's side, after each of their moves) give swings, trends and "position changed".
        const pastEvals = moves
          .filter((m) => m.by === "human" && typeof m.evalCp === "number")
          .map((m) => m.evalCp!);
        const materialBefore = materialBalance(chess, game.humanColor);
        const alertsBefore = new Set(alertsFor(chess, game.humanColor)); // already warned about last turn

        // Evaluate before and after the user's move to judge it.
        const openingBefore = currentOpening(chess)?.name;
        const before = await tryAnalyse(chess, game.startFen);
        const human = chess.move(resolution.san);
        const humanIdeas = moveIdeas(human, chess);
        const after = await tryAnalyse(chess, game.startFen);

        let quality: MoveQuality | undefined;
        let lossCp: number | undefined;
        let bestSan: string | undefined;
        let evalCp: number | undefined; // user's point of view, after their move
        if (before?.scoreCp !== undefined && after?.scoreCp !== undefined) {
          evalCp = -after.scoreCp;
          ({ quality, lossCp } = classifyMove(before.scoreCp, evalCp, before.best === moveToUci(human)));
          if (quality !== "best" && quality !== "good") {
            try {
              bestSan = new Chess(human.before).move(uciToObject(before.best)).san;
            } catch {
              /* engine suggestion not parseable: skip */
            }
          }
        }
        const humanOpening = currentOpening(chess)?.name;
        const humanRec = await record(game, chess, human, "human", {
          evalCp,
          quality,
          bestSan,
          opening: humanOpening && humanOpening !== openingBefore ? humanOpening : undefined,
          lossCp,
        });

        let speech = `You played ${humanRec.spoken}.`;
        let reply: { rec: MoveRecord; move: Move } | undefined;
        if (statusOf(chess).status === "active") {
          reply = await playEngine(game, chess);
          speech += ` I play ${reply.rec.spoken}.`;
        }
        game = await saveState(game, chess);
        const over = spokenGameOver(chess, game.humanColor);
        if (over) speech += ` ${over}`;
        else if (chess.inCheck()) speech += " You're in check.";

        const newOpening = reply?.rec.opening ?? humanRec.opening;
        const lastEval = pastEvals[pastEvals.length - 1];
        const positionNow = evalCp !== undefined ? describeEval(forWhite(evalCp, game.humanColor)) : undefined;
        const positionBefore = lastEval !== undefined ? describeEval(forWhite(lastEval, game.humanColor)) : "roughly equal";
        const materialAfter = materialBalance(chess, game.humanColor);
        const trendNow = evalCp !== undefined ? evalTrend([...pastEvals, evalCp]) : undefined;
        const commentary = {
          opening: newOpening ? { name: newOpening, reachedBy: reply?.rec.opening ? "my move" : "your move" } : undefined,
          yourMove: quality
            ? { quality, lossCp, betterWas: bestSan ? spokenMove(new Chess(human.before).move(bestSan)) : undefined }
            : undefined,
          yourMoveIdeas: humanIdeas,
          myMoveIdeas: reply ? moveIdeas(reply.move, chess) : [],
          // Only when the assessment changed category, so it isn't repeated every turn.
          position: positionNow && positionNow !== positionBefore ? positionNow : undefined,
          swing: evalCp !== undefined ? evalSwing(lastEval, evalCp) : undefined,
          // Trend and warnings only when they're news, so the same line isn't repeated every turn.
          trend: trendNow !== evalTrend(pastEvals) ? trendNow : undefined,
          material: materialAfter !== materialBefore ? spokenMaterial(materialAfter) : undefined,
          alerts: alertsFor(chess, game.humanColor).filter((a) => !alertsBefore.has(a) || /^your (queen|rook)/.test(a)),
        };

        return ok({
          speech,
          yourMove: humanRec.san,
          engineMove: reply?.rec.san,
          yourMoveSpoken: humanRec.spoken,
          engineMoveSpoken: reply?.rec.spoken,
          gameOverText: over || undefined,
          heardAs: resolution.via === "exact" ? undefined : resolution.heard,
          commentary,
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
    "set_level",
    {
      title: "Change difficulty",
      description: `Change the engine's strength in the current game. Levels: ${levelList}.`,
      inputSchema: z.object({ gameId: gameIdSchema, level: z.number().int().min(1).max(8) }),
    },
    ({ gameId, level }) =>
      guard(async () => {
        const { game } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError("That game is over. Start a new one and pick a level.");
        await store.updateGame(gameId, { level, updatedAt: now() });
        const direction = level > game.level ? "stronger" : level < game.level ? "gentler" : "the same";
        return ok({ speech: `Okay, I'll play at level ${level}, ${LEVELS[level].label}.`, level, previousLevel: game.level, direction });
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
        const opening = currentOpening(chess)?.name;
        const speech = over
          ? `${over} ${mat.speech}`
          : `Move ${chess.moveNumber()}. ${sideToMoveSpoken(chess, game.humanColor)} ${mat.speech}${opening ? ` We're in the ${opening}.` : ""}`;
        return ok({ speech, status: game.status, result: game.result, moveNumber: chess.moveNumber(), material: mat, opening, level: game.level, fen: chess.fen() });
      }),
  );

  server.registerTool(
    "hint",
    {
      title: "Suggest a move",
      description:
        "The engine's best move for the user at full strength, with the idea behind it. Does not play it. count: 1 (default, 'what should I play', 'any suggestion') up to 3 only when they ask for several ('my three best moves'). reveal: false for 'a small hint without giving it away' (names only the piece and the idea).",
      inputSchema: z.object({
        gameId: gameIdSchema,
        count: z.number().int().min(1).max(3).default(1),
        reveal: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, count, reveal }) =>
      guard(async () => {
        const { game, chess } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError("The game is over, so there's nothing to suggest.");
        if (chess.turn() !== game.humanColor) throw new UserFacingError("It's my move right now; ask again on your turn.");
        const lines = await engine.top(chess.fen(), count, 500);
        const options = lines.slice(0, count).map((l) => {
          const c = new Chess(chess.fen());
          const m = c.move(uciToObject(l.move));
          return { san: m.san, spoken: spokenMove(m), piece: PIECE_NAMES[m.piece], from: m.from, flags: m.flags, ideas: moveIdeas(m, c), evaluation: evalForUser(l, chess.turn(), game.humanColor) };
        });
        if (options.length === 0) throw new UserFacingError("You have no legal moves.");
        const best = options[0];
        const idea = best.ideas[0] ? `: it ${best.ideas[0]}` : "";
        let speech: string;
        if (!reveal) {
          // Where to look and why, never the square: "Look at your knight on the kingside: it can attack my queen."
          const area = /^[a-c]/.test(best.from) ? "on the queenside" : /^[d-e]/.test(best.from) ? "in the centre" : "on the kingside";
          const vague = best.ideas.map((i) => i.replace(/ on [a-h][1-8]/g, "").replace(/^attacks the/, "can attack my").replace(/^captures/, "can capture").replace(/^gives check/, "can give check").replace(/^develops the \w+/, "wants to come into play").replace(/^stakes a claim in the centre/, "can grab the centre")).find(Boolean);
          const why = vague ?? (best.flags.includes("k") || best.flags.includes("q") ? "your king wants safety" : best.piece === "pawn" ? "it can gain space" : "it has a strong move");
          speech = best.piece === "king" && (best.flags.includes("k") || best.flags.includes("q")) ? "Think about your king's safety." : `Look at your ${best.piece} ${area}: ${vague ? `it ${vague}` : why}.`;
        } else if (count === 1) speech = `Try ${best.spoken}${idea}.`;
        else speech = `Best is ${best.spoken}${idea}. Also good: ${options.slice(1).map((o) => o.spoken).join(", and ")}.`;
        return ok({ speech, options: reveal ? options : [{ piece: best.piece, ideas: best.ideas.map((i) => i.replace(/ on [a-h][1-8]/g, "")) }], reveal });
      }),
  );

  /** A side-to-move score as words and pawns from the user's point of view. */
  function evalForUser(l: { scoreCp: number; mate?: number }, sideToMove: Color, user: Color): { says: string; pawns: number; mateIn?: number } {
    const cp = sideToMove === user ? l.scoreCp : -l.scoreCp;
    const mate = l.mate === undefined ? undefined : sideToMove === user ? l.mate : -l.mate;
    if (mate !== undefined && mate !== 0) return { says: mate > 0 ? `you have a forced mate in ${mate}` : `I have a forced mate in ${-mate}`, pawns: Math.sign(mate) * 99, mateIn: mate };
    const a = Math.abs(cp);
    const who = cp > 0 ? "you're" : "I'm";
    const says = a < 40 ? "roughly equal" : a < 120 ? `${who} slightly better` : a < 300 ? `${who} clearly better` : `${who} winning`;
    return { says, pawns: Math.round(cp) / 100 };
  }

  const mine = (c: Color, user: Color) => (c === user ? "your" : "my");

  server.registerTool(
    "analyze_position",
    {
      title: "Analyse the position",
      description:
        "Everything about the current position from the user's side, for any question about it: evaluation (who is better, by how much, forced mates), the best moves (top 3), what I (the opponent) am threatening, pieces under attack or undefended on both sides, pins, forks and other tactics available, checks, material and pieces lost, castling rights, king safety, development, centre, pawn structure (isolated, doubled, passed), open files, the most active pieces, the game phase and opening, and the last moves with their quality. Answer only what was asked from these facts.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game, moves, chess } = await load(gameId);
        const user = game.humanColor;
        const me = other(user);
        const yourTurn = chess.turn() === user;
        const over = statusOf(chess).status !== "active" || game.status !== "active";
        const lines = over ? [] : await engine.top(chess.fen(), 3, 500);
        const evaluation = lines[0] ? evalForUser(lines[0], chess.turn(), user) : undefined;
        const spoken = (fen: string, uci: string) => {
          const c = new Chess(fen);
          const m = c.move(uciToObject(uci));
          return { move: spokenMove(m), san: m.san, ideas: moveIdeas(m, c) };
        };
        /** The engine's principal variation, spoken: the only move sequences the assistant may describe. */
        const line = (fen: string, pv: string[], plies = 4) => {
          const c = new Chess(fen);
          const out: string[] = [];
          for (const uci of pv.slice(0, plies)) {
            try {
              const m = c.move(uciToObject(uci));
              out.push(`${m.color === user ? "you" : "I"} ${spokenMove(m)}`);
            } catch {
              break;
            }
          }
          return out.join(", then ");
        };
        const bestMoves = yourTurn
          ? lines.map((l) => ({ ...spoken(chess.fen(), l.move), evaluation: evalForUser(l, chess.turn(), user).says, line: line(chess.fen(), l.pv) }))
          : [];
        // My threat: what I would play if it were my move now (a null move), and how much it would hurt.
        let threat: Record<string, unknown> | undefined;
        if (yourTurn && !over) {
          const nullFen = nullMoveFen(chess);
          const t = nullFen ? (await engine.top(nullFen, 1, 400))[0] : undefined;
          if (t && nullFen) {
            const ifIgnored = evalForUser(t, me, user);
            const s = spoken(nullFen, t.move);
            const serious = (t.mate !== undefined && t.mate > 0) || (evaluation && evaluation.pawns - ifIgnored.pawns >= 1.5);
            threat = { myBestMoveIfIgnored: s.move, whatItDoes: s.ideas, positionIfYouIgnoreIt: ifIgnored.says, serious: !!serious, line: line(nullFen, t.pv, 3), note: "This is only what happens if you ignore it; the evaluation above assumes you deal with it." };
          }
        }
        const lastHuman = [...moves].reverse().find((m) => m.by === "human");
        const lastEngine = [...moves].reverse().find((m) => m.by === "engine");
        let myLastIdeas: string[] = [];
        if (lastEngine) {
          const c = replay(moves.filter((m) => m.ply < lastEngine.ply).map((m) => m.uci), game.startFen);
          const m = c.move(uciToObject(lastEngine.uci));
          myLastIdeas = moveIdeas(m, c);
        }
        const tactics = yourTurn ? { ...shots(chess), forks: forks(new Chess(chess.fen())) } : undefined;
        // In check, every legal move is a way out: list them by kind, so "can my king escape?" is never guessed.
        let waysOutOfCheck: Record<string, string[]> | undefined;
        if (yourTurn && chess.inCheck()) {
          const legal = chess.moves({ verbose: true });
          const checkers = chess.attackers(chess.board().flat().find((p) => p?.type === "k" && p.color === user)!.square, me);
          waysOutOfCheck = {
            kingMoves: legal.filter((m) => m.piece === "k").map((m) => spokenMove(m)),
            captureTheChecker: legal.filter((m) => m.piece !== "k" && checkers.includes(m.to)).map((m) => spokenMove(m)),
            blocks: legal.filter((m) => m.piece !== "k" && !checkers.includes(m.to)).map((m) => spokenMove(m)),
            checkedBy: checkers.map((s) => `my ${PIECE_NAMES[chess.get(s)!.type]} on ${s}`),
          };
        }
        const mat = material(chess);
        const balance = materialBalance(chess, user);
        const facts = {
          moveNumber: chess.moveNumber(),
          toMove: yourTurn ? "you" : "me",
          phase: phase(chess),
          opening: currentOpening(chess)?.name,
          gameOver: over ? spokenGameOver(chess, user) ?? game.status : undefined,
          youAreInCheck: yourTurn && chess.inCheck(),
          waysOutOfCheck,
          legalMoveCount: yourTurn ? chess.moves().length : undefined,
          evaluation,
          bestMoves,
          threat,
          material: { balance: spokenMaterial(balance), you: user === "w" ? mat.white : mat.black, me: user === "w" ? mat.black : mat.white, youLost: lostPieces(chess, user), iLost: lostPieces(chess, me) },
          yourPiecesUnderAttack: hangingPieces(chess, user).map((h) => `${PIECE_NAMES[h.piece]} on ${h.square} (attacked by my ${PIECE_NAMES[h.attackedBy]})`),
          myPiecesYouCanWin: hangingPieces(chess, me).map((h) => `${PIECE_NAMES[h.piece]} on ${h.square} (attacked by your ${PIECE_NAMES[h.attackedBy]})`),
          pins: { yourPinnedPieces: pins(chess, user), myPinnedPieces: pins(chess, me) },
          tactics,
          castling: { kingside: castleWhy(chess, user, "k") ?? "you can castle kingside", queenside: castleWhy(chess, user, "q") ?? "you can castle queenside" },
          kingSafety: { you: kingSafety(chess, user).summary, me: kingSafety(chess, me).summary },
          development: { you: development(chess, user), me: development(chess, me) },
          centre: centre(chess).summary,
          pawns: { you: pawnStructure(chess, user), me: pawnStructure(chess, me) },
          // Where everything is, so no answer has to guess a square ("my queen on d1" was the user's queen).
          pieces: { yours: spokenPieceList(piecesOf(chess, user)), mine: spokenPieceList(piecesOf(chess, me)) },
          files: openFiles(chess),
          yourRooks: piecesOf(chess, user).filter((p) => p.type === "r").map((p) => {
            const f = p.square[0];
            const pawnsOn = piecesOf(chess, user).concat(piecesOf(chess, me)).filter((x) => x.type === "p" && x.square[0] === f);
            const ownPawn = pawnsOn.some((x) => piecesOf(chess, user).some((y) => y.square === x.square));
            return `rook on ${p.square}: ${pawnsOn.length === 0 ? "open file" : ownPawn ? "closed file (your own pawn is on it)" : "half-open file"}`;
          }),
          activity: { you: activity(chess, user), me: activity(chess, me) },
          // "Is my rook trapped?": pieces (not pawns) that have no legal move right now.
          yourPiecesWithNoMoves: yourTurn
            ? piecesOf(chess, user).filter((p) => p.type !== "p" && chess.moves({ square: p.square }).length === 0).map((p) => `${PIECE_NAMES[p.type]} on ${p.square}`)
            : undefined,
          squaresControlled: { you: control(chess, user), me: control(chess, me) },
          lastMoves: {
            yours: lastHuman ? { move: lastHuman.spoken, moveNumber: lastHuman.moveNumber, quality: lastHuman.quality, betterWas: lastHuman.bestSan } : undefined,
            mine: lastEngine ? { move: lastEngine.spoken, moveNumber: lastEngine.moveNumber, ideas: myLastIdeas } : undefined,
          },
        };
        const speech = [
          evaluation ? `Position: ${evaluation.says}.` : "",
          threat?.serious ? `I'm threatening ${threat.myBestMoveIfIgnored}.` : "",
          bestMoves[0] ? `Best for you is ${bestMoves[0].move}.` : "",
        ].filter(Boolean).join(" ") || "Here's the position.";
        return ok({ speech, ...facts });
      }),
  );

  server.registerTool(
    "consider_move",
    {
      title: "What if / can I play this move?",
      description:
        "Check a move without playing it: whether it's legal (and if not, exactly why: blocked, pinned, in check, castling rights, attacked square...), and if legal how good it is, what it does, whether it hangs anything, and my best reply. For 'can I move my king to e2', 'can I castle', 'is bishop takes f7 safe', 'what happens if I take that pawn', 'how would you respond to knight g5'.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        move: z.string().min(1).describe("The move: SAN (Nf3, O-O) or the user's words ('king to e2')."),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId, move }) =>
      guard(async () => {
        const { game, chess } = await load(gameId);
        const user = game.humanColor;
        const c = chess.turn() === user ? new Chess(chess.fen()) : null;
        if (!c) throw new UserFacingError("It's my move right now; ask again on your turn.");
        // "What happens if I move my queen?": a piece but no square. Say where it can go and ask which.
        const LETTER: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
        const san = /^([KQRBN])([a-h][1-8])$/.exec(move.trim()); // the model sometimes passes the piece's own square ("Qe7")
        const spec0 = readSpecs(move)[0];
        const named = /\b(king|queen|rook|bishop|knight|pawn)s?\b/i.exec(move)?.[1]?.toLowerCase();
        const pieceOnly =
          (named && !/\b[a-h]\s?[1-8]\b|castl/i.test(move) && !spec0) ||
          (san && c.get(san[2] as Square)?.type === san[1].toLowerCase() && c.get(san[2] as Square)?.color === user);
        if (pieceOnly) {
          const lm = legalMovesSpoken(c, { piece: named ?? LETTER[san![1].toLowerCase()] });
          return ok({ speech: lm.moves.length ? `${lm.speech} Which square do you have in mind?` : lm.speech, legal: "which square", moves: lm.moves });
        }
        const res = resolveSpokenMove(c, move, [move]);
        if (res.kind !== "move") {
          const spec = readSpecs(move)[0];
          const reason = spec ? explainIllegal(c, user, { to: spec.to, piece: spec.piece, from: spec.from, castle: spec.castle, capture: spec.capture }) : undefined;
          // "Did you mean…" only when the words were unclear; an illegal move gets its reason (and the nearest legal one).
          if (res.kind === "confirm" && !(res.reason === "illegal" && reason)) return ok({ speech: confirmQuestion(c, res), legal: "unclear", candidates: res.candidates });
          const nearest = res.kind === "confirm" ? res.candidates.map((san) => spokenMove(new Chess(c.fen()).move(san))) : [];
          return ok({ speech: reason ? `No: ${reason}.` : "That isn't a legal move here.", legal: false, reason, nearestLegal: nearest });
        }
        const before = await engine.top(c.fen(), 1, 400);
        const m = c.move(res.san);
        const ideas = moveIdeas(m, c);
        const after = c.isGameOver() ? [] : await engine.top(c.fen(), 1, 400);
        const nowEval = before[0] ? evalForUser(before[0], user, user) : undefined;
        const afterEval = after[0] ? evalForUser(after[0], other(user), user) : c.isCheckmate() ? { says: "checkmate, you win", pawns: 99 } : { says: "a draw", pawns: 0 };
        const loss = nowEval ? Math.max(0, Math.round((nowEval.pawns - afterEval.pawns) * 100)) : undefined;
        const quality = loss === undefined ? undefined : loss <= 15 ? "best or as good" : loss <= 60 ? "good" : loss <= 120 ? "inaccuracy" : loss <= 300 ? "mistake" : "blunder";
        let myReply: string | undefined;
        if (after[0]) {
          const r = new Chess(c.fen()).move(uciToObject(after[0].move));
          myReply = spokenMove(r);
        }
        const hangs = hangingPieces(c, user).map((h) => `${PIECE_NAMES[h.piece]} on ${h.square}`);
        const verdict = !quality ? "" : quality === "best or as good" ? ", and it's a strong move" : quality === "good" ? ", and it's fine" : `, but it would be a ${quality}`;
        const speech = `Yes, ${spokenMove(m)} is legal${verdict}.${myReply ? ` I'd answer ${myReply}.` : ""}${hangs.length && quality !== "best or as good" ? ` It would leave your ${hangs[0]} hanging.` : ""}`;
        return ok({ speech, legal: true, move: spokenMove(m), san: m.san, whatItDoes: ideas, quality, evaluationAfter: afterEval.says, comparedWithBest: nowEval?.says, leavesHanging: hangs, myBestReply: myReply });
      }),
  );

  server.registerTool(
    "review_game",
    {
      title: "Review the game",
      description:
        "How the user has played so far (or in the finished game): each of their mistakes and blunders with move number and the better move, the first mistake, the biggest blunder, how many moves were best or good, the openings reached, and the ideas behind my last move. For 'did I mess up', 'was my last move good', 'where did I go wrong', 'what was my biggest blunder', 'why did you play that', 'analyse the game'.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { readOnlyHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game, moves } = await load(gameId);
        const human = moves.filter((m) => m.by === "human");
        const fenBefore = (ply: number) => (ply <= 1 ? game.startFen ?? new Chess().fen() : moves.find((x) => x.ply === ply - 1)?.fenAfter ?? new Chess().fen());
        const better = (m: MoveRecord) => {
          if (!m.bestSan) return undefined;
          try {
            return spokenMove(new Chess(fenBefore(m.ply)).move(m.bestSan));
          } catch {
            return undefined;
          }
        };
        const bad = human.filter((m) => m.quality === "mistake" || m.quality === "blunder" || m.quality === "inaccuracy");
        const errors = bad.map((m) => ({ moveNumber: m.moveNumber, move: m.spoken, quality: m.quality, betterWas: better(m), lostPawns: m.lossCp !== undefined ? m.lossCp / 100 : undefined }));
        const rank = { blunder: 3, mistake: 2, inaccuracy: 1 } as Record<string, number>;
        const biggest = [...errors].sort((a, b) => (b.lostPawns ?? rank[b.quality!]) - (a.lostPawns ?? rank[a.quality!]))[0];
        const rated = human.filter((m) => m.quality);
        const goodShare = rated.length ? Math.round((100 * rated.filter((m) => m.quality === "best" || m.quality === "good").length) / rated.length) : undefined;
        const lastHuman = human[human.length - 1];
        const lastEngine = [...moves].reverse().find((m) => m.by === "engine");
        let myLastIdeas: string[] = [];
        if (lastEngine) {
          const c = replay(moves.filter((m) => m.ply < lastEngine.ply).map((m) => m.uci), game.startFen);
          const mv = c.move(uciToObject(lastEngine.uci));
          myLastIdeas = moveIdeas(mv, c);
        }
        const speech = human.length === 0
          ? "You haven't played a move yet."
          : errors.length === 0
            ? `No mistakes so far: ${rated.length ? `${goodShare}% of your moves were best or good` : "nothing to flag"}.`
            : `${errors.length} slip${errors.length === 1 ? "" : "s"} so far. The biggest was move ${biggest.moveNumber}, ${biggest.move}${biggest.betterWas ? `; ${biggest.betterWas} was better` : ""}.`;
        return ok({
          speech,
          yourMovesPlayed: human.length,
          bestOrGoodPercent: goodShare,
          mistakes: errors,
          firstMistake: errors[0],
          biggestMistake: biggest,
          yourLastMove: lastHuman ? { moveNumber: lastHuman.moveNumber, move: lastHuman.spoken, quality: lastHuman.quality, betterWas: lastHuman.quality && lastHuman.quality !== "best" && lastHuman.quality !== "good" ? better(lastHuman) : undefined } : undefined,
          myLastMove: lastEngine ? { moveNumber: lastEngine.moveNumber, move: lastEngine.spoken, ideas: myLastIdeas } : undefined,
          openings: moves.filter((m) => m.opening).map((m) => m.opening),
          status: game.status,
          result: game.result,
        });
      }),
  );

  server.registerTool(
    "offer_draw",
    {
      title: "Offer a draw",
      description: "The user offers a draw. I accept only when the position is level (or I'm worse) and we're past the opening.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      annotations: { destructiveHint: true },
    },
    ({ gameId }) =>
      guard(async () => {
        const { game, chess } = await load(gameId);
        if (game.status !== "active") throw new UserFacingError("That game is already over.");
        const l = (await engine.top(chess.fen(), 1, 400))[0];
        const forMe = l ? evalForUser(l, chess.turn(), other(game.humanColor)).pawns : 0;
        const accept = chess.history().length >= 20 ? forMe <= 0.3 : forMe <= -1;
        if (!accept) {
          return ok({ speech: forMe > 0.3 ? "No thanks, I like my position. Let's play on!" : "It's a bit early for a draw. Let's play on!", accepted: false });
        }
        await store.updateGame(gameId, { status: "draw", result: "1/2-1/2", reason: "agreement", updatedAt: now() });
        return ok({ speech: "I accept. The game is a draw by agreement. Good game!", accepted: true, result: "1/2-1/2", gameOver: true });
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
