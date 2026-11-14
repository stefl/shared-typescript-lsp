// Two fake Claude Code sessions in two worktrees, through the real wrapper.
// Needs two checkouts of a TypeScript 7 repo with packages installed:
//   SHARED_TS_LSP_E2E_A=<worktree> SHARED_TS_LSP_E2E_B=<worktree> bun test test/e2e.test.ts
// The file and symbol default to blackhole's apps/mcp/src/card.ts and hostInsets.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decoder, encode, type Message } from "../src/framing.ts";

const A = process.env.SHARED_TS_LSP_E2E_A;
const B = process.env.SHARED_TS_LSP_E2E_B;
const FILE = process.env.SHARED_TS_LSP_E2E_FILE ?? "apps/mcp/src/card.ts";
const SYMBOL = process.env.SHARED_TS_LSP_E2E_SYMBOL ?? "export function hostInsets";
const hubDir = mkdtempSync(join(tmpdir(), "shared-typescript-lsp-test-"));
const env = { ...process.env, SHARED_TS_LSP_DIR: hubDir, SHARED_TS_LSP_IDLE_MS: "3000" };
const wrapper = join(import.meta.dir, "..", "bin", "shared-typescript-lsp");

function session(cwd: string) {
  const p = Bun.spawn([wrapper], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const dec = new Decoder();
  const waiters: ((m: Message) => boolean)[] = [];
  const pushes: Message[] = [];
  (async () => {
    for await (const c of p.stdout) for (const m of dec.push(c)) {
      if (m.method === "textDocument/publishDiagnostics") pushes.push(m);
      for (let i = 0; i < waiters.length; i++) if (waiters[i](m)) waiters.splice(i--, 1);
    }
  })();
  let id = 0;
  const send = (m: object) => p.stdin.write(encode({ jsonrpc: "2.0", ...m }));
  const req = (method: string, params: unknown) => {
    const myId = ++id;
    send({ id: myId, method, params });
    return new Promise<Message>((r) => waiters.push((m) => (m.id === myId && !m.method ? (r(m), true) : false)));
  };
  const nextPush = (uri: string) =>
    new Promise<Message>((r) =>
      waiters.push((m) => (m.method === "textDocument/publishDiagnostics" && (m.params as any).uri === uri ? (r(m), true) : false)),
    );
  return { p, send, req, nextPush, pushes };
}

const run = A && B ? test : test.skip;

run(
  "two worktrees share one server, each sees only its own type error and references",
  async () => {
    const sa = session(A!);
    const sb = session(B!);
    const init = { processId: null, rootUri: null, capabilities: {} };
    const [ia, ib] = await Promise.all([
      sa.req("initialize", { ...init, rootUri: `file://${A}` }),
      sb.req("initialize", { ...init, rootUri: `file://${B}` }),
    ]);
    expect((ia.result as any).capabilities.referencesProvider).toBeTruthy();
    expect(ib.result).toEqual(ia.result);
    sa.send({ method: "initialized", params: {} });
    sb.send({ method: "initialized", params: {} });

    const uriA = `file://${A}/${FILE}`;
    const uriB = `file://${B}/${FILE}`;
    const text = readFileSync(`${A}/${FILE}`, "utf8");
    const pa = sa.nextPush(uriA);
    const pb = sb.nextPush(uriB);
    sa.send({ method: "textDocument/didOpen", params: { textDocument: { uri: uriA, languageId: "typescript", version: 1, text } } });
    sb.send({ method: "textDocument/didOpen", params: { textDocument: { uri: uriB, languageId: "typescript", version: 1, text: readFileSync(`${B}/${FILE}`, "utf8") } } });
    const [da, db] = await Promise.all([pa, pb]);
    const errors = (m: Message) => ((m.params as any).diagnostics as any[]).filter((d) => d.severity === 1);
    expect(errors(da)).toEqual([]);
    expect(errors(db)).toEqual([]);

    // Session A adds a type error. A gets it pushed; B's copy stays clean.
    const probe = `${text}\nconst __lspProbe: number = "x";\n`;
    const pa2 = sa.nextPush(uriA);
    sa.send({ method: "textDocument/didChange", params: { textDocument: { uri: uriA, version: 2 }, contentChanges: [{ text: probe }] } });
    const da2 = await pa2;
    expect(errors(da2).map((d) => d.message).join()).toContain("not assignable to type 'number'");
    const db2 = await sb.req("textDocument/diagnostic", { textDocument: { uri: uriB } });
    expect(((db2.result as any).items as any[]).filter((d) => d.severity === 1)).toEqual([]);

    // References stay inside each session's own worktree.
    const line = text.split("\n").findIndex((l) => l.includes(SYMBOL));
    const character = text.split("\n")[line].indexOf(SYMBOL.split(" ").pop()!);
    for (const [s, root, uri] of [[sa, A, uriA], [sb, B, uriB]] as const) {
      const r = await s.req("textDocument/references", { textDocument: { uri }, position: { line, character }, context: { includeDeclaration: true } });
      const locs = r.result as any[];
      expect(locs.length).toBeGreaterThan(1);
      expect(locs.every((l) => l.uri.startsWith(`file://${root}/`))).toBe(true);
    }

    // One server for both sessions.
    const st = Bun.spawnSync([wrapper, "status"], { env }).stdout.toString();
    const status = JSON.parse(st);
    expect(status.servers.length).toBe(1);
    expect(status.servers[0].sessions.length).toBe(2);
    console.log(`server ${status.servers[0].rssMB} MB, daemon ${status.daemon.rssMB} MB`);

    sa.p.kill();
    sb.p.kill();
  },
  120_000,
);

afterAll(() => {
  Bun.spawnSync([wrapper, "stop"], { env });
});
