// Alexa Chess: a voice-only Echo. Mic -> Nova 2 Sonic (speech to speech, streamed from this page) -> the chess agent
// (Sonic's tool) -> Sonic speaks the agent's reply. Chrome's recognizer, the browser voice and Polly were removed on
// 2026-10-23: they misheard and mispronounced too much.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const device = $("device"), live = $("live"), startEl = $("start"), startBtn = $("start-btn"), startNote = $("start-note");
  const debugEl = $("debug"), debugLog = $("debug-log");

  const BUILD = "sonic-1"; // shown in the debug drawer, to confirm which code the browser runs

  const params = new URLSearchParams(location.search);
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // The mic is half-duplex by default, like a walkie-talkie: while she talks Sonic gets silence, so she can't hear
  // herself through the speakers; tap the speaker or press Esc to cut her off. ?bargein=1 streams the mic throughout
  // (with headphones), and Sonic's own barge-in stops her when you talk over her.
  const BARGE_IN = params.get("bargein") === "1";
  const SESSION_RENEW_MS = 7 * 60 * 1000; // Sonic streams last 8 minutes at most: a fresh one opens between turns
  const IDLE_PAUSE_MS = 5 * 60 * 1000;     // nobody spoke for 5 minutes: stop streaming (Sonic bills the open mic)
  const FRAME = 512;                        // 32 ms of 16 kHz audio per frame, what Sonic expects

  // ---------- storage (may be unavailable) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let sessionId = store.get("alexaChess.session", null) || newId();
  store.set("alexaChess.session", sessionId);

  // ---------- state ----------
  let config = null;
  let started = false;
  let muted = false;
  let busy = false;        // the agent is working on a reply
  let voiceId = store.get("alexaChess.voice", "kiara");

  function setState(s, announce) {
    device.dataset.state = s;
    if (announce) live.textContent = announce;
  }
  const restState = () => setState(muted ? "muted" : "followup");

  // ---------- earcons (WebAudio, no files) ----------
  let outCtx = null; // 24 kHz: Sonic's voice and the earcons
  function tone(freqs, dur = 0.12, gain = 0.06) {
    if (!outCtx) return;
    let t = outCtx.currentTime;
    for (const f of freqs) {
      const o = outCtx.createOscillator(), g = outCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(outCtx.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.8;
    }
  }
  const earcon = {
    wake: () => tone([660, 880], 0.1),
    sleep: () => tone([880, 520], 0.12, 0.05),
    error: () => tone([300, 220], 0.16, 0.05),
  };

  // ---------- debug drawer (press D) ----------
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  function logTurn(heard, data, ms) {
    const li = document.createElement("li");
    const tools = (data.toolCalls || []).map((t) => `${t.name}(${JSON.stringify(t.args || {})})${t.isError ? " ✗" : ""}`).join(" · ");
    li.innerHTML =
      `<div class="you">🧑 ${esc(heard)}</div>` +
      (tools ? `<div class="tools">🔧 ${esc(tools)}</div>` : "") +
      `<div>🔵 ${esc(data.reply || "")}</div>` +
      `<div class="meta">${(ms / 1000).toFixed(1)} s${timing(data)} · ${data.voice || voiceId}${data.usage ? ` · ${data.usage.rounds} rounds · ${data.usage.inputTokens}+${data.usage.outputTokens} tok` : ""}</div>`;
    debugLog.prepend(li);
    persistLog(`${new Date().toLocaleTimeString()} · 🧑 ${heard}${tools ? ` 🔧 ${tools}` : ""} 🔵 ${data.reply || ""} ⏱ ${(ms / 1000).toFixed(1)} s${timing(data)}`);
    DS?.event(data.error ? "error" : "reply", data.reply || "", `${(ms / 1000).toFixed(1)} s${timing(data)}${tools ? ` · ${tools}` : ""}`);
  }

  /** " (model 0.9 s, board 0.6 s)": where the agent's time went. */
  function timing(data) {
    const t = data.timings;
    if (!t) return "";
    const s = (x) => `${(x / 1000).toFixed(1)} s`;
    return ` (${t.fastPath ? "fast · " : ""}model ${s(t.modelMs)}, board ${s(t.toolMs)})`;
  }

  /** A plain note in the drawer (and on the local debug screen). */
  function logNote(text, kind = "info") {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
    debugLog.prepend(li);
    persistLog(li.textContent);
    DS?.event(kind, text);
  }

  // ---------- debug screen: local testing only (?debug=1 shows it anywhere), never on the live site by default ----------
  const DS = (LOCAL && params.get("debug") !== "0") || params.get("debug") === "1" ? window.DebugScreen : null;
  DS?.init({ state: () => ({ speaking: isSpeaking(), busy, muted, awakeUntil: 0, followUpUntil: 0, openMic: true, halfDuplex: !BARGE_IN }) });

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

  // Local dev only: mirror the drawer to the local agent (packages/agent/eval-results/live/<date>-drawer.log).
  const isLocalAgent = () => !!config?.agentUrl && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.agentUrl);
  let mirrorQueue = [], mirrorTimer = null;
  function mirrorLog(line) {
    if (!isLocalAgent()) return;
    mirrorQueue.push(`${sessionId.slice(0, 8)} ${line}`);
    mirrorTimer ??= setTimeout(() => {
      const lines = mirrorQueue;
      mirrorQueue = [];
      mirrorTimer = null;
      fetch(new URL("debug-log", config.agentUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines }), keepalive: true }).catch(() => {});
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

  // ---------- the agent (Sonic's "alexa" tool) ----------
  /** One turn through the agent. Returns the words Sonic should say ("" = stay silent). */
  async function askAgent(text, alternatives) {
    busy = true;
    setState("thinking", "Thinking");
    const t0 = performance.now();
    let data;
    try {
      const res = await fetch(config.agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // woken: false = an open-mic conversation, so the agent drops what is clearly background talk.
        body: JSON.stringify({ sessionId, text, alternatives, woken: false }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || (!data.reply && !data.ignored)) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      data = { reply: "Sorry, I couldn't reach the chess board. Please try again.", error: true };
      earcon.error();
      logNote(`agent error: ${err.message || err}`, "error");
    }
    busy = false;
    if (data.ignored) {
      logNote(`ignored "${text}" (not for Alexa)${data.timings ? ` · ${data.timings.totalMs} ms` : ""}`, "ignored");
      restState();
      return "";
    }
    logTurn(text, data, performance.now() - t0);
    if (data.voice && data.voice !== voiceId) {
      voiceId = data.voice;
      store.set("alexaChess.voice", voiceId);
      renewAfterTurn = "new voice"; // Sonic sets the voice per stream: the next one uses it
    }
    return data.reply;
  }

  // ---------- Sonic's voice: 24 kHz PCM chunks, played back to back ----------
  let playHead = 0;          // outCtx time the queued audio ends
  let sources = [];
  let dropAudio = false;     // the agent said nothing: anything Sonic says anyway is not played
  const isSpeaking = () => !!outCtx && outCtx.currentTime < playHead;

  function playChunk(b64) {
    if (!outCtx || dropAudio || muted) return;
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = outCtx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      ch[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
    }
    const src = outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(outCtx.destination);
    const at = Math.max(outCtx.currentTime + 0.03, playHead);
    src.start(at);
    playHead = at + buf.duration;
    sources.push(src);
    src.onended = () => { sources = sources.filter((s) => s !== src); if (!isSpeaking()) speechDone(); };
    setState("speaking");
  }

  function stopSpeaking() {
    for (const s of sources) { try { s.stop(); } catch { /* already done */ } }
    sources = [];
    if (outCtx) playHead = outCtx.currentTime;
    speechDone();
  }
  function speechDone() {
    if (muted) return;
    if (device.dataset.state === "speaking") restState();
    maybeRenew();
  }

  // ---------- guest credentials for Sonic (Cognito identity pool, guest access) ----------
  // The classic flow: Cognito's OpenID token, then STS AssumeRoleWithWebIdentity on the stack's guest role. The enhanced
  // flow (GetCredentialsForIdentity) adds a session policy that never allows Bedrock ("no session policy allows").
  let creds = null;
  async function cognito(target, body) {
    const res = await fetch(`https://cognito-identity.${config.sonic.poolRegion}.amazonaws.com/`, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityService.${target}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${target}: ${data.message || data.__type || res.status}`);
    return data;
  }
  async function credentials() {
    if (creds && creds.expiration.getTime() - Date.now() > 5 * 60 * 1000) return creds;
    let identityId = store.get("alexaChess.identity", null);
    if (!identityId) {
      identityId = (await cognito("GetId", { IdentityPoolId: config.sonic.identityPoolId })).IdentityId;
      store.set("alexaChess.identity", identityId);
    }
    let token;
    try {
      token = (await cognito("GetOpenIdToken", { IdentityId: identityId })).Token;
    } catch (err) {
      store.set("alexaChess.identity", ""); // an identity from an old pool: a new one next time
      throw err;
    }
    const q = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleSessionName: "alexa-chess-guest", RoleArn: config.sonic.roleArn, WebIdentityToken: token, DurationSeconds: "3600" });
    const xml = await (await fetch(`https://sts.amazonaws.com/?${q}`)).text();
    const tag = (n) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(xml)?.[1];
    if (!tag("AccessKeyId")) throw new Error(`STS: ${tag("Message") || "no credentials"}`);
    creds = { accessKeyId: tag("AccessKeyId"), secretAccessKey: tag("SecretAccessKey"), sessionToken: tag("SessionToken"), expiration: new Date(tag("Expiration")) };
    return creds;
  }

  // ---------- the Sonic stream ----------
  let sonic = null;          // the open stream (AlexaSonic.open)
  let sonicClient = null;
  let openedAt = 0;
  let lastUserAt = 0;        // last time Sonic heard the user
  let renewAfterTurn = "";   // a reason to open a fresh stream once she has finished talking
  let retryMs = 1000;
  let usage = { speechIn: 0, speechOut: 0, textIn: 0, textOut: 0 };
  let usageBase = { speechIn: 0, speechOut: 0, textIn: 0, textOut: 0 }; // totals of the streams already closed

  function openSonic(why) {
    if (!config?.sonic || muted) return;
    const B = window.BedrockSonic;
    if (!B) { setState("error", "Couldn't load the voice. Reload the page."); return; }
    sonicClient ??= new B.BedrockRuntimeClient({ region: config.sonic.region, credentials });
    const s = window.AlexaSonic.open({
      send: (input) => sonicClient.send(new B.InvokeModelWithBidirectionalStreamCommand(input)),
      modelId: config.sonic.modelId,
      voiceId,
      onUserText: (text) => {
        const t = window.AlexaSonic.clean(text);
        if (!t) return;
        lastUserAt = Date.now();
        dropAudio = false;
        heardLog.push(t);
        DS?.hearing(t);
        logNote(`heard "${t}"`, "heard");
      },
      onToolUse: async ({ heard }) => {
        const said = window.AlexaSonic.clean(lastHeard() || heard);
        const other = window.AlexaSonic.clean(heard);
        if (window.AlexaWake.isSleepCommand([said])) { dropAudio = true; setTimeout(sleepByVoice, 0); return ""; }
        if (window.AlexaWake.isOnlyStop(said)) { dropAudio = true; logNote(`"${said}": nothing to stop`); return ""; }
        const say = await askAgent(said, other && other !== said ? [said, other] : [said]);
        if (!say) dropAudio = true;
        return say;
      },
      onRepeatTool: (heard) => logNote(`Sonic asked again for "${heard}": not sent`),
      onAudio: playChunk,
      onInterrupted: () => { logNote("interrupted: she stopped talking", "interrupt"); stopSpeaking(); },
      onTurnEnd: () => maybeRenew(),
      onUsage: (u) => {
        const t = u.details?.total;
        if (!t) return;
        usage = { speechIn: usageBase.speechIn + t.input.speechTokens, speechOut: usageBase.speechOut + t.output.speechTokens, textIn: usageBase.textIn + t.input.textTokens, textOut: usageBase.textOut + t.output.textTokens };
      },
      onClose: (err) => {
        if (sonic !== s) return; // a stream we replaced on purpose
        sonic = null;
        usageBase = { ...usage };
        if (muted) return;
        if (err) {
          logNote(`voice stream closed: ${err.message || err}; reconnecting in ${retryMs / 1000} s`, "error");
          setState("error");
          setTimeout(() => { restState(); openSonic("reconnect"); }, retryMs);
          retryMs = Math.min(retryMs * 2, 30000);
        } else openSonic("stream ended");
      },
    });
    heardLog = [];
    sonic = s;
    openedAt = Date.now();
    lastUserAt ||= Date.now();
    renewAfterTurn = "";
    logNote(`voice: Nova 2 Sonic stream open (${voiceId}, ${why})`);
    setTimeout(() => { if (sonic === s) retryMs = 1000; }, 10000);
  }
  // Sonic's transcripts: the last one is what the agent gets (the tool argument is Sonic's own copy of it).
  let heardLog = [];
  const lastHeard = () => heardLog.at(-1) || "";

  function closeSonic() {
    const s = sonic;
    sonic = null;
    usageBase = { ...usage };
    s?.close();
  }

  /** Between turns: a fresh stream before Sonic's 8-minute limit, or for a new voice. */
  function maybeRenew() {
    if (!sonic || busy || isSpeaking() || muted) return;
    const why = renewAfterTurn || (Date.now() - openedAt > SESSION_RENEW_MS ? "renewed before the 8-minute limit" : "");
    if (!why) return;
    const old = sonic;
    sonic = null;
    usageBase = { ...usage };
    old.close();
    openSonic(why);
  }

  // ---------- the microphone: 16 kHz PCM frames to Sonic ----------
  const WORKLET = `class Mic extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Int16Array(${FRAME}); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        const v = Math.max(-1, Math.min(1, ch[i]));
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === ${FRAME}) { this.port.postMessage(this.buf); this.buf = new Int16Array(${FRAME}); this.n = 0; }
      }
      return true;
    }
  }
  registerProcessor("mic", Mic);`;
  const silence = new Int16Array(FRAME);
  let quietUntil = 0; // half-duplex: silence until a moment after she stops (the room's echo)

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "mic");
    ctx.createMediaStreamSource(stream).connect(node);
    node.port.onmessage = (e) => {
      if (!sonic || muted) return;
      const speaking = isSpeaking();
      if (speaking) quietUntil = Date.now() + 400;
      const frame = !BARGE_IN && (speaking || Date.now() < quietUntil) ? silence : e.data;
      sonic.audio(frame);
      if (DS) { let sum = 0; for (let i = 0; i < e.data.length; i += 8) sum += (e.data[i] / 0x8000) ** 2; DS.level(Math.sqrt(sum / (e.data.length / 8))); }
    };
  }

  // Nobody spoke for 5 minutes: close the stream (an open mic costs money on Sonic), tap to come back.
  setInterval(() => {
    if (!started || muted || !sonic || busy || isSpeaking()) return;
    if (Date.now() - lastUserAt > IDLE_PAUSE_MS) {
      logNote("nobody spoke for 5 minutes: paused listening (tap the speaker to talk again)");
      toggleMute();
      setState("muted", "Paused. Tap the speaker to talk again.");
    }
  }, 5000);

  // ---------- controls ----------
  function toggleMute() {
    muted = !muted;
    if (muted) {
      stopSpeaking();
      closeSonic();
      setState("muted", "Microphone off");
    } else {
      restState();
      live.textContent = "Microphone on";
      lastUserAt = Date.now();
      openSonic("unmuted");
    }
  }

  /** "Pause" / "stop listening": the mic closes until the speaker is tapped (or M is pressed). */
  function sleepByVoice() {
    if (muted) return;
    logNote("paused by voice: tap the speaker or press M to talk again");
    earcon.sleep();
    toggleMute();
    live.textContent = "Paused. Tap the speaker to talk again.";
  }

  startBtn.addEventListener("click", async () => {
    started = true;
    outCtx = new AudioContext({ sampleRate: 24000 });
    startEl.hidden = true;
    earcon.wake();
    if (!config?.sonic) {
      setState("error", "The voice isn't set up on this site yet. Press D to type.");
      return logNote("config.json has no sonic settings: deploy with scripts/deploy.ps1", "error");
    }
    try {
      await startMic();
    } catch (err) {
      // No microphone: typed turns (D) still get her voice. Sonic needs a steady audio stream, so it gets silence.
      setState("error", "I need the microphone. Allow it and reload, or press D to type.");
      logNote(`microphone: ${err.message || err}; typing only (press D)`, "error");
      setInterval(() => { if (sonic && !muted) sonic.audio(silence); }, 32);
      lastUserAt = Date.now();
      return openSonic("typing only");
    }
    setState("followup", "Listening. Just talk, no wake word needed.");
    DS?.status(`ears: Nova 2 Sonic (${config.sonic.region}, ${voiceId})${BARGE_IN ? ", barge-in on" : ", half-duplex"}`);
    lastUserAt = Date.now();
    openSonic("start");
  });

  device.addEventListener("click", () => { if (started) { if (isSpeaking()) stopSpeaking(); else toggleMute(); } });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "d" || e.key === "D") { debugEl.hidden = !debugEl.hidden; }
    else if (e.key === "m" || e.key === "M") { if (started) toggleMute(); }
    else if (e.key === "Escape" || e.code === "Space") { if (isSpeaking()) { e.preventDefault(); stopSpeaking(); } }
  });

  $("close-debug").addEventListener("click", () => { debugEl.hidden = true; });
  $("type-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("type-input");
    const t = input.value.trim();
    input.value = "";
    if (!t || !config) return;
    // Typed words go through Sonic like speech, so she says the reply; before the start tap, the reply is only shown.
    if (sonic) { logNote(`typed "${t}"`, "sent"); lastUserAt = Date.now(); dropAudio = false; heardLog.push(t); sonic.text(t); }
    else await askAgent(t, [t]);
  });
  $("new-session").addEventListener("click", () => {
    sessionId = newId();
    store.set("alexaChess.session", sessionId);
    debugLog.innerHTML = "";
    live.textContent = "New session";
  });
  // Cost so far this page load, at the ap-northeast-1 prices (2026-10-23), in the drawer every minute.
  setInterval(() => {
    if (!started || !usage.speechIn) return;
    const usd = (usage.speechIn * 0.00363 + usage.speechOut * 0.01452 + usage.textIn * 0.000396 + usage.textOut * 0.003311) / 1000;
    $("debug").querySelector("strong").textContent = `Debug · voice $${usd.toFixed(3)} so far`;
  }, 60000);

  logNote(`build ${BUILD} · voice: Nova 2 Sonic, speech to speech · ${BARGE_IN ? "barge-in on (use headphones)" : "half-duplex: tap or Esc to interrupt"}`);
  if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) startNote.textContent = "This browser can't stream the microphone. Use a recent Chrome, Edge, Safari or Firefox, or press D to type.";

  // ---------- config + warm-up ----------
  fetch("config.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((c) => {
      config = c;
      // Wake the Lambdas and fetch guest credentials while the user is still reading the start screen.
      fetch(c.agentUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ warm: true }) }).catch(() => {});
      if (c.sonic) credentials().catch((err) => logNote(`voice credentials: ${err.message || err}`, "error"));
    })
    .catch(() => { startNote.textContent = "Couldn't load config.json. Deploy the site with scripts/deploy.ps1."; });
})();
