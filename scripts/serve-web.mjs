// Serves web/ on http://127.0.0.1:5173 for local testing. config.json points at the local agent
// (http://127.0.0.1:3002/) unless AGENT_URL is set, so nothing deployed is needed.
//   node scripts/serve-web.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");
const port = Number(process.env.PORT ?? 5173);
const agentUrl = process.env.AGENT_URL ?? "http://127.0.0.1:3002/";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/config.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agentUrl }));
  const file = normalize(join(root, path === "/" ? "index.html" : path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`web on http://127.0.0.1:${port}/ (agent: ${agentUrl})`));
