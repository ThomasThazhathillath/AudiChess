import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";
import { hangingPieces } from "./analysis.js";
import { PIECE_NAMES, PIECE_PLURALS, joinAnd, spokenMove } from "./spoken.js";

// Position facts for questions a blind player asks: pins, forks, pawn structure, king safety, why a move is
// illegal... Pure chess.js, no engine, so every answer is checkable. The engine adds evaluations on top (server.ts).

const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const FILES = "abcdefgh";
const START_COUNT: Record<PieceSymbol, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

export const other = (c: Color): Color => (c === "w" ? "b" : "w");
const fileOf = (s: string) => s.charCodeAt(0) - 97;
const rankOf = (s: string) => Number(s[1]) - 1;
const toSq = (f: number, r: number) => `${FILES[f]}${r + 1}` as Square;
const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;

type Placed = { type: PieceSymbol; color: Color; square: Square };
const at = (p: Placed) => `${PIECE_NAMES[p.type]} on ${p.square}`;

function pieces(chess: Chess, color?: Color): Placed[] {
  return chess.board().flat().filter((p): p is Placed => p !== null && (!color || p.color === color));
}

/** The same position with the other side to move (for "what is my opponent threatening"), or undefined when illegal. */
export function nullMoveFen(chess: Chess): string | undefined {
  if (chess.inCheck()) return undefined;
  const parts = chess.fen().split(" ");
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  const fen = parts.join(" ");
  try {
    new Chess(fen);
    return fen;
  } catch {
    return undefined;
  }
}

/** A Chess instance where `color` is to move (null move if needed). */
export function withTurn(chess: Chess, color: Color): Chess | undefined {
  if (chess.turn() === color) return new Chess(chess.fen());
  const fen = nullMoveFen(chess);
  return fen ? new Chess(fen) : undefined;
}

/** Pieces `color` has lost compared with a full set, e.g. ["a knight", "two pawns"]. */
export function lostPieces(chess: Chess, color: Color): string[] {
  const count: Record<string, number> = {};
  for (const p of pieces(chess, color)) count[p.type] = (count[p.type] ?? 0) + 1;
  const out: string[] = [];
  for (const t of ["q", "r", "b", "n", "p"] as PieceSymbol[]) {
    const missing = START_COUNT[t] - (count[t] ?? 0);
    if (missing > 0) out.push(missing === 1 ? `a ${PIECE_NAMES[t]}` : `${["", "", "two", "three", "four", "five", "six", "seven", "eight"][missing]} ${PIECE_PLURALS[t]}`);
  }
  return out;
}

const DIRS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
} as const;

/**
 * Pieces of `color` pinned by enemy bishops, rooks and queens: to the king (they can't move off the line) or to
 * something more valuable behind them.
 */
export function pins(chess: Chess, color: Color): { piece: string; to: string; by: string; absolute: boolean }[] {
  const out: { piece: string; to: string; by: string; absolute: boolean }[] = [];
  for (const e of pieces(chess, other(color))) {
    if (e.type !== "b" && e.type !== "r" && e.type !== "q") continue;
    const dirs = e.type === "q" ? [...DIRS.b, ...DIRS.r] : DIRS[e.type];
    for (const [df, dr] of dirs) {
      let f = fileOf(e.square) + df, r = rankOf(e.square) + dr;
      let first: Placed | undefined;
      while (onBoard(f, r)) {
        const p = chess.get(toSq(f, r)) as Placed | undefined;
        if (p) {
          if (!first) {
            if (p.color !== color || p.type === "k") break;
            first = { ...p, square: toSq(f, r) };
          } else {
            if (p.color === color && (p.type === "k" || VALUE[p.type] > VALUE[first.type])) {
              out.push({ piece: at(first), to: p.type === "k" ? "king" : at({ ...p, square: toSq(f, r) }), by: at(e), absolute: p.type === "k" });
            }
            break;
          }
        }
        f += df;
        r += dr;
      }
    }
  }
  return out;
}

