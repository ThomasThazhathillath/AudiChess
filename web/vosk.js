// Chess ears: a second, offline recognizer (Vosk with a chess-only grammar) beside Chrome's. Chrome hears
// "porn" for pawn; a recognizer that only knows chess words can't. Its reading goes to the agent as
// `chessHeard`. If the library or model is missing, it stays off and the page works as before.
// The pure helpers (timeline, hearings, pairing) have no DOM, so scripts/test-wake.mjs tests them in Node.
(function (root) {
  "use strict";

  const VOSK_URL = "https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js";
  const MODEL_PATH = "models/vosk-model-small-en-in-0.4.tar.gz"; // fetch with scripts/get-vosk-model.ps1
  const RATE = 16000;
  // Every word must be in the model's vocabulary (Vosk warns and drops others): "kingside" isn't, so it's
  // two words here.
  const GRAMMAR = [
    "alexa", "pawn", "knight", "bishop", "rook", "queen", "king", "takes", "captures", "to",
    "castle", "castles", "king side", "queen side", "short", "long",
    "promote", "equals", "check",
    "a", "b", "c", "d", "e", "f", "g", "h",
    "one", "two", "three", "four", "five", "six", "seven", "eight",
    "yes", "no", "white", "black", "easy", "medium", "hard", "full", "strength",
    "undo", "resign", "hint", "board", "repeat", "first", "second",
    "[unk]",
  ];
  const STABLE_MS = 1300;     // end an utterance when its words haven't changed for this long (noisy rooms)
  const PAIR_SLACK_MS = 1000; // Chrome's first interim result lags the start of speech
  const KEEP_MS = 120000;     // forget hearings older than this

  // ---------- pure helpers ----------

  /**
   * Maps the recognizer's stream time (seconds of audio fed) to wall-clock ms. Audio is fed in chunks; a
   * pause (Alexa speaking) or a stall opens a new segment so the mapping stays right afterwards.
   */
  function createTimeline(rate, reanchorMs = 500) {
    const segs = [];
    let fed = 0, gap = true;
    return {
      /** No audio is being fed (paused): the next chunk starts a new segment. */
      gap() { gap = true; },
      /** `n` samples were just fed; they ended at wall time `now`. */
      feed(n, now) {
        const startWall = now - (n / rate) * 1000;
        const last = segs[segs.length - 1];
        const expected = last ? last.wall + ((fed - last.sample) / rate) * 1000 : NaN;
        if (gap || !last || Math.abs(expected - startWall) > reanchorMs) segs.push({ sample: fed, wall: startWall });
        if (segs.length > 500) segs.splice(0, segs.length - 500);
        gap = false;
        fed += n;
      },
      /** Wall-clock ms for a stream time in seconds. */
      wall(sec) {
        const s = sec * rate;
        let seg = segs[0];
        for (const x of segs) { if (x.sample <= s) seg = x; else break; }
        return seg ? seg.wall + ((s - seg.sample) / rate) * 1000 : NaN;
      },
    };
  }

  /** A Vosk final result -> {text, start, end} in wall ms, or null if nothing was said. */
  function hearingFrom(result, timeline) {
    const words = (result && result.result) || [];
    const text = String((result && result.text) || words.map((w) => w.word).join(" ")).trim();
    if (!text || words.length === 0) return null;
    return { text, start: timeline.wall(words[0].start), end: timeline.wall(words[words.length - 1].end) };
  }

  /** Words after the last "alexa" (Chrome's text has the wake word removed too). */
  function afterWake(text) {
    const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    return words.slice(words.lastIndexOf("alexa") + 1).join(" ");
  }

  /** True if the text has at least one real word (not only [unk]). */
  function usable(text) {
    return String(text).split(/\s+/).some((w) => w && w !== "[unk]");
  }

  /**
   * The unused hearings that overlap a Chrome utterance [from, to] (wall ms), oldest first.
   * `from` is Chrome's first interim result, which comes a little after speech starts.
   */
  function overlapping(hearings, from, to, slackMs = PAIR_SLACK_MS) {
    return hearings
      .filter((h) => !h.used && h.end >= from - slackMs && h.start <= to)
      .sort((a, b) => a.start - b.start);
  }

  /** The text to send as chessHeard for these hearings, or null. */
  function chessText(matches) {
    const text = afterWake(matches.map((h) => h.text).join(" "));
    return usable(text) ? text : null;
  }

  // ---------- browser side ----------
  let state = "off"; // off | loading | ready | failed
  let log = () => {};
  let model = null, recognizer = null, ctx = null, stream = null, node = null;
  let paused = false, partial = "";
  let timeline = createTimeline(RATE);
  const hearings = [];
  const waiters = new Set();
  let loading = null;

  const TAP_WORKLET = `
    class ChessEarsTap extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.size = options.processorOptions.size;
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === this.size) {
            this.port.postMessage(this.buf, [this.buf.buffer]);
            this.buf = new Float32Array(this.size);
            this.n = 0;
          }
        }
        return true;
      }
    }
    registerProcessor("chess-ears-tap", ChessEarsTap);`;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function withTimeout(promise, ms, what) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
  }

  /** Load the library and the model in the background. Safe to call more than once. */
  function init(opts = {}) {
    if (opts.log) log = opts.log;
    if (loading) return loading;
    state = "loading";
    const modelUrl = new URL(MODEL_PATH, location.href).href; // the library's worker runs from a blob: URL
    const t0 = performance.now();
    loading = (async () => {
      const head = await fetch(modelUrl, { method: "HEAD" }).catch(() => null);
      if (!head || !head.ok) throw new Error(`model not found at ${MODEL_PATH} (run scripts/get-vosk-model.ps1)`);
      log("chess ears: loading model…");
      if (!root.Vosk) await loadScript(VOSK_URL);
      model = await withTimeout(new Promise((resolve, reject) => {
        const m = new root.Vosk.Model(modelUrl, -1);
        m.on("load", (msg) => (msg.result ? resolve(m) : reject(new Error("model failed to load"))));
        m.on("error", (msg) => reject(new Error(msg.error || "model error")));
      }), 120000, "model load");
      model.on("error", (msg) => log(`chess ears error: ${msg.error}`));
      state = "ready";
      log(`chess ears: model loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    })().catch((err) => {
      state = "failed";
      log(`chess ears off: ${err.message || err}`);
    });
    return loading;
  }

  /** Open the mic and start hearing. Call from a user gesture (it creates an AudioContext). */
  async function start() {
    if (ctx) return;
    try {
      try { ctx = new AudioContext({ sampleRate: RATE }); } catch { ctx = new AudioContext(); }
      ctx.resume().catch(() => {});
      await init();
      if (state !== "ready") return stop();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (!ctx) return stop(); // stopped while waiting for the mic
      const rate = ctx.sampleRate;
      timeline = createTimeline(rate);
      recognizer = new model.KaldiRecognizer(rate, JSON.stringify(GRAMMAR));
      recognizer.setWords(true);
      let lastLevelAt = 0, levelTicks = 0, levelPeak = 0;
      const note = (text) => window.dispatchEvent(new CustomEvent("chess-ears-log", { detail: text }));
      let lastPartial = "";
      // Vosk only ends an utterance after silence; with steady background noise that never comes. When the
      // words stop changing for STABLE_MS, end it ourselves.
      let stableTimer = 0;
      recognizer.on("partialresult", (msg) => {
        partial = (msg.result && msg.result.partial) || "";
        if (partial && partial !== lastPartial) {
          note(`chess ears hearing "${partial}"…`);
          clearTimeout(stableTimer);
          stableTimer = setTimeout(() => {
            if (!partial || !recognizer || typeof recognizer.retrieveFinalResult !== "function") return;
            note(`chess ears: words stable for ${STABLE_MS / 1000} s, ending the utterance`);
            try { recognizer.retrieveFinalResult(); } catch { /* next silence ends it instead */ }
          }, STABLE_MS);
        }
        lastPartial = partial;
      });
      recognizer.on("result", (msg) => {
        clearTimeout(stableTimer);
        partial = "";
        lastPartial = "";
        if (msg.result && msg.result.text) note(`chess ears heard "${msg.result.text}"`);
        const h = hearingFrom(msg.result, timeline);
        if (!h) return;
        const cutoff = Date.now() - KEEP_MS;
        while (hearings.length && hearings[0].end < cutoff) hearings.shift();
        hearings.push(h);
        // app.js uses this on its own when Chrome's recognizer returns nothing for the same speech.
        root.dispatchEvent?.(new CustomEvent("chess-ears-final", { detail: h }));
        for (const w of [...waiters]) w(false);
      });
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, "chess-ears-tap", { processorOptions: { size: Math.round(rate / 10) } });
      node.port.onmessage = (e) => {
        // Mic level once a second, so the drawer shows whether any audio reaches the page at all.
        if (Date.now() - lastLevelAt > 1000) {
          lastLevelAt = Date.now();
          let peak = 0;
          for (const v of e.data) peak = Math.max(peak, Math.abs(v));
          levelPeak = Math.max(levelPeak, peak);
          if (++levelTicks >= 3) { note(`mic level ${levelPeak.toFixed(3)}${levelPeak < 0.005 ? " (silent: wrong input device?)" : ""}`); levelTicks = 0; levelPeak = 0; }
        }
        if (paused || !recognizer) { timeline.gap(); return; }
        timeline.feed(e.data.length, Date.now());
        recognizer.acceptWaveformFloat(e.data, rate);
      };
      const silent = ctx.createGain();
      silent.gain.value = 0; // the worklet must reach the destination to be pulled; keep it inaudible
      ctx.createMediaStreamSource(stream).connect(node).connect(silent).connect(ctx.destination);
      log(`chess ears: listening (${rate} Hz, ${GRAMMAR.length} words)`);
    } catch (err) {
      log(`chess ears off: ${err.message || err}`);
      stop();
    }
  }

  /** Half-duplex: stop feeding audio while Alexa speaks (or the mic is muted). */
  function pause() {
    if (paused) return;
    paused = true;
    timeline.gap();
    if (recognizer) recognizer.retrieveFinalResult(); // flush what was said before Alexa started
  }
  function resume() { paused = false; }

  function stop() {
    if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (recognizer) { recognizer.remove(); recognizer = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    partial = "";
  }

  /**
   * What chess ears heard during a Chrome utterance [from, to] (wall ms). Waits up to `waitMs` for Vosk to
   * finish the utterance. Resolves to text without the wake word, or null (nothing usable, or ears off).
   */
  function hear(from, to, waitMs = 400) {
    if (!recognizer) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer = null;
      const attempt = (final) => {
        const matches = overlapping(hearings, from, to);
        if (!final && (matches.length === 0 || partial)) return; // Vosk may still be mid-utterance
        waiters.delete(attempt);
        clearTimeout(timer);
        matches.forEach((h) => { h.used = true; });
        resolve(chessText(matches));
      };
      waiters.add(attempt);
      timer = setTimeout(() => attempt(true), waitMs);
      attempt(false);
    });
  }

  root.ChessEars = {
    init, start, stop, pause, resume, hear,
    get state() { return recognizer ? "listening" : state; },
    // pure helpers, exported for tests
    GRAMMAR, createTimeline, hearingFrom, afterWake, usable, overlapping, chessText,
  };
})(typeof window !== "undefined" ? window : globalThis);
