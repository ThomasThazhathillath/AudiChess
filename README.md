# AudiChess: Alexa+ blind chess

Play chess with your eyes closed: a voice-only rival that tells you the board, answers any question about it and
trash-talks back.

**Play chess by voice with Alexa, with no board.** AudiChess is the web front end. Behind it are the `alexa_chess`
MCP server and the agent. You talk, she listens, plays back against you with a real chess
engine, chats like a friendly rival, and answers anything about the game, because you can't see the board.

Built for the **Build, Ship, Shape Hackathon, Alexa+ track**: a working **MCP integration** over **Streamable HTTP**,
driven by an agent that follows an **Agent Skill** (`SKILL.md`), with the Alexa+ experience simulated in a web page.

**Try it:** https://d2ammv4cvnzsu5.cloudfront.net (Chrome or Edge, with a microphone; headphones are best).
Tap the speaker and say "Let's play chess". No wake word is needed.

## What it's like

> **You:** Let's play chess.
>
> **Alexa:** Sure! White or black? And easy, medium or hard?
>
> **You:** White, easy.
>
> **Alexa:** Alright, we're playing white against me at easy level.
>
> **You:** D four.
>
> **Alexa:** You play pawn to d4, I play pawn to d5. This is the Queen's Pawn Game.
>
> **You:** Bishop f four.
>
> **Alexa:** Bishop to f4. I play pawn to a6. This is the Queen's Pawn Game: Accelerated London System.
>
> **You:** E three.
>
> **Alexa:** Pawn to e3. I play pawn to b5.
>
> **You:** C three.
>
> **Alexa:** Pawn to c3. I play knight to f6. Ooh, solid.
>
> **You:** Oops.
>
> **Alexa:** Want to take that back? Just say undo.

*(The lines are from real games on the live build.)*

What she does:
- **Understands spoken moves the way people say them:** "knight f three", "night takes e five", "castle kingside",
  "e4", "book g five" (rook), a move split over two breaths ("knight h" … "four"), and an unclear move played as its
  likeliest reading ("say undo if not").
- **Plays a real engine** (Stockfish) at 8 levels, from beginner (about 500 Elo) to full strength. The levels are
  calibrated by self-play. The language model never picks or checks moves.
- **Answers questions about the game:** what's on a square, what's attacked, threats, who's winning, the opening, the
  moves so far, a hint, "what if I play…", a game review. That's 305 tested questions in 18 categories.
- **Behaves like a rival, not a coach:** she never gives unasked hints or warnings. She makes short jabs when you
  blunder, compliments a good move, and chats in between.
- **Speaks naturally:** Amazon Nova 2 Sonic, speech to speech, in four English voices (British Amy by default).

## Architecture

```
 Browser (S3 + CloudFront)                          AWS
┌────────────────────────────┐  audio, WebSocket  ┌──────────────────────────────────┐
│ Echo simulator page        │ ◀───────────────▶  │ Amazon Nova 2 Sonic              │
│  mic 16 kHz → Sonic        │  (Cognito guest)   │  (ap-northeast-1) ears + voice   │
│  Sonic's voice → speaker   │                    │  one tool: "alexa"               │
│  tool call → agent ────────┼──┐                 └──────────────────────────────────┘
└────────────────────────────┘  │ HTTPS
                                ▼
                 ┌──────────────────────────────────┐
                 │ Agent Lambda (ap-south-1)        │  Amazon Nova 2 Lite (Bedrock Converse)
                 │  SKILL.md + tool loop            │  + instant code paths for moves,
                 │  = MCP client                    │    undo, small talk, banter
                 └───────────────┬──────────────────┘
                                 │ MCP, Streamable HTTP, Bearer token
                                 ▼
                 ┌──────────────────────────────────┐
                 │ MCP server Lambda "alexa_chess"  │  chess.js + Stockfish (Lambda layer)
                 │  17 tools, stateless JSON mode   │  spoken-move resolver, openings
                 └───────────────┬──────────────────┘
                                 ▼
          DynamoDB: alexa_chess_games / alexa_chess_moves (every move) / alexa_chess_sessions
```

- **Sonic is only the ears and the voice.** It transcribes every turn, calls the `alexa` tool, and reads the agent's
  reply word for word. All chess logic lives behind MCP.
- **Most turns need no language model.** Moves, undo, "knight to which square?", thinking noises and banter are
  handled in code (about 0.2 s). Questions use Nova 2 Lite (about 0.7–1 s), with prompt caching.
