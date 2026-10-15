import { createServer } from "node:http";
import { bestMove, engineMove } from "./chess/engine.js";
import { handleMcpRequest } from "./http.js";
import { MemoryGameStore } from "./store.js";

// Local dev server: same MCP endpoint as Lambda, in-memory games, bound to localhost only (spec advice).
// npm run dev   ->  http://127.0.0.1:3001/mcp   (set MCP_TOKEN to require a bearer token)

const port = Number(process.env.PORT ?? 3001);
const deps = { store: new MemoryGameStore(), engine: { move: engineMove, best: bestMove } };

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await handleMcpRequest(request, deps, { token: process.env.MCP_TOKEN });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(port, "127.0.0.1", () => {
  console.log(`alexa_chess MCP server on http://127.0.0.1:${port}/mcp${process.env.MCP_TOKEN ? " (bearer token required)" : ""}`);
});
