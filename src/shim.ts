// shared-typescript-lsp shim: what Claude Code starts in place of a language server.
//
// Speaks LSP on stdio to Claude Code and LSP over a Unix socket to the daemon,
// starting the daemon if none is running. TypeScript 7's server only answers
// pulled diagnostics (textDocument/diagnostic) and Claude Code only listens for
// pushed ones, so after every open, change or save the shim pulls diagnostics
// for this session's open files and pushes them as publishDiagnostics.
//
// Usage: shim.ts                    (run as a language server)
//        shim.ts status             (print what the daemon is running)
//        shim.ts warm               (start the server for this folder ahead of use)

import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Decoder, encode, type Message } from "./framing.ts";
import { HUB_DIR, LOG, SOCKET, debug, isMain } from "./paths.ts";

const PULL_DEBOUNCE_MS = 150;

type Conn = Socket & { onMsg?: (m: Message) => void; onClose?: () => void };

function connect(): Promise<Conn> {
  return new Promise((done, fail) => {
    const decoder = new Decoder();
    const sock = createConnection(SOCKET) as Conn;
    sock.once("error", fail);
    sock.once("connect", () => {
      sock.off("error", fail);
      sock.on("data", (chunk: Buffer) => {
        for (const m of decoder.push(chunk)) sock.onMsg?.(m);
      });
      sock.on("error", () => sock.onClose?.());
      sock.on("close", () => sock.onClose?.());
      done(sock);
    });
  });
}

function startDaemon() {
  mkdirSync(HUB_DIR, { recursive: true });
  const out = openSync(LOG, "a");
  // The same runtime and flags this shim runs under: Node, or Bun if started with Bun.
  const child = spawn(process.execPath, [...process.execArgv, join(import.meta.dirname, `daemon${extname(import.meta.filename)}`)], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: HUB_DIR,
  });
  child.unref();
}

async function connectOrStart() {
  try {
    return await connect();
  } catch {}
  startDaemon();
  for (let i = 0; i < 500; i++) {
    await sleep(10);
    try {
      return await connect();
    } catch {}
  }
  throw new Error(`shared-typescript-lsp: could not reach the daemon at ${SOCKET}`);
}

async function status() {
  let sock;
  try {
    sock = await connect();
  } catch {
    console.log("shared-typescript-lsp: daemon not running");
    return;
  }
  sock.onMsg = (m) => {
    console.log(JSON.stringify(m.result, null, 2));
    process.exit(0);
  };
  sock.write(encode({ jsonrpc: "2.0", id: 1, method: "hub/status" }));
}

async function serve() {
  debug("shim", "start, process age", `${Math.round(performance.now())}ms`);
  const sock = await connectOrStart();
  debug("shim", "connected", `${Math.round(performance.now())}ms`);
  const toDaemon = (m: unknown) => sock.write(encode(m));
  const toClaude = (m: Message) => {
    if (m.method === "textDocument/publishDiagnostics") {
      const p = m.params as any;
      debug("shim", "-> claude publishDiagnostics", p.uri, "v", p.version, "items", p.diagnostics?.length);
    } else debug("shim", "-> claude", m.method ?? "response", "id", m.id);
    process.stdout.write(encode(m));
  };

  toDaemon({ jsonrpc: "2.0", method: "hub/hello", params: { cwd: process.cwd() } });

  const open = new Map<string, number>(); // uri -> session's version
  let pullSeq = 0;
  const pulls = new Map<string, { uri: string; retried: boolean; at: number }>();
  let pullTimer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Set<string>();

  function pull(uri: string, retried = false) {
    const id = `hub-pull-${++pullSeq}`;
    pulls.set(id, { uri, retried, at: Date.now() });
    debug("shim", "pull", id, uri);
    toDaemon({ jsonrpc: "2.0", id, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
  }

  // Pull the changed file at once: Claude Code only waits briefly after an
  // edit. Then, a little later, every other open file, since an edit in one
  // file can break another that imports it.
  function schedulePull(uri: string) {
    pull(uri);
    dirty.add(uri);
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      const done = new Set(dirty);
      dirty.clear();
      for (const u of open.keys()) if (!done.has(u)) pull(u);
    }, PULL_DEBOUNCE_MS);
  }

  sock.onMsg = (m) => {
    if (typeof m.id === "string" && m.id.startsWith("hub-pull-") && !m.method) {
      const p = pulls.get(m.id);
      pulls.delete(m.id);
      const r = m.result as any;
      debug("shim", "pull result", m.id, p?.uri, `${p ? Date.now() - p.at : "?"}ms`, m.error ? { error: m.error } : { kind: r?.kind, items: r?.items?.length });
      if (!p || !open.has(p.uri)) return;
      if (m.error) {
        // ContentModified / ServerCancelled: the file moved on, try once more.
        // Method not found (-32601): a pre-7 server that pushes on its own.
        if (!p.retried && (m.error as any).code !== -32601) setTimeout(() => open.has(p.uri) && pull(p.uri, true), 300);
        return;
      }
      if (r?.kind === "unchanged") return;
      toClaude({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: p.uri, version: open.get(p.uri), diagnostics: r?.items ?? [] },
      });
      return;
    }
    toClaude(m);
  };
  sock.onClose = () => {
    debug("shim", "daemon socket closed");
    process.exit(1);
  };

  const decoder = new Decoder();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const m of decoder.push(chunk)) {
      const td = (m.params as any)?.textDocument;
      debug("shim", "<- claude", m.method ?? "response", "id", m.id, td?.uri ?? "", td?.version ?? "",
        m.method === "textDocument/didChange" ? { changes: (m.params as any).contentChanges?.length, full: !(m.params as any).contentChanges?.[0]?.range } : "");
      switch (m.method) {
        case "textDocument/didOpen":
          open.set(td.uri, td.version);
          toDaemon(m);
          schedulePull(td.uri);
          continue;
        case "textDocument/didChange":
          open.set(td.uri, td.version);
          toDaemon(m);
          schedulePull(td.uri);
          continue;
        case "textDocument/didSave":
          toDaemon(m);
          if (open.has(td.uri)) schedulePull(td.uri);
          continue;
        case "textDocument/didClose":
          open.delete(td.uri);
          toDaemon(m);
          continue;
        case "exit":
          toDaemon(m);
          setTimeout(() => process.exit(0), 50);
          continue;
      }
      toDaemon(m);
    }
  });
  process.stdin.on("end", () => {
    debug("shim", "stdin closed");
    sock.end();
    process.exit(0);
  });
}

/**
 * Start the daemon and the server for this folder ahead of the first edit,
 * then leave. Claude Code starts its language server only when a session first
 * edits a file, and reads diagnostics as soon as the Edit returns, so a cold
 * start misses that edit's type errors. Run from a SessionStart hook.
 */
async function warm() {
  const sock = await connectOrStart();
  const root = `file://${process.cwd()}`;
  sock.onMsg = (m) => {
    if (m.id === "warm") {
      debug("shim", "warm done", `${Math.round(performance.now())}ms`);
      sock.end();
      process.exit(0);
    }
  };
  sock.write(encode({ jsonrpc: "2.0", method: "hub/hello", params: { cwd: process.cwd() } }));
  sock.write(encode({ jsonrpc: "2.0", id: "warm", method: "initialize", params: { processId: null, rootUri: root, capabilities: {} } }));
  setTimeout(() => process.exit(0), 30_000);
}

if (isMain(import.meta.url)) {
  if (process.argv[2] === "status") await status();
  else if (process.argv[2] === "warm") await warm();
  else await serve();
}