/** Moves for the side to move that attack two or more targets at once (king, undefended or more valuable pieces). */
export function forks(chess: Chess): { move: string; san: string; targets: string[]; safe: boolean }[] {
  const me = chess.turn();
  const enemy = other(me);
  const out: { move: string; san: string; targets: string[]; safe: boolean }[] = [];
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const targets: string[] = [];
    for (const p of pieces(chess, enemy)) {
      if (!chess.attackers(p.square, me).includes(m.to)) continue;
      const defended = chess.attackers(p.square, enemy).length > 0;
      if (p.type === "k" || VALUE[p.type] > VALUE[m.piece] || !defended) targets.push(p.type === "k" ? "king" : at(p));
    }
    const attackers = chess.attackers(m.to, enemy).map((s) => chess.get(s)!.type);
    const cheapest = attackers.sort((a, b) => VALUE[a] - VALUE[b])[0];
    const defendedHere = chess.attackers(m.to, me).length > 0;
    const safe = !cheapest || (defendedHere && VALUE[cheapest] >= VALUE[m.piece]);
    chess.undo();
    if (targets.length >= 2) out.push({ move: spokenMove(m), san: m.san, targets, safe });
  }
  return out.sort((a, b) => Number(b.safe) - Number(a.safe) || b.targets.length - a.targets.length).slice(0, 4);
}

/** Tactical shots for the side to move: mates in one, checks, captures that win material. */
export function shots(chess: Chess): { mateInOne: string[]; checks: string[]; winningCaptures: string[] } {
  const me = chess.turn();
  const mateInOne: string[] = [];
  const checks: string[] = [];
  const winningCaptures: string[] = [];
  for (const m of chess.moves({ verbose: true })) {
    if (m.san.endsWith("#")) mateInOne.push(spokenMove(m));
    else if (m.san.endsWith("+")) checks.push(spokenMove(m));
    if (m.captured) {
      chess.move(m);
      const defended = chess.attackers(m.to, other(me)).length > 0;
      chess.undo();
      if (!defended || VALUE[m.captured] > VALUE[m.piece]) winningCaptures.push(spokenMove(m));
    }
  }
  return { mateInOne, checks: checks.slice(0, 6), winningCaptures: winningCaptures.slice(0, 6) };
}

/** Isolated, doubled and passed pawns, as squares or files. */
export function pawnStructure(chess: Chess, color: Color): { isolated: string[]; doubled: string[]; passed: string[] } {
  const mine = pieces(chess, color).filter((p) => p.type === "p");
  const theirs = pieces(chess, other(color)).filter((p) => p.type === "p");
  const files = new Map<number, number>();
  for (const p of mine) files.set(fileOf(p.square), (files.get(fileOf(p.square)) ?? 0) + 1);
  const dir = color === "w" ? 1 : -1;
  const isolated = mine.filter((p) => !files.has(fileOf(p.square) - 1) && !files.has(fileOf(p.square) + 1)).map((p) => p.square);
  const doubled = [...files.entries()].filter(([, n]) => n > 1).map(([f]) => `${FILES[f]} file`);
  const passed = mine
    .filter((p) => !theirs.some((t) => Math.abs(fileOf(t.square) - fileOf(p.square)) <= 1 && (rankOf(t.square) - rankOf(p.square)) * dir > 0))
    .map((p) => p.square);
  return { isolated, doubled, passed };
}

/** Knights and bishops still on their starting squares, and whether the king looks castled. */
export function development(chess: Chess, color: Color): { undeveloped: string[]; castled: boolean } {
  const home = color === "w" ? { n: ["b1", "g1"], b: ["c1", "f1"] } : { n: ["b8", "g8"], b: ["c8", "f8"] };
  const undeveloped: string[] = [];
  for (const t of ["n", "b"] as const) {
    for (const s of home[t]) {
      const p = chess.get(s as Square);
      if (p && p.color === color && p.type === t) undeveloped.push(`${PIECE_NAMES[t]} on ${s}`);
    }
  }
  const back = color === "w" ? "1" : "8";
  const king = pieces(chess, color).find((p) => p.type === "k")?.square ?? "";
  const rook = (s: string) => chess.get(s as Square)?.type === "r" && chess.get(s as Square)?.color === color;
  const castled = (king === `g${back}` && rook(`f${back}`)) || (king === `c${back}` && rook(`d${back}`)) || (king === `b${back}` && rook(`c${back}`));
  return { undeveloped, castled };
}

