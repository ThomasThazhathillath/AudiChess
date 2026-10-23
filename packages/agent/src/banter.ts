// Jabs and compliments: a playful rival, never a coach (2026-10-17: "no unsolicited warnings or coaching... throw
// short jabs when I play badly or she wins material, short appreciations when I play well").
//
// The lines are the user's own list, word for word; the number is its place in that list (Part 1 = taunts,
// Part 2 = appreciations). Lines that claim something the server can't check (pins, outposts, the clock...) were
// left out, and lines that claim a fact (a fork, a knight, a second check) sit in their own gated category.
// To add lines, append them to a category.
//
// 2026-10-23 (Phase 10b, "make banter friendlier, more jabs... don't remove insults, I want more of all that"):
// every line of the list stays. Unnumbered lines are new: friendly teasing and cheering. She speaks more often, and
// also says one of them on a quiet move (`tease`, `cheer`).

export const TAUNTS = {
  /** Your move lost 150+ cp. */
  blunder: [
    "Is that really your best move?", // 1
    "Did you mean to do that?", // 2
    "That move needs a second opinion.", // 5
    "Did you forget what your plan was?", // 14
    "That move came out of nowhere.", // 16
    "I hope that move had a plan.", // 18
    "Are you trying to confuse me or yourself?", // 20
    "Ouch! That was expensive.", // 51
    "That's going to hurt.", // 53
    "Your last move changed everything.", // 56
    "That square was dangerous!", // 57
    "One move can change a game.", // 59
    "I think you missed something.", // 60
    "That was a costly oversight.", // 61
    "The tactics were hiding in plain sight.", // 62
    "You may want that move back.", // 63
    "My opponent has entered the danger zone.", // 64
    "That move opened a door for me.", // 65
    "A small mistake, a big problem.", // 67
    "I think something just slipped through.", // 68
    "The position just took a turn.", // 71
    "Did you see what that move allowed?", // 72
    "Your defense has a hole in it.", // 73
    "That was a missed detail.", // 74
    "Ooh, I'll happily take that chance!",
    "Oops! Looks like my lucky day.",
    "Don't worry, plenty of game left.",
    "Hehe, I was hoping you'd do that.",
    "Well, that just made my day!",
  ],
  /** She just won material you left. */
  gift: [
    "Did you just give that piece away?", // 52
    "A free piece? Don't mind if I do.", // 54
    "I wasn't expecting a gift today.", // 55
    "You left that piece undefended.", // 58
    "That piece had better days.", // 69
    "You gave me exactly what I needed.", // 70
    "I'll gladly accept that mistake.", // 75
    "Ooh, a present! You shouldn't have.",
    "Thank you kindly! I'll look after it.",
    "Yoink! Sorry, I couldn't resist.",
  ],
  giftQueen: ["Did your queen just give up?", "Your queen? Feeling generous today!"], // 7, new
  /** An inaccuracy (60-150 cp). */
  odd: [
    "I think your pieces are confused.", // 3
    "Are we playing chess or guessing?", // 4
    "I wasn't expecting that. Neither was your king.", // 8
    "Your pieces seem to be on vacation.", // 9
    "That's certainly one way to play chess.", // 10
    "Even my pawns are surprised.", // 12
    "Your pieces need a team meeting.", // 17
    "That's a bold choice.", // 21
    "This board is getting entertaining.", // 24
    "I didn't know we were experimenting today.", // 25
    "Ooh, unusual! I like it.",
    "You're full of surprises today.",
    "Now that's a move with personality.",
  ],
  oddKnight: ["Your knight took the scenic route."], // 22
  /** Her move gives check. */
  check: [
    "Your king looks a little nervous.", // 13
    "Your king seems lost.", // 23
    "Your king has nowhere comfortable to go.", // 48
    "Check! Your king is under pressure.", // 76
    "Your king can't hide forever.", // 77
    "The hunt is on.", // 78
    "Your king needs an escape plan.", // 79
    "There's no peace for your king today.", // 80
    "The king's safety is becoming a problem.", // 81
    "I've got my eyes on your king.", // 82
    "Your king is running out of shelter.", // 84
    "The attack is getting closer.", // 85
    "Your king is getting a little too much attention.", // 87
    "The walls are closing in.", // 88
    "Your king's neighborhood is dangerous.", // 89
    "Your king needs some backup.", // 91
    "That king has nowhere to relax.", // 93
    "Your king is walking a tightrope.", // 96
    "The danger is real now.", // 97
    "Every escape square matters.", // 98
    "Your king is in the spotlight.", // 99
    "One wrong move could be fatal.", // 100
  ],
  checkAgain: ["Check again! Still comfortable?", "The checking moves keep coming."], // 86, 92
  /** Her move attacks your queen / your rook. */
  queen: [
    "Your queen looks vulnerable now.", // 66
    "Your queen looks lonely.", // 126
    "That's a lot of responsibility for one queen.", // 128
    "Your queen might be overextended.", // 133
    "Your queen has a lot to worry about.", // 141
    "Your queen is doing too much work.", // 148
  ],
  rook: ["Your rook needs an escape route.", "Your rook is running out of useful moves."], // 129, 146
  /** Her move forks. */
  fork: [
    "Did you see the fork?", // 101
    "The combination is coming together.", // 111
    "I have a little tactical idea.", // 114
    "You left a tactical opportunity open.", // 124
  ],
  forkKnight: ["My knight has a little surprise."], // 105
  /** Her capture or attack, by the piece that made it. */
  knight: ["My knight is having a wonderful day.", "My knight has found the perfect square.", "My knight is causing problems again.", "My knight has all the right squares."], // 6, 118, 135, 144
  bishop: ["My bishop sends its regards.", "My bishop sees the whole board.", "My bishop has a clear view."], // 15, 130, 147
  rookMine: ["My rook is enjoying this.", "My rook is ready for action."], // 19, 132
  queenMine: ["My queen has entered the conversation.", "My queen is feeling dangerous."], // 127, 137
  pieces: [
    "My pieces are exactly where I want them.", // 32
    "My pieces are working together beautifully.", // 46
    "My pieces are coordinating better.", // 123
    "My pieces are finding their rhythm.", // 142
    "My pieces have found their targets.", // 150
  ],
  /** The game swung her way without a blunder of yours. */
  pressure: [
    "I've got this position under control.", // 26
    "You're playing on my board now.", // 27
    "I see everything you're trying to do.", // 28
    "Your position is getting uncomfortable.", // 29
    "I've planned three moves ahead.", // 30
    "You're running out of good options.", // 31
    "The pressure is building.", // 33
    "I like my chances here.", // 34
    "Your defenses are starting to crack.", // 35
    "I've got a plan you haven't seen yet.", // 36
    "You're making this too easy.", // 37
    "My king sleeps peacefully.", // 38
    "The initiative is mine.", // 39
    "Your position is looking fragile.", // 40
    "I'm dictating the pace now.", // 41
    "The board is telling my story.", // 42
    "You're running out of room.", // 43
    "Every square has a purpose.", // 44
    "I've got the upper hand.", // 45
    "The attack is only getting stronger.", // 47
    "I can feel the momentum shifting.", // 49
    "This position suits me perfectly.", // 50
  ],
  /** The first time the game reaches the endgame. */
  endgame: [
    "Welcome to the endgame.", // 151
    "The pawns are starting to matter.", // 152
    "Every tempo counts now.", // 159
    "The finish line is getting closer.", // 169
    "The endgame is where patience pays.", // 175
  ],
  endgameAhead: ["The endgame favors me."], // 156
  /** Her pawn reached its 6th or 7th rank. */
  promotion: [
    "That pawn race looks dangerous.", // 155
    "My pawn is getting ideas.", // 161
    "The promotion race is on.", // 163
    "That passed pawn won't stop itself.", // 164
    "You can't ignore that pawn forever.", // 168
    "That promotion threat is serious.", // 173
    "One pawn can make all the difference.", // 174
  ],
  /** She is clearly winning and nothing else happened. */
  winning: [
    "The position demands precision.", // 191
    "One last calculation could decide it.", // 192
    "Stay focused; the game isn't over.", // 194
    "There's still time for a comeback.", // 195
    "The next move could change everything.", // 196
    "Can you hold the position together?", // 199
    "Let's see who finishes stronger.", // 200
  ],
  /** Friendly teasing on a quiet move, now and then. Claims nothing about the position. */
  tease: [
    "I'm watching you!",
    "Don't get too comfortable over there.",
    "I'm just getting warmed up.",
    "Hmm, what are you up to?",
    "You're keeping me on my toes.",
    "I've still got a few tricks left.",
    "Bring it on!",
    "Let's make this interesting.",
    "You're trickier than you look.",
    "Oh, you're making me work today.",
    "I'm not scared. Well, maybe a little.",
    "My pieces are plotting something. Probably.",
  ],
} as const;

