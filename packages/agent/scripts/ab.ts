import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { runTurn } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";

// A/B: the same scripted conversation on several Bedrock models, against the local MCP server.
//   (packages/mcp-server: npm run dev)   then   npm run ab
// Prices are approximate on-demand list prices per 1M tokens; check the Bedrock pricing page for ap-south-1.

const MODELS: { id: string; label: string; inPerM: number; outPerM: number }[] = [
  { id: "apac.amazon.nova-pro-v1:0", label: "Nova Pro", inPerM: 0.8, outPerM: 3.2 },
  { id: "apac.amazon.nova-lite-v1:0", label: "Nova Lite", inPerM: 0.06, outPerM: 0.24 },
  { id: "global.amazon.nova-2-lite-v1:0", label: "Nova 2 Lite", inPerM: 0.3, outPerM: 2.5 },
];

const SCRIPT = [
  "let's play chess",
  "white, and make it easy",
  "pawn to e4",
  "night f three|knight f3",
  "bishop to see four|bishop c4",
  "where is the black queen?",
  "talk less",
  "play harder",
  "what was your last move?",
];

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-south-1" });
const only = process.argv[2];

for (const model of MODELS.filter((m) => !only || m.label.toLowerCase().includes(only.toLowerCase()))) {
  const deps = {
    converse: (input: any) => bedrock.send(new ConverseCommand(input)),
    tools: new McpChessTools(process.env.MCP_URL ?? "http://127.0.0.1:3001/mcp", async () => "local"),
    sessions: new MemorySessionStore(),
    modelId: model.id,
  };
  const sessionId = `ab-${model.label.replace(/\s/g, "")}-${Date.now()}`;
  let inTok = 0, outTok = 0, cacheTok = 0, ms = 0, toolErrors = 0;
  console.log(`\n================ ${model.label} (${model.id}) ================`);
  for (const line of SCRIPT) {
    const [text, ...alts] = line.split("|");
    const t = Date.now();
    try {
      const r = await runTurn(deps, sessionId, { text, alternatives: [text, ...alts] });
      const dt = Date.now() - t;
      ms += dt;
      inTok += r.usage.inputTokens;
      outTok += r.usage.outputTokens;
      cacheTok += r.usage.cacheReadTokens + r.usage.cacheWriteTokens;
      toolErrors += r.toolCalls.filter((c) => c.isError).length;
      console.log(`🧑 ${text}\n   🔧 ${r.toolCalls.map((c) => `${c.name}${c.isError ? "✗" : ""}`).join(", ") || "-"}\n🔵 ${r.reply}  (${dt} ms)`);
    } catch (err) {
      console.log(`🧑 ${text}\n   💥 ${String(err).slice(0, 160)}`);
    }
  }
  // Cached prompt tokens are billed at roughly a quarter of the input price.
  const cost = (inTok * model.inPerM + cacheTok * model.inPerM * 0.25 + outTok * model.outPerM) / 1e6;
  const perTurn = cost / SCRIPT.length;
  console.log(
    `\n📊 ${model.label}: avg ${(ms / SCRIPT.length / 1000).toFixed(2)} s/turn, ${Math.round(inTok / SCRIPT.length)} in + ${Math.round(outTok / SCRIPT.length)} out + ${Math.round(cacheTok / SCRIPT.length)} cached tokens/turn, ` +
      `≈ $${perTurn.toFixed(5)}/turn ≈ $${(perTurn * 60).toFixed(3)} per 60-turn game, tool errors: ${toolErrors}`,
  );
}
