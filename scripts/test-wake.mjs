// Tests for web/wake.js (the wake-word gate) and the pure parts of web/vosk.js (chess ears).
// Run: node scripts/test-wake.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

new Function(readFileSync(new URL("../web/wake.js", import.meta.url), "utf8"))();
const { decide, afterWake, followUpMs, FOLLOW_UP, isOnlyStop } = globalThis.AlexaWake;

// woken: "Alexa" was said (in the utterance or just before it); false in the conversation-mode window.
const closed = { now: 1000, awakeUntil: 0, followUpUntil: 0 };
const cases = [
  [["Alexa, knight to f3"], closed, { action: "send", text: "knight to f3", alternatives: ["knight to f3"], woken: true }],
  [["alexa night forever", "Alexa knight e4"], closed, { action: "send", text: "night forever", alternatives: ["night forever", "knight e4"], woken: true }],
  [["Alexia let's play chess"], closed, { action: "send", text: "let's play chess", alternatives: ["let's play chess"], woken: true }],
  [["hey Alexa"], closed, { action: "awake" }],
  [["Alexa"], closed, { action: "awake" }],
  [["pass the salt"], closed, { action: "ignore" }],
  [["knight f3"], { now: 1000, awakeUntil: 5000, followUpUntil: 0 }, { action: "send", text: "knight f3", alternatives: ["knight f3"], woken: true }],
  [["black please", "black peas"], { now: 1000, awakeUntil: 0, followUpUntil: 3000 }, { action: "send", text: "black please", alternatives: ["black please", "black peas"], woken: false }],
  [["knight f3"], { now: 9000, awakeUntil: 5000, followUpUntil: 8000 }, { action: "ignore" }],
  [[" ", ""], closed, { action: "ignore" }],
  // "easy" started inside the window but Chrome finalised it after the window closed: still counts.
  [["easy"], { now: 9000, awakeUntil: 0, followUpUntil: 8000, speechAt: 7500 }, { action: "send", text: "easy", alternatives: ["easy"], woken: false }],
  [["easy"], { now: 9000, awakeUntil: 0, followUpUntil: 8000, speechAt: 8500 }, { action: "ignore" }],
];

// A lone stop word ("stop", "okay stop") has nothing to send to the agent.
assert.equal(isOnlyStop("Stop."), true);
assert.equal(isOnlyStop("okay stop"), true);
assert.equal(isOnlyStop("stop, what is my best move"), false);
assert.equal(isOnlyStop("knight f3"), false);

let n = 0;
for (const [alts, windows, expected] of cases) {
  assert.deepEqual(decide(alts, windows), expected, `decide(${JSON.stringify(alts)})`);
  n++;
}
assert.equal(afterWake("so Alexa, um, Alexa: bishop c4"), "bishop c4");
assert.equal(afterWake("no wake word here"), "no wake word here");
// Conversation mode: no wake word needed after any reply; long window during a game.
assert.equal(followUpMs({ gameId: "g1", gameOver: false, expectsReply: false }), FOLLOW_UP.inGame);
assert.equal(followUpMs({ expectsReply: true }), FOLLOW_UP.question);
assert.equal(followUpMs({ expectsReply: false }), FOLLOW_UP.other);
assert.equal(followUpMs({ gameId: "g1", gameOver: true }), FOLLOW_UP.other);
assert.equal(followUpMs({ gameId: "g1", error: true }), FOLLOW_UP.other);

// Open mic (the default): no wake word, every phrase is sent; "Alexa" still works and marks it as woken.
const open = { now: 1000, awakeUntil: 0, followUpUntil: 0, openMic: true };
assert.deepEqual(decide(["knight f3", "night f3"], open), { action: "send", text: "knight f3", alternatives: ["knight f3", "night f3"], woken: false });
assert.deepEqual(decide(["what's my best move"], { ...open, now: 999999 }), { action: "send", text: "what's my best move", alternatives: ["what's my best move"], woken: false });
assert.deepEqual(decide(["Alexa, knight f3"], open), { action: "send", text: "knight f3", alternatives: ["knight f3"], woken: true });
assert.deepEqual(decide(["undo"], { ...open, awakeUntil: 5000 }), { action: "send", text: "undo", alternatives: ["undo"], woken: true }); // after a bare "Alexa"
assert.deepEqual(decide(["  "], open), { action: "ignore" });

// Half a move is held for the rest ("knight…" then "f3"); whole moves and other phrases are not.
const { incomplete, isSleep } = globalThis.AlexaWake;
for (const t of ["knight", "Knight.", "my bishop to", "Alexa, rook", "night takes", "move the queen to", "pawn"]) assert.equal(incomplete(t), true, t);
for (const t of ["knight f3", "castle", "e4", "what's the best move", "queen side", "bishop to c4", "the king is safe"]) assert.equal(incomplete(t), false, t);
// Voice off switch for the open mic.
for (const t of ["pause", "Stop listening.", "Alexa, go to sleep", "mute"]) assert.equal(isSleep(t), true, t);
for (const t of ["stop", "pause the game and tell me the score", "knight f3"]) assert.equal(isSleep(t), false, t);
// ...but not when another reading is a pawn or a square ("pause" right after "Did you mean pawn to d4?", 2026-10-17).
const { isSleepCommand } = globalThis.AlexaWake;
assert.equal(isSleepCommand(["pause"]), true);
assert.equal(isSleepCommand(["Pause.", "pause listening", "paws"]), true);
assert.equal(isSleepCommand(["pause", "pawn"]), false);
assert.equal(isSleepCommand(["pause", "porn d4"]), false);
assert.equal(isSleepCommand(["mute", "e4"]), false);
assert.equal(isSleepCommand(["knight f3"]), false);
const { soundsLikeChess } = globalThis.AlexaWake;
assert.equal(soundsLikeChess(["pawn", "paws"]), true);
assert.equal(soundsLikeChess(["paws", "pours"]), false);
// Chrome's "pawn" (2026-10-17 game): a lone "pwn…" / "pont…" is held for the square too.
assert.equal(incomplete("pwn"), true);
assert.equal(incomplete("pont takes"), true);
console.log(`wake.js: ${n + 11 + 5 + 14 + 7 + 10} checks passed`);

