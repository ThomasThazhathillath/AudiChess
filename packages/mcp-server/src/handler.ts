import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { bestMove, engineMove } from "./chess/engine.js";
import { handleMcpRequest } from "./http.js";
import type { Deps } from "./server.js";
import { DynamoGameStore } from "./store.js";

const deps: Deps = {
  store: new DynamoGameStore(),
  engine: { move: engineMove, best: bestMove },
};

let tokenPromise: Promise<string> | undefined;

/** Bearer token from Secrets Manager, fetched once per cold start. */
function getToken(): Promise<string> {
  tokenPromise ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: process.env.MCP_SECRET_ARN }))
    .then((r) => r.SecretString ?? "")
    .catch((err) => {
      tokenPromise = undefined;
      throw err;
    });
  return tokenPromise;
}

function toRequest(event: LambdaFunctionURLEvent): Request {
  const { http } = event.requestContext;
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  const hasBody = event.body !== undefined && event.body !== null && http.method !== "GET" && http.method !== "HEAD";
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, "base64") : event.body) : undefined;
  return new Request(url, { method: http.method, headers, body });
}

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  const started = Date.now();
  const req = toRequest(event);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const res = await handleMcpRequest(req, deps, { token: await getToken(), allowedOrigins });

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const body = await res.text();

  console.log(
    JSON.stringify({
      level: "info",
      msg: "mcp request",
      method: event.requestContext.http.method,
      path: event.rawPath,
      rpc: rpcSummary(event.body, event.isBase64Encoded),
      status: res.status,
      ms: Date.now() - started,
    }),
  );
  return { statusCode: res.status, headers, body };
};

/** JSON-RPC method (and tool name) for logs, without arguments. */
function rpcSummary(body: string | undefined, b64: boolean): string | undefined {
  if (!body) return undefined;
  try {
    const msg = JSON.parse(b64 ? Buffer.from(body, "base64").toString() : body);
    return msg.method === "tools/call" ? `tools/call:${msg.params?.name}` : msg.method;
  } catch {
    return undefined;
  }
}
