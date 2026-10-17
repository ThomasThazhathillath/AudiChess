# Alexa+ Blind Chess — Build Plan

> On approval, this plan is copied into the repo as `docs/PLAN.md` (first step of Phase 0) and kept up to date as phases complete.

## Context

Build, Ship, Shape Hackathon — Alexa+ track: "Build a working MCP integration on the open standards for Agent Skills and Streamable HTTP transports. You can simulate an Alexa+ experience … via a web app."

Idea: play **blind chess by voice**. A web page imitates an Echo device. You speak a move, an agent (Amazon Bedrock, **Amazon Nova Pro**) works out what you meant and calls tools on our **MCP server** over **Streamable HTTP**. The server validates the move (chess.js), plays a reply with a real engine (**Stockfish**, not the LLM, because LLMs make illegal moves and lose the board), and the agent speaks the result.

Decisions so far:
- All on AWS, region **ap-south-1 (Mumbai)**, infra as a **SAM template**.
- Voice is **browser only**: Web Speech API for listening (Chrome/Edge) and `speechSynthesis` for speaking. No Polly.
- **Voice only**: no MCP Apps `ui://` board view. "Agent Skills" is covered by a standard `SKILL.md` (agentskills.io format) that teaches the agent blind-chess narration and move disambiguation.
- TypeScript / Node 22 throughout (Node 24 is installed locally; no Python needed).
- Order: **AWS infra, deployed → MCP server → agent + Echo web page.**
- **Naming:** one environment, no dev/prod. Every resource is named `alexa_chess_*`: Lambdas `alexa_chess_mcp_server` / `alexa_chess_agent`, tables `alexa_chess_games` / `alexa_chess_moves` / `alexa_chess_sessions`, secret `alexa_chess_mcp_token`, layer `alexa_chess_stockfish`, AWS CLI profile `default` (IAM user access keys). AWS rules force two exceptions: the stack is `alexa-chess` (no underscores allowed), the website bucket is `alexa-chess-website-bucket` and the deploy-artifacts bucket is `alexa-chess-cloudformation-bucket` (S3: lowercase, globally unique, no underscores).
- **Every move is persisted** (human and engine) as its own row in `alexa_chess_moves` before the tool returns, so games can be replayed and reviewed.

## Architecture

```
Browser (S3 + CloudFront)                 AWS ap-south-1
┌─────────────────────────┐   HTTPS   ┌──────────────────────────────┐
│ Echo simulator page     │ ───────▶  │ AgentFunction (Function URL) │
│  mic → SpeechRecognition│  /chat    │  Bedrock Converse tool loop  │
│  text ← speechSynthesis │ ◀───────  │  = MCP client                │
└─────────────────────────┘           └──────────────┬───────────────┘
                                         Streamable HTTP, Bearer token
                                                      ▼
                                      ┌──────────────────────────────┐
                                      │ McpServerFunction (Fn URL)   │
                                      │  POST /mcp  JSON-RPC         │
                                      │  chess.js + Stockfish WASM   │
                                      └──────────────┬───────────────┘
                                                      ▼
                                      DynamoDB alexa_chess_games / _moves / _sessions
```

**Why Lambda works for MCP:** the server runs Streamable HTTP in **stateless JSON mode**. Every POST gets one `application/json` response, there's no `MCP-Session-Id`, and GET returns 405. All three are allowed by the 2025-11-25 spec. Game state lives in DynamoDB keyed by `gameId`, so any Lambda instance can answer any request.

## Repo layout (target)

```
Alexa+ Chess/
├─ docs/PLAN.md
├─ template.yaml                 # SAM: all AWS resources
├─ samconfig.toml                # stack name, region ap-south-1, capabilities
├─ package.json                  # npm workspaces root
├─ layers/stockfish/nodejs/package.json   # stockfish npm in a Lambda layer
├─ packages/
│  ├─ shared/                    # types: GameState, tool names
│  ├─ mcp-server/src/
│  │   ├─ handler.ts             # Lambda ⇄ MCP Streamable HTTP adapter
│  │   ├─ server.ts              # McpServer + tool registrations
│  │   ├─ chess/game.ts          # chess.js wrapper, spoken-move formatting
│  │   ├─ chess/engine.ts        # Stockfish (UCI over WASM), Elo levels
│  │   └─ store.ts               # DynamoDB get/put game
│  └─ agent/src/
│      ├─ handler.ts             # POST /chat → reply text
│      ├─ bedrock.ts             # Converse API loop with tool use
│      ├─ mcpClient.ts           # @modelcontextprotocol/sdk client, HTTP transport
│      └─ history.ts             # chat history in DynamoDB
│  └─ agent/skills/blind-chess/SKILL.md  # Agent Skill (bundled into the agent Lambda)
├─ web/                          # static Echo simulator (index.html, app.js, styles.css)
└─ scripts/
   ├─ deploy.ps1                 # sam build + deploy + publish web + write config.json
   └─ (packages/mcp-server/scripts/smoke.ts)  # official MCP client smoke test: npm run smoke -- <url> <token>
```

---

## Phase 0: Local setup (one-time)

1. `git init`, `.gitignore` (node_modules, .aws-sam, dist, samconfig local overrides), and copy this plan to `docs/PLAN.md`.
2. Install the tools with winget:
   - `winget install Amazon.AWSCLI`
   - `winget install Amazon.SAM-CLI`
   - `npm install -g esbuild`: SAM's esbuild builder needs it on PATH.
   - Docker is **not** needed: functions build with SAM's esbuild builder, and the layer builds with npm.
   - The Stockfish layer keeps only the `lite-single` engine (~1.8 MB). Its `postinstall` deletes the ~95 MB full-network builds.
3. AWS credentials. You have an account but no CLI keys yet:
   - Recommended: **IAM Identity Center**. Enable it, create a user with the `AdministratorAccess` permission set, then run `aws configure sso` (profile `alexa_chess`, region `ap-south-1`).
   - Fallback: create an IAM user with an access key, then run `aws configure --profile default`.
   - Check with `aws sts get-caller-identity --profile default`.
4. **Bedrock model: Amazon Nova Pro**, called through the APAC cross-region inference profile `apac.amazon.nova-pro-v1:0`. On-demand calls to the plain `amazon.nova-pro-v1:0` ID are rejected in ap-south-1, so the profile is required. Access was verified with a Converse call (~0.6 s). Claude models were not enabled for this account.

## Phase 1: AWS infrastructure (SAM), deployed

Write `template.yaml` with stub handlers, so the whole stack deploys and gets its URLs before any real logic exists.

**Parameters:** `BedrockModelId` (APAC inference profile ID), `AllowedOrigin` (default `*` until CloudFront exists; the deploy script then sets the CloudFront domain).

**Globals:** Node 22.x, **arm64**, `Tracing: Active`, env `GAMES_TABLE`, `MOVES_TABLE`, `SESSIONS_TABLE`, `LOG_LEVEL`.

**Resources:**
| Resource | Type | Notes |
|---|---|---|
| `GamesTable` | `alexa_chess_games` | PK `gameId`. One item per game: color, level, current FEN, status, result, created/updated timestamps. No TTL: kept as history. |
| `MovesTable` | `alexa_chess_moves` | PK `gameId`, SK `ply` (number). **One item per half-move**, written on every human and engine move: `san`, `uci`, `by` (human/engine), `spoken`, `fenAfter`, `timestamp`. Full replayable game history; `last_moves` and a `game_history` tool read from here. |
| `SessionsTable` | `alexa_chess_sessions` | PK `sessionId`. Agent chat turns + current `gameId`, TTL `expiresAt` 7 days. |
| `McpAuthSecret` | `AWS::SecretsManager::Secret` | `GenerateSecretString`, 40 chars, no punctuation. Bearer token for `/mcp`. |
| `StockfishLayer` | `AWS::Serverless::LayerVersion` | `ContentUri: layers/stockfish`, `BuildMethod: nodejs22.x`, compatible with arm64. |
| `McpServerFunction` | `AWS::Serverless::Function` | esbuild (`External: [stockfish]`), 1536 MB (Stockfish speed), 30 s timeout, `FunctionUrlConfig: AuthType NONE`, layer above. Policies: `DynamoDBCrudPolicy` on the table, `AWSSecretsManagerGetSecretValuePolicy` on the secret. Env `MCP_SECRET_ARN`. |
| `AgentFunction` | `AWS::Serverless::Function` | esbuild, 1024 MB, 60 s timeout (several Bedrock rounds), Function URL with **CORS** (`AllowOrigins: [!Ref AllowedOrigin]`, POST, `content-type`). Policies: DynamoDB CRUD, secret read, and `bedrock:InvokeModel` + `bedrock:Converse` on `arn:aws:bedrock:*::foundation-model/*` and `arn:aws:bedrock:ap-south-1:${AWS::AccountId}:inference-profile/*`. Wildcard regions are needed because APAC profiles route across Asia-Pacific regions. Env `MCP_URL` (McpServer Function URL), `MODEL_ID`, `MCP_SECRET_ARN`. |
| `McpLogGroup`, `AgentLogGroup` | `AWS::Logs::LogGroup` | 14-day retention. |
| `WebsiteBucket` | `AWS::S3::Bucket` | Private, block all public access, SSE-S3. |
| `WebsiteOAC` | `AWS::CloudFront::OriginAccessControl` | sigv4, s3. |
| `WebsiteDistribution` | `AWS::CloudFront::Distribution` | Default root `index.html`, `CachingOptimized` policy, HTTPS redirect, PriceClass_200 (includes India). |
| `WebsiteBucketPolicy` | `AWS::S3::BucketPolicy` | Allows `cloudfront.amazonaws.com` with `AWS:SourceArn` = the distribution. |

