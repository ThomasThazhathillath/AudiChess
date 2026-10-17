// The user's 305 questions (2026-10-16), grouped as they wrote them, each with the scenario it is asked in.
// Scenario ids are defined in scripts/qa-eval.ts.

export type ScenarioId =
  | "italian" | "sicilian" | "in_check" | "fork" | "mate1" | "queen_attacked" | "pin"
  | "endgame_pawn" | "endgame_rook" | "history" | "game_over" | "no_game" | "prior_answer";

export interface Question {
  n: number;
  category: string;
  text: string;
  scenario: ScenarioId;
}

type Group = { category: string; scenario: ScenarioId; questions: (string | [string, ScenarioId])[] };

const GROUPS: Group[] = [
  { category: "Board position", scenario: "italian", questions: [
    "Where is my king?", "Where is my queen?", "Where are my knights?", "Where are my bishops?", "Where are my rooks?",
    "Where are my pawns?", "Where is my opponent's queen?", "What piece is on E4?", "Is square F7 occupied?",
    "Where are all my opponent's pieces?", ["Which pieces do I have left?", "history"], ["Which pieces has my opponent lost?", "history"],
    "Can you describe the current board?", "What is the current position?", "Which squares are occupied by my pieces?",
  ] },
  { category: "Legal moves", scenario: "italian", questions: [
    "What moves can my knight make?", "What moves can my bishop make?", "What moves can my rook make?",
    "What moves can my queen make?", "What moves can my king make?", "What moves can my pawn make?",
    "What are all my legal moves?", "Can I move my king to E2?", "Can I move my queen to H5?",
    "Can my pawn move two squares?", "Can my knight jump over pieces?", "Can my bishop move through another piece?",
    ["Can I capture that piece?", "queen_attacked"], ["Can my king capture this piece?", "in_check"], "Why is this move illegal?",
    "Can I castle kingside?", "Can I castle queenside?", ["Can I promote my pawn?", "endgame_pawn"], "Can I promote to a knight?",
    ["Can I move while in check?", "in_check"],
  ] },
  { category: "Check and checkmate", scenario: "in_check", questions: [
    "Am I in check?", ["Is my opponent in check?", "italian"], ["Is this checkmate?", "in_check"], ["Can I checkmate my opponent in one move?", "mate1"],
    "Can I get out of check?", "Can I block the check?", "Can I capture the attacking piece?", "Can my king escape?",
    ["Is my king safe?", "italian"], ["Can my opponent checkmate me next move?", "italian"], ["Is there a forced checkmate?", "mate1"],
    ["How many moves until checkmate?", "mate1"], "Can I avoid checkmate?", ["Is there a back-rank checkmate?", "mate1"], ["Can I force a checkmate?", "mate1"],
  ] },
  { category: "Threats and defence", scenario: "queen_attacked", questions: [
    "Is my queen under attack?", "Is my king under threat?", "Which of my pieces are under attack?",
    "Which opponent pieces are undefended?", "Am I about to lose a piece?", ["Is my rook trapped?", "italian"],
    ["Is my knight pinned?", "pin"], ["Is my opponent threatening a fork?", "italian"], "What is my opponent threatening?",
    "What is the biggest threat on the board?", "How can I defend my queen?", ["How can I protect my king?", "italian"],
    ["Can I save my rook?", "italian"], "Can I escape this attack?", ["Is my opponent setting a trap?", "italian"],
  ] },
  { category: "Best moves and hints", scenario: "italian", questions: [
    "What should I play?", "What is my best move?", "Give me a hint.", "Give me a small hint without revealing the answer.",
    "What are my three best moves?", "What is the safest move?", "What is the most aggressive move?",
    "What move would a grandmaster play?", "What is the easiest move to understand?", "Should I attack or defend?",
    "Should I exchange queens?", "Should I trade my bishop for their knight?", "Should I castle now?", "Should I sacrifice a piece?",
    "Can I win material here?", "Can I improve my position?", "What move should I avoid?", "What happens if I move my queen?",
    "What happens if I capture that pawn?", "What is the best move for my knight?",
  ] },
  { category: "Tactics", scenario: "fork", questions: [
    "Is there a fork available?", ["Can I pin an opponent's piece?", "italian"], ["Can I perform a skewer?", "italian"],
    ["Is there a discovered attack?", "italian"], ["Can I give a discovered check?", "italian"], "Is there a double attack?",
    ["Can I trap my opponent's queen?", "italian"], "Can I win a rook with a combination?", ["Can I remove the defender of their queen?", "italian"],
    ["Is there a deflection tactic?", "italian"], ["Can I sacrifice my queen for checkmate?", "mate1"], "Is there a tactical opportunity I am missing?",
    ["Can I force a perpetual check?", "italian"], ["Can I force a draw?", "italian"], "Can I win a piece with a tactic?",
  ] },
  { category: "Strategy and evaluation", scenario: "sicilian", questions: [
    "Who has the better position?", "Am I winning or losing?", "Is this position equal?", "How much material am I ahead?",
    "What is my biggest weakness?", "Which side controls the center?", "Are my pieces well developed?",
    "Which of my pieces is misplaced?", "Is my pawn structure good?", "Do I have isolated pawns?", "Do I have doubled pawns?",
    "Is my bishop better than my opponent's knight?", "Do I have a passed pawn?", "Is my rook on an open file?",
    "How can I improve my king safety?", "Should I attack on the kingside or queenside?", "What is my long-term plan?",
    "Which pieces should I exchange?", "What is the engine evaluation?", "What are my chances of winning?",
  ] },
  { category: "Opening theory", scenario: "italian", questions: [
    "What opening are we playing?", "What is the name of this opening?", "Is this the Italian Game?", ["Is this the Sicilian Defense?", "sicilian"],
    "What is the main idea behind this opening?", "What is the best response to this opening?", ["Have I made an opening mistake?", "history"],
    "Am I following opening theory?", "What is the best move in this position?", "What opening trap should I watch out for?",
    "What is my opponent trying to achieve?", "How should I develop my pieces?", "Should I control the center?",
    "What should I play after my opponent plays E5?", ["How can I punish this opening mistake?", "queen_attacked"],
  ] },
  { category: "Endgame", scenario: "endgame_pawn", questions: [
    "Are we in the endgame?", "How do I win this endgame?", ["How do I draw this position?", "endgame_rook"], "Should I activate my king?",
    "Should I push my passed pawn?", "Can my pawn promote safely?", "Can my opponent stop my pawn from promoting?",
    ["Should I move my rook behind the passed pawn?", "endgame_rook"], "What is the opposition?", ["Can I win with king and rook against king?", "endgame_rook"],
    "Can I win with king and queen against king?", "Is this a theoretically drawn position?", "Should I trade into this endgame?",
    "Can I force a stalemate?", ["How do I defend this rook endgame?", "endgame_rook"],
  ] },
  { category: "Chess rules", scenario: "italian", questions: [
    "What is en passant?", "Can I capture en passant here?", "How does castling work?", "Have I lost the right to castle?",
    "Can I castle while in check?", "Can I castle through an attacked square?", "What happens when my pawn reaches the last rank?",
    "What is stalemate?", "What is a draw by repetition?", "What is the fifty-move rule?", "Can a game end in a draw?",
    "What happens if neither player can checkmate?", "What is the touch-move rule?", "What happens if I make an illegal move?",
    "Can a king capture another king?", "Can I have two queens?", "What is the difference between checkmate and stalemate?",
    "Can I offer a draw at any time?", "What is insufficient material?", "What is threefold repetition?",
  ] },
  { category: "Game history", scenario: "history", questions: [
    "What was my last move?", "What was my opponent's last move?", "Why did my opponent play that move?",
    "What did I play three moves ago?", "Repeat the last five moves.", "What is the move sequence so far?",
    "Can you read the moves aloud?", "What was the first move of the game?", "What is the current move number?",
    "When did I make my first mistake?", "Which was my biggest blunder?", "What was the best move I missed?",
    "Can you show me the game notation?", "Can you explain my last move?", "What would have happened if I had played another move?",
    "Can you analyze the game from move 10?", "What was the position before my last move?", "Was my last move the engine's best move?",
  ] },
  { category: "Clock and time", scenario: "italian", questions: [
    "How much time do I have left?", "How much time does my opponent have?", "Who has more time?", "How much time is left in the game?",
    "Am I running low on time?", "How many seconds do I have to move?", "What is my time control?", "Is this a bullet, blitz or rapid game?",
    "How much increment do I get per move?", "Should I play quickly here?", "How long have I spent thinking about this move?",
  ] },
  { category: "Game controls", scenario: "italian", questions: [
    ["Can we start a new game?", "no_game"], ["Can I play as White?", "no_game"], ["Can I play as Black?", "no_game"],
    ["Can I play against a beginner?", "no_game"], ["Can I play against a stronger opponent?", "no_game"],
    "Can you make the move E2 to E4?", "Can you move my knight to F3?", "Can you castle kingside for me?", ["Can you undo my last move?", "history"],
    "Can you redo the move?", "Can we restart the game?", "Can we pause the game?", "Can we resume the game?", "Can I resign?",
    "Can I offer a draw?", "Can I accept a draw?", "Can you save this game?", ["Can you analyze the game?", "history"], ["Can you tell me the result?", "game_over"],
  ] },
  { category: "AI opponent", scenario: "italian", questions: [
    "How strong are you?", "What is your rating?", "Can you play at my level?", "Can you play like a grandmaster?",
    "Can you make easier moves?", "Can you play more aggressively?", "Can you play defensively?", ["Can you explain your last move?", "history"],
    ["Why did you choose that move?", "history"], "Were you planning a trap?", ["Can I have a rematch?", "game_over"], "Can you play a different opening?",
    "Can you play without using your queen?", "Can you explain every move?", "Can you give me a handicap?", ["Can I take back a mistake?", "history"],
    "Can you play a blindfold chess game?",
  ] },
  { category: "Learning and coaching", scenario: "italian", questions: [
    "Can you teach me chess from the beginning?", "What should a beginner learn first?", "How can I stop making blunders?",
    "How do I calculate variations?", "How many moves ahead should I think?", "How can I improve my rating?",
    ["What are my most common mistakes?", "history"], "Can you quiz me on chess tactics?", "Can you give me a checkmate puzzle?",
    "Can you create a puzzle from this position?", ["Is my move a mistake, an inaccuracy or a blunder?", "history"],
    ["What would have been a better move?", "history"], "Can you explain this position simply?", "Can you teach me forks?",
    "How do I defend against Scholar's Mate?", "Can you train me in endgames?", ["What should I practice after this game?", "history"],
    "Can you make a personalized training plan?", "Can you explain this concept with an example?", ["Can you help me learn from this game?", "history"],
  ] },
  { category: "Natural conversation", scenario: "history", questions: [
    "Am I doing okay?", "Is this a good move?", "Did I mess up?", "What just happened?", "Why is that a bad move?",
    ["Can I save this position?", "queen_attacked"], ["Am I in trouble?", "queen_attacked"], ["How do I get out of this situation?", "queen_attacked"],
    ["What should I be worried about?", "queen_attacked"], ["Is there anything obvious I'm missing?", "queen_attacked"], ["What's the catch?", "queen_attacked"],
    ["Can I win this game?", "italian"], ["Is there a way out?", "in_check"], ["Give me the short version.", "prior_answer"],
    ["Explain everything that's happening.", "italian"], ["Just tell me whether this move is safe.", "italian"],
    ["Don't reveal the best move yet.", "italian"], ["Can you repeat your last answer?", "prior_answer"],
    ["Can you explain that in simpler words?", "prior_answer"], ["Can you speak more slowly?", "italian"],
  ] },
  { category: "Accessibility", scenario: "italian", questions: [
    "Can you describe the board from my perspective?", "Read all my pieces and their positions.", "Tell me which squares are under attack.",
    "Describe the legal moves without a diagram.", "Repeat the coordinates slowly.", "Use full piece names instead of abbreviations.",
    "Announce every move my opponent makes.", "Announce when my king is in check.", "Alert me when a piece is undefended.",
    "Confirm each move before playing it.", "Let me play entirely by voice.", ["Tell me when the game ends.", "italian"],
    ["Read the final result aloud.", "game_over"], "Can you describe the board row by row?", ["Can you tell me which piece moved?", "history"],
  ] },
  { category: "Opponent analysis", scenario: "italian", questions: [
    "What is my opponent planning?", ["Which piece is my opponent trying to attack?", "queen_attacked"], ["What is my opponent's strongest threat?", "queen_attacked"],
    "What is my opponent's weakest piece?", "Which squares does my opponent control?", "Can my opponent force an exchange?",
    "What would my opponent play next?", "What are their best candidate moves?", "What is the most dangerous reply to my move?",
    ["Can my opponent escape if I attack their queen?", "queen_attacked"], "If I make this move, how can they respond?",
    ["What is the worst-case scenario for me?", "queen_attacked"], "Which of my opponent's pieces is most active?",
    "Can my opponent force checkmate?", "What defensive resources does my opponent have?",
  ] },
];

export const QUESTIONS: Question[] = (() => {
  let n = 0;
  return GROUPS.flatMap((g) =>
    g.questions.map((q) => {
      n++;
      const [text, scenario] = typeof q === "string" ? [q, g.scenario] : q;
      return { n, category: g.category, text, scenario };
    }),
  );
})();
