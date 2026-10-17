// Alexa Chess: a voice-only Echo. Just talk (no wake word) -> agent -> Polly audio back.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const device = $("device"), live = $("live"), startEl = $("start"), startBtn = $("start-btn"), startNote = $("start-note");
  const debugEl = $("debug"), debugLog = $("debug-log"), langSel = $("lang");

  const BUILD = "rival-1"; // shown in the debug drawer, to confirm which code the browser runs

  const params = new URLSearchParams(location.search);
  // Speech-to-text: Chrome's own recognizer, one phrase at a time (default), or Amazon Transcribe streaming
  // (?stt=transcribe). Chrome in English (US) hears short chess phrases far better than Transcribe en-IN did ("24" for
  // pawn d4, "Swansea 4" for c4), and it decides itself when a phrase is over, so nothing is cut or dropped by our timers.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let STT = params.get("stt") === "transcribe" || !Recognition ? "transcribe" : "chrome";
  // Open mic (default): a conversation, no "Alexa" needed; everything heard goes to the agent, which drops only what is
  // clearly background talk. ?wake=1 restores the wake word with its follow-up windows.
  const OPEN_MIC = params.get("wake") !== "1";
  const VERBOSE = params.has("verbose"); // log every mic cycle (one-phrase recognition restarts every few seconds)
  // Barge-in: with Transcribe the mic stays open while she talks (echo cancellation removes most of her voice),
  // and only "Alexa…" or "stop" interrupts. ?bargein=0 restores strict half-duplex (silence while she talks).
  // Chrome's recognizer is always half-duplex, like a walkie-talkie: tap the speaker or press Esc to cut her off.
  const BARGE_IN = params.get("bargein") !== "0";
  // Optional Transcribe A/B switches: ?lang=multi (en-IN + hi-IN identification), ?stability=off|low|medium|high.
  const sttOverrides = {
    ...(params.get("lang") === "multi" ? { mode: "multi" } : /^(en-US|en-GB|hi-IN)$/.test(params.get("lang") || "") ? { languageCode: params.get("lang") } : {}),
    ...(params.get("stability") ? { stability: params.get("stability") } : {}),
  };

  // Chess ears (Vosk) open the mic a second time. With them running, Chrome's recognizer still saw "speech
  // detected" but returned almost no words for 40 minutes (2026-10-16 log), so they're off unless ?ears=1.
  const EARS_ON = params.has("ears");

  // ---------- tunables ----------
  const WAKE = window.AlexaWake.WAKE; // shared with the tested gate in wake.js
  const AWAKE_MS = 12000;     // after a bare "Alexa", wait this long for the command (8 s was too short in the live test)
  // After each reply, wake.js followUpMs() keeps listening without the wake word (long during a game).

  // ---------- storage (may be unavailable) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let sessionId = store.get("alexaChess.session", null) || newId();
  store.set("alexaChess.session", sessionId);

  // ---------- state ----------
  let agentUrl = null;
  let transcribeUrl = null;
  let started = false;
  let muted = false;
  let busy = false;          // waiting for the agent
  let speaking = false;
  let awakeUntil = 0;
  let followUpUntil = 0;
  let currentAudio = null;
  let stateTimer = null;

  function setState(s, announce) {
    device.dataset.state = s;
    if (announce) live.textContent = announce;
  }

  /** The ring's resting state: red if muted, faint blue while listening without the wake word, else dark. */
  function restState() {
    clearTimeout(stateTimer);
    if (muted) return setState("muted");
    const now = Date.now();
    if (OPEN_MIC && awakeUntil <= now) return setState("followup");
    const until = Math.max(awakeUntil, followUpUntil);
    if (until > now) {
      setState(awakeUntil > now ? "awake" : "followup");
      stateTimer = setTimeout(restState, until - now + 50);
    } else setState("idle");
  }

  // ---------- earcons (WebAudio, no files) ----------
  let audioCtx = null;
  function tone(freqs, dur = 0.12, gain = 0.06) {
    if (!audioCtx) return;
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.8;
    }
  }
  const earcon = {
    wake: () => tone([660, 880], 0.1),
    end: () => tone([740, 520], 0.09, 0.04),
    error: () => tone([300, 220], 0.16, 0.05),
  };

  // ---------- debug drawer (press D) ----------
  function logTurn(heard, alts, data, ms) {
    const li = document.createElement("li");
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const tools = (data.toolCalls || []).map((t) => `${t.name}(${JSON.stringify(t.args || {})})${t.isError ? " ✗" : ""}`).join(" · ");
    li.innerHTML =
      `<div class="you">🧑 ${esc(heard)}</div>` +
      (alts.length > 1 ? `<div class="alts">alts: ${esc(alts.slice(1).join(" | "))}</div>` : "") +
      (tools ? `<div class="tools">🔧 ${esc(tools)}</div>` : "") +
      `<div>🔵 ${esc(data.reply || "")}</div>` +
      `<div class="meta">${(ms / 1000).toFixed(1)} s${timing(data)} · ${data.voice || "browser voice"}${data.usage ? ` · ${data.usage.rounds} rounds · ${data.usage.inputTokens}+${data.usage.outputTokens} tok` : ""}</div>`;
    debugLog.prepend(li);
    persistLog(`${new Date().toLocaleTimeString()} · 🧑 ${heard}${alts.length > 1 ? ` [alts: ${alts.slice(1).join(" | ")}]` : ""}${tools ? ` 🔧 ${tools}` : ""} 🔵 ${data.reply || ""} ⏱ ${(ms / 1000).toFixed(1)} s${timing(data)}`);
    DS?.event(data.error ? "error" : "reply", data.reply || "", `${(ms / 1000).toFixed(1)} s${timing(data)}${tools ? ` · ${tools}` : ""}`);
  }

  /** " (model 0.9 s, board 0.6 s, voice 0.3 s)": where the reply time went, from the agent. */
  function timing(data) {
    const t = data.timings;
    if (!t) return "";
    const s = (x) => `${(x / 1000).toFixed(1)} s`;
    return ` (${t.fastPath ? "fast · " : ""}model ${s(t.modelMs)}, board ${s(t.toolMs)}, voice ${s(t.ttsMs)})`;
  }

  /** A plain note in the drawer: build tag, ignored speech, mic restarts. Also shown on the debug screen. */
  function logNote(text) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
    debugLog.prepend(li);
    persistLog(li.textContent);
    toScreen(text);
  }

  // ---------- always-visible debug screen (until the app is tuned; ?debug=0 hides it) ----------
  const DS = params.get("debug") === "0" ? null : window.DebugScreen;
  DS?.init({ state: () => ({ speaking, busy, muted, awakeUntil, followUpUntil, openMic: OPEN_MIC, halfDuplex: STT !== "transcribe" || !BARGE_IN }) });
  /** Route a drawer note to the debug screen: what was heard and what happened to it; ear status up top. */
  function toScreen(text) {
    if (!DS) return;
    const quoted = (t) => /"([^"]*)"/.exec(t)?.[1] ?? t;
    if (/^ears: mic level|^hearing "/.test(text)) return; // the meter and the live box show these
    if (/^ears: connected/.test(text)) return DS.status(`ears: ${text.slice(6)}`);
    if (/^ears: (disconnected|reconnecting|could not|connection stalled|bad frame|\w+Exception|microphone|no Transcribe)/.test(text)) {
      DS.status(text, true);
      return DS.event("error", text);
    }
    if (/^ears: audio at|^ears: mic "/.test(text)) return DS.event("info", text);
    if (/^heard "/.test(text)) return DS.event("heard", quoted(text), text.replace(/^heard "[^"]*"\s*/, ""));
    if (/^ignored "/.test(text)) return DS.event("ignored", quoted(text), text.replace(/^ignored "[^"]*"\s*/, ""));
    if (/^dropped "/.test(text)) return DS.event("dropped", quoted(text), text.replace(/^dropped "[^"]*"\s*/, ""));
    if (/^interrupted by|^cancelled/.test(text)) return DS.event("interrupt", text);
    if (/^build |^listening without/.test(text)) return DS.event("info", text);
  }

  // The drawer's log survives reloads (last 500 lines), so a whole game can be reviewed afterwards.
  const LOG_KEY = "alexaChess.debugLog";
  let savedLog = [];
  try { savedLog = JSON.parse(store.get(LOG_KEY, "[]")); } catch { savedLog = []; }
  function persistLog(line) {
    savedLog.push(line);
    if (savedLog.length > 500) savedLog = savedLog.slice(-500);
    store.set(LOG_KEY, JSON.stringify(savedLog));
    mirrorLog(line);
  }

  // Local dev only: mirror the drawer to the local agent (packages/agent/eval-results/live/<date>-drawer.log), so a
  // real-mic session can be reviewed without access to this browser. Never on the deployed site.
  const isLocalAgent = () => !!agentUrl && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(agentUrl);
  // ...and the exact audio streamed to Transcribe, one second at a time, so a bad transcript can be replayed.
  let audioQueue = [], audioTimer = null;
  function mirrorAudio(chunk) {
    if (!isLocalAgent()) return;
    audioQueue.push(chunk);
    audioTimer ??= setTimeout(() => {
      const body = new Blob(audioQueue);
      audioQueue = [];
      audioTimer = null;
      fetch(new URL(`debug-audio?session=${encodeURIComponent(sessionId)}`, agentUrl), { method: "POST", body }).catch(() => {});
    }, 1000);
  }
  let mirrorQueue = [], mirrorTimer = null;
  function mirrorLog(line) {
    if (!isLocalAgent()) return;
    mirrorQueue.push(`${sessionId.slice(0, 8)} ${line}`);
    mirrorTimer ??= setTimeout(() => {
      const lines = mirrorQueue;
      mirrorQueue = [];
      mirrorTimer = null;
      fetch(new URL("debug-log", agentUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines }), keepalive: true }).catch(() => {});
    }, 1000);
  }
  for (const line of savedLog.slice(-200)) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = `(earlier) ${line}`;
    debugLog.prepend(li);
  }
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy log";
  copyBtn.addEventListener("click", () => navigator.clipboard?.writeText(savedLog.join("\n")).then(() => logNote("log copied to clipboard"), () => logNote("could not copy the log")));
  document.querySelector("#debug header")?.insertBefore(copyBtn, $("new-session"));

  window.addEventListener("chess-ears-log", (e) => logNote(e.detail));

  // ---------- talking to the agent ----------
  let pending = null; // AbortController of the request in flight ("stop" while thinking cancels it)
  /**
   * @param woken false = conversation mode (no "Alexa"): the agent may decide it was background talk and stay
   *   silent, so there is no chime and the listening window is kept as it was.
   */
  async function send(text, alternatives, chessHeard, woken = true) {
    text = text.trim();
    if (!text || busy) return;
    if (!agentUrl) return;
    busy = true;
    clearTimeout(stateTimer); // a pending "awake" timeout must not darken the ring mid-reply
    const windowsBefore = { awakeUntil, followUpUntil };
    awakeUntil = 0;
    followUpUntil = 0;
    if (woken) earcon.end();
    DS?.event("sent", text, woken ? "to Alexa (wake word)" : "to Alexa (conversation mode, no wake word)");
    setState("thinking", "Thinking");
    const t0 = performance.now();
    pending = new AbortController();
    let data;
    try {
      const res = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text, alternatives, woken, ...(chessHeard ? { chessHeard } : {}) }),
        signal: pending.signal,
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || (!data.reply && !data.ignored)) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      if (err.name === "AbortError") data = { ignored: true, cancelled: true };
      else {
        data = { reply: "Sorry, I couldn't reach the chess board. Please try again.", error: true };
        earcon.error();
      }
    }
    pending = null;
    busy = false;
    if (data.ignored) {
      // Background talk (or "stop" while thinking): say nothing, keep listening exactly as before.
      awakeUntil = windowsBefore.awakeUntil;
      followUpUntil = windowsBefore.followUpUntil;
      logNote(data.cancelled ? `cancelled "${text}"` : `ignored "${text}" (not for Alexa)${data.timings ? ` · ${data.timings.totalMs} ms` : ""}`);
      restState();
      resumeListening();
      return;
    }
    logTurn(text, alternatives, data, performance.now() - t0);
    await speak(data);
    const windowMs = window.AlexaWake.followUpMs(data);
    followUpUntil = Date.now() + windowMs;
    if (!OPEN_MIC) logNote(`listening without "Alexa" for ${windowMs / 1000} s`);
    restState();
  }

  // ---------- speaking (Polly MP3 from the agent, browser voice as fallback) ----------
  let replyText = ""; // what she is saying now, to recognise her own voice leaking into the mic
  let replyAsks = false; // her reply is a question: a short answer may cut in before she finishes
  function speak(data) {
    return new Promise((resolve) => {
      speaking = true;
      replyText = data.reply || "";
      replyAsks = !!data.expectsReply;
      if (STT !== "transcribe" || !BARGE_IN) pauseListening();
      setState(data.error ? "error" : "speaking");
      let safety = null;
      const done = () => {
        if (!speaking) return;
        clearTimeout(safety);
        speaking = false;
        currentAudio = null;
        if (STT !== "transcribe" || !BARGE_IN) resumeListening();
        resolve();
      };
      // An "ended" event that never comes (browser voices sometimes drop it) must not leave the mic shut for good:
      // once nothing is playing any more, she's done.
      const stillTalking = () => (currentAudio ? !currentAudio.paused && !currentAudio.ended : "speechSynthesis" in window && speechSynthesis.speaking);
      const check = () => { if (stillTalking()) safety = setTimeout(check, 1000); else done(); };
      safety = setTimeout(check, 3000 + (data.reply || "").length * 80);
      if (data.audio) {
        const audio = new Audio(`data:audio/mpeg;base64,${data.audio}`);
        currentAudio = audio;
        // Once only: onerror and a rejected play() can both fire, and a second voice would cancel the first (ending it early).
        const fallback = () => { if (currentAudio !== audio) return; currentAudio = null; browserSpeak(data.reply, done); };
        audio.onended = done;
        audio.onerror = fallback;
        audio.play().catch(fallback);
      } else browserSpeak(data.reply, done);
    });
  }

  function browserSpeak(text, done) {
    if (!("speechSynthesis" in window)) return done();
    const u = new SpeechSynthesisUtterance(text);
    const lang = langSel.value;
    const voice = speechSynthesis.getVoices().find((v) => v.lang === lang) || speechSynthesis.getVoices().find((v) => v.lang.startsWith("en"));
    if (voice) u.voice = voice;
    u.onend = done;
    u.onerror = done;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (currentAudio) { currentAudio.pause(); currentAudio.onended?.(); }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  // ---------- listening: Chrome's recognizer, one phrase at a time ----------
  // Like a walkie-talkie conversation: Chrome listens for one phrase, decides itself when it is over and returns it;
  // we send it, she answers, and the mic opens again as soon as she stops talking. Never while she talks or thinks,
  // so she can't hear herself. Silence just restarts the mic.
  let recognition = null;
  let listening = false;
  let wantListening = false;
  const RESTART_MS = 100;    // after a phrase or a silence (was 250: words said in the gap were lost)
  let restartDelay = RESTART_MS;
  let speechAt = 0;          // first interim result of the utterance in progress
  let lastRecEventAt = 0;    // any event from the recognizer, for the watchdog
  let renewWhy = "";         // a real error: the next "end" builds a fresh recognizer
  // Every mic cycle (on, sound, speech, no-speech): on screen only with ?verbose, but always in the local mirror log,
  // so a deaf spell can be read afterwards (2026-10-17's couldn't: Chrome heard nothing, or sound but no speech?).
  const cycleNote = (text) => { if (VERBOSE) logNote(text); else mirrorLog(`${new Date().toLocaleTimeString()} · ${text}`); };

  /**
   * A recognizer with all its handlers. Rebuilt when Chrome's goes deaf (speech detected but no words, twice), after a
   * real error, or when it stops sending events: the old object is dropped, and its late events are ignored.
   */
  function makeRecognition() {
    const r = new Recognition();
    r.continuous = false;
    r.interimResults = true; // live captions and the start time only; just the final phrase is sent
    r.maxAlternatives = 5;   // n-best readings for the spoken-move matcher
    // No `phrases` biasing: Chrome exposes it, but its cloud recognizer then fails every start with
    // "phrases-not-supported" (only on-device recognition supports it), which killed the wake word.
    const on = (fn) => (e) => { if (r !== recognition) return; lastRecEventAt = Date.now(); fn(e); };

    r.onstart = on(() => { listening = true; restartDelay = RESTART_MS; speechAt = 0; heardSpeech = false; gotWords = false; cycleNote("mic on"); });
    r.onend = on(() => {
      listening = false;
      if (renewWhy) { const why = renewWhy; renewWhy = ""; return renewRecognition(why); }
      if (checkLanguageHealth()) return renewRecognition("speech detected twice but no words");
      cycleNote(`mic off${speaking ? " (Alexa speaking)" : busy ? " (thinking)" : muted ? " (muted)" : ", restarting"}`);
      // After each phrase, a silence or a network hiccup: open the mic again unless she's busy (send() reopens it).
      if (wantListening && !muted && !speaking && !busy) setTimeout(startListening, restartDelay);
    });
    // Diagnostics: how far Chrome gets each cycle (audio captured -> sound -> speech -> result).
    r.onaudiostart = on(() => cycleNote("audio capture started"));
    r.onsoundstart = on(() => cycleNote("sound detected"));
    r.onspeechstart = on(() => { heardSpeech = true; cycleNote("speech detected"); });
    r.onaudioend = on(() => cycleNote("audio capture ended"));
    r.onnomatch = on(() => logNote("speech heard but not recognised"));
    r.onerror = on((e) => {
      if (e.error === "no-speech" || e.error === "aborted") return cycleNote(`recognition: ${e.error}`); // silence, or we stopped it
      logNote(`recognition error: ${e.error}${e.message ? ` (${e.message})` : ""}`);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        // Not only "blocked": it came after 7 quiet minutes on 2026-10-17 and switched the mic off for good. Muted
        // instead, so a tap (a user gesture Chrome accepts) turns it back on.
        if (!muted) toggleMute();
        setState("muted", "Microphone off. Tap the speaker to turn it back on.");
        return;
      }
      restartDelay = Math.min(restartDelay * 2, 5000);
      renewWhy = `after "${e.error}"`;
    });
    r.onresult = on((e) => {
      lastChromeAt = Date.now();
      gotWords = true;
      if (speaking || busy || muted) { // half-duplex: never react to our own voice
        const last = e.results[e.results.length - 1];
        if (last?.isFinal) logNote(`dropped "${last[0].transcript.trim()}" (${speaking ? "Alexa was speaking" : busy ? "still thinking" : "muted"})`);
        speechAt = 0;
        return;
      }
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const top = result[0].transcript;
        if (!result.isFinal) {
          DS?.hearing(top.trim());
          if (!speechAt) { speechAt = Date.now(); logNote(`hearing "${top.trim()}"…`); } // counts even if Chrome finalises later
          // Still talking: a held "bishop…" waits for the rest ("f4" was being said when the hold ran out, 2026-10-17).
          if (held) { clearTimeout(held.timer); held.timer = setTimeout(flushHeld, HOLD_MS); }
          // Light the ring the moment the wake word is heard, like a real Echo.
          if (WAKE.test(top) && device.dataset.state === "idle") { earcon.wake(); setState("awake", "Listening"); }
          // No forced early finals: ending an utterance after a 1.3 s pause (and restarting the mic) cut
          // "Alexa … let's play chess" in two and lost the command (2026-10-16 log). Chrome finalises itself.
          continue;
        }
        const alts = Array.from({ length: result.length }, (_, j) => result[j].transcript.trim()).filter(Boolean);
        if (alts.length) logNote(`heard "${alts[0]}"${alts.length > 1 ? ` (alternatives: ${alts.slice(1).join(" | ")})` : ""}`);
        handleUtterance(alts, speechAt);
        speechAt = 0;
      }
    });
    return r;
  }

  /** Swap in a fresh recognizer (the old one is aborted and its late events ignored), then listen again. */
  function renewRecognition(why) {
    if (!Recognition) return;
    const old = recognition;
    recognition = makeRecognition();
    listening = false;
    try { old?.abort(); } catch { /* already stopped */ }
    logNote(`mic: fresh recognizer (${why})`);
    if (wantListening && !muted && !speaking && !busy) setTimeout(startListening, RESTART_MS);
  }

  if (Recognition) recognition = makeRecognition();

  // ---------- watchdog: the mic is on whenever it should be ----------
  // A swallowed start() error or an "end" event that never comes would leave the mic off with nothing in the log.
  let offSince = 0;
  setInterval(() => {
    if (!started || STT === "transcribe" || !recognition) return;
    const now = Date.now();
    const should = wantListening && !muted && !speaking && !busy;
    if (!should || listening) offSince = 0;
    else if (!offSince) offSince = now;
    else if (now - offSince > 1500) {
      offSince = 0;
      logNote("mic: was off for no reason, restarting");
      startListening();
    }
    // Chrome ends a silent phrase itself after several seconds; 20 s without any event means it is stuck.
    if (listening && now - lastRecEventAt > 20000) renewRecognition("no events for 20 s");
  }, 1000);
  // Coming back to the tab: make sure the mic is running again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !started || STT === "transcribe") return;
    cycleNote("tab visible again");
    if (!listening) startListening();
  });

  // ---------- listening: Amazon Transcribe streaming (default) ----------
  // One stream stays open while listening. Partials light the ring and mark when speech started; each final
  // segment is one utterance for the same wake/follow-up gate (wake.js) that Chrome's results went through.
  let ears = null;
  const ECHO_TAIL_MS = 400; // half-duplex mode (?bargein=0): silence this long after Alexa stops, for room echo
  const echoIds = new Set();    // Transcribe segments that began while Alexa spoke: her voice, never a command
  const stoppedIds = new Set(); // segments whose "stop" already cancelled an answer

  function makeEars() {
    return new window.TranscribeEars({
      getUrl: async () => {
        if (!transcribeUrl) throw new Error("no transcribeUrl in config.json");
        const res = await fetch(transcribeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, ...sttOverrides }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
        return data.url;
      },
      log: logNote,
      onAudio: mirrorAudio,
      endpointMs: window.AlexaWake.endpointMs,
      onLevel: (rms) => DS?.level(rms),
      onPartial: ({ text, id }) => {
        DS?.hearing(text, muted ? "muted" : speaking ? "Alexa is speaking" : busy ? "she's thinking" : echoIds.has(id) ? "her own voice" : "");
        if (muted) return;
        if (speaking) {
          // Barge-in: "Alexa…", "stop", or a short answer to her question; anything else now is her own voice or noise.
          const progress = currentAudio?.duration ? currentAudio.currentTime / currentAudio.duration : undefined;
          const b = window.AlexaWake.bargeIn(text, replyText, replyAsks, progress);
          if (!b) { echoIds.add(id); return; }
          echoIds.delete(id);
          logNote(`interrupted by "${text}"`);
          stopSpeaking();
          if (b === "command") { speechAt = Date.now(); awakeUntil = Date.now() + AWAKE_MS; }
          if (b === "answer") speechAt = Date.now(); // the follow-up window, set as she stops, takes the answer
          return;
        }
        if (busy) {
          // "stop" / "cancel" while she's thinking: drop the answer that is on its way.
          if (pending && window.AlexaWake.bargeIn(text, "") === "stop") { stoppedIds.add(id); pending.abort(); }
          return;
        }
        if (echoIds.has(id)) return;
        if (!speechAt) { speechAt = Date.now(); logNote(`hearing "${text}"…`); }
        // Light the ring the moment the wake word is heard, like a real Echo.
        if (WAKE.test(text) && device.dataset.state === "idle") { earcon.wake(); setState("awake", "Listening"); }
      },
      onFinal: ({ text, alternatives, languageCode, id, early }) => {
        if (echoIds.has(id) || stoppedIds.has(id)) { // her voice, or a "stop" already acted on
          echoIds.delete(id);
          stoppedIds.delete(id);
          if (!early) logNote(`dropped "${text}" (${speaking ? "Alexa speaking" : "her own voice or a stop"})`);
          speechAt = 0;
          return;
        }
        if (speaking || busy || muted) {
          logNote(`dropped "${text}" (${speaking ? "Alexa was speaking" : busy ? "still thinking" : "muted"})`);
          speechAt = 0;
          return;
        }
        logNote(`heard "${text}"${early ? " (end of speech)" : ""}${languageCode && languageCode !== "en-IN" ? ` [${languageCode}]` : ""}${alternatives.length > 1 ? ` (partials: ${alternatives.slice(1).join(" | ")})` : ""}`);
        handleUtterance(alternatives, speechAt);
        speechAt = 0;
      },
      onFatal: (why) => {
        if (why === "no-url" && Recognition && STT === "transcribe") {
          logNote("ears: no Transcribe URL after 3 tries: switching to Chrome speech recognition for this page");
          STT = "chrome";
          ears.suspend();
          startListening();
        }
      },
    });
  }

  // ---------- chess ears fallback ----------
  // Chrome's recognizer sometimes detects speech but returns no words for minutes, with no error. Vosk still
  // hears chess words and "alexa", so when Chrome stays silent about an utterance, Vosk's reading is used alone.
  let lastChromeAt = 0;     // last time Chrome returned any result
  let voskSentUntil = 0;    // end of the last utterance sent from Vosk alone: Chrome's late copy is ignored
  const CHROME_GRACE_MS = 2000;
  window.addEventListener("chess-ears-final", (e) => {
    const h = e.detail;
    setTimeout(() => {
      const text = String(h.text).replace(/\[unk\]/g, " ").replace(/\s+/g, " ").trim();
      if (!text || h.used || speaking || busy || muted) return;
      if (lastChromeAt >= h.start - 500) return; // Chrome heard this too: its own path handles it
      const now = Date.now();
      const d = window.AlexaWake.decide([text], { now, awakeUntil, followUpUntil, speechAt: h.start, openMic: OPEN_MIC });
      if (d.action === "awake") {
        logNote(`chess ears woke me ("${text}"): Chrome heard nothing`);
        if (device.dataset.state !== "awake") earcon.wake();
        awakeUntil = now + AWAKE_MS;
        return restState();
      }
      if (d.action === "send") {
        h.used = true;
        voskSentUntil = h.end;
        logNote(`chess ears only: sending "${d.text}" (Chrome heard nothing)`);
        return send(d.text, d.alternatives, d.text, d.woken);
      }
      logNote(`ignored chess ears "${text}" (no wake word)`);
    }, CHROME_GRACE_MS);
  });

  // Half a move ("knight…"): recognition ended the phrase at the pause. Hold it and join it to the next phrase.
  const HOLD_MS = 4000;
  let held = null; // { alts, startedAt, timer }
  function flushHeld() {
    const h = held;
    held = null;
    if (h) handleUtterance(h.alts, h.startedAt, true);
  }

  function handleUtterance(alts, startedAt, fromHold = false) {
    const now = Date.now();
    if (startedAt && startedAt <= voskSentUntil + 500) return logNote(`skipped Chrome's late "${alts[0]}" (already sent from chess ears)`);
    if (held) {
      clearTimeout(held.timer);
      const first = held.alts[0];
      alts = alts.map((a) => `${first} ${a}`);
      startedAt = held.startedAt;
      held = null;
      logNote(`joined into "${alts[0]}"`);
    } else if (!fromHold && window.AlexaWake.incomplete(alts[0])) {
      held = { alts, startedAt, timer: setTimeout(flushHeld, HOLD_MS) };
      logNote(`holding "${alts[0]}" for the rest of the move`);
      return;
    }
    if (window.AlexaWake.isSleepCommand(alts)) return sleepByVoice();
    // ...unless another reading was chess ("pause" | "pawn"): then it goes to her like anything else.
    if (window.AlexaWake.isOnlyStop(alts[0]) && !window.AlexaWake.soundsLikeChess(alts.slice(1))) return logNote(`"${alts[0]}": nothing to stop`);
    const d = window.AlexaWake.decide(alts, { now, awakeUntil, followUpUntil, speechAt: startedAt, openMic: OPEN_MIC });
    if (d.action === "send") return sendWithChessEars(d, startedAt || now, now);
    if (d.action === "awake") {
      if (device.dataset.state !== "awake") earcon.wake();
      awakeUntil = now + AWAKE_MS;
      return restState();
    }
    // Background talk without the wake word: ignore, but let the ring settle.
    const closedFor = Math.round((now - Math.max(awakeUntil, followUpUntil)) / 1000);
    logNote(`ignored "${alts[0]}" (no wake word; listening window closed ${closedFor > 9999 ? "long ago" : `${closedFor} s ago`})`);
    if (device.dataset.state === "awake") restState();
  }

  /** Pair Chrome's utterance with what chess ears (vosk.js) heard over the same time, then send both. */
  async function sendWithChessEars(d, from, to) {
    const ears = window.ChessEars;
    if (ears?.state !== "listening") return send(d.text, d.alternatives, undefined, d.woken);
    const chessHeard = await ears.hear(from, to);
    logNote(`chess ears: ${chessHeard ? `"${chessHeard}"` : "nothing usable"}`);
    return send(d.text, d.alternatives, chessHeard, d.woken);
  }

  // ---------- a recognizer language that goes deaf ----------
  // Chrome's en-IN service once returned nothing for hours, with no error: speech detected, zero words. After two
  // such sessions in a row, switch to English (US) so the wake word keeps working.
  // In en-US too it can go deaf the same way: then a fresh recognizer (returns true) instead of another language.
  let heardSpeech = false, gotWords = false, deafSessions = 0;
  function checkLanguageHealth() {
    if (speaking || muted) return false;
    deafSessions = heardSpeech && !gotWords ? deafSessions + 1 : 0;
    if (deafSessions < 2) return false;
    deafSessions = 0;
    if (langSel.value === "en-US") return true;
    logNote(`${langSel.value} heard speech but returned no words twice: switching to en-US`);
    langSel.value = "en-US";
    return false;
  }

  function startListening() {
    if (STT === "transcribe") { wantListening = true; if (!muted) ears?.activate(); return; }
    wantListening = true;
    if (!recognition || listening || muted || speaking || busy) return;
    recognition.lang = langSel.value;
    try { recognition.start(); } catch { /* already started */ }
  }
  let echoTimer = null;
  function pauseListening() {
    window.ChessEars?.pause();
    clearTimeout(echoTimer);
    if (STT === "transcribe") { ears?.pause(); return; } // silence frames keep the stream open
    if (recognition && listening) recognition.abort();
  }
  function resumeListening() {
    if (!wantListening || muted) return;
    window.ChessEars?.resume();
    if (STT === "transcribe") { clearTimeout(echoTimer); echoTimer = setTimeout(() => { if (!speaking) ears?.resume(); }, ECHO_TAIL_MS); return; }
    setTimeout(startListening, 150);
  }

  // ---------- controls ----------
  function toggleMute() {
    muted = !muted;
    if (muted) {
      if (held) { clearTimeout(held.timer); held = null; }
      pauseListening();
      if (STT === "transcribe") ears?.suspend(); // closes the stream: nothing is sent (or billed) while muted
      stopSpeaking();
      setState("muted", "Microphone off");
    } else {
      restState();
      live.textContent = "Microphone on";
      window.ChessEars?.resume();
      if (STT === "transcribe") ears?.resume();
      startListening();
    }
  }

  /** "Pause" / "stop listening": the open mic closes until the speaker is tapped (or M is pressed). */
  function sleepByVoice() {
    if (muted) return;
    logNote("paused by voice: tap the speaker or press M to talk again");
    toggleMute();
    browserSpeak("Okay, I'll stop listening. Tap me when you want me back.", () => {});
  }

  const READY = OPEN_MIC ? "Listening. Just talk, no wake word needed." : "Ready. Say Alexa to talk.";
  startBtn.addEventListener("click", async () => {
    started = true;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    startEl.hidden = true;
    earcon.wake();
    if (STT === "transcribe") {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode || !window.TranscribeEars) {
        logNote("ears: this browser can't stream the mic: using Chrome speech recognition");
        STT = "chrome";
      } else {
        setState(OPEN_MIC ? "followup" : "idle", READY);
        ears = makeEars();
        wantListening = true;
        try {
          await ears.start();
        } catch (err) {
          logNote(`ears: microphone failed (${err.name || ""} ${err.message || err})`);
          wantListening = false;
          setState("error", err.name === "NotAllowedError" ? "Microphone access is blocked. Allow it in the browser settings and reload." : "Couldn't open the microphone. Press D for details.");
        }
        if (EARS_ON) window.ChessEars?.start();
        return;
      }
    }
    if (!recognition) {
      setState("error", "Voice input needs Chrome or Edge. Press D to type instead.");
      return;
    }
    setState(OPEN_MIC ? "followup" : "idle", READY);
    DS?.status(`ears: Chrome speech recognition (${langSel.value}), one phrase at a time`);
    startListening();
    if (EARS_ON) window.ChessEars?.start(); // optional second recognizer; stays off if its model isn't there
  });

  device.addEventListener("click", () => { if (started) { if (speaking) stopSpeaking(); else toggleMute(); } });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "d" || e.key === "D") { debugEl.hidden = !debugEl.hidden; }
    else if (e.key === "m" || e.key === "M") { if (started) toggleMute(); }
    else if (e.key === "Escape") { stopSpeaking(); }
    else if (e.code === "Space" && started && !muted) {
      // Keyboard "action button": cuts her off while she talks, otherwise the same as saying "Alexa".
      e.preventDefault();
      if (speaking) return stopSpeaking();
      earcon.wake();
      awakeUntil = Date.now() + AWAKE_MS;
      restState();
    }
  });

  $("close-debug").addEventListener("click", () => { debugEl.hidden = true; });
  $("type-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("type-input");
    const t = input.value;
    input.value = "";
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    send(t, [t]);
  });
  $("new-session").addEventListener("click", () => {
    sessionId = newId();
    store.set("alexaChess.session", sessionId);
    debugLog.innerHTML = "";
    live.textContent = "New session";
  });
  // en-US by default: on 2026-10-16 afternoon Chrome's en-IN recognizer silently returned no words at all (bare
  // A/B test, none of our code: en-IN 0 results, en-US fine on the same mic), and en-US hears chess moves well. The
  // drawer's picker still switches it. (A new key, so a choice saved under the old one starts from en-US again.)
  const LANG_KEY = "alexaChess.sttLang";
  langSel.value = store.get(LANG_KEY, "en-US");
  langSel.addEventListener("change", () => {
    store.set(LANG_KEY, langSel.value);
    if (listening) recognition.abort(); // restarts with the new language
  });
  const hearing = STT === "transcribe"
    ? `Amazon Transcribe${Object.keys(sttOverrides).length ? ` ${JSON.stringify(sttOverrides)}` : ""}`
    : `Chrome speech recognition (${langSel.value}), one phrase at a time (?stt=transcribe for Amazon Transcribe)`;
  logNote(`build ${BUILD} · listening with ${hearing} · ${OPEN_MIC ? "open mic, no wake word (?wake=1 for \"Alexa\")" : "wake word \"Alexa\""}${EARS_ON ? " · chess ears ON" : ""}`);
  if (EARS_ON) window.ChessEars?.init({ log: logNote }); // fetch the chess-ears model while the start screen is up
  if (STT === "chrome" && !Recognition) startNote.textContent = "This browser has no speech recognition. Use Chrome or Edge, or press D to type.";

  // ---------- config + warm-up ----------
  fetch("config.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((c) => {
      agentUrl = c.agentUrl;
      transcribeUrl = c.transcribeUrl || null;
      if (STT === "transcribe" && !transcribeUrl) logNote("config.json has no transcribeUrl: Transcribe ears can't start (redeploy, or use ?stt=chrome)");
      // Wake the Lambdas while the user is still reading the start screen.
      fetch(agentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ warm: true }) }).catch(() => {});
    })
    .catch(() => { startNote.textContent = "Couldn't load config.json. Deploy the site with scripts/deploy.ps1."; });
})();