**Outputs:** `McpServerUrl` (Function URL + `mcp`), `AgentUrl`, `WebsiteUrl` (`https://<cf-domain>`), `WebsiteBucketName`, `DistributionId`, `McpAuthSecretArn`.

**Stubs:** each function returns `{ ok: true, service: "mcp" | "agent" }`, so the deploy can be checked end to end.

**`samconfig.toml`:** stack `alexa-chess`, region `ap-south-1`, profile `default`, `capabilities = "CAPABILITY_IAM"`, `s3_bucket = "alexa-chess-cloudformation-bucket"` (deploy artifacts bucket, created once outside the stack; S3 doesn't allow underscores), `confirm_changeset = false`.

**`scripts/deploy.ps1`:**
1. `sam build` then `sam deploy`
2. Read the stack outputs (`aws cloudformation describe-stacks`)
3. Write `web/config.json` = `{ agentUrl }`
4. `aws s3 sync web/ s3://<bucket> --delete`
5. `aws cloudfront create-invalidation --paths "/*"`
6. On the first run, redeploy with `AllowedOrigin=https://<cf-domain>` to lock down CORS.

**Phase 1 status: ✅ deployed 2026-10-15.** Website https://d2ammv4cvnzsu5.cloudfront.net, agent and MCP stub URLs answer, CORS only allows the CloudFront origin. Site files live in `alexa-chess-website-bucket`. Deploy artifacts go to `alexa-chess-cloudformation-bucket`.

**Phase 1 done when:** `sam deploy` succeeds; `curl <McpServerUrl>` and `curl <AgentUrl>` return the stub JSON; `WebsiteUrl` serves a placeholder `index.html`.

> Risk: AWS now checks both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` for public Function URLs. If a URL returns 403 Forbidden, add an explicit `AWS::Lambda::Permission` for `lambda:InvokeFunction` with `Principal: "*"` next to SAM's auto-generated URL permission.

## Phase 2: MCP server (Streamable HTTP on Lambda)

**Dependencies:** `@modelcontextprotocol/server` v2 (`McpServer` + `WebStandardStreamableHTTPServerTransport`), `zod` v4, `chess.js`, AWS SDK v3 (provided by the Lambda runtime, so left out of the bundle). The layer provides `stockfish` (lite single-threaded WASM). Dev: `@modelcontextprotocol/client` v2, `vitest`, `tsx`.

**Transport (`handler.ts`):**
- On each request, create `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`.
- Adapt the Lambda Function URL event into the request/response shape the transport expects. The SDK's `WebStandardStreamableHTTPServerTransport` takes a `Request` and returns a `Response`; use it if the installed SDK version has it, otherwise use a small Node `IncomingMessage` shim.
- Checks before MCP handling:
  - `Authorization: Bearer <secret>`, else 401. The secret is cached per cold start.
  - `Origin`: if present and not allowlisted, 403 (spec requirement).
  - `MCP-Protocol-Version`: if unsupported, 400 (the SDK handles this).
  - GET returns 405; DELETE returns 405.

**Tools** (all take `gameId` except `new_game`; every result has a short `speech` string for the voice, plus structured data):
| Tool | Input | Returns |
|---|---|---|
| `new_game` | `color: white\|black\|random`, `level: 1-8` (about 500 to full strength; see Phase 8 for how each level plays) | `gameId`, side, and the engine's first move if you play black |
| `make_move` | `move` (SAN like `Nf3`, or UCI like `g1f3`) | Your move spoken, engine reply spoken, check/mate/draw status. Illegal move gives a clear error plus close legal alternatives. |
| `legal_moves` | optional `square` or `piece` (e.g. `knight`) | Spoken list, e.g. "Your knights can go to f3, h3, c3" |
| `describe_square` | `square` | "Black bishop on c5" / "empty" |
| `list_pieces` | `color` | Pieces grouped by type, spoken |
| `read_board` | — | Full position spoken rank by rank, plus FEN |
| `last_moves` | `count` (default 2) | Recent moves in spoken form (read from `alexa_chess_moves`) |
| `game_history` | optional `gameId` | Full move list (PGN + spoken), status and result. Also lists your recent games when no game is given. |
| `game_status` | — | Whose turn, material count, check, move number |
| `hint` | — | The full-strength engine's best move (MultiPV search, 500 ms), spoken as "The best move here, according to the engine, would be …" |
| `undo` | — | Takes back the last move pair |
| `resign` | — | Ends the game |

**`chess/game.ts`:** load/save FEN plus move history; `toSpoken(move)` turns `Nxe5+` into "knight takes e5, check" and handles castling, promotion and en passant.

**`chess/engine.ts`:** spawn Stockfish WASM once per container (cache across warm calls), UCI `position fen … go movetime N`, parse `bestmove`.

**Tests:** vitest for `game.ts` (spoken output, illegal moves, castling, promotion) and `engine.ts` (returns a legal move from a given FEN).

**Phase 2 status: ✅ deployed 2026-10-15.** 12 tools live at the McpServerUrl. 19 vitest tests pass (unit tests plus end-to-end through the real transport with Stockfish). The live smoke test passed: 401 without a token, 403 for browser origins, 405 for GET. Every move is confirmed as a row in `alexa_chess_moves`. Engine replies take about 0.3–0.7 s warm. Local dev: `npm run dev` serves `http://127.0.0.1:3001/mcp` with in-memory games.

**Phase 2 done when:**
- `npm run smoke -- <McpServerUrl> <token>` (official MCP client) succeeds for initialize, tools/list, new_game → make_move → history.
- The official **MCP Inspector** (`npx @modelcontextprotocol/inspector`, Streamable HTTP, bearer header) lists and calls the tools.

## Phase 3: Agent + Echo simulator web page

**Agent Skill:** `packages/agent/skills/blind-chess/SKILL.md` (inside the agent package because SAM only bundles files under each function's CodeUri) (agentskills.io format with YAML frontmatter `name`, `description`). Rules:
- Turn speech into SAN. Spoken files and pieces get confused ("bee/dee/e", "night"), so ask a confirm question when unsure.
- Always repeat the move back.
- Never show board diagrams, keep replies short for the ear.
- Use `read_board` / `describe_square` when asked "where is…".

The agent Lambda bundles the skill (esbuild text loader) into its system prompt.

**Agent (`AgentFunction`):**
- `POST /chat { sessionId, text }` → `{ reply, gameId, gameOver }`.
- Loads chat history and the current `gameId` from DynamoDB.
- Connects to the MCP server with `Client` + `StreamableHTTPClientTransport` (bearer header), then `listTools()`, which maps to Bedrock `toolConfig`.
- Runs the Bedrock **Converse** loop (`@aws-sdk/client-bedrock-runtime`): forwards `toolUse` to `client.callTool`, returns `toolResult`, stops at `end_turn` or after 6 rounds.
- Saves history (trimmed to the last ~20 turns) and returns the final text.
- Bedrock never sees raw engine logic, only tools. That keeps the LLM in the "understanding and narration" role.

**Web page (`web/`, plain HTML/CSS/JS, no build step):**
- Echo-style device: dark cylinder/puck with the **blue light ring** animating on listen (cyan spin), think (pulse) and speak (wave).
- Wake by button or spacebar, or by saying "Alexa…" while continuous listening is on (optional toggle).
- `webkitSpeechRecognition` (en-IN/en-US selectable) gives the transcript, which is POSTed to `/chat`. The reply is read by `speechSynthesis`, and the mic re-arms automatically for the next move.
- Side panel: conversation transcript, plus a text box fallback (for browsers without speech recognition and for judges). No board, since the game is blind; the "reveal board" button only prints the FEN after the game ends.
- `sessionId` is kept in `localStorage`; `config.json` (from the deploy script) gives `agentUrl`.

**Phase 3 status: ✅ deployed 2026-10-15.** The Nova Pro agent is live: it hides ids from the model, injects the current gameId, and forces a tool call on every turn while a game is running. Without that, Nova once "played" a move from memory without calling the server. 5 agent unit tests pass. A local `npm run chat` run uses real Bedrock with the live MCP server. The Echo page is live with ring states, chips, a tool-call trace, hands-free mode, settings, keyboard control and aria-live regions. Verified: text and chip flows from the browser (new game, e4 with engine reply, read board), the session survives a reload, and replies take ~1.3–2 s warm (~3.5 s cold). **Not yet verified:** microphone input in a real Chrome window.

**Phase 3 done when:** in Chrome at `WebsiteUrl`, saying "Alexa, start a new game, I'll play white, easy" → "pawn to e4" → "where's the black queen?" → "read me the board" all get correct spoken replies, and a full game can reach checkmate or resignation.

## Verification (end to end)

1. `sam validate --lint` passes.
2. Phase 1: stub URLs respond; CloudFront serves the page.
3. Phase 2: `npm test` (vitest) passes; `smoke-mcp.ps1` passes; MCP Inspector connects over Streamable HTTP and calls every tool.
4. Phase 3: run the voice script above in Chrome. Check CloudWatch logs for tool calls, and confirm illegal moves give friendly corrections.
5. Optional: add the MCP URL plus bearer token to Claude Desktop / Claude Code as a remote MCP server, as a second client showing interoperability for the judges.

## Cost / cleanup
Mostly free-tier (Lambda, DynamoDB on-demand, CloudFront). Ongoing costs are Secrets Manager (~$0.40/month) and Bedrock tokens. Tear down with `sam delete --stack-name alexa-chess` after emptying the bucket.

---

## Phase 4 — Conversational Alexa+ upgrade

> Phases 0–3 (infra, MCP server, agent and Echo page) are done and documented in `docs/PLAN.md`. On approval, this plan is appended there as **Phase 4**, and Phase 3 is committed first.

### Context

The first end-to-end version works, but in real use:
1. **Speech recognition mangles chess.** For example, "knight e4" is heard as "night forever".
2. **It sounds like a command parser, not Alexa+.** We want natural, chess-focused banter: "Ooh, the Sicilian! Going for a fight, I see." It should also react to the user's moves.
3. **Colour and difficulty should be picked by voice.**
4. **The UI should be just a speaker**: the Echo device and its light ring, nothing else.
5. **No clicking per utterance.** It should listen continuously and respond to the wake word **"Alexa"**.

Cost-conscious decisions you made:
- **Listening:** Chrome's free continuous recognition, plus a server-side chess move matcher.
- **Voice:** Amazon Polly neural, about $0.10–0.15 per game.
- **Model:** A/B test Nova Pro against Nova Lite and Nova 2 Lite, and keep the cheapest one that sounds good.
- **Wake word:** required.
- **Personality:** lively but brief.

Target cost: well under $1 per 40-move game, and a few cents if Nova Lite wins.

Two facts checked in ap-south-1:
- Polly neural voices are available, including **Kajal (en-IN)**, Joanna, Ruth and Matthew (en-US) and Amy and Brian (en-GB). Polly generative voices and Nova Sonic are **not** available in Mumbai.
- Both `apac.amazon.nova-lite-v1:0` and `global.amazon.nova-2-lite-v1:0` are available.

---

### Milestone 0: Housekeeping
- Commit Phase 3 (the agent, the Echo page, the skill and the tests are all uncommitted right now).

### Milestone 1: Spoken move matcher (fixes "night forever")

**Browser.** Chrome `SpeechRecognition` uses `maxAlternatives = 5`. Every utterance is sent as `{ text, alternatives[] }`.

**Agent.** When the model calls `make_move`, the agent attaches this turn's raw `alternatives` automatically, so the model can't drop them. The model still passes its own best SAN guess as `move`.

**MCP server**, new file `packages/mcp-server/src/chess/spokenMove.ts`, `resolveSpokenMove(chess, inputs[])`:
1. **Fast path.** The existing `playHumanMove` parsing (SAN and UCI) in `chess/game.ts` runs on the model's `move`.
2. **Normalize each transcript.** Strip "Alexa", "please", "I'll play", "move my" and similar. Map spoken tokens:
   - **Pieces:** night/nite/knite/horse → knight; rock/ruck/castle → rook; pond/porn → pawn, and so on.
   - **Files:** ay/hey → a; be/bee → b; see/sea/si → c; dee → d; ee/he → e; ef/if → f; gee/ji → g; aitch/age → h.
   - **Ranks:** won → 1; to/too → 2; tree/free → 3; for/fore → 4; ate → 8, and so on.
   - **Split fused words:** "forever" → "four ever" → "e4"/"f4" candidates; "before" → "b4".
3. **Generate and rank.** For every legal move (~30), generate spoken forms: "knight e4", "knight to e4", "knight takes e4", "e4" for pawns, "castle kingside", and so on. Score each (move, transcript) pair with a phonetic key (letter names spelled out, kn→n, ph→f, digits→words) and normalized Levenshtein similarity.
4. **Decide.** If the top score is clearly ahead, play it. If two candidates are close, return `needsConfirmation` with them, and Alexa asks "Knight to e4, or knight to f4?". If nothing scores well, return the existing illegal-move suggestions.

**`make_move` input** gains optional `alternatives: string[]`, and its output gains `heardAs` and `needsConfirmation` with `candidates`. Unit tests cover a table of 40+ real misrecognitions, including "night forever" → Ne4/Nf4 depending on legality, "bishop see four", "pawn to eat four", "castle short" and "queen takes be seven".

### Milestone 2: Voice-only Echo + wake word + Polly voice

**UI** (rewrite of `web/index.html`, `styles.css` and `app.js`):
- **Only the Echo device**, centred on a dark background, with the light ring. The header, chips, panel and visible settings are removed.
- **One-time "Tap to start" overlay.** Browsers require a user gesture before they allow the microphone and audio playback. After that, there's nothing else to click.
- **Ring states**, like a real Echo:
  - off while idle
  - cyan sweep when it hears the wake word
  - spinning while thinking
  - pulsing while speaking
  - solid red when muted (tap the device to mute or unmute)
  - orange on error
- **Earcons.** Soft wake and end chimes generated with WebAudio, so no audio files are needed.
- **Hidden debug drawer** (press **D**): transcripts with alternatives, tool calls, latency and voice settings, useful for judges and for us. It's off by default.
- **Accessibility:** a visually hidden `aria-live` region and keyboard control (Space to wake, Esc to stop, M to mute).

**Wake word engine** (in `app.js`):
- Recognition runs continuously (`continuous = true`, interim results) and auto-restarts on `end` or errors, with backoff.
- **Gate on "Alexa"** and close mishearings ("Alexia", "a lexa"). Text after the wake word in the same utterance is the command. If only "Alexa" is said, it stays awake for about 6 s waiting for the command, like a real Echo.
- **Follow-up only when Alexa asks a question.** If the reply ends with a question ("White or black?", "Knight to e4 or f4?"), the next ~8 s are accepted without the wake word. Otherwise the wake word is always required, as you chose.
- **Half-duplex.** Recognition results are ignored while Alexa is speaking, so it never hears itself. Esc or a tap interrupts.

**Polly voice** (new file `packages/agent/src/voice.ts`):
- The agent calls Polly `SynthesizeSpeech` (neural engine, MP3) and returns `audio` (base64, about 10 KB per reply) alongside `reply`. That's one round trip.
- The default voice is **Kajal (en-IN)**. "Use an American / British voice" switches to Joanna or Amy; the choice is stored in the session.
- "Say that slower" or "repeat that" uses SSML prosody or replays the last reply.
- If Polly fails, the browser falls back to `speechSynthesis`.
- IAM: add `polly:SynthesizeSpeech` to `AgentFunction` in `template.yaml`.

### Milestone 3: Natural commentary + colour and level by voice

**Commentary facts from the MCP server.** The model narrates; the server supplies the facts. That keeps it grounded.
- **Openings** (new files `chess/openings.ts` and `data/openings.json`): the lichess `chess-openings` dataset (CC0), keyed by position. `make_move` returns `opening` whenever the game reaches a newly named line, such as "Sicilian Defense" and later "Sicilian Defense: Najdorf Variation".
- **Move quality** (new file `chess/analysis.ts`, plus `engine.ts` gaining `analyse()`, which parses `info … score cp|mate`): a quick full-strength evaluation (depth ~10, ~150–300 ms) before and after the user's move gives the centipawn loss. That maps to **best / good / inaccuracy / mistake / blunder**, with `bestWas` when it's a mistake. There's also an eval trend, from the user's point of view, in pawns.
- **Engine move ideas and alerts** (from chess.js attack maps): capture, check, castles, develops a piece, central pawn break. Alerts cover the user's pieces left hanging, the user in check, and mate threats.
- **Stored per move** in `alexa_chess_moves`: `evalCp`, `classification` and `opening`. This also lays the groundwork for coach mode.

**Persona** (rewrite of `packages/agent/skills/blind-chess/SKILL.md`):
- A warm, witty Alexa+ chess companion. Normally 1–2 sentences: the moves plus at most one natural remark. Vary the phrasing and don't comment on every quiet move.
- Always react to new openings, blunders, mistakes, great moves, checks, big captures and big eval swings.
- **Chattiness** can be minimal, brief (default) or chatty. "Talk less" or "talk more" changes it, handled by a small agent-local tool that stores the setting in the session. The current setting goes into the system prompt.
- The final spoken round uses temperature ~0.6 so it sounds natural; tool-choosing rounds stay at 0.

**Colour and level by voice:**
- "Let's play" with no details gets one question: "Sure! White or black, and how tough should I be: easy, medium, hard, or full strength?"
- Words map to levels: beginner=1, easy=2, casual=3, medium=4, challenging=5, hard=6, expert=7, grandmaster/max=8. "Random" and "you pick" also work.
- **New MCP tool `set_level`**, for "play harder" or "go easy on me" mid-game. It updates the game, and the change is announced.

### Milestone 4: Model A/B and cost trim
- New `packages/agent/scripts/ab.ts` plays the same scripted conversation (new game, Sicilian, a blunder, a board question, a level change) on Nova Pro, Nova Lite and Nova 2 Lite.
- It prints each model's replies, latency, and token usage from Converse `usage`, with an estimated cost per game. We pick the cheapest model whose banter and tool use are good, and set it as the `BedrockModelId` default.
- Try Bedrock prompt caching (a cache point after the system prompt and tools) if the chosen model supports it, and log the token savings.

### Milestone 5: Polish
- **Warm-up ping** on page load: the agent wakes itself, the MCP server and Stockfish, so the first real turn isn't a cold start.
- **AWS Budget alert** at $5/month. This needs your email address; I'll ask when we get there.
- Update `docs/PLAN.md`, plus a short demo script for the hackathon video.

### Next (after this phase): Coach mode
- A "coach voice" persona: a different Polly voice that explains ideas instead of bantering.
- "What's the better move here?" uses the hint tool plus the engine's line. "Why was that bad?" uses the stored evals. Undo already exists.
- A post-game review of the key moments, using the move classifications in `alexa_chess_moves`.

---

### Critical files
- **MCP server:** `packages/mcp-server/src/chess/{spokenMove,openings,analysis,engine,game}.ts`, `src/server.ts` (`make_move`, new `set_level`), `src/store.ts` (new move fields, level update), `data/openings.json`, `scripts/build-openings.ts`.
- **Agent:** `packages/agent/skills/blind-chess/SKILL.md`, `src/agent.ts` (alternatives injection, chattiness/voice prefs, temperature), `src/voice.ts` (new), `src/handler.ts` (new body fields `alternatives`, `warm`), `scripts/ab.ts`.
- **Web:** full rewrite of `web/index.html`, `web/styles.css` and `web/app.js`.
- **Infra:** `template.yaml` (Polly permission; tightened agent timeout/memory if needed).
- **External data:** download the 5 lichess `chess-openings` TSV files (a–e.tsv, ~400 KB total, CC0) from github.com/lichess-org/chess-openings and convert them once into `data/openings.json`.

### Verification
- **Unit tests:**
  - spoken-move matcher table (40+ cases, including the reported ones)
  - opening lookup (1.e4 c5 → Sicilian Defense)
  - analysis classification on known blunder positions
  - `set_level`
  - agent: alternatives injection, chattiness, voice prefs, Polly mocked
- **A/B harness:** results table of replies, latency and cost for each model.
- **Live:**
  - MCP smoke test
  - scripted agent chat
  - a real Chrome session covering:
    - wake word and follow-up after a question
    - homophones ("night forever")
    - colour and level by voice
    - commentary on the Sicilian and on a deliberate blunder
    - "talk less"
    - voice switch
    - "repeat that"
- **Monitoring:** CloudWatch logs per turn (latency, tokens, characters sent to Polly) to confirm cost per game.

### Phase 4 status (2026-10-15): ✅ deployed and live-tested (agent on Nova 2 Lite, Polly Kajal voice)
- **Spoken move matcher** (`chess/spokenMove.ts`): homophone rules plus phonetic ranking. "night f three" → Nf3, "bishop see four" → Bc4; "night forever" → asks "knight to e4, or knight to a4?". Never auto-plays a different move when a clearly illegal one was said. 30+ table tests.
- **Commentary facts** in `make_move`: lichess opening names (3,865 positions, CC0), move quality from before/after Stockfish evaluation, ideas behind the engine's move, and hanging-piece alerts. Stored per move (`evalCp`, `quality`, `bestSan`, `opening`).
- **New MCP tool `set_level`.** Colour and difficulty are picked by voice; the agent blocks `new_game` until the user has said both.
- **Agent:** recognition alternatives injected into `make_move`, wake word stripped. Agent-local `set_preferences` (chattiness, voice, speed) and `repeat_last` are answered without a second model call. Temperature is 0 for tool choice and 0.6 for phrasing. Prompt caching on the static skill. Polly neural voice (Kajal default).
- **Echo page:** voice-only speaker, one-time "Tap to wake", continuous Chrome recognition gated by "Alexa" (`web/wake.js`, 12 Node checks), follow-up listening only after real questions, half-duplex, earcons, tap/M to mute, hidden debug drawer (D) with a text box.
- **Model A/B** (`npm run ab`, 9-turn script, prompt caching on): Nova Pro ~$0.125/game, Nova Lite ~$0.009/game (plain banter), **Nova 2 Lite ~$0.05/game (best banter) → new default** `global.amazon.nova-2-lite-v1:0`. Prices are approximate list prices.
- **Local full stack, no AWS deploy needed:** `.claude/launch.json` (mcp-local :3001, agent-local :3002 with real Bedrock + Polly, web-local :5173).
- **Template:** Polly permission added; model default changed. `sam validate --lint` and `sam build` pass.
- **Not yet verified:** real microphone and wake word in Chrome; deployed Lambdas.

## Phase 5 — Chatty companion and "chess ears" (2026-10-16)

### Deployed fixes (live on CloudFront, 2026-10-16)
- Conversation mode: no "Alexa" needed after replies (2 min during a game, 30 s after a question, 20 s otherwise).
- Web files are served with no-cache.
- Debug drawer (press D): build tag, mic on/off, what was heard, ignored or dropped speech.
- The agent asks for a missing colour or difficulty itself.
- The server never auto-plays a piece move for a bare square ("a6" no longer becomes Ba6).

### Built in Phase 5 (committed and deployed 2026-10-16)
- **Agent (`packages/agent/src/agent.ts`)**
  - `factsForModel` gives the model spoken moves plus ranked `talkingPoints` instead of the server's canned `speech`; "better was" only for mistakes and blunders.
  - `recentPhrases` goes into the prompt as an avoid-list; `cleanSpeech` strips hand-over closers ("Your move.", "What will you play next?", "Your turn — what's next?").
  - `limitSentences` caps chatty replies at 4 sentences; `chattinessCommand` handles "talk more/less", "just the moves" without a model call.
  - Local tool `ask_again` for garbled speech and small talk (it cannot announce moves). A tool call is forced after a game ends too.
  - `new_game` facts say who moves first. The chess-grammar hearing (`chessHeard`) leads the alternatives passed to `make_move`. Phrasing temperature is 0.8.
  - Variety: `QUIET_THEMES` rotate by turn count (third argument of `talkingPoints`), and `dropRepeatedSentences` removes any sentence after the first that overlaps a recent one by 0.7 or more (never one announcing this turn's moves).
  - `needsConfirmation` from `make_move` is spoken word for word and ends the loop, so the model cannot predict a move.
- **Skill**: `blind-chess/SKILL.md` rewritten as the "chatty companion" (default chattiness = chatty).
- **MCP server**: `make_move` commentary adds swing, trend, position, material (each only when changed), `yourMoveIdeas`, `yourMoveSpoken`/`engineMoveSpoken`, `gameOverText`, and only new alerts. `new_game` returns `engineMoveSpoken` and `levelName`. `spokenMove.ts` handles en-IN mishearings (porn/pond/Pondicherry → pawn, "take night").
- **Web**: `web/vosk.js` runs Vosk (`vosk-model-small-en-in-0.4`, in gitignored `web/models/`, fetched by `scripts/get-vosk-model.ps1`) with a chess grammar next to Chrome speech recognition; `app.js` pairs results by time and sends `chessHeard`. `deploy.ps1` uploads `models/` with a long cache header.
- **Eval**: `npm run eval -- --label <name>` in `packages/agent` (needs the local MCP server; set `MCP_URL` if it is not on :3001). Results in `packages/agent/eval-results/`.

### Eval results (24-turn script)
| run | repeated 3-grams | hand-back endings | words/reply | made-up moves |
|---|---|---|---|---|
| baseline (HEAD) | 94 | 58% | 27 | — |
| phase5 (before variety fixes) | 61 | 4% | 28 | 0 |
| phase5d | 32 | 0% | 25 | 0 (1 post-game flag from the checker; the reply restates the game history) |

Cost ≈ $0.06–0.07 per game.

### Later: coach mode
A coach persona and voice, "what's the better move here?", "why was that bad?" from stored evals, and a post-game review.

### Phase 5b — recognition fixes after the first real-mic game (2026-10-16)
Findings from a 96-turn live game: Chrome (en-IN) almost never heard "rook" (rock, rocky, rok, ruk, rope, book, rocket, even…); "yes" after "Did you mean…?" was treated as a new move, so the same question repeated up to 9 times; the local dev server dropped `chessHeard`, so the Vosk readings were never used in that game.
- `dev-server.ts` now forwards `chessHeard` and appends every turn to `packages/agent/eval-results/live/<date>.jsonl`; the debug drawer keeps its last 500 lines in localStorage and has a "Copy log" button; it also logs Chrome's audio/sound/speech events, Vosk partials/results and a mic level every 3 s.
- Agent: a pending question is stored in the session (`pending`). "yes", "no", "first/second", or the disambiguating file ("see") are answered locally; the second identical question plays the likeliest move and says "I took that as …; say undo if that's wrong". Move-shaped speech forces `make_move` (never `ask_again`). A request with no text no longer crashes.
- Resolver (`spokenMove.ts`): many more rook/bishop/pawn sound-alikes, fuzzy piece prefixes, "even" = e1, "wish up" = bishop, and "Which rook: the one on c7, or the one on e1?" when two pieces reach the same square.
- Web: Chrome `SpeechRecognition.phrases` biasing was tried and removed: Chrome's cloud recognizer fails every start with `phrases-not-supported`.
- Not done yet: per-turn dynamic Vosk grammar, cloud STT (Amazon Transcribe custom vocabulary or Deepgram keyterms). Decide after a real-mic retest with the new logs.

### Afternoon incident: the wake word went deaf (2026-10-16)
- Symptom: Chrome reported "speech detected" but returned no words, so even "Alexa" stopped working.
- Cause: Chrome's **English (India)** recognizer silently stopped returning words for this browser. A bare A/B test with none of our code on the page: en-IN 0 results, en-US fine on the same mic, no errors from either. Possibly a Google-side problem, or throttling after hundreds of recognition restarts during debugging.
- Fixes (build `en-us-10`, deployed):
  - Default language is now en-US (the drawer's picker still switches it).
  - The page switches to en-US by itself after two recognition sessions that hear speech but return no words.
  - Chess ears (Vosk) are **off by default** (`?ears=1` turns them on). Their benefit wasn't proven, and a second mic capture is a risk.
  - Forced early finals were removed: they cut "Alexa … let's play chess" in two.
- Agent: `ask_again` must not brush off game questions; board questions go to the board tools. A "Your move, please" closer is stripped. The skill notes Hindi filler ("aur", "haan").
- Open: an answer to "are you going to take my pawn?" claimed d4 could take d5. It was board reasoning beyond the tool facts, worth a look in coach mode.

## Phase 6 — Amazon Transcribe streaming ears (2026-10-16)

Why: Chrome's free recognizer was the weak link. Its en-IN service returned no words for hours, it misheard chess ("porn" for pawn, "93" for knight f3), and it offers no tuning. The Echo page now listens with **Amazon Transcribe streaming** in ap-south-1. The experience is unchanged: one tap, "Alexa" wake word, conversation mode (wake.js `decide()`/`followUpMs()` untouched), half-duplex, and the debug drawer with its persistent log.

### Architecture
```
mic (echo cancellation, noise suppression, auto gain)
  -> AudioWorklet web/pcm-worklet.js (16 kHz mono s16le, 100 ms chunks; the AudioContext runs at 16 kHz)
  -> web/eventstream.js (AWS event-stream frames, CRC32)  -> one WebSocket, kept open while listening
  -> wss://transcribestreaming.ap-south-1.amazonaws.com:8443 (SigV4-presigned URL)
  <- partials + finals -> web/transcribe.js -> app.js -> wake.js gate -> agent POST (unchanged)
page --POST {sessionId}--> alexa_chess_transcribe_url (Lambda Function URL) -> presigned URL (300 s)
```
- **No credentials in the browser.** `packages/transcribe-url` (Node 22, arm64, esbuild) signs the URL with `@smithy/signature-v4` and `@aws-crypto/sha256-js`. Its role can only call `transcribe:StartStreamTranscriptionWebSocket`. It requires a sessionId, uses the same CORS origin lock as the agent, and logs every issued or denied URL as JSON. **TODO:** real rate limiting (per-session/IP counters in DynamoDB, or CloudFront + WAF) before wider use.
- **URL expiry only gates the handshake**, so an open stream keeps working past 300 s. Every (re)connect uses a fresh URL, and the page prefetches one so a reconnect costs ~150 ms. Reconnects use backoff from 0.5 s to 8 s with jitter. Up to 3 s of speech captured during a reconnect is sent once the socket opens. A stalled socket (5 s of unsent audio) is replaced.
- **Half-duplex:** while Alexa speaks, and for 400 ms after (room echo), the page sends **silence frames** instead of the mic. Transcribe never hears her, and the stream doesn't hit the ~15 s idle timeout. Mute closes the stream, so nothing is sent or billed.
- **Alternatives:** Transcribe streaming returns one alternative per segment, so `alternatives` = the final plus the partials that differed from it (pure prefixes dropped).
- **Fallback:** `?stt=chrome` runs the old Chrome recognizer path unchanged. The page also switches to it by itself after 3 failed URL fetches. Vosk stays off (`?ears=1`). A/B switches: `?lang=multi`, `?stability=off|low|medium|high`.
- **Local stack:** the local agent (`packages/agent/scripts/dev-server.ts`) also serves `POST /transcribe-url` with the same handler, signed with your local AWS credentials. `serve-web.mjs` puts `transcribeUrl` in config.json. `.claude/launch.json` adds `mcp-alt`/`agent-alt`/`web-alt` (ports 3011/3012/5183) next to the original three.

### Custom vocabulary
- `infra/transcribe/vocabulary.txt`, generated and validated by `node scripts/build-vocabulary.mjs` (`--check`). It has 495 phrases: Alexa, pieces, chess verbs, difficulty and colour words, Hinglish fillers (aur, haan, …), the 64 squares (`e-four` → DisplayAs `e4`), and every piece+square (`pawn-d-four` → `pawn d4`).
- Transcribe has dropped SoundsLike/IPA, so those columns stay empty. Phrases can't contain digits.
- CloudFormation has no resource for vocabularies. `.\scripts\deploy.ps1` uploads the file to `alexa-chess-cloudformation-bucket` and runs create-vocabulary or update-vocabulary for `alexa_chess_vocabulary` (en-IN), waiting for READY. `-VocabularyOnly` does just that step. Created 2026-10-16.

### Choosing the settings: Polly end-to-end test (`node scripts/test-transcribe.mjs --compare`)
Kajal (en-IN) speaks 15 commands, including Hinglish (SSML hi-IN "और") and two with 25% noise. They stream through the real presign handler and codec. Moves are judged by the chess server's own resolver in a position where they're legal.

| config | raw transcripts right | moves/commands resolved (required 12) | latency after speech |
|---|---|---|---|
| **en-IN + vocabulary + stability high (default)** | 12/15 | **12/12** (+2/3 extra) | ~0.5–0.7 s |
| en-IN, no vocabulary | 9/15 ("Queen Queen Dikes D5", "E4" for pawn e4) | 12/12 | ~0.5–0.7 s |
| stability off | 10/15 | 12/12 (+3/3) | ~0.5–0.7 s |
| multi-language en-IN + hi-IN | 9/15 | 12/12 | **~3 s** |

- Decision: single en-IN + vocabulary + stability high. Multi-language identification added ~2.5 s per turn with no accuracy gain, and every segment came back as en-IN anyway ("aur" → "Or", which the agent ignores).
- Transcribe en-IN writes a quick "pawn dee four" as **"24"** and "pawn see four" as **"Swansea 4"**. `spokenMove.ts` now reads a bare `2N` as pawn dN, plus `twenty`/`swansea`/`worn`. The agent's `looksLikeMove` treats a bare "24" as a move, so `make_move` is forced.
- Still a miss: "Alexa, haan, knight to f3" → "ha na to F3" → f3. A Hindi word in the middle of a command can swallow the piece name.

### Browser dry run (fake mic = Polly clips, real page, real agent and Bedrock)
Background chatter was ignored without the wake word. Then:
1. "Alexa, let's play chess" → heard ~2 s after speech started.
2. "white, easy" (no wake word) → `new_game`.
3. "pawn d4" (heard "24") → d4.
4. "knight f3" → Nf3.

The stream connected in ~150 ms. That run found and fixed one bug: `looksLikeMove("24", "2")` was false because it tested the alternatives joined together.

### Cost (ap-south-1 list price, checked 2026-10-16)
- Transcribe streaming: **$0.0001667 per second = $0.01 per minute = $0.60 per hour** of audio sent, billed per second with no minimum. Custom vocabulary and language identification add nothing.
- The stream is open whenever the page is listening (silence while Alexa talks is billed too): **≈ $0.25 for a 25-minute game**, ≈ $0.40 for 40 minutes. The presign Lambda costs fractions of a cent.
- Per game, all in: Transcribe ~$0.25 + Nova 2 Lite ~$0.06 + Polly ~$0.10–0.15 ≈ **$0.40–0.45**.
- Optimise later: close the stream after the follow-up window ends with no game, and open it again on a local wake-word or VAD trigger. Or stop sending silence while Alexa speaks and reconnect instead (costs ~150 ms per turn).

### Tests
`node scripts/test-eventstream.mjs` (codec, including a real AWS frame from the docs), `npm test` in `packages/transcribe-url` (the signature matches an independent implementation of the documented steps; handler guards), `node scripts/build-vocabulary.mjs --check`, `node scripts/test-wake.mjs`, both existing vitest suites, `node scripts/test-transcribe.mjs` (needs AWS).

### Status
- Built and tested locally, with the vocabulary live in AWS.
- **Not deployed:** the Lambda, template and site changes wait for `.\scripts\deploy.ps1`.
- First real-microphone game: see Phase 6b.

## Phase 6b — Interrupting, speed, background noise, and the 305 questions (2026-10-16)

The first real-microphone game with Transcribe (the 2026-10-16 afternoon session, in `packages/agent/eval-results/live/`) showed:
- **She couldn't be interrupted.** The mic was muted while she spoke.
- **Replies were slow.** Each turn made 2 model rounds plus 2 Stockfish analyses (2–3.5 s). On top of that, Transcribe kept segments open 5–9 s while there was background sound.
- **Background talk was treated as commands.** "Correct.", "Yeah.", "Gala appeared in a coral" went to the agent in conversation mode. A forced `make_move` then answered "X isn't a legal move" with six options, and "Correct." restarted the game.
- **She talked too much.** Hints were fine, but error replies listed six moves.

### Voice (web)
- **Barge-in.** The mic stays open while Alexa talks (the browser's echo cancellation removes most of her voice). Only "Alexa…" or a stop word ("stop", "wait", "enough", "bas", "ruko"…) interrupts. Partials whose words mostly match what she is saying count as echo, and so does any Transcribe segment that began while she spoke. "Stop" while she is thinking cancels the answer on its way. `?bargein=0` restores strict half-duplex. Logic is in `wake.js` (`bargeIn`, `isOnlyStop`), tested in `scripts/test-wake.mjs`.
- **Our own end of speech.** An utterance ends when its partial stops changing for `endpointMs(text)`:
  - 0.7 s after a square or castling side, or a question;
  - 0.8 s after yes/no and similar words;
  - 1.1 s otherwise;
  - 1.6 s after a single word;
  - 2.5 s after a lone piece name ("knight…").
  Later revisions of an utterance already sent are dropped; a real continuation is sent ("Alexa," … "let's play chess"). Code in `transcribe.js` (`onSegment`/`unsent`), tested in `scripts/test-ears.mjs`.
- **`woken` flag.** `decide()` reports whether "Alexa" was said; the agent gets it with every utterance. Ignored utterances keep the listening window unchanged, with no chime.
- **Timings.** Every reply's timings (model, board, voice) are logged in the drawer. In local mode the drawer and the exact streamed audio are mirrored to `packages/agent/eval-results/live/` (`<date>-drawer.log`, `<date>-<session>.pcm`). Replay the audio with `node scripts/test-transcribe.mjs --wav <file>.pcm`.

### Agent
- **Moves never wait for the model.** A move-shaped utterance goes straight to `make_move`; the server resolves the spoken move. Brief replies are built from templates (`quickMoveReply`): the two moves plus at most one fact (game over, a piece left hanging, a real mistake, a new opening). Chatty mode makes one model call to phrase it.
- **Question router.** `routeQuestion` sends obvious questions straight to their tool:
  - `hint` and `consider_move` answers are spoken as is, with no model call at all.
  - `analyze_position`, `review_game`, `last_moves` and `game_history` need one model call to phrase the answer.
  - Everything else goes to the model. At most 3 rounds, down from 6.
- **Background filter.** Utterances heard without "Alexa" are graded `yes` / `maybe` / `no` by `addressedLevel`:
  - `no` (no chess words, no question to Alexa) is dropped without any call.
  - `maybe` reaches the model with an `ignore` tool.
  - `yes` (a move, chess words, an answer to her question) is handled as if woken.
  A failed move heard without "Alexa" is ignored silently.
- **Guards:**
  - No new game mid-game without restart words.
  - No resign without "I resign" ("Can I resign?" asks first).
  - No undo when "redo" was said.
  - Questions ("Is f7 occupied?", "Can I castle?") never go down the move path.
  - Hints are hidden only when the user asked for that.
- **Brief by default**: one or two sentences. Questions get up to three, unless they asked for everything. Read-outs stay whole.
- **New local tools:**
  - `answer`: rules and general knowledge, grounded by a rules cheat sheet in the skill (the model once got promotion wrong).
  - `ignore`.
  - `set_preferences.confirmMoves`: "confirm each move before playing it", using `make_move` with `preview`.
- The skill (`SKILL.md`) was rewritten with a routing table for all 18 question categories, the rules cheat sheet, and honest answers for missing features (no clock, pause, redo or handicap).

### Chess server
- `analyze_position`: everything about the position from the user's side. Engine evaluation in words and pawns, forced mates, the top 3 moves with the engine's real lines, and my threat (null-move search) with its line. Pieces under attack on both sides, pins, forks, mates in one, checks, winning captures. Ways out of check, pieces with no moves. Material and lost pieces, castling rights with reasons, king safety, development, centre, pawn structure, open files, activity, squares controlled, phase, opening, and the last moves with their quality. Pure position facts are in `chess/insight.ts`.
- `consider_move`: "can I / what if" without playing. It says why a move is illegal: blocked by…, pinned by…, the square is attacked by…, castling rights or pieces in between, pawn rules. For a legal move it gives the quality, what the move does, whether it leaves something hanging, and my best reply.
- `review_game` (mistakes, the first and the biggest with the better move, my last move's ideas), `offer_draw`.
- `hint`: one move by default, 3 on request; `reveal: false` names only the piece, the area and the idea.
- `make_move`:
  - Illegal moves say why ("That move isn't possible: your bishop on f1 is blocked by your pawn on e2. Did you mean pawn to c4?").
  - At most two related suggestions, never random ones.
  - Hidden `preview` for confirm-each-move; `lossCp` is stored.
- `new_game` takes a hidden `fen` / `setupMoves` (tests and puzzles). Engine calls take a start FEN. `topMoves` uses MultiPV.
- Engine searches sync with `isready`/`readyok` before `go`. A stray line from an earlier search once made a fork position's best move "Kd1". `go` is sent outside the engine's output callback.

### Evaluation
- `npm run qa` (`packages/agent/scripts/qa-eval.ts`): all **305** questions the user listed (`eval/questions.ts`, 18 categories). Each is asked in a fitting position: Italian, Sicilian as Black, in check, fork, mate in one, queen attacked, pinned knight, two endgames, a game with a blunder, a finished game, no game. Every question gets a fresh game, through the real agent and Stockfish. **Amazon Nova Pro** grades each answer against the true facts (board, all legal moves, analysis, review). Its failures are re-read by hand: it misjudges some board facts, for example claiming that a pawn on e4 can capture e5.
- `npm run sim` (`scripts/game-sim.ts`): whole games with moves spoken the way people say them and the way recognition mishears them ("pond to f3", "porn to a 3", "night", "24"). It mixes in background chatter (real lines from the live game, plus Hinglish) without the wake word, and questions from the list.
- Note: Claude models on Bedrock need an AWS Marketplace subscription that this account can't complete. All six auto-created agreements terminated at once; nothing is active. The project uses Amazon Nova only.

| run | result |
|---|---|
| qa round 1 (before the fixes above) | 271/305 = 89% (Nova Pro; about half the failures were judge errors), 2.4 s average |
| sim round 1 | moves 54/54 played correctly, background 18/18 ignored, questions 17/20 answered |

**Deployed 2026-10-16** (`.\scripts\deploy.ps1`, build `transcribe-5`, https://d2ammv4cvnzsu5.cloudfront.net):
- **New Lambda** `alexa_chess_transcribe_url`, locked to the site's origin (a foreign origin gets 403).
- **Production check** (scratch `verify-deployed.mjs`):
  - a Polly clip streamed through the deployed presigned URL came back as "Alexa, let's play chess." / "knight to F3.";
  - the deployed agent answered the short colour/level question, started a game and ignored "Correct." (49 ms);
  - a move took 0.8 s and a hint 0.4 s, including Polly.
- **Since the 5 PM live tests:**
  - the wait after a bare "Alexa" is 12 s;
  - a short answer can cut in over her question;
  - fillers ("uh", "ok") no longer hide a question;
  - a final with its tail cut off is replaced by its fuller partial;
  - the always-visible debug screen (`web/debugscreen.js`, `?debug=0` hides it) shows what is heard and what happened to it.
- **Finding:** music or TV near the mic was the main cause of the mishearings. With it off, recognition was good.

### Live-site test (2026-10-16, ~6:30 PM) and "decide, don't ask"
In 1.d4 e6 the user said "pawn takes e6" several times. Transcribe heard:
- "pawn takes a 6."
- "E6 elephant 6"
- "takes sex."
- "Bw takes a 6."

**Every one was dropped in silence.** A move that didn't resolve without the wake word was ignored, which was a bug. (No white pawn could take on e6 there, but the player must hear that.) The user asked for any accent to work, and for no "Did you mean…? Did you mean…?" loops. Changes:
- **A move attempt always gets an answer**, wake word or not. Accent-shaped attempts count as move attempts ("night S3", "night ef three", "92 S3").
- **Decide instead of asking** (agent fast path):
  - Unclear words are played as their best reading, announced as *"Taking 'night S3' as knight to f3; say undo if not."*
  - With two readings, a constrained Nova call (`guessLegalMove`, legal moves only) picks one.
  - Words that named no move go to the same decoder over all legal moves.
  - An understood but illegal move gets one sentence of why ("I heard 'pawn takes e6': that isn't possible, none of your pawns can reach e6").
  - Only a board question ("Which rook: c7 or e1?") or confirm-each-move mode still asks.
- **Accent sound-alikes** in `spokenMove.ts` (`accentVariants`), tried when the literal reading isn't legal:
  - spelled letters ("e for elephant", NATO words), handled before parsing so "e for" is never read as e4;
  - rank words (sex/sikh/sax → six, ate → eight…);
  - confusable files (a↔e and s→f are strong; b↔d, v, p, t, z, j, x are weak and only used when the words formed no move at all, so "pawn d4" can't become "b4").
- **What was heard is said back** in illegal-move replies. Explanations know captures with nothing to take, and moves where no piece was named.
- **Vocabulary**: 64 capture phrases ("takes e-six" → "takes e6"), 559 phrases in all.
- **Tests**: chess server 131, agent 58, page 73 checks. The Polly suite runs per accent (`--voice Kajal|Joanna|Matthew|Amy|Brian`).

Latency in the replay of the live session (local, real Bedrock and Polly), from the end of speech to audio ready:
- moves: **0.45–0.8 s** (was ~2.5–3.5 s);
- background: dropped in under 20 ms;
- routed hints and "can I…": about 1 s;
- analysis questions: about 2 s.

## Phase 7 — Open-mic conversation and Chrome one-phrase hearing (2026-10-17)

A friend's Voice Chess (Alexa+ MCP add-on, no LLM in the move path) heard moves better than ours. A side-by-side run of both
parsers on each other's test phrases showed that our matcher was already the stronger one: his 170 phrases scored 153 right
and 16 "did you mean" for us, against his 33 of our 49. The gap was the hearing in front of the parser: his page uses
Chrome's recognizer in English (US), one phrase at a time, with no wake word and no timers of its own. Changes:

### Voice (web)
- **Chrome one phrase at a time is the default** (`continuous=false`, interim results for captions only, 5 alternatives,
  en-US). Chrome decides when a phrase is over; no client endpointing or "revision" dropping. The mic reopens after each
  phrase and as soon as she stops talking; never while she talks or thinks. Transcribe stays available with `?stt=transcribe`.
- **Open mic: no wake word.** After the start tap everything heard is sent (`decide(..., {openMic})`); "Alexa" still
  works. `?wake=1` restores the wake word with its follow-up windows.
- **Half a move is held**: "knight…" (phrase ended at the pause) is joined to the next phrase ("f3"), up to 4 s.
- **"Pause" / "stop listening" / "go to sleep"** mutes the mic by voice; tap the speaker or press M to talk again.
  Tap, Esc or Space cuts her off while she speaks.
- A speaking safety net: if the audio's "ended" event never comes, the mic reopens once nothing is playing.
- Mic-cycle notes (silence restarts every few seconds) are logged only with `?verbose`.

### Agent
- **Open-mic filter**: one-word requests ("hint", "undo", "what?"), greetings and thanks, and short phrases with a number
  mid-game ("14", "is he is 5": a misheard move) are answered instead of dropped.
- **Answers to her questions**: "no, knight f3" is a new move (not "scrap that"), also when a lower alternative is just
  "no"; "no, the other one"; "the one on b1"; "the c pawn"; "kingside" / "long"; "the left one" (from the player's side).

### Chess server
- "castle on the queen's side" was played **kingside** (the apostrophe became "queens side"); fixed.
- A bare "castle" with both sides legal now asks "Castle which way: kingside, or queenside?" (`doubt: "which"`).
- A lower alternative can no longer outvote the best transcript (weights per move are the best, not the sum).
- NATO letters ("pawn to echo four", "echo takes delta five") and the starting file ("knight b d2", "knight to d2 of b",
  "from the f file", "the c pawn takes d5") are read directly and played, not asked about.

### Tests
- Chess server 155, agent 61, page 73 checks. Both parsers on both phrase sets: 170/170 and 49/49.
- Browser run with a scripted recognizer against the local agent, MCP server, Bedrock and Polly: open-mic start, silence
  restarts, half-duplex, "knight" + "f3" joined (1.4 s, no model), "thank you" and "14" answered, "pause" mutes, "no,
  knight c3" played (0.7 s). Not yet tried with a real microphone in Chrome, and not deployed.

## Phase 8 — Fair levels, steadier ears, a rival instead of a coach (2026-10-17)

Play-testing the stable build (`stable-2026-10-17`) and the day's live log showed:
- **Even "easy" was hard to beat.** Levels 1–3 used Stockfish's Skill Level 0/3/6 and 4–7 its `UCI_Elo` (minimum 1320).
  Stockfish turns `UCI_Elo` into a Skill level, so level 2 (Skill 3) played like level 5 and level 3 like level 7.
  Nothing could play like an 800.
- **She went deaf now and then.** 9 of 81 turns were dropped in silence by the open-mic filter, and in 8 of them the
  user repeated themselves 2–12 s later. The filter read only the best transcript ("Vineet", while an alternative was
  "Queen 8").
- **Unasked coaching:** 13 of 81 replies were "Careful, your … is under attack"; mistakes got "X was better".
- **Monologues:** read-outs skipped every limit (a 47-word list of queen moves, 153 words for the board).

The user asked for:
- easy ≈ 800, medium ≈ 1500, hard ≈ 2500;
- short jabs when they play badly or she wins material, and short compliments when they play well (from their
  own list of 300 lines);
- the engine's best move only when asked ("The best move here, according to the engine, would be …"), with
  asked-for analysis kept short;
- replies like a person across the board.

### Chess server
- **Levels** (`chess/engine.ts`). Same numbers and words as before; the strengths changed:

  | level | word | target | how |
  |---|---|---|---|
  | 1 | beginner | ~500 | picker: depth 3, T 260, blunders 18% |
  | 2 | easy | ~800 | picker: depth 5, T 140, blunders 8% |
  | 3 | casual | ~1100 | picker: depth 6, T 90, blunders 4.5% |
  | 4 | medium | ~1500 | picker: depth 8, T 52, blunders 2.2% |
  | 5 | challenging | ~2000 | `UCI_Elo 2600`, 800 ms |
  | 6 | hard | ~2500 | `UCI_Elo 2850`, 1000 ms |
  | 7 | expert | ~2800 | `UCI_Elo 3100`, 1000 ms |
  | 8 | max | full | full strength, 1000 ms |

- **Human-like picker** (`pickHumanlike`, levels 1–4):
  - One MultiPV search scores every legal move at a shallow depth (20–240 ms locally).
  - A move is drawn with weight `exp(-loss/T)`; with probability `blunderRate` it is a move losing 150–900 cp
    instead (a hung piece, a missed tactic).
  - The first 6 moves use half the temperature and no blunders, so openings look normal.
  - It falls back to Skill 0 if the search fails.
- **Every search resets `MultiPV 1`**: a timed-out `topMoves` could leave it at 3.
- **Calibration** (`scripts/calibrate.ts`): self-play between neighbouring levels, judged by full-strength analysis
  (ACPL = average centipawn loss).
- **Facts for jabs and compliments** (`moveFacts` on `make_move`): which piece moved, captures, checks, the material
  change over the turn, the phase, whether the user was in check, her pawn one step from queening, whether she took the
  piece the user just moved, and the winner. `moveIdeas` now names forks.
- **Hint** speaks only the engine's move: "The best move here, according to the engine, would be knight to f3." (no
  idea). For three: "According to the engine, the best moves are …". `piece` limits it to one piece (Stockfish
  `searchmoves`): "The best knight move here …".
- **Shorter read-outs:**
  - The board: "You have king e1, queen d1, …, pawns a2 to h2. I have …" (44 words at the start, was 73).
  - Row by row: owners once per run, pawn ranges, empty ranks merged (47 words, was 153).
  - Legal moves: 5 at most, squares only for one piece, captures first.
  - `last_moves`: 6 half-moves at most. `game_history`: the last 6 unless `full: true`.
  - `consider_move`: two sentences.
  - `analyze_position`'s own speech no longer names the best move.
- **Undo** replays from the game's start position (set-up games undid to the wrong position).

### Agent
- **Jabs and compliments** (`src/banter.ts`):
  - The user's lines, word for word, by category: blunder, gift, inaccuracy, check, queen/rook attacked, fork,
    piece, pressure, endgame, promotion, winning; praise for good moves, tactics, forks, attacks, mate, defence,
    endgame; and parting words.
  - Lines that claim a fact (a fork, a knight, a second check) are used only when it is true. Lines nobody can check
    (pins, outposts, the clock) were left out.
  - `pickBanter` decides from the server's facts only. Each remark has a tier: the game's end always; a blunder, a
    gift, a fork or a won piece after 1 quiet move; mistakes and strong moves after 2; flavour after 3. No line
    repeats in a game.
  - Brief mode adds the line with no model call. Chatty mode gives the model the event and three examples.
- **No unasked coaching:**
  - "Careful, …", "X was better" and the "warn them" talking point are gone.
  - The model never sees alerts, better moves, trend or her own threats on move turns.
  - SKILL rule 3: every question gets a straight answer, and nothing is volunteered.
  - Right after an undo, "what should I have played?" gives the hint.
- **Short replies:**
  - `capWords`: 30 words for moves, 35 for answers, unless a read-out was asked for.
  - Sentence limits: brief answers 2, chatty moves 3 and answers 2.
  - `maxTokens` 200.
  - A guessed move quotes the words only when they were a short garble.
- **Routing without the model:**
  - Bare "undo" (0.3 s, was 1.3 s).
  - "Read / describe the board" in the short form ("ranks" only when they say row or rank).
  - Opponent-move questions go to her threat, with the user's own best moves hidden.
  - "What should I avoid?" names the risk.
  - "How am I doing?" gives the evaluation.
  - Reasoning the model speaks by mistake ("The user asked me to…") is replaced by the tool's words.
- **Hearing:**
  - The open-mic filter reads every alternative ("Queen 8", "Pawan Singh 7", "pornh sex").
  - A move heard only faintly ("ok fine" | "Nokia 5", "K5", "1087") gets "Sorry, I didn't catch your move. Say it
    again?" with no model and no guess.
- **Levels:** `LEVEL_NAMES` and SKILL.md say the new strengths.

### Voice (web)
- **Watchdog:** the mic restarts when it should be on but isn't for 1.5 s (a swallowed `start()`, a lost `end`
  event), and a recognizer silent for 20 s is replaced.
- **Fresh recognizer:** rebuilt after two sessions with speech but no words (also in en-US) and after real errors.
  Restart after a phrase or silence is 100 ms (was 250).
- **`not-allowed`** mutes with "Tap the speaker to turn it back on" instead of switching the mic off for good. Coming
  back to the tab restarts the mic.
- **A held half-move waits while the user is still talking** ("Bishop…" + "f4" was flushed mid-word).
- **"Pause" or "stop" with a chess reading** ("pawn") no longer mutes or is dropped: it goes to the agent.
- **Mic-cycle diagnostics** (on, sound, speech, no-speech) always go to the local mirror log, so the next deaf spell
  shows whether Chrome heard anything.

### Evaluation
- **Calibration**, ACPL per level (self-play, 6 games per pairing; human bands: ~800 120+, ~1500 60–70, ~2000 ~40,
  ~2500 20–25):

  | level | round 1 (first settings; 5–7 at UCI_Elo 2000/2500/2800) | round 2 (5–7 at 2600/2850/3100) | round 3 (levels 3–5, medium at T 52) |
  |---|---|---|---|
  | 1 beginner | 232 (10 blunders/game) | 193 (8.2) | — |
  | 2 easy | 183 (5.8) | 146 (7.2) | — |
  | 3 casual | 105 (1.9) | 101 (2.5) | 94 (2.4) |
  | 4 medium | 73 (1.1) | 54 (0.8) | **62** (1.0) |
  | 5 challenging | 72 (1.8) | 39 (0.5) | 33 (0.4) |
  | 6 hard | 55 (1.2) | 40 (1.1) | — |
  | 7 expert | 21 (0.3) | 37 (1.5) | — |

  - **Order:** in every round each level beat the one below it (5/6 to 8/8).
  - **Time per move:** the picker levels take 25–200 ms, and 5–7 use their full 0.8–1 s.
  - **ACPL depends on the opponent:** level 7 scored 21 against level 6 in round 1, but 37 in round 2 against a
    stronger level 6.
  - **Limits:** this is a proxy for human Elo. Your own games are the real check, especially for 6 and 7.

- **`npm run rival`** (`scripts/rival-sim.ts`, new): whole games through the real agent in brief mode with no model.
  The player is simulated: half engine moves, half random. It measures remarks, length, coaching and the score per
  level.

  | run | remark rate | words per move reply | coaching | model calls | simulated player's score (L1/L2/L3/L4) |
  |---|---|---|---|---|---|
  | round 1 | 0.48–0.60 | 12.3 avg, 22 max | 0 | 5 (sim bug) | 3/3, 2/3, 0/3, 0/3 |
  | round 2 (tiers) | 0.29–0.33 | 11.1 avg, 21 max | 0 | 0 | 3/3, 2/3, 0/3, 0/3 |

- **Conversation eval** (`npm run eval`, Nova 2 Lite, same 24-turn script):

  | build | sentences / reply | words / reply | max latency | cost |
  |---|---|---|---|---|
  | stable-2026-10-17 | 1.83 | 10.8 | 8.9 s | $0.014 |
  | Phase 8 | 1.96 | 11.2 | 2.0 s | $0.015 |

- **305 questions** (`npm run qa -- --no-judge`, Nova 2 Lite):

  | run | words per answer (avg / p50 / p90 / max) | answers over 35 words | cost |
  |---|---|---|---|
  | 16 Oct (round 2, before Phase 6b–8) | 25.6 / 24 / 43 / 149 | 67 | — |
  | Phase 8 round 1 | 18.4 / 17 / 27 / 149 | 5 | ~$0.34 (usage not yet recorded) |
  | Phase 8 final | 19.4 / 19 / 30 / 81 | 6 (all asked-for read-outs or "explain everything") | $0.334 |

  - **Unasked coaching** (a scan for "careful", "was better", "you should" in answers to questions that didn't ask
    for help): 0.
  - **Reasoning leaks:** 0 in the final run.
  - **Errors:** 0.

  Rounds 2–6 fixed:
  - opponent questions answered with the user's moves;
  - "what should I avoid" getting the best move;
  - "best move for my knight" getting a pawn move;
  - a model reasoning leak (170 words);
  - over-cautious refusals ("that would be coaching", "a strategic advantage I can't give away", "cheating").

  Nova 2 Lite kept refusing to help its own opponent. Three things stopped it:
  - **Code answers:** "which of my pieces are under attack / anything hanging / alert me" is now answered straight
    from the facts.
  - **Note:** every routed analysis answer carries "you are the player's eyes as well as their opponent".
  - **Retry:** a reply that still refuses gets one more model call. If that refuses too, it becomes "I can't spot
    that from here. Ask me what's under attack or what I'm threatening, and I'll tell you."

  Re-running the refusal-prone questions twice, 7 of 8 were answered both times; the 8th ("remove the defender of
  their queen") isn't in the facts.
- **Conversation eval, later rounds:**
  - **"Quiet move."** The model said its talking-point label out loud. The labels were reworded, and the
    sentence is dropped if it slips through.
  - **Chatty move turns.** Twice they left out a move ("Pawn to a3. A free piece? Don't mind if I do."). Chatty
    turns now take both moves from the template, and the model adds only the reaction. Final run: 1.88 sentences
    and 10.6 words per reply, every engine move said, 1.7 s max, $0.0126.
- **Browser** (scripted recognizer, local agent with Nova 2 Lite and Polly, no Transcribe):
  - The watchdog restarted a swallowed start in 2.3 s.
  - "Bishop" + "f4" (started 3.5 s later) was joined and played.
  - "pause" | "pawn" was answered instead of muting.
  - The hint wording was right, and "Bishop a6??" got "That piece had better days."
  - Undo took 0.3 s, then "what should I have played?" gave the engine's move.
  - "ok fine" | "Nokia 5" and "K5" were re-asked in 0.3 s.
  - The board read-out was 54 words, mid-game.
  - `not-allowed` muted with the tap hint, and a tap restarted the mic.
  - Two deaf cycles gave a fresh recognizer.
- **Prices** in the evals are now the ones billed in ap-south-1 (Nova 2 Lite $0.35 / $2.95 per million tokens),
  and `qa-eval` records usage and cost.

### Cost of this phase
**About $1.08 in all (Nova 2 Lite and Polly, ap-south-1, covered by credits).** No Transcribe was used, and
calibration and the rival sim run on local Stockfish at no cost.

| item | runs | cost |
|---|---|---|
| 305-question eval, no judge | 2 full runs plus 5 targeted rounds (149 questions) | ~$0.87 |
| conversation eval | 6 runs, including one on the stable build | ~$0.08 |
| browser tests (local agent with Polly) | 2 sessions | ~$0.06 |
| Cost Explorer queries (billing check) | 7 | $0.07 |

### Tests
- **Chess server 168** (was 155):
  - engine picker statistics with a seeded RNG, and every level legal and fast;
  - easy finds a mate in one;
  - `moveFacts`, the winner, undo from a set-up position;
  - short move lists and `game_history`;
  - hint wording, and the hint for one piece;
  - fork ideas;
  - compact board read-outs.
- **Agent 79** (was 61):
  - `banter.test.ts`: event mapping, fact gates, tiers, no repeats, line length;
  - the no-coaching facts;
  - `capWords`;
  - today's dropped lines and faint moves;
  - direct routes, undo then "what should I have played";
  - refusal retry, reasoning leak, move guard, labels said aloud.
- **Page 81 checks** (was 73): "pause" vs "pawn".

### Status
Built, tested locally and in the browser with a scripted recognizer. **Not yet played with a real microphone, not
committed and not deployed.** The next real-mic session will log every mic cycle to the local drawer log, which
shows whether any remaining deaf spell is Chrome's.
