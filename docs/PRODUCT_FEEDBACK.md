# AudiChess: product feedback

**Track:** Alexa+ (primary). **Mini challenge:** AWS Builder *(if entering; see the note at the end)*.

AudiChess is blind chess by voice:
- an Echo-style web page streams the mic to **Amazon Nova 2 Sonic**;
- Sonic calls one tool, which runs an agent on **Amazon Nova 2 Lite**;
- the agent plays through our **MCP server** (Streamable HTTP, 17 tools, Stockfish), following an **Agent Skill**
  (`SKILL.md`).

Everything runs on AWS. Detailed friction, with steps and severity, is in `docs/FRICTION_LOG.md`.

## AWS services we used, and how

| Service | How we used it |
|---|---|
| **Amazon Bedrock: Nova 2 Sonic** | Speech to speech: the browser streams 16 kHz mic audio over the bidirectional stream. Sonic transcribes, calls our tool and speaks the reply word for word. |
| **Amazon Bedrock: Nova 2 Lite** | The agent's model (Converse API, tool use, prompt caching), through the `global.` inference profile. |
| **Amazon Bedrock: Nova Pro / Nova Lite** | Nova Pro was the first agent model and is the judge in our 305-question eval. Nova Lite was in the A/B test. |
| **AWS Lambda** | Two functions with function URLs: the MCP server (1536 MB, Stockfish) and the agent. Stockfish ships as a Lambda layer. |
| **Amazon DynamoDB** | Games, every move (one row per half-move) and agent sessions. |
| **Amazon Cognito** (identity pools) | Guest credentials so the static page can call Sonic directly, scoped to one model. |
| **Amazon S3 + CloudFront** | The web page (origin access control, HTTPS). |
| **AWS Secrets Manager** | The MCP server's bearer token. |
| **AWS SAM / CloudFormation, IAM, CloudWatch Logs** | All infrastructure in one template; least-privilege roles; JSON logs. |
| **Amazon Transcribe** (streaming, custom vocabulary) | Our speech recognition for a few days (en-IN, custom vocabulary), then removed for cost. |
| **Amazon Polly** | The early voice and test audio for the Transcribe evals, then replaced by Sonic. |
| **AWS Cost Explorer** | Checking what each eval round really cost. |

Non-AWS tools:
- the MCP TypeScript SDK v2 (server and client) and MCP Inspector;
- the Agent Skills `SKILL.md` format;
- chess.js;
- Stockfish (WASM).

## Per tool

### Amazon Nova 2 Sonic

- **Used for:** the whole voice: listening and speaking, through one tool call per turn.
- **Worked well:**
  - The voices are natural, and Amy is the one we chose.
  - Tool use inside a speech-to-speech stream is a great pattern: Sonic is the ears and voice, and our agent keeps
    all the logic.
  - With synthetic audio it was 10/10 heard right and 10/10 spoken word for word.
  - Running cost is reasonable (about $0.012 per minute of talking).
- **Needs work:**
  - **Hallucinated tool calls** (the main problem): Sonic invented user turns and repeated the tool call, about 75
    calls in 77 s in one real game.
  - **No recognition biasing:** "rook" became "book", and "undo the last move" became "unbelievable isn't it".
  - **Silent "deaf" spells,** with no error event.
  - **Indian-English voices** transcribe English in Devanagari.
  - **Endpointing** is only HIGH / MEDIUM / LOW.
  - **Not offered in Mumbai.**
  - **No browser sample.**
- **Onboarding:** medium to hard. The event protocol (session, prompt, content blocks, audio, tool results) is strict
  about order and spread across pages. Getting the browser connected took a custom SDK bundle and the Cognito
  classic flow.
- **Would we build with it again?** Yes. It's the reason AudiChess feels like a speaker and not a web form. A custom
  vocabulary and a fix for repeated tool calls would make it production-ready.

### Amazon Nova 2 Lite (Bedrock Converse)

- **Used for:** the agent: picking tools, answering 305 kinds of chess questions, banter.
- **Worked well:**
  - It's fast (about 0.7 s a turn) and cheap (about $0.04 per 60-turn game with prompt caching).
  - Tool use is reliable.
  - It beat Nova Pro and Nova Lite on banter in our A/B test.
- **Needs work:**
  - It refused to help its own opponent ("that would be cheating").
  - Once, a 170-word reasoning monologue was spoken.
  - It copied few-shot examples word for word.
  - It called analysis tools for small talk and volunteered the best move.
- **Onboarding:** easy. Converse plus tool use plus `cachePoint` worked first time. The only stumble was model IDs:
  the plain ID is rejected on demand in ap-south-1, and you need the inference profile and wildcard-region IAM.
- **Would we build with it again?** Yes, for any fast tool-using agent.

### Amazon Bedrock (platform)

- **Worked well:**
  - One API for every model.
  - Prompt caching cut our input cost a lot.
  - Billing shows up per model.
- **Needs work:**
  - When a plain model ID is rejected, the error should name the inference profile to use.
  - A managed IAM policy for "invoke this profile wherever it routes" would help.
