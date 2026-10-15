// Alexa Chess - Echo simulator. Browser speech in, agent call, browser speech out.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const device = $("device"), micBtn = $("mic-btn"), statusEl = $("status"), captionEl = $("caption");
  const log = $("log"), empty = $("empty"), composer = $("composer"), input = $("composer-input");
  const gamePill = $("game-pill"), handsFree = $("handsfree");
  const langSel = $("lang"), voiceSel = $("voice"), rate = $("rate"), rateOut = $("rate-out"), mute = $("mute");

  // ---------- small persistence helpers (storage can be unavailable) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let sessionId = store.get("alexaChess.session", null) || newId();
  store.set("alexaChess.session", sessionId);

  let agentUrl = null;
  let busy = false;
  let listening = false;

  // ---------- device state ----------
  function setState(state, message) {
    device.dataset.state = state;
    if (message !== undefined) statusEl.textContent = message;
  }

  // ---------- conversation log ----------
  function addMessage(role, text, extra = {}) {
    empty.hidden = true;
    const li = document.createElement("li");
    li.className = `msg ${role}${extra.error ? " err" : ""}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = role === "user" ? "You" : "Alexa";
    li.append(who);
    const body = document.createElement("span");
    body.className = "body";
    if (extra.typing) {
      body.innerHTML = '<span class="typing" aria-label="Alexa is thinking"><i></i><i></i><i></i></span>';
    } else {
      body.textContent = text;
    }
    li.append(body);
    log.append(li);
    log.scrollTop = log.scrollHeight;
    return li;
  }

  function fillReply(li, data, ms) {
    li.querySelector(".body").textContent = data.reply;
    if (data.error) li.classList.add("err");
    if (data.toolCalls && data.toolCalls.length) {
      const tools = document.createElement("div");
      tools.className = "tools";
      tools.setAttribute("aria-label", "MCP tools called");
      for (const t of data.toolCalls) {
        const chip = document.createElement("span");
        chip.className = `tool${t.isError ? " bad" : ""}`;
        const args = Object.entries(t.args || {}).filter(([k]) => k !== "gameId" && k !== "sessionId");
        chip.textContent = `${t.name}(${args.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")})`;
        chip.title = t.speech || "";
        tools.append(chip);
      }
      li.append(tools);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${(ms / 1000).toFixed(1)} s`;
    li.append(meta);
    log.scrollTop = log.scrollHeight;
  }

  function updateGamePill(data) {
    if (!data.gameId) { gamePill.hidden = true; return; }
    gamePill.hidden = false;
    gamePill.textContent = data.gameOver ? "Game over" : "Game in progress";
    gamePill.classList.toggle("over", !!data.gameOver);
  }

  // ---------- talking to the agent ----------
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    if (!agentUrl) { setState("error", "Still loading configuration, try again in a second."); return; }
    busy = true;
    stopSpeaking();
    addMessage("user", text);
    const pending = addMessage("alexa", "", { typing: true });
    setState("thinking", "Thinking…");
    captionEl.textContent = "";
    const started = performance.now();
    try {
      const res = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.reply) throw new Error(data.error || `HTTP ${res.status}`);
      fillReply(pending, data, performance.now() - started);
      updateGamePill(data);
      busy = false;
      speak(data.reply);
    } catch (err) {
      busy = false;
      const msg = "Sorry, I couldn't reach the chess server. Please try again.";
      fillReply(pending, { reply: msg, error: true }, performance.now() - started);
      setState("error", `${msg} (${err.message})`);
      speak(msg);
    }
  }

  // ---------- speech out ----------
  let voices = [];
  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
    const saved = store.get("alexaChess.voice", "");
    voiceSel.innerHTML = "";
    const preferred = (v) => /aria|jenny|neerja|google us english|samantha|zira|female/i.test(v.name);
    voices.sort((a, b) => Number(preferred(b)) - Number(preferred(a)));
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.name === saved) opt.selected = true;
      voiceSel.append(opt);
    }
  }

  function speak(text) {
    if (mute.checked || !("speechSynthesis" in window)) { afterSpeaking(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find((x) => x.name === voiceSel.value);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Number(rate.value);
    u.onstart = () => setState("speaking", text);
    u.onend = afterSpeaking;
    u.onerror = afterSpeaking;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function afterSpeaking() {
    if (device.dataset.state === "speaking" || device.dataset.state === "thinking") setState("idle");
    if (handsFree.checked && recognition && !busy) setTimeout(startListening, 250);
  }

  // ---------- speech in ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  if (Recognition) {
    recognition = new Recognition();
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;
    recognition.onstart = () => { listening = true; setState("listening", "Listening…"); };
    recognition.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      captionEl.textContent = final || interim;
      if (final) send(final);
    };
    recognition.onerror = (e) => {
      listening = false;
      if (e.error === "no-speech" || e.error === "aborted") { setState("idle", "I didn't hear anything. Press the button and try again."); return; }
      if (e.error === "not-allowed") { setState("error", "Microphone access is blocked. Allow it in the browser, or type below."); return; }
      setState("error", `Speech recognition error: ${e.error}. You can type below.`);
    };
    recognition.onend = () => {
      listening = false;
      if (device.dataset.state === "listening") setState("idle", "Press the button or Space to talk.");
    };
  } else {
    statusEl.textContent = "Voice input needs Chrome or Edge. You can still type commands below.";
  }

  function startListening() {
    if (!recognition || listening || busy) return;
    stopSpeaking();
    recognition.lang = langSel.value;
    try { recognition.start(); } catch { /* already started */ }
  }

  function toggleListening() {
    if (!recognition) { input.focus(); return; }
    if (listening) recognition.stop(); else startListening();
  }

  // ---------- wiring ----------
  micBtn.addEventListener("click", toggleListening);
  document.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    if (e.code === "Space" && !typing && !e.repeat) { e.preventDefault(); toggleListening(); }
    if (e.key === "Escape") { stopSpeaking(); if (listening) recognition.abort(); setState("idle", "Stopped."); }
  });
  composer.addEventListener("submit", (e) => { e.preventDefault(); const t = input.value; input.value = ""; send(t); });
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.dataset.say)));

  $("reset-btn").addEventListener("click", () => {
    sessionId = newId();
    store.set("alexaChess.session", sessionId);
    log.innerHTML = "";
    empty.hidden = false;
    gamePill.hidden = true;
    stopSpeaking();
    setState("idle", "New session. Say “Alexa, let’s play chess” to begin.");
  });

  const settings = $("settings"), settingsBtn = $("settings-btn");
  settingsBtn.addEventListener("click", () => {
    settings.hidden = !settings.hidden;
    settingsBtn.setAttribute("aria-expanded", String(!settings.hidden));
  });
  langSel.value = store.get("alexaChess.lang", "en-IN");
  langSel.addEventListener("change", () => store.set("alexaChess.lang", langSel.value));
  voiceSel.addEventListener("change", () => store.set("alexaChess.voice", voiceSel.value));
  rate.value = store.get("alexaChess.rate", "1");
  rateOut.textContent = Number(rate.value).toFixed(1);
  rate.addEventListener("input", () => { rateOut.textContent = Number(rate.value).toFixed(1); store.set("alexaChess.rate", rate.value); });
  mute.checked = store.get("alexaChess.mute", "0") === "1";
  mute.addEventListener("change", () => store.set("alexaChess.mute", mute.checked ? "1" : "0"));
  handsFree.checked = store.get("alexaChess.handsfree", "0") === "1";
  handsFree.addEventListener("change", () => store.set("alexaChess.handsfree", handsFree.checked ? "1" : "0"));

  if ("speechSynthesis" in window) {
    loadVoices();
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }

  fetch("config.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((c) => { agentUrl = c.agentUrl; })
    .catch(() => setState("error", "Couldn't load config.json. Is the site deployed with scripts/deploy.ps1?"));
})();