/** A one-line picture of the king's safety: where it is, pawn cover, open files, enemy pressure. */
export function kingSafety(chess: Chess, color: Color): { square: string; shieldPawns: number; openFilesNearKing: string[]; attackedSquaresAround: number; summary: string } {
  const king = pieces(chess, color).find((p) => p.type === "k")!;
  const kf = fileOf(king.square), kr = rankOf(king.square);
  const dir = color === "w" ? 1 : -1;
  let shield = 0;
  const openNear: string[] = [];
  for (let f = kf - 1; f <= kf + 1; f++) {
    if (f < 0 || f > 7) continue;
    const ownPawnOnFile = pieces(chess, color).some((p) => p.type === "p" && fileOf(p.square) === f);
    if (!ownPawnOnFile) openNear.push(`${FILES[f]} file`);
    for (const step of [1, 2]) {
      const r = kr + dir * step;
      if (!onBoard(f, r)) continue;
      const p = chess.get(toSq(f, r));
      if (p && p.color === color && p.type === "p") { shield++; break; }
    }
  }
  let pressure = 0;
  for (let f = kf - 1; f <= kf + 1; f++) for (let r = kr - 1; r <= kr + 1; r++) {
    if (onBoard(f, r) && chess.isAttacked(toSq(f, r), other(color))) pressure++;
  }
  const { castled } = development(chess, color);
  const inCheck = chess.turn() === color && chess.inCheck();
  const words = [
    inCheck ? "in check" : "",
    castled ? "castled" : "not castled",
    `${shield} pawn${shield === 1 ? "" : "s"} in front`,
    openNear.length ? `open ${joinAnd(openNear)} nearby` : "",
    pressure ? `${pressure} square${pressure === 1 ? "" : "s"} around it attacked` : "",
  ].filter(Boolean);
  return { square: king.square, shieldPawns: shield, openFilesNearKing: openNear, attackedSquaresAround: pressure, summary: `king on ${king.square}: ${words.join(", ")}` };
}

/** Who controls the four centre squares: attacks plus occupation. */
export function centre(chess: Chess): { white: number; black: number; summary: string } {
  let white = 0, black = 0;
  for (const s of ["d4", "e4", "d5", "e5"] as Square[]) {
    white += chess.attackers(s, "w").length;
    black += chess.attackers(s, "b").length;
    const p = chess.get(s);
    if (p?.type === "p") p.color === "w" ? (white += 2) : (black += 2);
  }
  const summary = Math.abs(white - black) <= 1 ? "the centre is balanced" : `${white > black ? "White" : "Black"} controls the centre`;
  return { white, black, summary };
}

/** Open files (no pawns) and which rooks or queens stand on them. */
export function openFiles(chess: Chess): { open: string[]; heavyPiecesOnThem: string[] } {
  const all = pieces(chess);
  const open: string[] = [];
  const on: string[] = [];
  for (let f = 0; f < 8; f++) {
    if (all.some((p) => p.type === "p" && fileOf(p.square) === f)) continue;
    open.push(`${FILES[f]} file`);
    for (const p of all) if ((p.type === "r" || p.type === "q") && fileOf(p.square) === f) on.push(`${p.color === "w" ? "White" : "Black"} ${at(p)}`);
  }
  return { open, heavyPiecesOnThem: on };
}

/** The piece of `color` with the most legal moves, and the side's total number of legal moves. */
export function activity(chess: Chess, color: Color): { mobility: number; mostActive?: string; leastActive?: string } {
  const c = withTurn(chess, color);
  if (!c) return { mobility: 0 };
  const moves = c.moves({ verbose: true });
  const per = new Map<string, number>();
  for (const p of pieces(c, color)) if (p.type !== "k" && p.type !== "p") per.set(at(p), 0);
  for (const m of moves) {
    const key = `${PIECE_NAMES[m.piece]} on ${m.from}`;
    if (per.has(key)) per.set(key, per.get(key)! + 1);
  }
  const sorted = [...per.entries()].sort((a, b) => b[1] - a[1]);
  return { mobility: moves.length, mostActive: sorted[0]?.[0], leastActive: sorted[sorted.length - 1]?.[0] };
}

/** Squares `color` attacks, grouped as a count plus the ones near the other king and in the centre. */
export function control(chess: Chess, color: Color): { count: number; nearEnemyKing: string[]; inEnemyHalf: number } {
  const enemyKing = pieces(chess, other(color)).find((p) => p.type === "k")!;
  let count = 0, inEnemyHalf = 0;
  const near: string[] = [];
  for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) {
    const s = toSq(f, r);
    if (!chess.isAttacked(s, color)) continue;
    count++;
    if ((color === "w" && r >= 4) || (color === "b" && r <= 3)) inEnemyHalf++;
    if (Math.max(Math.abs(f - fileOf(enemyKing.square)), Math.abs(r - rankOf(enemyKing.square))) === 1) near.push(s);
  }
  return { count, nearEnemyKing: near, inEnemyHalf };
}

/** opening / middlegame / endgame, from development and the material left. */
export function phase(chess: Chess): "opening" | "middlegame" | "endgame" {
  const all = pieces(chess);
  const nonPawn = all.filter((p) => p.type !== "p" && p.type !== "k").reduce((s, p) => s + VALUE[p.type], 0);
  const queens = all.filter((p) => p.type === "q").length;
  if (nonPawn <= 26 || (queens === 0 && nonPawn <= 34)) return "endgame";
  const undeveloped = development(chess, "w").undeveloped.length + development(chess, "b").undeveloped.length;
  if (chess.moveNumber() <= 12 && undeveloped >= 3) return "opening";
  return "middlegame";
}

