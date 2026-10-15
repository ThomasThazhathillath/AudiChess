import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { type AgentDeps, runTurn } from "./agent.js";
import { McpChessTools } from "./mcpClient.js";
import { DynamoSessionStore } from "./sessions.js";

const bedrock = new BedrockRuntimeClient({});
const secrets = new SecretsManagerClient({});

const deps: AgentDeps = {
  converse: (input) => bedrock.send(new ConverseCommand(input)),
  tools: new McpChessTools(process.env.MCP_URL!, async () => {
    const r = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.MCP_SECRET_ARN }));
    return r.SecretString ?? "";
  }),
  sessions: new DynamoSessionStore(),
  modelId: process.env.MODEL_ID!,
};

// CORS headers are added by the Function URL configuration (AllowedOrigin = the CloudFront site).
const respond = (statusCode: number, body: unknown): LambdaFunctionURLResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  if (event.requestContext.http.method !== "POST") return respond(405, { error: "POST { sessionId, text }" });

  let sessionId: unknown;
  let text: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : (event.body ?? "");
    ({ sessionId, text } = JSON.parse(raw));
  } catch {
    return respond(400, { error: "Body must be JSON: { sessionId, text }" });
  }
  if (typeof sessionId !== "string" || !/^[\w-]{8,64}$/.test(sessionId)) return respond(400, { error: "sessionId must be 8-64 letters, digits, - or _" });
  if (typeof text !== "string" || !text.trim() || text.length > 500) return respond(400, { error: "text must be 1-500 characters" });

  const started = Date.now();
  try {
    const result = await runTurn(deps, sessionId, text.trim());
    console.log(JSON.stringify({ level: "info", msg: "turn", sessionId, text, reply: result.reply, tools: result.toolCalls.map((t) => t.name), ms: Date.now() - started }));
    return respond(200, result);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "turn failed", sessionId, error: String(err), stack: (err as Error)?.stack }));
    return respond(200, { reply: "Sorry, I'm having trouble reaching the chess board right now. Please try again in a moment.", gameOver: false, toolCalls: [], error: true });
  }
};
