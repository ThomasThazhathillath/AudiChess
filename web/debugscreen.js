// Always-visible debug screen (until the app is fully tuned): what the mic hears, live, and what happened to
// each utterance. Hide it with ?debug=0. No dependencies; app.js feeds it.
(function (root) {
  "use strict";

  const MAX_ROWS = 14;
  let el = null, hearingEl = null, statusEl = null, modeEl = null, meterEl = null, listEl = null, getState = null;
  let lastHearingAt = 0;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const time = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function init(opts) {
    getState = opts.state;
    el = document.createElement("section");
    el.id = "debugscreen";
    el.setAttribute("aria-label", "What Alexa hears");
    el.innerHTML = `
      <div class="ds-top">
        <span class="ds-status" id="ds-status">ears: not started</span>
        <span class="ds-meter" title="microphone level"><span id="ds-meter"></span></span>
        <span class="ds-mode" id="ds-mode"></span>
      </div>
      <div class="ds-hearing-label">Hearing now</div>
      <div class="ds-hearing" id="ds-hearing">…</div>
      <ol class="ds-list" id="ds-list"></ol>`;
    document.body.appendChild(el);
    document.body.classList.add("with-debugscreen");
    hearingEl = el.querySelector("#ds-hearing");
    statusEl = el.querySelector("#ds-status");
    modeEl = el.querySelector("#ds-mode");
    meterEl = el.querySelector("#ds-meter");
    listEl = el.querySelector("#ds-list");
    setInterval(updateMode, 300);
  }

  /** The words being heard right now (partial results). */
  function hearing(text, note) {
    if (!el) return;
    hearingEl.textContent = text || "…";
    hearingEl.dataset.note = note || "";
    hearingEl.classList.add("live");
    lastHearingAt = Date.now();
  }

  /** Connection and recognizer status: "ears: connected", "ears: reconnecting in 2 s", errors. */
  function status(text, bad) {
    if (!el) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("bad", !!bad);
  }

  /** Mic level from the audio worklet (RMS 0..1), shown as a bar in dB from -60 to 0. */
  function level(rms) {
    if (!el) return;
    const db = 20 * Math.log10(rms + 1e-9);
    meterEl.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  }

  function updateMode() {
    if (!el || !getState) return;
    const s = getState();
    const now = Date.now();
    let text;
    if (s.muted) text = "🔇 muted";
    else if (s.speaking) text = s.halfDuplex ? "🔊 Alexa speaking: tap or press Esc to interrupt" : "🔊 Alexa speaking: say “stop” or “Alexa” to interrupt";
    else if (s.busy) text = "⏳ thinking…";
    else if (s.openMic && !(s.awakeUntil > now)) text = "👂 listening: just talk (no “Alexa” needed)";
    else if (s.awakeUntil > now) text = `👂 awake: say your command (${Math.ceil((s.awakeUntil - now) / 1000)} s)`;
    else if (s.followUpUntil > now) text = `💬 no “Alexa” needed for ${Math.ceil((s.followUpUntil - now) / 1000)} s`;
    else text = "😴 waiting for “Alexa”";
    modeEl.textContent = text;
    if (lastHearingAt && now - lastHearingAt > 2500) hearingEl.classList.remove("live");
  }

  /**
   * One row in the history. kind: heard | sent | ignored | dropped | reply | interrupt | error | info
   */
  function event(kind, text, detail) {
    if (!el) return;
    const li = document.createElement("li");
    li.className = `ds-${kind}`;
    const icon = { heard: "🗣", sent: "➡", ignored: "🚫", dropped: "🔇", reply: "🔵", interrupt: "✋", error: "⚠", info: "·" }[kind] || "·";
    li.innerHTML = `<span class="ds-time">${time()}</span> ${icon} <span class="ds-text">${esc(text)}</span>${detail ? ` <span class="ds-detail">${esc(detail)}</span>` : ""}`;
    listEl.prepend(li);
    while (listEl.children.length > MAX_ROWS) listEl.lastChild.remove();
  }

  root.DebugScreen = { init, hearing, status, level, event };
})(typeof window !== "undefined" ? window : globalThis);
