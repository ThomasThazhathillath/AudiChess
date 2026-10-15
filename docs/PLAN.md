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
| `new_game` | `color: white\|black\|random`, `level: 1-8` (mapped to Stockfish `UCI_Elo` 1350→2850 and `movetime`) | `gameId`, side, and the engine's first move if you play black |
| `make_move` | `move` (SAN like `Nf3`, or UCI like `g1f3`) | Your move spoken, engine reply spoken, check/mate/draw status. Illegal move gives a clear error plus close legal alternatives. |
| `legal_moves` | optional `square` or `piece` (e.g. `knight`) | Spoken list, e.g. "Your knights can go to f3, h3, c3" |
| `describe_square` | `square` | "Black bishop on c5" / "empty" |
| `list_pieces` | `color` | Pieces grouped by type, spoken |
| `read_board` | — | Full position spoken rank by rank, plus FEN |
| `last_moves` | `count` (default 2) | Recent moves in spoken form (read from `alexa_chess_moves`) |
| `game_history` | optional `gameId` | Full move list (PGN + spoken), status and result. Also lists your recent games when no game is given. |
| `game_status` | — | Whose turn, material count, check, move number |
| `hint` | — | Stockfish best move at depth 12, spoken |
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
- Words map to levels: beginner=1, easy=2, medium=4, hard=6, expert=7, grandmaster/max=8. "Random" and "you pick" also work.
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