export { hangingPieces };

// ---------- why a move is illegal ----------

function between(from: string, to: string): Square[] {
  const df = Math.sign(fileOf(to) - fileOf(from)), dr = Math.sign(rankOf(to) - rankOf(from));
  const out: Square[] = [];
  let f = fileOf(from) + df, r = rankOf(from) + dr;
  while (toSq(f, r) !== to && onBoard(f, r)) { out.push(toSq(f, r)); f += df; r += dr; }
  return out;
}

/** Can the piece on `from` reach `to` by its movement rules (ignoring checks)? If not, why. */
function geometry(chess: Chess, from: Square, to: Square): string | undefined {
  const p = chess.get(from)!;
  const dest = chess.get(to);
  const name = PIECE_NAMES[p.type];
  if (from === to) return `your ${name} is already on ${to}`;
  if (dest && dest.color === p.color) return `${to} is occupied by your own ${PIECE_NAMES[dest.type]}`;
  const df = fileOf(to) - fileOf(from), dr = rankOf(to) - rankOf(from);
  const ad = Math.abs(df), ar = Math.abs(dr);
  const blocked = () => {
    const b = between(from, to).find((s) => chess.get(s));
    if (!b) return undefined;
    const q = chess.get(b)!;
    return `your ${name} on ${from} is blocked by ${q.color === p.color ? "your" : "my"} ${PIECE_NAMES[q.type]} on ${b}`;
  };
  switch (p.type) {
    case "n":
      return (ad === 1 && ar === 2) || (ad === 2 && ar === 1) ? undefined : `a knight on ${from} can't jump to ${to}; knights move in an L shape`;
    case "k":
      return ad <= 1 && ar <= 1 ? undefined : "the king only moves one square at a time, except when castling";
    case "b":
      return ad === ar ? blocked() : `bishops move diagonally, and ${to} isn't on a diagonal from ${from}`;
    case "r":
      return df === 0 || dr === 0 ? blocked() : `rooks move in straight lines, and ${to} isn't on the same rank or file as ${from}`;
    case "q":
      return ad === ar || df === 0 || dr === 0 ? blocked() : `${to} isn't in a straight line or diagonal from your queen on ${from}`;
    case "p": {
      const dir = p.color === "w" ? 1 : -1;
      const startRank = p.color === "w" ? 1 : 6;
      if (dr * dir <= 0) return "pawns only move forward";
      if (df === 0) {
        if (dr === dir) return dest ? `a pawn can't capture straight ahead, and ${to} is occupied` : undefined;
        if (dr === 2 * dir) {
          if (rankOf(from) !== startRank) return "a pawn can only move two squares on its first move";
          const mid = toSq(fileOf(from), rankOf(from) + dir);
          if (chess.get(mid)) return `the square in front, ${mid}, is blocked`;
          return dest ? `${to} is occupied` : undefined;
        }
        return "a pawn moves one square forward, or two from its starting square";
      }
      if (ad === 1 && dr === dir) {
        const ep = chess.fen().split(" ")[3];
        return dest || ep === to ? undefined : `pawns capture diagonally, and there's nothing to take on ${to}`;
      }
      return "pawns move straight forward and capture one square diagonally";
    }
  }
}

/** Why castling is not possible for `color` on `side` right now, or undefined if it is legal. */
export function castleWhy(chess: Chess, color: Color, side: "k" | "q"): string | undefined {
  const sideName = side === "k" ? "kingside" : "queenside";
  const c = withTurn(chess, color) ?? new Chess(chess.fen());
  const legal = c.turn() === color && c.moves({ verbose: true }).some((m) => m.flags.includes(side));
  if (legal) return chess.turn() === color ? undefined : `you can castle ${sideName} on your turn`;
  const rights = chess.getCastlingRights(color) as Record<string, boolean>;
  if (!rights[side]) return `you've lost the right to castle ${sideName}: your king or that rook has already moved`;
  if (chess.turn() === color && chess.inCheck()) return "you can't castle while in check";
  const back = color === "w" ? "1" : "8";
  const empty = side === "k" ? ["f", "g"] : ["b", "c", "d"];
  const occupied = empty.map((f) => `${f}${back}` as Square).filter((s) => chess.get(s));
  if (occupied.length) return `the pieces between your king and rook are still there: ${joinAnd(occupied.map((s) => `${PIECE_NAMES[chess.get(s)!.type]} on ${s}`))}`;
  const pass = (side === "k" ? ["f", "g"] : ["d", "c"]).map((f) => `${f}${back}` as Square);
  const hit = pass.find((s) => chess.isAttacked(s, other(color)));
  if (hit) {
    const by = chess.attackers(hit, other(color))[0];
    return `your king would pass through or land on ${hit}, which my ${PIECE_NAMES[chess.get(by)!.type]} on ${by} attacks`;
  }
  return `castling ${sideName} isn't possible right now`;
}

