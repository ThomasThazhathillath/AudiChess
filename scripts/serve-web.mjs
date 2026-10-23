// Serves web/ on http://127.0.0.1:5173 for local testing. config.json points at the local agent
// (http://127.0.0.1:3002/) unless AGENT_URL is set. The voice (Nova 2 Sonic) uses the deployed stack's guest identity
// pool, read from the stack outputs at start (or SONIC_POOL_ID); the SDK bundle is rebuilt first.
//   node scripts/serve-web.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");
const port = Number(process.env.PORT ?? 5173);
const agentUrl = process.env.AGENT_URL ?? "http://127.0.0.1:3002/";
execFileSync(process.execPath, [join(root, "..", "scripts", "build-sonic-sdk.mjs")], { stdio: "inherit" });
function stackSonic() {
  if (process.env.SONIC_POOL_ID) return { identityPoolId: process.env.SONIC_POOL_ID, roleArn: process.env.SONIC_ROLE_ARN, poolRegion: "ap-south-1", region: "ap-northeast-1", modelId: "amazon.nova-2-sonic-v1:0" };
  try {
    const out = JSON.parse(execFileSync("aws", ["cloudformation", "describe-stacks", "--stack-name", "alexa-chess", "--region", "ap-south-1", "--query", "Stacks[0].Outputs", "--output", "json"], { encoding: "utf8", shell: true }));
    const get = (k) => out.find((o) => o.OutputKey === k)?.OutputValue;
    return get("SonicIdentityPoolId") ? { identityPoolId: get("SonicIdentityPoolId"), roleArn: get("SonicGuestRoleArn"), poolRegion: "ap-south-1", region: get("SonicRegion"), modelId: get("SonicModelId") } : undefined;
  } catch { return undefined; }
}
const sonic = stackSonic();
if (!sonic) console.warn("No Sonic identity pool found (deploy the stack, or set SONIC_POOL_ID): the page will have no voice.");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/config.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ agentUrl, sonic }));
  const file = normalize(join(root, path === "/" ? "index.html" : path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`web on http://127.0.0.1:${port}/ (agent: ${agentUrl})`));
