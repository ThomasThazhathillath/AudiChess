import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient } from "@aws-sdk/client-polly";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { handler as transcribeUrlHandler } from "../../transcribe-url/src/handler.js";
import { runTurn } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";
import { pollySpeaker } from "../src/voice.js";

// Local agent with the same POST contract as the Lambda: real Bedrock + Polly, sessions in memory.
// Pair it with the local MCP server (packages/mcp-server: npm run dev) and scripts/serve-web.mjs.
//   npm run dev   ->  http://127.0.0.1:3002/

const LIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval-results", "live");
const region = process.env.AWS_REGION ?? "ap-south-1";
const port = Number(process.env.PORT ?? 3002);
const bedrock = new BedrockRuntimeClient({ region });

const deps = {
  converse: (input: any) => bedrock.send(new ConverseCommand(input)),
  tools: new McpChessTools(process.env.MCP_URL ?? "http://127.0.0.1:3001/mcp", async () => process.env.MCP_TOKEN ?? "local"),
  sessions: new MemorySessionStore(),
  modelId: process.env.MODEL_ID ?? "apac.amazon.nova-pro-v1:0",
  speak: pollySpeaker(new PollyClient({ region })),
};

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const raw = body.toString("utf8");
  const path = new URL(req.url ?? "/", "http://x").pathname;
  // The exact microphone audio the page streamed to Transcribe (16 kHz s16le), local testing only, so a bad
  // transcript can be replayed: node scripts/test-transcribe.mjs --wav <file>.
  if (path === "/debug-audio") {
    try {
      const session = (new URL(req.url ?? "/", "http://x").searchParams.get("session") ?? "unknown").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
      mkdirSync(LIVE_DIR, { recursive: true });
      appendFileSync(join(LIVE_DIR, `${new Date().toISOString().slice(0, 10)}-${session}.pcm`), body);
    } catch { /* never break the page */ }
    return res.writeHead(204).end();
  }
  // The page's debug drawer, mirrored while testing locally (web/app.js mirrorLog).
  if (path === "/debug-log") {
    try {
      const lines: unknown = JSON.parse(raw || "{}").lines;
      if (Array.isArray(lines) && lines.length) {
        mkdirSync(LIVE_DIR, { recursive: true });
        appendFileSync(join(LIVE_DIR, `${new Date().toISOString().slice(0, 10)}-drawer.log`), lines.map(String).join("\n") + "\n");
      }
    } catch { /* logging must never break anything */ }
    return res.writeHead(204).end();
  }
  // Local twin of the alexa_chess_transcribe_url Lambda: same handler, signed with your local AWS credentials.
  if (new URL(req.url ?? "/", "http://x").pathname === "/transcribe-url") {
    try {
      const out = await transcribeUrlHandler(
        { headers: {}, body: raw, isBase64Encoded: false, requestContext: { http: { method: req.method, sourceIp: "127.0.0.1" } } } as any,
        { credentials: defaultProvider() as any },
      );
      return res.writeHead(out.statusCode ?? 200, { "content-type": "application/json" }).end(out.body);
    } catch (err) {
      console.error(err);
      return res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));
    }
  }
  try {
    const body = JSON.parse(raw || "{}");
    if (body.warm) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    if (typeof body.sessionId !== "string" || typeof body.text !== "string" || !body.text.trim()) {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "sessionId and text are required" }));
    }
    const t = Date.now();
    const alternatives: string[] = Array.isArray(body.alternatives) ? body.alternatives.filter((a: unknown) => typeof a === "string").slice(0, 5) : [];
    const chessHeard = typeof body.chessHeard === "string" && body.chessHeard.trim() ? body.chessHeard.trim() : undefined;
    const woken = body.woken !== false;
    const result = await runTurn(deps, body.sessionId, { text: body.text, alternatives, chessHeard, woken });
    const tm = result.timings;
    console.log(`🧑 ${woken ? "" : "(no wake word) "}${body.text}${chessHeard ? `  👂 ${chessHeard}` : ""}  →  ${result.ignored ? "🔇 ignored" : `🔵 ${result.reply}`}  (${Date.now() - t} ms${tm ? `: model ${tm.modelMs}, tools ${tm.toolMs}, voice ${tm.ttsMs}${tm.fastPath ? ", fast path" : ""}` : ""}; tools: ${result.toolCalls.map((c) => c.name).join(",") || "-"})`);
    // Every turn goes to a JSONL file too, so a real game can be replayed and measured afterwards.
    try {
      mkdirSync(LIVE_DIR, { recursive: true });
      appendFileSync(
        join(LIVE_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`),
        JSON.stringify({ at: new Date().toISOString(), sessionId: body.sessionId, text: body.text, alternatives, chessHeard, woken, ignored: result.ignored === true, timings: result.timings, reply: result.reply, tools: result.toolCalls.map((c) => ({ name: c.name, args: c.args, isError: c.isError })), confirm: result.toolCalls.some((c) => c.name === "make_move" && /^(I heard|Which|Did you mean)/.test(c.speech ?? "")) }) + "\n",
      );
    } catch { /* logging must never break a turn */ }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`alexa_chess agent (local) on http://127.0.0.1:${port}/`));
