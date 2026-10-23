// Tests for web/wake.js (the wake-word gate) and web/sonic.js (the Nova 2 Sonic session), no AWS.
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

// ---------- sonic.js: transcripts, event order, one agent call per turn ----------
new Function(readFileSync(new URL("../web/sonic.js", import.meta.url), "utf8"))();
const Sonic = globalThis.AlexaSonic;
let s = 0;
for (const [heard, want] of [["e-four.", "e four"], ["knight f-three.", "knight f three"], ["what should i have played?", "what should i have played?"], ["Bishop c-four!", "Bishop c four"], ["  let's play chess. ", "let's play chess"]]) {
  assert.equal(Sonic.clean(heard), want, heard);
  s++;
}

/** A fake Sonic: records the input events and replays scripted output events. */
function fakeSonic(script) {
  const sent = [];
  const out = [];
  let push;
  const body = { async *[Symbol.asyncIterator]() { for (;;) { while (out.length) { const e = out.shift(); if (e === "end") return; yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify({ event: e })) } }; } await new Promise((r) => { push = r; }); } } };
  const emit = (e) => { out.push(e); push?.(); };
  const send = async (input) => {
    (async () => { for await (const c of input.body) sent.push(JSON.parse(new TextDecoder().decode(c.chunk.bytes)).event); })();
    setTimeout(() => script(emit), 0);
    return { body };
  };
  return { send, sent };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
{
  const calls = [];
  const heard = [];
  const f = fakeSonic(async (emit) => {
    emit({ contentStart: { contentId: "u1", type: "TEXT", role: "USER", additionalModelFields: '{"generationStage":"FINAL"}' } });
    emit({ textOutput: { contentId: "u1", content: "e-four." } });
    emit({ contentEnd: { contentId: "u1", type: "TEXT", stopReason: "END_TURN" } });
    emit({ toolUse: { toolUseId: "t1", toolName: "alexa", content: '{"heard":"e four"}' } });
    await tick();
    emit({ toolUse: { toolUseId: "t2", toolName: "alexa", content: '{"heard":"e four"}' } }); // Sonic asking again
    await tick();
    emit({ completionEnd: {} });
    emit("end");
  });
  let repeats = 0, closed = false;
  const session = Sonic.open({
    send: f.send,
    onUserText: (t) => heard.push(t),
    onToolUse: async ({ heard: h }) => { calls.push(h); return calls.length === 1 ? "" : "should not be asked"; },
    onRepeatTool: () => repeats++,
    onClose: () => { closed = true; },
  });
  session.audio(new Int16Array(512));
  await tick(); await tick(); await tick(); await tick();
  const kinds = f.sent.map((e) => Object.keys(e)[0]);
  assert.deepEqual(kinds.slice(0, 9), ["sessionStart", "promptStart", "contentStart", "textInput", "contentEnd", "contentStart", "textInput", "contentEnd", "contentStart"]);
  assert.equal(f.sent[1].promptStart.audioOutputConfiguration.voiceId, "kiara");
  assert.equal(f.sent[2].contentStart.role, "SYSTEM");
  assert.match(f.sent[3].textInput.content, /LANGUAGE LOCK: English only/);
  assert.equal(f.sent[5].contentStart.role, "SYSTEM_SPEECH");
  assert.equal(f.sent[8].contentStart.type, "AUDIO");
  assert.ok(kinds.includes("audioInput"));
  assert.deepEqual(heard, ["e-four."]);
  assert.deepEqual(calls, ["e four"], "the agent is asked once per user turn");
  assert.equal(repeats, 1);
  const results = f.sent.filter((e) => e.toolResult).map((e) => JSON.parse(e.toolResult.content));
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.say === "" && /Stay silent/.test(r.instruction)));
  assert.ok(closed);
  s += 12;
}
console.log(`sonic.js: ${s} checks passed`);