export const PRAISE = {
  /** Your best move in a sharp spot, or a swing your way. */
  good: [
    "Excellent move!", // 1
    "Well played!", // 2
    "Brilliant choice!", // 3
    "Very nicely done.", // 4
    "That's a strong move.", // 5
    "Impressive calculation.", // 6
    "Beautifully played.", // 7
    "You found the right move.", // 8
    "Great decision!", // 9
    "That was precise.", // 10
    "A very solid choice.", // 11
    "You handled that well.", // 12
    "Excellent positional awareness.", // 13
    "That's clever chess.", // 14
    "Very good technique.", // 15
    "A smart and practical move.", // 16
    "Nicely spotted!", // 17
    "That's a confident move.", // 18
    "Well calculated.", // 19
    "You're playing some excellent chess.", // 20
  ],
  /** You won material. */
  tactic: [
    "Brilliant tactic!", // 21
    "What a combination!", // 22
    "You spotted the winning tactic.", // 26
    "A fantastic tactical sequence.", // 28
    "You saw that several moves ahead.", // 31
    "You found the hidden resource.", // 35
    "That tactic was hard to spot.", // 37
    "Excellent calculation under pressure.", // 38
    "A very sharp combination.", // 39
    "You made the tactics look effortless.", // 40
  ],
  /** Your move forks. */
  fork: ["Excellent fork!", "What a double attack!"], // 23, 30
  /** Your best move, quietly improving. */
  positional: [
    "Excellent positional play.", // 41
    "Great piece coordination.", // 43
    "You found the perfect square.", // 47
    "That's a strong positional decision.", // 49
    "Your pieces are working together perfectly.", // 50
    "Excellent long-term planning.", // 51
    "That was a patient maneuver.", // 53
    "You understood the position very well.", // 55
  ],
  /** Your good move gives check. */
  attack: [
    "What a powerful attack!", // 56
    "Excellent attacking instincts.", // 57
    "That was a dangerous initiative.", // 58
    "You built the attack beautifully.", // 59
    "Your pieces attacked in perfect harmony.", // 62
    "That was a brilliant attacking idea.", // 63
    "You found the right moment to strike.", // 65
    "That attack was very well coordinated.", // 67
    "You kept the pressure on perfectly.", // 68
  ],
  /** You checkmated me. */
  mate: ["A beautiful mating pattern.", "A devastating combination.", "What a finish!"], // 66, 69, 70
  /** Your best move while in check or with a piece attacked. */
  defense: [
    "Excellent defense!", // 71
    "What a resourceful move.", // 72
    "Great defensive awareness.", // 74
    "That's a wonderful escape.", // 75
    "You neutralized the attack beautifully.", // 76
    "Very resilient play.", // 77
    "You held your position together.", // 78
    "That was a clever defensive resource.", // 79
    "You defended with great precision.", // 80
  ],
  /** Your best move in the endgame. */
  endgame: ["Excellent endgame technique.", "That's a textbook endgame.", "You made every tempo count."], // 81, 85, 90
  endgameKing: ["Great king activity."], // 82
  endgameAhead: ["You converted the advantage well.", "You found the winning plan."], // 86, 88
  /** Cheering on a quiet move, now and then, while the user isn't clearly losing. */
  cheer: [
    "Nice and steady.",
    "I like your style.",
    "This is a fun game!",
    "Good thinking.",
    "Ooh, solid.",
    "I'm enjoying this one.",
    "Love the confidence!",
    "You're a pleasure to play against.",
    "Good one. I'm thinking hard now.",
    "Lovely. Keep them coming!",
  ],
} as const;

