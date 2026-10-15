// SKILL.md is bundled as a string: esbuild's text loader on Lambda, scripts/md-loader.mjs and vitest locally.
declare module "*.md" {
  const content: string;
  export default content;
}
