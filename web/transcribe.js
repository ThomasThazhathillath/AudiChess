// The Echo's ears: one Amazon Transcribe streaming connection fed from the microphone.
// mic (echo cancellation, noise suppression, auto gain) -> pcm-worklet.js (16 kHz s16le, 100 ms) -> event-stream
// frames (eventstream.js) -> presigned wss URL from alexa_chess_transcribe_url -> partial + final transcripts.
(function (root) {
  "use strict";

  const ES = root.AlexaEventStream;
  const CHUNK_BYTES = 3200; // 100 ms of 16 kHz 16-bit mono
  const BACKLOG_CHUNKS = 30; // keep up to 3 s of speech while (re)connecting, sent as soon as the socket opens
  const URL_FRESH_MS = 240000; // presigned URLs live 300 s; reuse a prefetched one for 4 min
  const LEVEL_EVERY_MS = 10000;

  class TranscribeEars {
    /**
     * @param {{
     *   getUrl: () => Promise<string>,
     *   log: (text: string) => void,
     *   onPartial: (r: {text: string, id: string}) => void,
     *   onFinal: (r: {text: string, alternatives: string[], languageCode?: string, id: string}) => void,
     *   onFatal?: (why: string) => void,
     * }} opts
     */
    constructor(opts) {
      this.opts = opts;
      this.ws = null;
      this.wanted = false; // a connection should be open (started and not suspended)
      this.silent = false; // send zeros instead of the mic (Alexa is speaking)
      this.backlog = [];
      this.backoff = 500;
      this.urlFailures = 0;
      this.retryTimer = null;
      this.prefetched = null; // { url, at }
      this.decoder = null;
      this.lastLevelLog = 0;
      this.levels = [];
      this.stallSince = 0;
      this.connId = 0;
      // Per Transcribe segment: what we already sent as an utterance (our own end-of-speech detection).
      this.segments = new Map(); // ResultId -> { consumed: string[], partials: string[], last: string, timer }
    }

    // ---------- our own end of speech ----------
    // Transcribe closes a segment only after a pause; with a TV or a fan on, that took 5–9 s in the live game.
    // An utterance ends when its partial text has not changed for opts.endpointMs(text) ms.
    segment(id) {
      let s = this.segments.get(id);
      if (!s) { s = { consumed: [], partials: [], last: "", timer: null }; this.segments.set(id, s); }
      return s;
    }

    /** The part of a segment's text not yet sent, or null when it is only a revision of what was sent. */
    unsent(s, text) {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      if (s.consumed.length === 0) return words.join(" ");
      const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
      const head = words.slice(0, s.consumed.length).map(norm);
      const same = head.filter((w, i) => w === norm(s.consumed[i] || "")).length / s.consumed.length;
      const rest = words.slice(s.consumed.length);
      // "Knight F3." sent early, then revised to "Knight to F3.": a revision, not a new "F3." to play. A one-word
      // continuation only counts when everything already sent was heard exactly the same way.
      if (same < 0.6 || rest.length === 0 || (rest.length === 1 && same < 1)) return null;
      return rest.join(" ");
    }

    endpoint(id) {
      const s = this.segments.get(id);
      if (!s || !s.last) return;
      const text = s.last;
      s.consumed = s.consumed.concat(text.split(/\s+/).filter(Boolean));
      const alternatives = ES.buildAlternatives(text, s.partials);
      s.partials = [];
      s.last = "";
      this.opts.onFinal({ text, alternatives, id, early: true });
    }

    onSegment(r) {
      const s = this.segment(r.id);
      const text = this.unsent(s, r.text);
      if (!r.isPartial) {
        clearTimeout(s.timer);
        this.segments.delete(r.id);
        if (!text) return;
        // Transcribe sometimes finalises with the tail cut off ("Why did you" after the partial "Why did you choose
        // this"): when the final is just the start of the last partial, the fuller partial is what was said.
        const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
        const last = s.partials[s.partials.length - 1] || "";
        const best = last && norm(last).startsWith(norm(text)) && norm(last).length > norm(text).length ? last : text;
        this.opts.onFinal({ text: best, alternatives: ES.buildAlternatives(best, s.partials.concat(best === text ? [] : [text])), languageCode: r.languageCode, id: r.id });
        return;
      }
      if (!text) return;
      if (text !== s.last) {
        if (s.partials[s.partials.length - 1] !== text) s.partials.push(text);
        s.last = text;
        clearTimeout(s.timer);
        const wait = this.opts.endpointMs ? this.opts.endpointMs(text) : 1200;
        s.timer = setTimeout(() => this.endpoint(r.id), wait);
      }
      this.opts.onPartial({ text, id: r.id });
    }

    /** Ask for the microphone and start streaming. Call from a user gesture. */
    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const track = this.stream.getAudioTracks()[0];
      const s = track.getSettings ? track.getSettings() : {};
      this.opts.log(`ears: mic "${track.label || "default"}" (echo cancel ${s.echoCancellation}, noise suppress ${s.noiseSuppression}, auto gain ${s.autoGainControl})`);
      track.onended = () => { this.opts.log("ears: the microphone was disconnected"); this.opts.onFatal?.("mic-ended"); };

      // A 16 kHz context lets the browser resample the mic with a proper filter; the worklet copes with any rate.
      try { this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" }); }
      catch { this.ctx = new AudioContext({ latencyHint: "interactive" }); }
      await this.ctx.audioWorklet.addModule("pcm-worklet.js");
      let source;
      try { source = this.ctx.createMediaStreamSource(this.stream); }
      catch {
        // Some browsers refuse a mic in a context at a different rate: fall back to the device rate.
        await this.ctx.close();
        this.ctx = new AudioContext({ latencyHint: "interactive" });
        await this.ctx.audioWorklet.addModule("pcm-worklet.js");
        source = this.ctx.createMediaStreamSource(this.stream);
      }
      this.node = new AudioWorkletNode(this.ctx, "pcm-worklet", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      this.node.port.onmessage = (e) => this.onAudio(new Uint8Array(e.data.pcm), e.data.rms);
      const mute = this.ctx.createGain();
      mute.gain.value = 0; // keeps the graph pulled without playing the mic back
      source.connect(this.node).connect(mute).connect(this.ctx.destination);
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.opts.log(`ears: audio at ${this.ctx.sampleRate} Hz -> 16000 Hz PCM`);
      this.wanted = true;
      this.connect();
    }

    /** Alexa is speaking: keep the stream alive with silence, so she never hears herself. */
    pause() { this.silent = true; this.backlog = []; }
    resume() { this.silent = false; }

    /** Close the stream (mute). The mic stays granted; resume with activate(). */
    suspend() {
      this.wanted = false;
      clearTimeout(this.retryTimer);
      this.close("suspended");
    }
    activate() {
      if (this.wanted) return;
      this.wanted = true;
      this.backoff = 500;
      this.connect();
    }

    // ---------- connection ----------
    async freshUrl() {
      const p = this.prefetched;
      this.prefetched = null;
      if (p && Date.now() - p.at < URL_FRESH_MS) return { url: p.url, ms: 0 };
      const t = performance.now();
      const url = await this.opts.getUrl();
      return { url, ms: Math.round(performance.now() - t) };
    }

    prefetch() {
      this.opts.getUrl().then((url) => { this.prefetched = { url, at: Date.now() }; }, () => { /* fetched again on demand */ });
    }

    async connect() {
      if (!this.wanted || (this.ws && this.ws.readyState <= 1)) return;
      clearTimeout(this.retryTimer);
      const id = ++this.connId;
      let got;
      try {
        got = await this.freshUrl();
        this.urlFailures = 0;
      } catch (err) {
        this.urlFailures++;
        this.opts.log(`ears: could not get a stream URL (${err.message || err})`);
        if (this.urlFailures >= 3) this.opts.onFatal?.("no-url");
        return this.retry();
      }
      if (id !== this.connId || !this.wanted) return;
      const t = performance.now();
      const ws = new WebSocket(got.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.decoder = new ES.Decoder();
      for (const s of this.segments.values()) clearTimeout(s.timer);
      this.segments.clear(); // result ids belong to one stream
      ws.onopen = () => {
        this.opts.log(`ears: connected (${got.ms ? `URL ${got.ms} ms, ` : "prefetched URL, "}socket ${Math.round(performance.now() - t)} ms)`);
        this.backoff = 500;
        this.stallSince = 0;
        // Speech captured while connecting goes first, so a word said during a reconnect is not lost.
        for (const chunk of this.backlog) ws.send(ES.encodeAudioEvent(chunk));
        this.backlog = [];
        this.prefetch();
        clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(() => this.prefetch(), URL_FRESH_MS);
      };
      ws.onmessage = (e) => this.onMessage(e.data);
      ws.onerror = () => { /* onclose follows with the code */ };
      ws.onclose = (e) => {
        if (this.ws === ws) this.ws = null;
        clearInterval(this.refreshTimer);
        this.opts.log(`ears: disconnected (code ${e.code}${e.reason ? `, ${e.reason}` : ""})`);
        if (this.wanted) this.retry();
      };
    }

    retry(min = 0) {
      if (!this.wanted) return;
      const wait = Math.max(min, this.backoff) * (0.8 + Math.random() * 0.4);
      this.backoff = Math.min(this.backoff * 2, 8000);
      this.opts.log(`ears: reconnecting in ${(wait / 1000).toFixed(1)} s`);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), wait);
    }

    close(why) {
      const ws = this.ws;
      this.ws = null;
      clearInterval(this.refreshTimer);
      if (!ws) return;
      try {
        if (ws.readyState === 1) ws.send(ES.encodeAudioEvent(new Uint8Array(0))); // polite end of stream
        ws.close(1000, why);
      } catch { /* already closing */ }
    }

    // ---------- audio ----------
    onAudio(pcm, rms) {
      this.levels.push(rms);
      this.opts.onLevel?.(rms);
      const now = Date.now();
      if (now - this.lastLevelLog > LEVEL_EVERY_MS) {
        const peak = Math.max(...this.levels);
        const avg = this.levels.reduce((a, b) => a + b, 0) / this.levels.length;
        this.opts.log(`ears: mic level avg ${(20 * Math.log10(avg + 1e-9)).toFixed(0)} dB, peak ${(20 * Math.log10(peak + 1e-9)).toFixed(0)} dB${this.silent ? " (sending silence: Alexa speaking)" : ""}`);
        this.levels = [];
        this.lastLevelLog = now;
      }
      if (!this.wanted) return;
      const chunk = this.silent ? new Uint8Array(pcm.length) : pcm;
      this.opts.onAudio?.(chunk); // local debugging: a copy of exactly what is streamed
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) {
        if (!this.silent) {
          this.backlog.push(chunk);
          if (this.backlog.length > BACKLOG_CHUNKS) this.backlog.shift();
        }
        return;
      }
      // A stalled socket (network gone without a close) piles up unsent audio: reconnect after 5 s of that.
      if (ws.bufferedAmount > CHUNK_BYTES * 50) {
        this.stallSince ||= now;
        if (now - this.stallSince > 5000) {
          this.opts.log("ears: connection stalled, reconnecting");
          this.close("stalled");
          this.retry();
        }
        return;
      }
      this.stallSince = 0;
      ws.send(ES.encodeAudioEvent(chunk));
    }

    // ---------- transcripts ----------
    onMessage(data) {
      let messages;
      try { messages = this.decoder.push(new Uint8Array(data)); }
      catch (err) { this.opts.log(`ears: bad frame (${err.message})`); this.close("bad frame"); return this.retry(); }
      for (const m of messages) {
        const p = ES.parseTranscript(m);
        if (p.kind === "exception") {
          this.opts.log(`ears: ${p.type}: ${p.message}`);
          // LimitExceeded = too many streams or too fast: back off longer. The socket closes after an exception.
          if (p.type === "LimitExceededException") this.backoff = Math.max(this.backoff, 4000);
          continue;
        }
        if (p.kind !== "results") continue;
        for (const r of p.results) {
          if (r.text) this.onSegment(r);
        }
      }
    }
  }

  root.TranscribeEars = TranscribeEars;
})(typeof window !== "undefined" ? window : globalThis);