export const ENDINGS = {
  youWin: ["Good game!", "You're a worthy opponent.", "Keep playing like that!", "Well played, and good luck in your next game!"], // 91, 93, 97, 100
  iWin: ["Good game!", "Thanks for the match.", "That was a fun game.", "I enjoyed that challenge.", "You made me think.", "You fought hard until the end."], // 91, 92, 94, 95, 96, 99
  draw: ["Good game!", "Thanks for the match.", "That was a fun game.", "That was a close contest."], // 91, 92, 94, 98
} as const;

/** What the agent remembers between turns: lines already used this game and how long it has been quiet. */
export interface BanterState {
  gameId?: string;
  used: string[];
  /** User moves since the last remark. */
  quiet: number;
  /** Her previous move gave check. */
  lastCheck?: boolean;
  /** "Welcome to the endgame" was already said. */
  endgame?: boolean;
  /** User moves this game, so the opening moves are announced plainly. */
  moves?: number;
}

export interface Banter {
  mood: "taunt" | "praise" | "ending";
  /** The event, for the model in chatty mode ("the user blundered"). */
  event: string;
  line: string;
  /** A few lines from the same pool, the picked one first (examples for the model). */
  examples: string[];
}
/**
 * How many quiet moves (user moves without a remark) each kind of remark waits for. The first sim gave a remark on
 * half of all moves (2026-10-17, rival-sim), so the gaps were 1, 2 and 3 moves. 2026-10-23: the user wants more of
 * it ("I want more of all that"): a blunder is jabbed at once, everything else waits one move.
 */
