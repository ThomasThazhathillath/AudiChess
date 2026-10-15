import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Smoke test any alexa_chess MCP endpoint with the official MCP client over Streamable HTTP.
//   npm run smoke -- <url> [token]
//   e.g. npm run smoke -- http://127.0.0.1:3001/mcp
//        npm run smoke -- https://<id>.lambda-url.ap-south-1.on.aws/mcp <token>

const [url = "http://127.0.0.1:3001/mcp", token = process.env.MCP_TOKEN] = process.argv.slice(2);

const client = new Client({ name: "alexa_chess_smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
});

const call = async (name: string, args: Record<string, unknown>) => {
  const t = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const data = res.structuredContent as Record<string, any>;
  console.log(`${res.isError ? "✗" : "✓"} ${name} (${Date.now() - t} ms): ${data?.speech}`);
  if (res.isError) process.exitCode = 1;
  return data;
};

await client.connect(transport);
console.log(`✓ connected to ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`);
const { tools } = await client.listTools();
console.log(`✓ ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const game = await call("new_game", { color: "white", level: 3, sessionId: "smoke-test" });
await call("make_move", { gameId: game.gameId, move: "e4" });
await call("make_move", { gameId: game.gameId, move: "Nf3" });
await call("describe_square", { gameId: game.gameId, square: "e4" });
await call("last_moves", { gameId: game.gameId, count: 4 });
const history = await call("game_history", { gameId: game.gameId });
console.log(`  PGN: ${history.pgn.split("\n").pop()}`);
await call("resign", { gameId: game.gameId });
await client.close();
