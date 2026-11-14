import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// dist/ is what the plugin runs. Rebuild it with Node and check nothing changed.
test("dist/ matches src/ (run `node scripts/build.ts`)", () => {
  const root = join(import.meta.dir, "..");
  const script = `import { outputs } from "./scripts/build.ts"; console.log(JSON.stringify([...outputs()]));`;
  const fresh: [string, string][] = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" }));
  for (const [f, js] of fresh) expect(readFileSync(join(root, "dist", f), "utf8")).toBe(js);
});
