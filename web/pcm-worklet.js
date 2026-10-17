// AudioWorklet: microphone -> 16 kHz mono 16-bit PCM in 100 ms chunks for Amazon Transcribe.
// Runs on the audio thread. If the AudioContext already runs at 16 kHz (Chrome resamples the mic for us) this only
// converts and batches; otherwise it low-passes (moving average) and resamples by linear interpolation.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outRate = 16000;
    this.ratio = sampleRate / this.outRate; // input samples per output sample
    this.taps = Math.max(1, Math.round(this.ratio)); // anti-alias: average over ~one output period
    this.hist = new Float32Array(this.taps);
    this.histPos = 0;
    this.histSum = 0;
    this.pos = 0; // fractional read position into the filtered stream, relative to `prev`
    this.prev = 0; // last filtered sample of the previous block
    this.chunk = new Int16Array(1600); // 100 ms at 16 kHz
    this.fill = 0;
    this.sq = 0; // for the level meter
  }

  push(s) {
    this.sq += s * s;
    const v = Math.max(-1, Math.min(1, s));
    this.chunk[this.fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.fill === this.chunk.length) {
      const rms = Math.sqrt(this.sq / this.chunk.length);
      this.port.postMessage({ pcm: this.chunk.buffer, rms }, [this.chunk.buffer]);
      this.chunk = new Int16Array(1600);
      this.fill = 0;
      this.sq = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.taps === 1 && Math.abs(this.ratio - 1) < 1e-6) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    // Moving-average low-pass, then linear interpolation at `ratio` steps.
    const filtered = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      this.histSum += ch[i] - this.hist[this.histPos];
      this.hist[this.histPos] = ch[i];
      this.histPos = (this.histPos + 1) % this.taps;
      filtered[i] = this.histSum / this.taps;
    }
    // Position -1 is `prev`, 0..n-1 are this block's samples.
    while (this.pos < filtered.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.prev : filtered[i];
      const b = filtered[i + 1];
      this.push(a + (b - a) * frac);
      this.pos += this.ratio;
    }
    this.pos -= filtered.length;
    this.prev = filtered[filtered.length - 1];
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