- **The MCP server is a standard MCP server.** It runs Streamable HTTP in stateless JSON mode (no session id; GET
  returns 405), so any Lambda instance can answer any request. Game state lives in DynamoDB. Any MCP client can use
  it; see below.

### MCP tools (`alexa_chess`)

| Play | Look | Help and review |
|---|---|---|
| `new_game`, `make_move`, `undo`, `resign`, `offer_draw`, `set_level` | `read_board`, `describe_square`, `list_pieces`, `legal_moves`, `last_moves`, `game_status`, `game_history` | `hint`, `analyze_position`, `consider_move`, `review_game` |

Every tool returns structured content plus a ready-to-speak `speech` sentence. `make_move` accepts loose speech
("night takes e five") and resolves it against the legal moves.

### Agent Skill

[`packages/agent/skills/blind-chess/SKILL.md`](packages/agent/skills/blind-chess/SKILL.md) (agentskills.io format)
teaches the agent:
- blind-chess narration: spoken, short, never invents a fact the tools didn't give;
- which tool answers which question;
- move disambiguation;
- the rival personality.

## Use the MCP server from another client

The server works with any MCP client. For example, Claude Code:

```bash
claude mcp add --transport http alexa_chess https://o333krdke5vzhn4katt2gkxu6u0uoudc.lambda-url.ap-south-1.on.aws/mcp --header "Authorization: Bearer <token>"
```

The token is in AWS Secrets Manager (`alexa_chess_mcp_token`); ask us for one. To smoke-test any endpoint with the
official MCP client:

```bash
npm run smoke --prefix packages/mcp-server -- <url> <token>
```

## Run it locally

Requirements: Node 22+, and AWS credentials with Bedrock access to Nova 2 Lite (for questions) and Nova 2 Sonic (for
voice).

```bash
npm install --prefix packages/mcp-server
npm install --prefix packages/agent
npm run dev --prefix packages/mcp-server
npm run dev --prefix packages/agent
node scripts/serve-web.mjs
```

The MCP server runs on port 3001, the agent on 3002 and the page on 5173.
Without a microphone, press **D** for the debug drawer and type turns.

## Deploy

```powershell
.\scripts\deploy.ps1
```

Requirements: AWS CLI, SAM CLI, Node 22+. This builds and deploys the SAM stack `alexa-chess` in ap-south-1: the two
Lambdas with function URLs, the Stockfish layer, three DynamoDB tables, the token secret, the S3 + CloudFront site,
and a Cognito guest pool. The pool's role may only call Nova 2 Sonic in ap-northeast-1. The script then builds the
browser Sonic SDK bundle and uploads the page.

## Tests and evaluations

| What | Command | Latest result |
|---|---|---|
| Chess server unit tests | `npm test --prefix packages/mcp-server` | 176 pass |
| Agent unit tests | `npm test --prefix packages/agent` | 89 pass |
| Page checks (Sonic session, cleaning) | `node scripts/test-wake.mjs` | 59 + 30 pass |
| Live MCP smoke test | `npm run smoke` (above) | 17 tools, each call under 170 ms |
| Game conversation eval | `npm run eval --prefix packages/agent` | 0 made-up claims, 0 engine moves unsaid, 0.73 s average |
| Small-talk eval (30 turns) | `npm run eval --prefix packages/agent -- --script chat` | 0 re-asks, 0 unasked coaching |
| 305 questions, 18 categories | `npm run qa --prefix packages/agent` | 0 errors, 0 unasked coaching, about 19 words per answer |
| Voice end to end (real audio → Sonic → agent → speech) | `npm run sonic --prefix packages/agent` | 10/10 heard and spoken word for word |
| Whole simulated games, no model | `npm run rival --prefix packages/agent` | banter on 58% of moves, 0 coaching |
| Engine level calibration | `packages/mcp-server/scripts/calibrate.ts` | each level beats the one below |

**Cost:**
- questions: about $0.04 of model for a 60-turn game;
- voice: about $0.012 per minute of talking.

## Repository

```
web/                      Echo simulator page: Sonic session (sonic.js), app, debug drawer (D)
packages/mcp-server/      MCP server: tools, chess wrapper, Stockfish engine, spoken-move resolver
packages/agent/           Agent: tool loop, routing, banter, skill, evals
layers/stockfish/         Stockfish Lambda layer
template.yaml             SAM: every AWS resource
scripts/deploy.ps1        build + deploy + upload
docs/PLAN.md              the full build log: every phase, what broke, how it was measured, what it cost
```