- **Would we build with it again?** Yes.

### AWS Lambda + function URLs

- **Used for:** the MCP server (stateless Streamable HTTP) and the agent.
- **Worked well:**
  - Stateless JSON mode for MCP fits Lambda exactly.
  - Function URLs gave us HTTPS endpoints with no API Gateway.
  - A Lambda layer packaged Stockfish cleanly.
- **Needs work:**
  - Cold starts (about 4.8 s on the first turn) needed a warm-up ping.
  - There is no official MCP-on-Lambda handler, so we wrote the adapter, Origin checks and bearer auth ourselves.
- **Onboarding:** easy.
- **Would we build with it again?** Yes.

### Amazon DynamoDB

- **Used for:** game state, every move as its own row (replayable games), and sessions.
- **Worked well:** on-demand tables, with nothing to tune. Any Lambda instance can serve any game.
- **Needs work:** nothing significant for this use.
- **Would we build with it again?** Yes.

### Amazon Cognito (identity pools)

- **Used for:** guest credentials so the browser can call Sonic with no server in the audio path.
- **Worked well:** guest access with a role scoped to one model ARN is a clean security story.
- **Needs work:** the enhanced (simplified) flow's session policy never allows Bedrock, and we had to use the classic
  flow. This should be documented in the Bedrock and Sonic browser guides, or allowed.
- **Onboarding:** hard, because of that one undocumented limit.
- **Would we build with it again?** Yes, with the classic flow.

### Amazon S3 + CloudFront, Secrets Manager, SAM / CloudFormation, IAM, CloudWatch

- **Worked well:**
  - The whole stack is one SAM template, and one script deploys it (`deploy.ps1`).
  - Origin access control keeps the bucket private.
  - Secrets Manager holds the MCP token.
  - Each function has its own CloudWatch log group, with JSON logs.
- **Needs work:** CloudFormation has no resource for Transcribe custom vocabularies (we used a script step).
- **Would we build with them again?** Yes.

### Amazon Transcribe (streaming)

- **Used for:** speech to text for a few days, before Sonic.
- **Worked well:** with an en-IN custom vocabulary (495 chess phrases), 12 of 12 spoken commands resolved, about
  0.5–0.7 s after speech.
- **Needs work:**
  - Continuous streaming cost too much for a personal budget during testing.
  - Multi-language identification added about 2.5 s per turn.
  - Vocabulary phrases can't contain digits.
- **Would we build with it again?** Yes, for accuracy-critical dictation, if the budget allows. Its custom vocabulary
  is exactly what Sonic is missing.

### Amazon Polly

- **Used for:** the first voice, and test audio for our recognition evals.
- **Worked well:** SSML and the Indian-English voices made realistic test clips.
- **Needs work:** it mispronounced some chess phrasing, and Sonic sounded more natural.
- **Would we build with it again?** Yes, for generating test audio.

### Alexa+ (track) and MCP / Agent Skills

- **Used for:**
  - the MCP server (`alexa_chess`, 17 tools, Streamable HTTP, bearer auth);
  - an Agent Skill (`SKILL.md`) that teaches blind-chess narration and the rival personality;
  - an Echo-style web simulator.
- **Worked well:**
  - The open standards made the server portable: the official MCP client and MCP Inspector connect with no changes.
  - The Skill format kept persona and tool guidance in one readable file.
- **Needs work:** we found no way to connect a custom MCP server to a real Alexa+ device. A developer preview, even
  limited to your own Echo, would let us test with Alexa's own speech and turn-taking.
- **Onboarding:** the MCP spec and SDK were straightforward. Running on Lambda in stateless mode needed a careful
  read of the transport section.
- **Would we build with it again?** Yes, and we'd ship AudiChess as a real Alexa+ experience on the day that's
  possible.

## Feature requests

| Request | Why it matters | Urgency |
|---|---|---|
| Sonic: custom vocabulary or phrase boosting | Domain words (chess moves, product names) are misheard with no way to fix them | Critical |
| Sonic: empty tool result = say nothing, and a cap on tool calls per turn | Prevents invented user turns and loops | Critical |
| Alexa+ developer preview for custom MCP servers | Lets track builders test on the real device | Important |
| Sonic: speech-detected / voice-activity events | Tells "heard nothing" from "ignored speech" | Important |
| Sonic: endpointing silence in milliseconds | Fine control over cutting in vs. waiting | Important |
| Sonic in ap-south-1, or a cross-region profile | Latency and data residency for Indian users | Important |
| Official browser sample: Cognito guest + Sonic + mic worklet | Saves the setup we had to do by hand | Important |
| Sonic: pin the input language separately from the voice | Indian-English voices without Devanagari transcripts | Important |
| Official MCP-on-Lambda handler (stateless, auth, Origin) | Every Alexa+ builder writes this adapter | Nice-to-have |
| Sonic: speaking-rate setting | Accessibility for blind users who hear every read-out | Nice-to-have |

---

*Note on the AWS Builder mini challenge: it has its own extra required fields on the Devpost form. The services
table above can be reused for them.*