const GAP = { end: 0, big: 0, mid: 1, minor: 1 } as const;
/** The chance of a friendly tease or cheer on a move where nothing else happened. */
const CHAT_CHANCE = 0.6;
/** No friendly chatter on the first moves of a game: they are announced plainly. */
const OPENING_MOVES = 3;
type Tier = keyof typeof GAP;

interface MoveResult {
  gameOverText?: unknown;
  commentary?: {
    yourMove?: { quality?: string; lossCp?: number };
    swing?: { direction?: string };
    trend?: string;
    yourMoveIdeas?: string[];
    myMoveIdeas?: string[];
  };
  moveFacts?: {
    yourPiece?: string;
    youCaptured?: string;
    youGaveCheck?: boolean;
    myPiece?: string;
    iCaptured?: string;
    iGaveCheck?: boolean;
    iTookYourPiece?: boolean;
    materialChange?: number;
    materialBalance?: number;
    evalForYou?: number;
    wasInCheck?: boolean;
    hadPieceAttacked?: boolean;
    phase?: string;
    myPawnNearPromotion?: boolean;
    winner?: "you" | "me" | "draw";
  };
}

type Pick = { tier: Tier; mood: Banter["mood"]; event: string; pools: readonly (readonly string[])[] };

/** The most important thing that happened this turn, as a remark to make, or nothing. */
function eventOf(r: MoveResult, state: BanterState, rng: () => number): Pick | undefined {
  const f = r.moveFacts ?? {};
  const c = r.commentary ?? {};
  const q = c.yourMove?.quality;
  const mine = c.myMoveIdeas ?? [];
  const yours = c.yourMoveIdeas ?? [];
  const best = q === "best";
  const change = f.materialChange ?? 0;
  if (f.winner === "you") return { tier: "end", mood: "ending", event: "the user checkmated you and won", pools: [PRAISE.mate] };
  if (f.winner === "me") return { tier: "end", mood: "ending", event: "you won the game", pools: [ENDINGS.iWin] };
  if (f.winner === "draw") return { tier: "end", mood: "ending", event: "the game is a draw", pools: [ENDINGS.draw] };
  if (f.iCaptured && change <= -2 && (q === "blunder" || q === "mistake" || change <= -3)) {
    return { tier: change <= -3 ? "big" : "mid", mood: "taunt", event: `the user left a ${f.iCaptured} and you took it`, pools: f.iCaptured === "queen" ? [TAUNTS.gift, TAUNTS.giftQueen] : [TAUNTS.gift] };
  }
  if (q === "blunder") return { tier: "big", mood: "taunt", event: "the user's move was a blunder", pools: [TAUNTS.blunder] };
  if (mine.some((i) => i.startsWith("forks"))) return { tier: "big", mood: "taunt", event: "your move forks two of their pieces", pools: f.myPiece === "knight" ? [TAUNTS.fork, TAUNTS.forkKnight] : [TAUNTS.fork] };
  // Only a fork that survives: "Bishop takes d5. I take your bishop. Excellent fork!" (sim, 2026-10-17).
  if (yours.some((i) => i.startsWith("forks")) && !f.iTookYourPiece) return { tier: "big", mood: "praise", event: "the user's move forks two of your pieces", pools: [PRAISE.fork] };
  if (f.youCaptured && change >= 3) return { tier: "big", mood: "praise", event: `the user won material: they took your ${f.youCaptured}`, pools: [PRAISE.tactic] };
  if (q === "mistake") return { tier: "mid", mood: "taunt", event: "the user's move was a mistake", pools: [TAUNTS.blunder] };
  if (f.youCaptured && change >= 2) return { tier: "mid", mood: "praise", event: `the user won material: they took your ${f.youCaptured}`, pools: [PRAISE.tactic] };
  if (best && c.swing?.direction === "your way") {
    return { tier: "mid", mood: "praise", event: "the user found a strong move", pools: [f.youGaveCheck ? PRAISE.attack : f.wasInCheck || f.hadPieceAttacked ? PRAISE.defense : PRAISE.good] };
  }
  // Flavour: only after three quiet moves (checked by the caller), so the rare ones below get their turn.
  if (f.iGaveCheck) return { tier: "minor", mood: "taunt", event: "your move gives check", pools: state.lastCheck ? [TAUNTS.check, TAUNTS.checkAgain] : [TAUNTS.check] };
  if (mine.some((i) => i.startsWith("attacks the queen"))) return { tier: "minor", mood: "taunt", event: "your move attacks their queen", pools: [TAUNTS.queen] };
  if (mine.some((i) => i.startsWith("attacks the rook"))) return { tier: "minor", mood: "taunt", event: "your move attacks their rook", pools: [TAUNTS.rook] };
  if (f.myPawnNearPromotion) return { tier: "minor", mood: "taunt", event: "your pawn is one step from promoting", pools: [TAUNTS.promotion] };
  if (f.phase === "endgame" && !state.endgame) {
    return { tier: "minor", mood: "taunt", event: "the game just reached the endgame", pools: (f.evalForYou ?? 0) < -100 ? [TAUNTS.endgame, TAUNTS.endgameAhead] : [TAUNTS.endgame] };
  }
  if (c.swing?.direction === "my way") return { tier: "minor", mood: "taunt", event: "the game is swinging your way", pools: [TAUNTS.pressure] };
  if (q === "inaccuracy") return { tier: "minor", mood: "taunt", event: "the user's move was a little inaccurate", pools: f.yourPiece === "knight" ? [TAUNTS.odd, TAUNTS.oddKnight] : [TAUNTS.odd] };
  if (best && f.youGaveCheck) return { tier: "minor", mood: "praise", event: "the user's good move gives check", pools: [PRAISE.attack] };
  if (best && (f.wasInCheck || f.hadPieceAttacked)) return { tier: "minor", mood: "praise", event: "the user defended well", pools: [PRAISE.defense] };
  if (best && f.phase === "endgame") {
    return { tier: "minor", mood: "praise", event: "the user played the endgame well", pools: [PRAISE.endgame, ...(f.yourPiece === "king" ? [PRAISE.endgameKing] : []), ...((f.evalForYou ?? 0) >= 300 ? [PRAISE.endgameAhead] : [])] };
  }
  if (best && c.trend === "improving") return { tier: "minor", mood: "praise", event: "the user is playing well", pools: [PRAISE.positional] };
  const winning = (f.evalForYou ?? 0) <= -300 || (f.materialBalance ?? 0) <= -3;
  if (winning && rng() < 0.35) return { tier: "minor", mood: "taunt", event: "you are clearly winning", pools: [TAUNTS.winning] };
  if ((f.iCaptured || mine.some((i) => i.startsWith("attacks"))) && rng() < 0.5) {
    const own = f.myPiece === "knight" ? TAUNTS.knight : f.myPiece === "bishop" ? TAUNTS.bishop : f.myPiece === "rook" ? TAUNTS.rookMine : f.myPiece === "queen" ? TAUNTS.queenMine : undefined;
    return { tier: "minor", mood: "taunt", event: `your ${f.myPiece ?? "piece"} is active`, pools: own ? [own, TAUNTS.pieces] : [TAUNTS.pieces] };
  }
  // Nothing happened: a friendly word now and then, so she sounds like company and not a move announcer.
  if ((state.moves ?? 0) >= OPENING_MOVES && state.quiet >= GAP.minor && rng() < CHAT_CHANCE) {
    const losing = (f.evalForYou ?? 0) <= -200 || (f.materialBalance ?? 0) <= -2;
    if (!losing && rng() < 0.5) return { tier: "minor", mood: "praise", event: "a quiet move; cheer them on", pools: [PRAISE.cheer] };
    return { tier: "minor", mood: "taunt", event: "a quiet move; tease them in a friendly way", pools: [TAUNTS.tease] };
  }
  return undefined;
}

