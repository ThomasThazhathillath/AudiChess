import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { runTurn } from "../src/agent.js";
import { McpChessTools } from "../src/mcpClient.js";
import { MemorySessionStore } from "../src/sessions.js";

// Talk to the agent locally: real Bedrock (Nova Pro) + the deployed MCP server, sessions in memory.
//   npm run chat -- "start a new game" "pawn to e4" "night forever|knight e4"   ("|" separates recognition alternatives)
// Env: MCP_URL (defaults to the deployed server), MODEL_ID, AWS_REGION (ap-south-1).

const region = process.env.AWS_REGION ?? "ap-south-1";
const mcpUrl = process.env.MCP_URL ?? "https://o333krdke5vzhn4katt2gkxu6u0uoudc.lambda-url.ap-south-1.on.aws/mcp";
const bedrock = new BedrockRuntimeClient({ region });
const secrets = new SecretsManagerClient({ region });

const deps = {
  converse: (input: any) => bedrock.send(new ConverseCommand(input)),
  tools: new McpChessTools(mcpUrl, async () => {
    if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: "alexa_chess_mcp_token" }));
    return r.SecretString ?? "";
  }),
  sessions: new MemorySessionStore(),
  modelId: process.env.MODEL_ID ?? "apac.amazon.nova-pro-v1:0",
};

const utterances = process.argv.slice(2);
if (utterances.length === 0) utterances.push("Alexa, let's play chess. I'll be white, easy please.", "pawn to e4", "where is the black queen?");

const sessionId = `local-${Date.now()}`;
for (const utterance of utterances) {
  const [text, ...alternatives] = utterance.split("|").map((s) => s.trim());
  const t = Date.now();
  const r = await runTurn(deps, sessionId, { text, alternatives: [text, ...alternatives] });
  console.log(`\n🧑 ${utterance}`);
  for (const c of r.toolCalls) console.log(`   🔧 ${c.name}(${JSON.stringify({ ...c.args, gameId: c.args.gameId ? "…" : undefined, sessionId: undefined })})${c.isError ? " ✗" : ""}`);
  console.log(`🔵 ${r.reply}   (${Date.now() - t} ms, ${r.usage.rounds} rounds, ${r.usage.inputTokens}+${r.usage.outputTokens} tokens)`);
}
