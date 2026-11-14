// Generated from src/shim.ts by scripts/build.ts. Edit the source, then rebuild.
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
import { mkdirSync, openSync, readdirSync, readFileSync,             } from "node:fs";
import { createConnection,             } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Decoder, encode,              } from "./framing.js";
import { HUB_DIR, LOG, SOCKET, debug, isMain } from "./paths.js";

const PULL_DEBOUNCE_MS = 150;

                                                                            

function connect()                {
  return new Promise((done, fail) => {
    const decoder = new Decoder();
    const sock = createConnection(SOCKET)        ;
    sock.once("error", fail);
    sock.once("connect", () => {
      sock.off("error", fail);
      sock.on("data", (chunk        ) => {
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
  const child = spawn(process.execPath, [...process.execArgv, join(dirname(fileURLToPath(import.meta.url)), `daemon${extname(fileURLToPath(import.meta.url))}`)], {
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
  const toDaemon = (m         ) => sock.write(encode(m));
  const toClaude = (m         ) => {
    if (m.method === "textDocument/publishDiagnostics") {
      const p = m.params       ;
      debug("shim", "-> claude publishDiagnostics", p.uri, "v", p.version, "items", p.diagnostics?.length);
    } else debug("shim", "-> claude", m.method ?? "response", "id", m.id);
    process.stdout.write(encode(m));
  };

  toDaemon({ jsonrpc: "2.0", method: "hub/hello", params: { cwd: process.cwd() } });

  const open = new Map                (); // uri -> session's version
  let pullSeq = 0;
  const pulls = new Map                                                       ();
  let pullTimer                                           ;
  const dirty = new Set        ();

  function pull(uri        , retried = false) {
    const id = `hub-pull-${++pullSeq}`;
    pulls.set(id, { uri, retried, at: Date.now() });
    debug("shim", "pull", id, uri);
    toDaemon({ jsonrpc: "2.0", id, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
  }

  // Pull the changed file at once: Claude Code only waits briefly after an
  // edit. Then, a little later, every other open file, since an edit in one
  // file can break another that imports it.
  function schedulePull(uri        ) {
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
      const r = m.result       ;
      debug("shim", "pull result", m.id, p?.uri, `${p ? Date.now() - p.at : "?"}ms`, m.error ? { error: m.error } : { kind: r?.kind, items: r?.items?.length });
      if (!p || !open.has(p.uri)) return;
      if (m.error) {
        // ContentModified / ServerCancelled: the file moved on, try once more.
        // Method not found (-32601): a pre-7 server that pushes on its own.
        if (!p.retried && (m.error       ).code !== -32601) setTimeout(() => open.has(p.uri) && pull(p.uri, true), 300);
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
  process.stdin.on("data", (chunk        ) => {
    for (const m of decoder.push(chunk)) {
      const td = (m.params       )?.textDocument;
      debug("shim", "<- claude", m.method ?? "response", "id", m.id, td?.uri ?? "", td?.version ?? "",
        m.method === "textDocument/didChange" ? { changes: (m.params       ).contentChanges?.length, full: !(m.params       ).contentChanges?.[0]?.range } : "");
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

/** A TypeScript source file under `dir`, for warm() to open. */
function sampleFile(dir        , depth = 0)                {
  let entries          ;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries)
    if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name) && !e.name.endsWith(".d.ts")) return join(dir, e.name);
  if (depth >= 4) return null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const f = sampleFile(join(dir, e.name), depth + 1);
    if (f) return f;
  }
  return null;
}

/**
 * Start the daemon and the server for this folder ahead of the first edit,
 * and have the server load the folder's project by opening one file and asking
 * for its diagnostics. Claude Code starts its language server only when a
 * session first edits a file, and reads diagnostics about 100 ms later, so a
 * cold server or an unloaded project misses that edit's type errors. Run from
 * a SessionStart hook.
 */
async function warm() {
  const sock = await connectOrStart();
  const root = `file://${process.cwd()}`;
  const file = sampleFile(process.cwd());
  const uri = file ? `file://${file}` : null;
  const done = () => {
    debug("shim", "warm done", `${Math.round(performance.now())}ms`, uri ?? "no file");
    sock.end();
    process.exit(0);
  };
  sock.onMsg = (m) => {
    if (m.id === "warm") {
      if (!uri) return done();
      sock.write(encode({ jsonrpc: "2.0", method: "initialized", params: {} }));
      const text = readFileSync(file , "utf8");
      sock.write(encode({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text } } }));
      sock.write(encode({ jsonrpc: "2.0", id: "warm-pull", method: "textDocument/diagnostic", params: { textDocument: { uri } } }));
    } else if (m.id === "warm-pull") {
      sock.write(encode({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } }));
      setTimeout(done, 20);
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