/**
 * The jab or compliment for this move, if one fits, from the server's facts only. Pure: the caller stores the
 * returned state in the session. `rng` decides the optional remarks and which line of a pool is said.
 */
export function pickBanter(result: Record<string, unknown>, prev: BanterState | undefined, gameId: string | undefined, rng: () => number = Math.random): { banter?: Banter; state: BanterState } {
  const r = result as MoveResult;
  const f = r.moveFacts ?? {};
  const state: BanterState = prev && prev.gameId === gameId ? { ...prev, used: [...prev.used] } : { gameId, used: [], quiet: GAP.minor };
  const pick = eventOf(r, state, rng);
  state.moves = (state.moves ?? 0) + 1;
  state.lastCheck = !!f.iGaveCheck;
  if (f.phase === "endgame") state.endgame = true; // announced at most once, and never late
  // Something happened but she spoke too recently: stay quiet (a smaller event never takes its place).
  if (!pick || state.quiet < GAP[pick.tier]) {
    state.quiet++;
    return { state };
  }
  const pool = [...new Set(pick.pools.flat())];
  const fresh = pool.filter((l) => !state.used.includes(l));
  const choices = fresh.length ? fresh : pool; // every line of the pool used this game: start over
  const line = choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))];
  // The game's end gets its parting words too: "What a finish! Good game!".
  const ending = f.winner === "you" ? ENDINGS.youWin[Math.min(ENDINGS.youWin.length - 1, Math.floor(rng() * ENDINGS.youWin.length))] : "";
  const spoken = ending ? `${line} ${ending}` : line;
  state.used = [...state.used, line].slice(-80);
  state.quiet = 0;
  const examples = [line, ...choices.filter((l) => l !== line).slice(0, 2)];
  return { banter: { mood: pick.mood, event: pick.event, line: spoken, examples }, state };
}
