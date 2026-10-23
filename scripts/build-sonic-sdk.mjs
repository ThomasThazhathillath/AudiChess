// Bundles the AWS SDK's Bedrock client for the page: web/vendor/bedrock-sonic.js (gitignored, rebuilt by deploy.ps1
// and serve-web.mjs). In the browser the SDK opens Nova 2 Sonic's bidirectional stream over a WebSocket.
//   node scripts/build-sonic-sdk.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(root, "packages", "agent"); // the SDK and esbuild are the agent's dependencies
const require = createRequire(join(agentDir, "package.json"));
const esbuild = require("esbuild");

const out = join(root, "web", "vendor", "bedrock-sonic.js");
mkdirSync(dirname(out), { recursive: true });
const entry = join(agentDir, "node_modules", ".sonic-entry.mjs");
writeFileSync(
  entry,
  `import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";
window.BedrockSonic = { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand };
`,
);
const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: out,
  absWorkingDir: agentDir,
  logLevel: "warning",
  metafile: true,
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`web/vendor/bedrock-sonic.js: ${(bytes / 1024).toFixed(0)} KB`);
