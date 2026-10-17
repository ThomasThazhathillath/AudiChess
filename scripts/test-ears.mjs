// Tests for the end-of-speech logic in web/transcribe.js: utterances end when a partial stops changing; later
// revisions of text already sent are never sent again; real continuations are.
// Run: node scripts/test-ears.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const f of ["eventstream.js", "transcribe.js"]) new Function(readFileSync(new URL(`../web/${f}`, import.meta.url), "utf8"))();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ears() {
  const finals = [];
  const partials = [];
  const e = new globalThis.TranscribeEars({
    getUrl: async () => "x",
    log: () => {},
    endpointMs: () => 20,
    onPartial: (p) => partials.push(p.text),
    onFinal: (f) => finals.push(f),
  });
  const partial = (id, text) => e.onSegment({ id, isPartial: true, text });
  const final = (id, text) => e.onSegment({ id, isPartial: false, text });
  return { e, finals, partials, partial, final };
}

let n = 0;
const check = async (name, fn) => { await fn(); n++; };

await check("ends an utterance when the partial stops changing, and ignores the later revision", async () => {
  const t = ears();
  t.partial("r1", "Knight");
  t.partial("r1", "Knight F3.");
  await sleep(40);
  assert.deepEqual(t.finals.map((f) => [f.text, f.early]), [["Knight F3.", true]]);
  t.final("r1", "Knight to F3."); // Transcribe's own final, revised: not a new "F3." to play
  assert.equal(t.finals.length, 1);
});

await check("a pause after the wake word: 'Alexa' then the command, from the same segment", async () => {
  const t = ears();
  t.partial("r2", "Alexa,");
  await sleep(40);
  t.partial("r2", "Alexa, let's play");
  t.partial("r2", "Alexa, let's play chess.");
  await sleep(40);
  t.final("r2", "Alexa, let's play chess.");
  assert.deepEqual(t.finals.map((f) => f.text), ["Alexa,", "let's play chess."]);
});

await check("Transcribe's final before our timer: sent once, with the differing partials as alternatives", async () => {
  const t = ears();
  t.partial("r3", "pawn");
  t.partial("r3", "porn d4");
  t.final("r3", "pawn d4");
  await sleep(40);
  assert.equal(t.finals.length, 1);
  assert.deepEqual(t.finals[0].alternatives, ["pawn d4", "porn d4"]);
});

await check("a one-word continuation counts only when the start was heard the same way", async () => {
  const t = ears();
  t.partial("r4", "Knight");
  await sleep(40);
  t.partial("r4", "Knight F3");
  await sleep(40);
  assert.deepEqual(t.finals.map((f) => f.text), ["Knight", "F3"]);
  const u = ears();
  u.partial("r5", "Night");
  await sleep(40);
  u.partial("r5", "Knight F3"); // the start changed: a revision, not "F3" on its own
  await sleep(40);
  assert.deepEqual(u.finals.map((f) => f.text), ["Night"]);
});

await check("an unchanged partial (noise keeps the segment open) does not restart the timer", async () => {
  const t = ears();
  t.partial("r6", "castle kingside");
  await sleep(10);
  t.partial("r6", "castle kingside");
  await sleep(15);
  assert.equal(t.finals.length, 1); // 25 ms after the first partial, not 20 ms after the repeat
});

await check("a final with its tail cut off: the fuller partial wins", async () => {
  const t = ears();
  t.partial("r7", "Why did you");
  t.partial("r7", "Why did you choose this");
  t.final("r7", "Why did you"); // live test, 2026-10-16
  assert.equal(t.finals.length, 1);
  assert.equal(t.finals[0].text, "Why did you choose this");
});

console.log(`transcribe.js ears: ${n} checks passed`);
process.exit(0);
