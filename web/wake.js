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

  /**
   * Should this partial transcript, heard while Alexa is talking, interrupt her? Her own voice leaking into the
   * mic must not: a partial whose words mostly appear in what she is saying is treated as echo.
   * @returns {"stop" | "command" | null}  stop: just be quiet; command: "Alexa, …" (listen for the rest)
   */
  /**
   * @param progress how far through her reply the audio is (0..1), when known: a word she said earlier, heard again
   *   well after she said it, is the user's answer ("black?" at the end of "White or black? And easy…").
   */
  function bargeIn(partial, replyText, replyIsQuestion, progress) {
    const text = String(partial || "").trim();
    if (!text) return null;
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
    const words = norm(text);
    const replyWords = norm(replyText);
    const spoken = new Set(replyWords);
    const echo = words.length >= 2 && words.filter((w) => spoken.has(w)).length / words.length >= 0.6;
    if (STOP.test(text) && !spoken.has(STOP.exec(text)[1].toLowerCase())) return "stop";
    if (WAKE.test(text) && !WAKE.test(replyText || "") && !echo) return "command";
    // Answering her question before she has finished ("black, easy" over "White or black? And easy, medium or
    // hard?"). Her own voice leaking back repeats her words in her order; an answer combines them differently.
    if (replyIsQuestion && ANSWER.test(text)) {
      if (!` ${replyWords.join(" ")} `.includes(` ${words.join(" ")} `)) return "answer";
      // Her own words in her order: echo, unless they come well after she said them.
      const at = (replyWords.indexOf(words[words.length - 1]) + 1) / Math.max(1, replyWords.length);
      if (typeof progress === "number" && progress - at > 0.3) return "answer";
    }
    return null;
  }
  const ANSWER = /^\s*(?:yes|yeah|yep|no|nope|haan|nahi|white|black|easy|medium|hard|random|whatever|the first|the second|first|second)\b/i;

  /** True when the whole utterance is just a stop word ("stop", "okay stop"): nothing to send to the agent. */
  const isOnlyStop = (text) => STOP.test(text) && String(text).trim().replace(STOP, "").replace(/[\s.,!?]+/g, "") === "";

  /**
   * How long a partial transcript must stay unchanged before we treat it as the end of the utterance (our own
   * end-of-speech detection: with background noise Transcribe kept segments open for 5–9 s). Complete-looking
   * commands end quickly; a lone "knight" or "Alexa" waits longer for the rest.
   */
  function endpointMs(text) {
    const t = String(text || "").trim().toLowerCase().replace(/[.!,]+$/, "");
    if (!t) return 1500;
    const words = t.split(/\s+/);
    if (/\?$/.test(t) && words.length >= 3) return 700;
    if (/\b[a-h]\s?[1-8]$|\b(kingside|queenside|short|long)$/.test(t)) return 700; // a move ends on its square
    if (/^(?:yes|no|yeah|nope|undo|white|black|easy|medium|hard|stop|okay|ok|resign|hint)$/.test(t)) return 800;
    // A piece name alone ("knight…", "Alexa, castle…"): the square or side is still coming.
    if (/^(?:(?:hey )?alexa,? )?(?:knight|night|bishop|rook|queen|king|pawn|porn|castle|castles|my knight|my bishop)(?: to| takes)?$/.test(t)) return 2500;
    if (words.length === 1) return 1600; // "Alexa…", "knight…": more is probably coming
    return 1100;
  }

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

  root.AlexaWake = { WAKE, FOLLOW_UP, afterWake, decide, followUpMs, bargeIn, isOnlyStop, endpointMs, incomplete, isSleep };
})(typeof window !== "undefined" ? window : globalThis);