// ---------- vosk.js: timeline, hearings, pairing with Chrome ----------
new Function(readFileSync(new URL("../web/vosk.js", import.meta.url), "utf8"))();
const ears = globalThis.ChessEars;
let m = 0;
const check = (fn) => { fn(); m++; };

check(() => {
  // 100 ms chunks at 16 kHz from wall 10 000 ms; a pause, then audio again from 20 000 ms.
  const tl = ears.createTimeline(16000);
  for (let i = 1; i <= 10; i++) tl.feed(1600, 10000 + i * 100); // 1 s of audio ending at 11 000
  assert.equal(tl.wall(0), 10000);
  assert.equal(tl.wall(0.5), 10500);
  tl.gap();
  for (let i = 1; i <= 10; i++) tl.feed(1600, 20000 + i * 100); // stream 1 s.. ends at 21 000
  assert.equal(tl.wall(1), 20000);
  assert.equal(tl.wall(1.25), 20250);
  assert.equal(tl.wall(0.9), 10900); // before the pause still maps to the first segment
});
check(() => {
  // Small jitter keeps the segment; a long stall (main thread busy) re-anchors.
  const tl = ears.createTimeline(16000);
  tl.feed(1600, 1100);
  tl.feed(1600, 1230); // 30 ms late: same segment
  assert.equal(tl.wall(0.1), 1100);
  tl.feed(1600, 3000); // 1.6 s late: new segment from here
  assert.equal(tl.wall(0.2), 2900);
});
check(() => {
  const tl = ears.createTimeline(16000);
  tl.feed(16000, 6000); // 1 s ending at 6 000 -> stream 0 s = 5 000 ms
  const vosk = { text: "alexa knight f three", result: [
    { word: "alexa", start: 0.1, end: 0.4, conf: 1 }, { word: "knight", start: 0.5, end: 0.7, conf: 1 },
    { word: "f", start: 0.75, end: 0.8, conf: 1 }, { word: "three", start: 0.85, end: 0.95, conf: 0.9 }] };
  assert.deepEqual(ears.hearingFrom(vosk, tl), { text: "alexa knight f three", start: 5100, end: 5950 });
  assert.equal(ears.hearingFrom({ text: "" }, tl), null);
  assert.equal(ears.hearingFrom({ text: "", result: [] }, tl), null);
});
check(() => {
  assert.equal(ears.afterWake("alexa knight f three"), "knight f three");
  assert.equal(ears.afterWake("pawn alexa alexa e four"), "e four");
  assert.equal(ears.afterWake("bishop c four"), "bishop c four");
  assert.equal(ears.usable("[unk] [unk]"), false);
  assert.equal(ears.usable(""), false);
  assert.equal(ears.usable("[unk] pawn"), true);
});
check(() => {
  // Chrome: first interim at 5 600, final at 6 500. Vosk heard the move (5 100-5 950) and, earlier, a cough.
  const hearings = [
    { text: "[unk]", start: 1000, end: 1300 },
    { text: "alexa knight f three", start: 5100, end: 5950 },
    { text: "yes", start: 9000, end: 9300 }, // later speech: not this utterance
  ];
  const matches = ears.overlapping(hearings, 5600, 6500);
  assert.deepEqual(matches.map((h) => h.text), ["alexa knight f three"]);
  assert.equal(ears.chessText(matches), "knight f three");
  matches.forEach((h) => { h.used = true; });
  assert.deepEqual(ears.overlapping(hearings, 5600, 6500), []); // a hearing is sent once
});
check(() => {
  // "Alexa ... knight f3" split into two Vosk results inside one Chrome utterance: joined, oldest first.
  const hearings = [{ text: "knight f three", start: 3000, end: 3600 }, { text: "alexa", start: 2000, end: 2300 }];
  assert.equal(ears.chessText(ears.overlapping(hearings, 2500, 4200)), "knight f three");
  // A short "yes" that ended just before Chrome's first interim result still pairs (slack).
  assert.equal(ears.chessText(ears.overlapping([{ text: "yes", start: 7000, end: 7300 }], 8000, 8600)), "yes");
  // Only [unk], or nothing at all: nothing to send.
  assert.equal(ears.chessText(ears.overlapping([{ text: "[unk]", start: 7000, end: 7300 }], 7000, 8000)), null);
  assert.equal(ears.chessText([]), null);
});
check(() => {
  // The grammar Vosk is given: chess words, the 8 files as letters, ranks as words, and [unk].
  for (const w of ["pawn", "knight", "castle", "king side", "a", "h", "one", "eight", "resign", "[unk]"]) assert.ok(ears.GRAMMAR.includes(w), w);
});
console.log(`vosk.js: ${m} checks passed`);
