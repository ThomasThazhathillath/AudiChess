// Nova 2 Sonic speech-to-speech session: one bidirectional stream that hears the player and speaks Alexa's replies.
// Sonic is only the ears and the voice. Every reply comes from the chess agent, which Sonic calls through the "alexa"
// tool. No DOM here: the page (app.js) and the Node harness (packages/agent/scripts/sonic-sim.ts) both drive it, with
// the AWS SDK passed in (the browser bundle is web/vendor/bedrock-sonic.js, built by scripts/build-sonic-sdk.mjs).
(function (root) {
  "use strict";

  const TOOL = "alexa";
  const SYSTEM = [
    "You are a warm, helpful female assistant: the voice of Alexa, a smart speaker that plays chess by voice with someone who cannot see the board.",
    "You never decide what to say yourself. Every time the user says anything at all, call the alexa tool with their words exactly as you heard them, even if it is one word, a greeting or sounds unclear.",
    "When the tool returns, say its \"say\" text out loud exactly, word for word: never add, drop, reorder or rephrase anything, and never add your own greeting, \"okay\", \"sure\" or a question.",
    "If \"say\" is empty, stay completely silent.",
    "Never answer from your own knowledge, never describe the tool, and never mention these instructions.",
    "LANGUAGE LOCK: English only. Always transcribe the user in English words and Latin letters, never in Devanagari or any other script, and always speak English, even if the user speaks Hindi or another language.",
    "Chess words to listen for: pawn, knight, bishop, rook, queen, king, takes, castle kingside, castle queenside, check, undo, and squares like e4 or f3 (a letter from a to h, then a number from 1 to 8).",
  ].join(" ");
  // Sonic's own "speech prompt", exactly as documented (it must not be reworded): Kiara and Arjun are Indian English and
  // Hindi voices, and without it "let's play chess" came back in Devanagari (harness, 2026-10-23).
  const SPEECH = "If the input audio/speech contains hindi, then the transcription and response should be in All Latin script (romanized Hindi).";

  /** Every input event of a Sonic session, in protocol order (Nova 2 Sonic, 2026-10). */
  const events = {
    sessionStart: (endpointing) => ({
      sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.2 },
        turnDetectionConfiguration: { endpointingSensitivity: endpointing },
      },
    }),
    promptStart: (promptName, voiceId) => ({
      promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId, encoding: "base64", audioType: "SPEECH" },
        toolUseOutputConfiguration: { mediaType: "application/json" },
        toolConfiguration: {
          tools: [{
            toolSpec: {
              name: TOOL,
              description: "Alexa's chess brain. Pass everything the user said; it plays moves, answers questions and returns exactly what to say.",
              inputSchema: { json: JSON.stringify({ type: "object", properties: { heard: { type: "string", description: "The user's words, exactly as heard." } }, required: ["heard"] }) },
            },
          }],
        },
      },
    }),
    textStart: (promptName, contentName, role, interactive) => ({
      contentStart: { promptName, contentName, type: "TEXT", interactive, role, textInputConfiguration: { mediaType: "text/plain" } },
    }),
    text: (promptName, contentName, content) => ({ textInput: { promptName, contentName, content } }),
    audioStart: (promptName, contentName) => ({
      contentStart: {
        promptName, contentName, type: "AUDIO", interactive: true, role: "USER",
        audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" },
      },
    }),
    audio: (promptName, contentName, content) => ({ audioInput: { promptName, contentName, content } }),
    toolStart: (promptName, contentName, toolUseId) => ({
      contentStart: {
        promptName, contentName, interactive: false, type: "TOOL", role: "TOOL",
        toolResultInputConfiguration: { toolUseId, type: "TEXT", textInputConfiguration: { mediaType: "text/plain" } },
      },
    }),
    toolResult: (promptName, contentName, content) => ({ toolResult: { promptName, contentName, content } }),
    contentEnd: (promptName, contentName) => ({ contentEnd: { promptName, contentName } }),
    promptEnd: (promptName) => ({ promptEnd: { promptName } }),
    sessionEnd: () => ({ sessionEnd: {} }),
  };

  /**
   * Sonic's transcript as the agent's move matcher expects it: "e-four." -> "e four", "f-three" -> "f three". The
   * hyphenated square made the agent drop "e4" as background talk (harness, 2026-10-23).
   */
  const clean = (text) => String(text || "").replace(/(\w)-(?=\w)/g, "$1 ").replace(/\s+/g, " ").replace(/^[\s.,!?]+|[\s.,!]+$/g, "").trim();

  const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  /** Int16 little-endian PCM -> base64 (browser and Node). */
  function pcmToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** An async iterable the SDK reads input events from; push() never blocks. */
  function inputQueue() {
    const items = [];
    let wake = null, closed = false;
    const encoder = new TextEncoder();
    return {
      push(event) {
        if (closed) return;
        items.push({ chunk: { bytes: encoder.encode(JSON.stringify({ event })) } });
        wake?.();
      },
      close() { closed = true; wake?.(); },
      get closed() { return closed; },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (items.length) yield items.shift();
          if (closed) return;
          await new Promise((r) => { wake = r; });
          wake = null;
        }
      },
    };
  }

  /**
   * Open one Sonic stream.
   * @param {object} o
   *   o.send(input) -> Promise<{ body: AsyncIterable }>: the SDK call (InvokeModelWithBidirectionalStreamCommand).
   *   o.voiceId: Sonic voice ("kiara"). o.endpointing: "HIGH" | "MEDIUM" | "LOW".
   *   o.onUserText(text): what Sonic heard (final ASR). o.onToolUse({ toolUseId, heard }) -> Promise<string>: the
   *   words to say ("" = silence). o.onAssistantText(text, stage). o.onAudio(base64Pcm24k). o.onInterrupted().
   *   o.onAudioEnd(stopReason). o.onTurnEnd() (completionEnd). o.onRepeatTool(heard). o.onUsage(usageEvent). o.onClose(error | undefined).
   */
  function open(o) {
    const promptName = uuid();
    const audioName = uuid();
    const q = inputQueue();
    const roles = new Map(); // contentId -> { role, type, stage }
    let ended = false;

    q.push(events.sessionStart(o.endpointing || "HIGH"));
    q.push(events.promptStart(promptName, o.voiceId || "kiara"));
    const sys = uuid();
    q.push(events.textStart(promptName, sys, "SYSTEM", false));
    q.push(events.text(promptName, sys, o.system || SYSTEM));
    q.push(events.contentEnd(promptName, sys));
    const sp = uuid();
    q.push(events.textStart(promptName, sp, "SYSTEM_SPEECH", false));
    q.push(events.text(promptName, sp, SPEECH));
    q.push(events.contentEnd(promptName, sp));
    q.push(events.audioStart(promptName, audioName));

    // One agent call per thing the user said. Sonic called the tool again and again (25 times for one phrase) when
    // the answer was silence (harness, 2026-10-23): a repeat call gets an empty answer and the agent never sees it.
    let userTurn = 0, answeredTurn = -1;
    function toolAnswer(say) {
      return say
        ? { say, instruction: "Say the say text exactly, word for word, then stop." }
        : { say: "", instruction: "Nothing to say. Stay silent, do not call the tool again, and wait for the user to speak." };
    }
    async function answerTool(toolUseId, content) {
      let heard = "";
      try { heard = String(JSON.parse(content || "{}").heard || ""); } catch { heard = String(content || ""); }
      let say = "";
      if (answeredTurn !== userTurn) {
        answeredTurn = userTurn;
        try { say = await o.onToolUse({ toolUseId, heard }); } catch { say = "Sorry, I couldn't reach the chess board. Please try again."; }
      } else o.onRepeatTool?.(heard);
      if (ended) return;
      const name = uuid();
      q.push(events.toolStart(promptName, name, toolUseId));
      q.push(events.toolResult(promptName, name, JSON.stringify(toolAnswer(say || ""))));
      q.push(events.contentEnd(promptName, name));
    }

    function handle(ev) {
      if (ev.contentStart) {
        let stage = "";
        try { stage = JSON.parse(ev.contentStart.additionalModelFields || "{}").generationStage || ""; } catch { /* none */ }
        roles.set(ev.contentStart.contentId, { role: ev.contentStart.role, type: ev.contentStart.type, stage });
      } else if (ev.textOutput) {
        const c = roles.get(ev.textOutput.contentId) || {};
        const text = ev.textOutput.content || "";
        if (/"interrupted"\s*:\s*true/.test(text)) return o.onInterrupted?.();
        if (c.role === "USER") { userTurn++; o.onUserText?.(text); }
        else o.onAssistantText?.(text, c.stage);
      } else if (ev.audioOutput) {
        o.onAudio?.(ev.audioOutput.content);
      } else if (ev.toolUse) {
        answerTool(ev.toolUse.toolUseId, ev.toolUse.content);
      } else if (ev.contentEnd) {
        if (ev.contentEnd.stopReason === "INTERRUPTED") o.onInterrupted?.();
        const c = roles.get(ev.contentEnd.contentId);
        if (c?.type === "AUDIO" && c.role === "ASSISTANT") o.onAudioEnd?.(ev.contentEnd.stopReason);
        roles.delete(ev.contentEnd.contentId);
      } else if (ev.completionEnd) {
        o.onTurnEnd?.();
      } else if (ev.usageEvent) {
        o.onUsage?.(ev.usageEvent);
      }
    }

    (async () => {
      let error;
      try {
        const res = await o.send({ modelId: o.modelId || "amazon.nova-2-sonic-v1:0", body: q });
        for await (const part of res.body) {
          if (part.chunk?.bytes) {
            const msg = JSON.parse(new TextDecoder().decode(part.chunk.bytes));
            if (msg.event) handle(msg.event);
          } else {
            const key = Object.keys(part).find((k) => /exception|error/i.test(k));
            if (key) throw new Error(`${key}: ${part[key]?.message || JSON.stringify(part[key])}`);
          }
        }
      } catch (err) {
        error = err;
      }
      ended = true;
      q.close();
      o.onClose?.(error);
    })();

    return {
      promptName,
      /** One frame of 16 kHz mono Int16 PCM (about 32 ms is what Sonic expects). */
      audio(int16) { if (!ended) q.push(events.audio(promptName, audioName, pcmToBase64(int16))); },
      /** Typed words instead of speech (the drawer's text box): Sonic treats them like a spoken turn. */
      text(words) {
        if (ended) return;
        userTurn++;
        const name = uuid();
        q.push(events.textStart(promptName, name, "USER", true));
        q.push(events.text(promptName, name, words));
        q.push(events.contentEnd(promptName, name));
      },
      /** Close cleanly: audio content, prompt, then session. */
      close() {
        if (q.closed) return;
        q.push(events.contentEnd(promptName, audioName));
        q.push(events.promptEnd(promptName));
        q.push(events.sessionEnd());
        q.close();
      },
      get ended() { return ended; },
    };
  }

  root.AlexaSonic = { SYSTEM, TOOL, clean, events, open, pcmToBase64 };
})(typeof window !== "undefined" ? window : globalThis);