/**
 * Plain-language reason a move can't be played. `piece` and `from` narrow which of the user's pieces was meant.
 * Returns undefined when some piece of that kind can legally go there.
 */
export function explainIllegal(chess: Chess, color: Color, target: { to?: string; piece?: PieceSymbol; from?: string; castle?: "k" | "q" | "any"; capture?: boolean }): string | undefined {
  if (target.castle === "any") {
    // A bare "castle": explain only when neither side works, using the side whose right is still there.
    const k = castleWhy(chess, color, "k");
    const q = castleWhy(chess, color, "q");
    return k && q ? (/lost the right/.test(k) ? q : k) : undefined;
  }
  if (target.castle) return castleWhy(chess, color, target.castle);
  const to = target.to?.toLowerCase() as Square | undefined;
  if (!to || !/^[a-h][1-8]$/.test(to)) return "I couldn't tell which square you meant";
  const c = withTurn(chess, color);
  if (!c) return "it isn't your move right now";
  // "Takes a6" with nothing there: that is the reason, whatever piece was meant.
  const victim = c.get(to);
  const epSquare = c.fen().split(" ")[3];
  if (target.capture && (!victim || victim.color === color) && epSquare !== to) {
    return victim ? `${to} has your own ${PIECE_NAMES[victim.type]} on it` : `there's nothing on ${to} to take`;
  }
  const candidates = pieces(c, color).filter((p) => (!target.piece || p.type === target.piece) && (!target.from || p.square === target.from));
  if (candidates.length === 0) {
    if (target.from) return `you don't have ${target.piece ? `a ${PIECE_NAMES[target.piece]}` : "a piece"} on ${target.from}`;
    return target.piece ? `you don't have a ${PIECE_NAMES[target.piece]} anymore` : "you have no piece that could go there";
  }
  const legal = c.moves({ verbose: true });
  if (candidates.some((p) => legal.some((m) => m.from === p.square && m.to === to))) return undefined;
  const reasons: string[] = [];
  for (const p of candidates) {
    const g = geometry(c, p.square, to);
    if (g) { reasons.push(g); continue; }
    // The move is fine by itself: it must leave the king in check.
    if (c.inCheck()) { reasons.push(`you're in check, and moving your ${PIECE_NAMES[p.type]} to ${to} doesn't get you out of it`); continue; }
    if (p.type === "k") {
      const by = c.attackers(to, other(color))[0];
      reasons.push(by ? `${to} is attacked by my ${PIECE_NAMES[c.get(by)!.type]} on ${by}, so your king can't go there` : `your king can't go to ${to}: it would be in check`);
      continue;
    }
    const pin = pins(c, color).find((x) => x.absolute && x.piece === `${PIECE_NAMES[p.type]} on ${p.square}`);
    reasons.push(pin ? `your ${pin.piece} is pinned to your king by my ${pin.by}` : `moving your ${PIECE_NAMES[p.type]} there would leave your king in check`);
  }
  // The most useful reason first: "legal-looking but…" (check, pin, attacked square), then a piece that could go
  // there but is blocked, then the plain movement rule.
  const rank = (r: string) => (/check|pinned|attacked by/.test(r) ? 0 : /blocked|occupied/.test(r) ? 1 : 2);
  const best = [...reasons].sort((a, b) => rank(a) - rank(b))[0];
  // No piece named: one random piece's movement rule ("your rook on a1 is blocked") would only confuse.
  if (!target.piece && rank(best) > 0) return `none of your pieces can reach ${to}`;
  if (candidates.length === 1 || rank(best) < 2) return best;
  return `none of your ${PIECE_PLURALS[candidates[0].type]} can reach ${to}`;
}

/** Moves of the side to move that a full list would include, spoken, for "describe the legal moves". */
export function movesByPiece(chess: Chess): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of chess.moves({ verbose: true }) as Move[]) {
    const key = `${PIECE_NAMES[m.piece]} on ${m.from}`;
    (out[key] ??= []).push(m.to);
  }
  return out;
}
