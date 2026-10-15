// Tests for web/wake.js (the wake-word gate). Run: node scripts/test-wake.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

new Function(readFileSync(new URL("../web/wake.js", import.meta.url), "utf8"))();
const { decide, afterWake } = globalThis.AlexaWake;

const closed = { now: 1000, awakeUntil: 0, followUpUntil: 0 };
const cases = [
  [["Alexa, knight to f3"], closed, { action: "send", text: "knight to f3", alternatives: ["knight to f3"] }],
  [["alexa night forever", "Alexa knight e4"], closed, { action: "send", text: "night forever", alternatives: ["night forever", "knight e4"] }],
  [["Alexia let's play chess"], closed, { action: "send", text: "let's play chess", alternatives: ["let's play chess"] }],
  [["hey Alexa"], closed, { action: "awake" }],
  [["Alexa"], closed, { action: "awake" }],
  [["pass the salt"], closed, { action: "ignore" }],
  [["knight f3"], { now: 1000, awakeUntil: 5000, followUpUntil: 0 }, { action: "send", text: "knight f3", alternatives: ["knight f3"] }],
  [["black please", "black peas"], { now: 1000, awakeUntil: 0, followUpUntil: 3000 }, { action: "send", text: "black please", alternatives: ["black please", "black peas"] }],
  [["knight f3"], { now: 9000, awakeUntil: 5000, followUpUntil: 8000 }, { action: "ignore" }],
  [[" ", ""], closed, { action: "ignore" }],
];

let n = 0;
for (const [alts, windows, expected] of cases) {
  assert.deepEqual(decide(alts, windows), expected, `decide(${JSON.stringify(alts)})`);
  n++;
}
assert.equal(afterWake("so Alexa, um, Alexa: bishop c4"), "bishop c4");
assert.equal(afterWake("no wake word here"), "no wake word here");
console.log(`wake.js: ${n + 2} checks passed`);
