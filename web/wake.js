// Wake-word gate for the Echo simulator. Pure logic, no DOM, so it can be tested in Node:
//   node scripts/test-wake.mjs
(function (root) {
  "use strict";

  const WAKE = /\b(alexa|alexia|alexis|a lexa|elexa|alexa's|lexa)\b/i;

  /** Text after the (last) wake word, without leading punctuation. */
  function afterWake(text) {
    const m = text.match(new RegExp(WAKE.source, "ig"));
    if (!m) return text.trim();
    const last = text.toLowerCase().lastIndexOf(m[m.length - 1].toLowerCase());
    return text.slice(last + m[m.length - 1].length).replace(/^[\s,.!?:;-]+/, "").trim();
  }

  /**
   * Decide what to do with one final recognition result.
   * @param {string[]} alts   recognition alternatives, best first
   * @param {{now:number, awakeUntil:number, followUpUntil:number}} windows
   * @returns {{action:"send", text:string, alternatives:string[]} | {action:"awake"} | {action:"ignore"}}
   */
  function decide(alts, windows) {
    const clean = alts.map((a) => a.trim()).filter(Boolean);
    if (clean.length === 0) return { action: "ignore" };
    const withWake = clean.find((a) => WAKE.test(a));
    if (withWake) {
      const cmd = afterWake(withWake);
      if (!cmd) return { action: "awake" };
      const others = clean.map((a) => (WAKE.test(a) ? afterWake(a) : a)).filter((c) => c && c !== cmd);
      return { action: "send", text: cmd, alternatives: [cmd, ...others] };
    }
    if (windows.awakeUntil > windows.now || windows.followUpUntil > windows.now) {
      return { action: "send", text: clean[0], alternatives: clean };
    }
    return { action: "ignore" };
  }

  root.AlexaWake = { WAKE, afterWake, decide };
})(typeof window !== "undefined" ? window : globalThis);
