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
├─ skills/blind-chess/SKILL.md   # Agent Skill: narration + disambiguation rules
├─ web/                          # static Echo simulator (index.html, app.js, styles.css)
└─ scripts/
   ├─ deploy.ps1                 # sam build + deploy + publish web + write config.json
   └─ smoke-mcp.ps1              # curl-style JSON-RPC checks against deployed /mcp
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

**Dependencies:** `@modelcontextprotocol/sdk`, `zod`, `chess.js`, `@aws-sdk/client-dynamodb` + `lib-dynamodb`, `@aws-sdk/client-secrets-manager`. The layer provides `stockfish` (WASM, single-threaded build).

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

**Phase 2 done when:**
- `scripts/smoke-mcp.ps1` against the deployed URL succeeds for `initialize`, `tools/list` and `tools/call new_game` → `make_move e4` (engine replies).
- The official **MCP Inspector** (`npx @modelcontextprotocol/inspector`, Streamable HTTP, bearer header) lists and calls the tools.

## Phase 3: Agent + Echo simulator web page

**Agent Skill:** `skills/blind-chess/SKILL.md` (agentskills.io format with YAML frontmatter `name`, `description`). Rules:
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

**Phase 3 done when:** in Chrome at `WebsiteUrl`, saying "Alexa, start a new game, I'll play white, easy" → "pawn to e4" → "where's the black queen?" → "read me the board" all get correct spoken replies, and a full game can reach checkmate or resignation.

## Verification (end to end)

1. `sam validate --lint` passes.
2. Phase 1: stub URLs respond; CloudFront serves the page.
3. Phase 2: `npm test` (vitest) passes; `smoke-mcp.ps1` passes; MCP Inspector connects over Streamable HTTP and calls every tool.
4. Phase 3: run the voice script above in Chrome. Check CloudWatch logs for tool calls, and confirm illegal moves give friendly corrections.
5. Optional: add the MCP URL plus bearer token to Claude Desktop / Claude Code as a remote MCP server, as a second client showing interoperability for the judges.

## Cost / cleanup
Mostly free-tier (Lambda, DynamoDB on-demand, CloudFront). Ongoing costs are Secrets Manager (~$0.40/month) and Bedrock tokens. Tear down with `sam delete --stack-name alexa-chess` after emptying the bucket.
