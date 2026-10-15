import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createChessServer, type Deps } from "./server.js";

export interface HttpOptions {
  /** Bearer token clients must send. Undefined disables auth (local runs only). */
  token?: string;
  /** Browser origins allowed to call the endpoint. Requests without an Origin header (servers, CLIs) are always allowed. */
  allowedOrigins?: string[];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  json(status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);

function tokenMatches(header: string | null, token: string): boolean {
  const presented = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * MCP Streamable HTTP endpoint in stateless JSON mode: every POST gets one application/json
 * response, no MCP-Session-Id is issued, GET/DELETE answer 405. That lets any Lambda instance
 * serve any request, with game state kept in DynamoDB.
 */
export async function handleMcpRequest(req: Request, deps: Deps, opts: HttpOptions): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/" || url.pathname === "/health") {
    return json(200, { ok: true, service: "alexa_chess_mcp_server", mcpEndpoint: "/mcp" });
  }
  if (url.pathname !== "/mcp") return json(404, { error: "Not found. The MCP endpoint is /mcp." });

  // Spec: servers MUST validate Origin to prevent DNS rebinding.
  const origin = req.headers.get("origin");
  if (origin && !(opts.allowedOrigins ?? []).includes(origin)) return rpcError(403, "Origin not allowed");

  if (opts.token && !tokenMatches(req.headers.get("authorization"), opts.token)) {
    return rpcError(401, "Missing or invalid bearer token", { "www-authenticate": 'Bearer realm="alexa_chess"' });
  }

  if (req.method !== "POST") return rpcError(405, "Method not allowed. This stateless server only accepts POST.", { allow: "POST" });

  const server = createChessServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    // Fully read the body before tearing down the per-request server.
    const body = await res.text();
    return new Response(body, { status: res.status, headers: res.headers });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
