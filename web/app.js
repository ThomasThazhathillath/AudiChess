// Alexa Chess: a voice-only Echo. Say "Alexa ..." -> agent -> Polly audio back.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const device = $("device"), live = $("live"), startEl = $("start"), startBtn = $("start-btn"), startNote = $("start-note");
  const debugEl = $("debug"), debugLog = $("debug-log"), langSel = $("lang");

  // ---------- tunables ----------
  const WAKE = window.AlexaWake.WAKE; // shared with the tested gate in wake.js
  const AWAKE_MS = 6000;      // after a bare "Alexa", wait this long for the command
  const FOLLOW_UP_MS = 8000;  // after Alexa asks a question, answer without the wake word

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
  }

  // ---------- talking to the agent ----------
  async function send(text, alternatives) {
    text = text.trim();
    if (!text || busy) return;
    if (!agentUrl) return;
    busy = true;
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
        body: JSON.stringify({ sessionId, text, alternatives }),
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
    if (data.expectsReply) followUpUntil = Date.now() + FOLLOW_UP_MS;
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

  if (Recognition) {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;

    recognition.onstart = () => { listening = true; restartDelay = 250; };
    recognition.onend = () => {
      listening = false;
      // Chrome stops after silences and network hiccups: keep the mic open while we want it.
      if (wantListening && !muted && !speaking) setTimeout(startListening, restartDelay);
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantListening = false;
        setState("error", "Microphone access is blocked. Allow it in the browser settings and reload.");
        return;
      }
      if (e.error !== "no-speech" && e.error !== "aborted") restartDelay = Math.min(restartDelay * 2, 5000);
    };
    recognition.onresult = (e) => {
      if (speaking || busy || muted) return; // half-duplex: never react to our own voice
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const top = result[0].transcript;
        if (!result.isFinal) {
          // Light the ring the moment the wake word is heard, like a real Echo.
          if (WAKE.test(top) && device.dataset.state === "idle") { earcon.wake(); setState("awake", "Listening"); }
          continue;
        }
        const alts = Array.from({ length: result.length }, (_, j) => result[j].transcript.trim()).filter(Boolean);
        handleUtterance(alts);
      }
    };
  }

  function handleUtterance(alts) {
    const now = Date.now();
    const d = window.AlexaWake.decide(alts, { now, awakeUntil, followUpUntil });
    if (d.action === "send") return send(d.text, d.alternatives);
    if (d.action === "awake") {
      if (device.dataset.state !== "awake") earcon.wake();
      awakeUntil = now + AWAKE_MS;
      return restState();
    }
    // Background talk without the wake word: ignore, but let the ring settle.
    if (device.dataset.state === "awake") restState();
  }

  function startListening() {
    if (!recognition || listening || muted || speaking) return;
    wantListening = true;
    recognition.lang = langSel.value;
    try { recognition.start(); } catch { /* already started */ }
  }
  function pauseListening() { if (recognition && listening) recognition.abort(); }
  function resumeListening() { if (wantListening && !muted) setTimeout(startListening, 150); }

  // ---------- controls ----------
  function toggleMute() {
    muted = !muted;
    if (muted) { pauseListening(); stopSpeaking(); setState("muted", "Microphone off"); }
    else { setState("idle", "Microphone on"); startListening(); }
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
  langSel.value = store.get("alexaChess.lang", "en-IN");
  langSel.addEventListener("change", () => {
    store.set("alexaChess.lang", langSel.value);
    if (listening) recognition.abort(); // restarts with the new language
  });
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
