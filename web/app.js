// Alexa Chess: a voice-only Echo. Say "Alexa ..." -> agent -> Polly audio back.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const device = $("device"), live = $("live"), startEl = $("start"), startBtn = $("start-btn"), startNote = $("start-note");
  const debugEl = $("debug"), debugLog = $("debug-log"), langSel = $("lang");

  const BUILD = "en-us-10"; // shown in the debug drawer, to confirm which code the browser runs

  // Chess ears (Vosk) open the mic a second time. With them running, Chrome's recognizer still saw "speech
  // detected" but returned almost no words for 40 minutes (2026-10-16 log), so they're off unless ?ears=1.
  const EARS_ON = new URLSearchParams(location.search).has("ears");

  // ---------- tunables ----------
  const WAKE = window.AlexaWake.WAKE; // shared with the tested gate in wake.js
  const AWAKE_MS = 8000;      // after a bare "Alexa", wait this long for the command
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

  /** The ring's resting state: red if muted, faint blue while a follow-up/awake window is open, else dark. */
  function restState() {
    clearTimeout(stateTimer);
    if (muted) return setState("muted");
    const now = Date.now();
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
      `<div class="meta">${(ms / 1000).toFixed(1)} s · ${data.voice || "browser voice"}${data.usage ? ` · ${data.usage.rounds} rounds · ${data.usage.inputTokens}+${data.usage.outputTokens} tok` : ""}</div>`;
    debugLog.prepend(li);
    persistLog(`${new Date().toLocaleTimeString()} · 🧑 ${heard}${alts.length > 1 ? ` [alts: ${alts.slice(1).join(" | ")}]` : ""}${tools ? ` 🔧 ${tools}` : ""} 🔵 ${data.reply || ""}`);
  }

  /** A plain note in the drawer: build tag, ignored speech, mic restarts. */
  function logNote(text) {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
    debugLog.prepend(li);
    persistLog(li.textContent);
  }

  // The drawer's log survives reloads (last 500 lines), so a whole game can be reviewed afterwards.
  const LOG_KEY = "alexaChess.debugLog";
  let savedLog = [];
  try { savedLog = JSON.parse(store.get(LOG_KEY, "[]")); } catch { savedLog = []; }
  function persistLog(line) {
    savedLog.push(line);
    if (savedLog.length > 500) savedLog = savedLog.slice(-500);
    store.set(LOG_KEY, JSON.stringify(savedLog));
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
  async function send(text, alternatives, chessHeard) {
    text = text.trim();
    if (!text || busy) return;
    if (!agentUrl) return;
    busy = true;
    clearTimeout(stateTimer); // a pending "awake" timeout must not darken the ring mid-reply
    awakeUntil = 0;
    followUpUntil = 0;
    earcon.end();
    setState("thinking", "Thinking");
    const t0 = performance.now();
    let data;
    try {
      const res = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text, alternatives, ...(chessHeard ? { chessHeard } : {}) }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.reply) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      data = { reply: "Sorry, I couldn't reach the chess board. Please try again.", error: true };
      earcon.error();
    }
    busy = false;
    logTurn(text, alternatives, data, performance.now() - t0);
    await speak(data);
    const windowMs = window.AlexaWake.followUpMs(data);
    followUpUntil = Date.now() + windowMs;
    logNote(`listening without "Alexa" for ${windowMs / 1000} s`);
    restState();
  }

  // ---------- speaking (Polly MP3 from the agent, browser voice as fallback) ----------
  function speak(data) {
    return new Promise((resolve) => {
      speaking = true;
      pauseListening();
      setState(data.error ? "error" : "speaking");
      const done = () => {
        if (!speaking) return;
        speaking = false;
        currentAudio = null;
        resumeListening();
        resolve();
      };
      if (data.audio) {
        const audio = new Audio(`data:audio/mpeg;base64,${data.audio}`);
        currentAudio = audio;
        audio.onended = done;
        audio.onerror = () => browserSpeak(data.reply, done);
        audio.play().catch(() => browserSpeak(data.reply, done));
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

  // ---------- listening: continuous recognition gated by the wake word ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let wantListening = false;
  let restartDelay = 250;
  let speechAt = 0;          // first interim result of the utterance in progress

  if (Recognition) {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    // No `recognition.phrases` biasing: Chrome exposes it, but its cloud recognizer then fails every start with
    // "phrases-not-supported" (only on-device recognition supports it), which killed the wake word.

    recognition.onstart = () => { listening = true; restartDelay = 250; speechAt = 0; heardSpeech = false; gotWords = false; logNote("mic on"); };
    recognition.onend = () => {
      listening = false;
      checkLanguageHealth();
      logNote(`mic off${speaking ? " (Alexa speaking)" : muted ? " (muted)" : ", restarting"}`);
      // Chrome stops after silences and network hiccups: keep the mic open while we want it.
      if (wantListening && !muted && !speaking) setTimeout(startListening, restartDelay);
    };
    // Diagnostics: show how far Chrome gets each cycle (audio captured -> sound -> speech -> result).
    recognition.onaudiostart = () => logNote("audio capture started");
    recognition.onsoundstart = () => logNote("sound detected");
    recognition.onspeechstart = () => { heardSpeech = true; logNote("speech detected"); };
    recognition.onaudioend = () => logNote("audio capture ended");
    recognition.onnomatch = () => logNote("speech heard but not recognised");
    recognition.onerror = (e) => {
      logNote(`recognition error: ${e.error}${e.message ? ` (${e.message})` : ""}`);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantListening = false;
        setState("error", "Microphone access is blocked. Allow it in the browser settings and reload.");
        return;
      }
      if (e.error !== "no-speech" && e.error !== "aborted") {
        logNote(`mic error: ${e.error}`);
        restartDelay = Math.min(restartDelay * 2, 5000);
      }
    };
    recognition.onresult = (e) => {
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
          if (!speechAt) { speechAt = Date.now(); logNote(`hearing "${top.trim()}"…`); } // counts even if Chrome finalises later
          // Light the ring the moment the wake word is heard, like a real Echo.
          if (WAKE.test(top) && device.dataset.state === "idle") { earcon.wake(); setState("awake", "Listening"); }
          // No forced early finals: ending an utterance after a 1.3 s pause (and restarting the mic) cut
          // "Alexa … let's play chess" in two and lost the command (2026-10-16 log). Chrome finalises itself.
          continue;
        }
        const alts = Array.from({ length: result.length }, (_, j) => result[j].transcript.trim()).filter(Boolean);
        handleUtterance(alts, speechAt);
        speechAt = 0;
      }
    };
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
      const d = window.AlexaWake.decide([text], { now, awakeUntil, followUpUntil, speechAt: h.start });
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
        return send(d.text, d.alternatives, d.text);
      }
      logNote(`ignored chess ears "${text}" (no wake word)`);
    }, CHROME_GRACE_MS);
  });

  function handleUtterance(alts, startedAt) {
    const now = Date.now();
    if (startedAt && startedAt <= voskSentUntil + 500) return logNote(`skipped Chrome's late "${alts[0]}" (already sent from chess ears)`);
    const d = window.AlexaWake.decide(alts, { now, awakeUntil, followUpUntil, speechAt: startedAt });
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
    if (ears?.state !== "listening") return send(d.text, d.alternatives);
    const chessHeard = await ears.hear(from, to);
    logNote(`chess ears: ${chessHeard ? `"${chessHeard}"` : "nothing usable"}`);
    return send(d.text, d.alternatives, chessHeard);
  }

  // ---------- a recognizer language that goes deaf ----------
  // Chrome's en-IN service once returned nothing for hours, with no error: speech detected, zero words. After two
  // such sessions in a row, switch to English (US) so the wake word keeps working.
  let heardSpeech = false, gotWords = false, deafSessions = 0;
  function checkLanguageHealth() {
    if (speaking || muted) return;
    deafSessions = heardSpeech && !gotWords ? deafSessions + 1 : 0;
    if (deafSessions >= 2 && langSel.value !== "en-US") {
      logNote(`${langSel.value} heard speech but returned no words twice: switching to en-US`);
      langSel.value = "en-US";
      deafSessions = 0;
    }
  }

  function startListening() {
    if (!recognition || listening || muted || speaking) return;
    wantListening = true;
    recognition.lang = langSel.value;
    try { recognition.start(); } catch { /* already started */ }
  }
  function pauseListening() { window.ChessEars?.pause(); if (recognition && listening) recognition.abort(); }
  function resumeListening() { if (wantListening && !muted) { window.ChessEars?.resume(); setTimeout(startListening, 150); } }

  // ---------- controls ----------
  function toggleMute() {
    muted = !muted;
    if (muted) { pauseListening(); stopSpeaking(); setState("muted", "Microphone off"); }
    else { setState("idle", "Microphone on"); window.ChessEars?.resume(); startListening(); }
  }

  startBtn.addEventListener("click", async () => {
    started = true;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    startEl.hidden = true;
    earcon.wake();
    if (!recognition) {
      setState("error", "Voice input needs Chrome or Edge. Press D to type instead.");
      return;
    }
    setState("idle", "Ready. Say Alexa to talk.");
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
      // Keyboard "action button": same as saying "Alexa".
      e.preventDefault();
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
  // A/B test, none of our code: en-IN 0 results, en-US fine on the same mic). The drawer's picker still switches it.
  langSel.value = store.get("alexaChess.lang", "en-US");
  langSel.addEventListener("change", () => {
    store.set("alexaChess.lang", langSel.value);
    if (listening) recognition.abort(); // restarts with the new language
  });
  logNote(`build ${BUILD}${EARS_ON ? " · chess ears ON" : " · chess ears off (add ?ears=1 to try them)"}`);
  if (EARS_ON) window.ChessEars?.init({ log: logNote }); // fetch the chess-ears model while the start screen is up
  if (!Recognition) startNote.textContent = "This browser has no speech recognition. Use Chrome or Edge, or press D to type.";

  // ---------- config + warm-up ----------
  fetch("config.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((c) => {
      agentUrl = c.agentUrl;
      // Wake the Lambdas while the user is still reading the start screen.
      fetch(agentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ warm: true }) }).catch(() => {});
    })
    .catch(() => { startNote.textContent = "Couldn't load config.json. Deploy the site with scripts/deploy.ps1."; });
})();
