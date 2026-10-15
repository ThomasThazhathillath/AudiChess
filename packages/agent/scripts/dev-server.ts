import { createServer } from "node:http";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PollyClient } from "@aws-sdk/client-polly";
import { runTurn } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";
import { pollySpeaker } from "../src/voice.js";

// Local agent with the same POST contract as the Lambda: real Bedrock + Polly, sessions in memory.
// Pair it with the local MCP server (packages/mcp-server: npm run dev) and scripts/serve-web.mjs.
//   npm run dev   ->  http://127.0.0.1:3002/

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
  let raw = "";
  for await (const c of req) raw += c;
  try {
    const body = JSON.parse(raw || "{}");
    if (body.warm) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    const t = Date.now();
    const result = await runTurn(deps, body.sessionId, { text: body.text, alternatives: body.alternatives ?? [] });
    console.log(`🧑 ${body.text}  →  🔵 ${result.reply}  (${Date.now() - t} ms, tools: ${result.toolCalls.map((c) => c.name).join(",") || "-"})`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`alexa_chess agent (local) on http://127.0.0.1:${port}/`));
