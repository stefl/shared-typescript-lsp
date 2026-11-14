// Builds dist/*.js from src/*.ts, so the plugin runs as plain JavaScript on Node
// (or Bun) with no type stripping at run time, which would cost about 27 MB per
// process. Needs Node 22.13 or later to run: `node scripts/build.ts`.
// test/dist.test.ts fails when dist/ is out of date.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

export function build(source: string, name: string): string {
  const js = stripTypeScriptTypes(source, { mode: "strip" }).replace(/(from\s+"\.\/[\w-]+)\.ts"/g, '$1.js"');
  return `// Generated from src/${name} by scripts/build.ts. Edit the source, then rebuild.\n${js}`;
}

export function outputs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")))
    out.set(f.replace(/\.ts$/, ".js"), build(readFileSync(join(root, "src", f), "utf8"), f));
  return out;
}

if (process.argv[1] === import.meta.filename) {
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const [f, js] of outputs()) writeFileSync(join(root, "dist", f), js);
  console.log(`built ${[...outputs().keys()].join(", ")}`);
}
