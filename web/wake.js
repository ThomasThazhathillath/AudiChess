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

  // Conversation mode: after Alexa replies, keep listening without the wake word.
  const FOLLOW_UP = { inGame: 120000, question: 30000, other: 20000 };

  /** How long to listen without the wake word after a reply. During a game you think between moves, so it stays open. */
  function followUpMs(reply) {
    if (reply.error) return FOLLOW_UP.other;
    if (reply.gameId && !reply.gameOver) return FOLLOW_UP.inGame;
    return reply.expectsReply ? FOLLOW_UP.question : FOLLOW_UP.other;
  }

  /**
   * Decide what to do with one final recognition result.
   * @param {string[]} alts   recognition alternatives, best first
   * @param {{now:number, awakeUntil:number, followUpUntil:number, speechAt?:number, openMic?:boolean}} windows
   *   speechAt: when the first interim result of this utterance arrived. Chrome finalises a second or
   *   so after you stop talking, so an answer that started inside the window still counts.
   *   openMic: a conversation with no wake word at all (the default): everything heard is sent.
   * @returns {{action:"send", text:string, alternatives:string[], woken:boolean} | {action:"awake"} | {action:"ignore"}}
   *   woken: "Alexa" was said (in this utterance, or just before it). false = conversation mode, where the agent
   *   ignores anything that isn't plausibly for Alexa (background talk).
   */
  function decide(alts, windows) {
    const clean = alts.map((a) => a.trim()).filter(Boolean);
    if (clean.length === 0) return { action: "ignore" };
    const withWake = clean.find((a) => WAKE.test(a));
    if (withWake) {
      const cmd = afterWake(withWake);
      if (!cmd) return { action: "awake" };
      const others = clean.map((a) => (WAKE.test(a) ? afterWake(a) : a)).filter((c) => c && c !== cmd);
      return { action: "send", text: cmd, alternatives: [cmd, ...others], woken: true };
    }
    if (windows.openMic) return { action: "send", text: clean[0], alternatives: clean, woken: windows.awakeUntil > windows.now };
    const heardAt = Math.min(windows.now, windows.speechAt || windows.now);
    if (windows.awakeUntil > heardAt) return { action: "send", text: clean[0], alternatives: clean, woken: true };
    if (windows.followUpUntil > heardAt) return { action: "send", text: clean[0], alternatives: clean, woken: false };
    return { action: "ignore" };
  }

  // Barge-in: while Alexa speaks, only her name or a stop word interrupts her.
  const STOP = /^\s*(?:(?:ok(?:ay)?|hey|alexa)[\s,]+)?(stop|wait|enough|hold on|shut up|quiet|be quiet|pause|cancel|never ?mind|bas|ruko|chup)\b/i;

  /** True when the whole utterance is just a stop word ("stop", "okay stop"): nothing to send to the agent. */
  const isOnlyStop = (text) => STOP.test(text) && String(text).trim().replace(STOP, "").replace(/[\s.,!?]+/g, "") === "";

  /**
   * Half a move: a piece name with the square still to come ("knight…", "Alexa, my bishop to…"). Speech recognition
   * often ends the phrase at the pause, so the page holds it and joins it to the next phrase instead of sending it.
   */
  function incomplete(text) {
    const t = String(text || "").trim().toLowerCase().replace(/[.!,?]+$/, "");
    return /^(?:(?:hey )?alexa,? )?(?:(?:um|uh|okay|ok|so|and|move|play|my|the)\s+)*(?:knight|night|bishop|rook|queen|king|pawn|porn|horse)(?:\s+(?:to|takes|on|goes to|captures))?$/.test(t);
  }

  /** "Pause", "stop listening", "go to sleep": close the open mic (tap the speaker or press M to talk again). */
  const SLEEP = /^\s*(?:(?:ok(?:ay)?|hey)?[\s,]*alexa[\s,]+)?(?:stop listening|pause listening|pause|mute|mute yourself|go to sleep|sleep|take a break|don'?t listen)[\s.!]*$/i;
  const isSleep = (text) => SLEEP.test(String(text || ""));

  /**
   * The mic sleeps only when no other reading sounds like chess: "pause" was most likely "pawn" when it came right
   * after "Did you mean pawn to d4?" (2026-10-17 log), and muting there made her seem deaf.
   */
  const CHESS_LIKE = /\b(?:pawn|porn|pond|pawan|knight|night|bishop|rook|ruk|queen|king|castle)\w*|\b[a-h]\s?[1-8]\b/i;
  /** Any of these readings sounds like chess (a piece or a square): then a lone "pause" / "stop" is not one. */
  const soundsLikeChess = (alts) => (alts || []).some((a) => CHESS_LIKE.test(String(a || "")));
  const isSleepCommand = (alts) => isSleep(alts?.[0]) && !soundsLikeChess((alts || []).slice(1));

  root.AlexaWake = { WAKE, FOLLOW_UP, afterWake, decide, followUpMs, isOnlyStop, incomplete, isSleep, isSleepCommand, soundsLikeChess };
})(typeof window !== "undefined" ? window : globalThis);
