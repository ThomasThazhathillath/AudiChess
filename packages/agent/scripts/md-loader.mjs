// Node module hook so local runs (tsx) can `import skill from "./SKILL.md"` like the esbuild bundle does.
// Usage: node --import ./scripts/md-loader.mjs --import tsx scripts/chat.ts
import { register } from "node:module";

const hooks = `
import { readFile } from "node:fs/promises";
export async function load(url, context, next) {
  if (url.endsWith(".md")) {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) + ";" };
  }
  return next(url, context);
}`;

register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);
