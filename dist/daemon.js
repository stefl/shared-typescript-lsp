// Generated from src/daemon.ts by scripts/build.ts. Edit the source, then rebuild.
// shared-typescript-lsp daemon: shared TypeScript language servers, many sessions.
//
// Sessions (shims) connect over a Unix socket and speak LSP. Each document is
// routed to the server for the nearest node_modules/typescript above it:
// `tsc --lsp` for TypeScript 7 and later, typescript-language-server pointed at
// that TypeScript for older ones. Servers are keyed by repo and TypeScript
// version: every worktree of one repo shares a server, whichever package
// manager installed it, a repo with mixed versions gets one server per version,
// and two repos never share one. Each worktree is its own workspace folder in
// the server, so each session sees only its own files.
//
// The daemon rewrites request IDs so each session only sees its own replies,
// counts opens per document so one session closing a file doesn't close it for
// another, and answers the servers' own requests (configuration, progress).

import { execFileSync, spawn,                   } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer,             } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Decoder, encode,              } from "./framing.js";
import { IDLE_MS, LOG, SOCKET, VERSION, debug, isMain, uriKey } from "./paths.js";

                                           

const log = (...a           ) => {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {}
};

// ---- which server serves a folder ------------------------------------------

                                                                                                                      

const specCache = new Map                     ();

function findTsls()                {
  for (const dir of (process.env.PATH ?? "").split(":").concat(join(homedir(), ".bun", "bin"))) {
    const p = join(dir, "typescript-language-server");
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/**
 * The repo a folder belongs to: git's common directory, which is the same for
 * every worktree of one repo. A folder outside git is its own repo.
 */
export function repoOf(dir        )         {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return realpathSync(resolve(dir, out));
  } catch {}
  return realpathSync(dir);
}

/** The server for files in `dir`: the nearest node_modules/typescript above it. */
export function specFor(dir        )              {
  const cached = specCache.get(dir);
  if (cached !== undefined) return cached;
  let spec              = null;
  const pkg = join(dir, "node_modules", "typescript", "package.json");
  if (existsSync(pkg)) {
    const tsDir = realpathSync(dirname(pkg));
    const version         = JSON.parse(readFileSync(pkg, "utf8")).version ?? "0";
    const repo = repoOf(dir);
    // The first worktree to ask supplies the binary; the others have the same version.
    if (Number(version.split(".")[0]) >= 7) {
      const tsc = join(tsDir, "bin", "tsc");
      spec = { key: `tsc ${version} ${repo}`, kind: "tsc", version, cmd: [tsc, "--lsp", "--stdio"], tsDir, repo };
    } else {
      const tsls = findTsls();
      if (tsls) spec = { key: `tsls ${version} ${repo}`, kind: "tsls", version, cmd: [tsls, "--stdio"], tsDir, repo };
    }
  } else if (dirname(dir) !== dir) {
    spec = specFor(dirname(dir));
  }
  specCache.set(dir, spec);
  return spec;
}

const uriDir = (uri        ) => {
  try {
    return dirname(fileURLToPath(uri));
  } catch {
    return null;
  }
};

// ---- sessions ----------------------------------------------------------------

class Client {
  static seq = 0;
           n = ++Client.seq;
           decoder = new Decoder();
           sock        ;
  cwd         ;
  root         ;
  initParams      ;
  home         ; // the server for the session's own folder: answers initialize and workspace requests
           servers = new Set        ();
           docServer = new Map                ();
  closed = false;
  constructor(sock        ) {
    this.sock = sock;
  }
  send(msg         ) {
    if (this.closed) return;
    if (msg.method === "textDocument/publishDiagnostics")
      debug("daemon", "session", this.n, "pushed by server", (msg.params       ).uri, (msg.params       ).diagnostics?.length);
    this.sock.write(encode(msg));
  }
}

                                                                                           

class Server {
           spec      ;
           proc              ;
           decoder = new Decoder();
           clients = new Set        ();
           pending = new Map                 ();
           docs = new Map                                                               ();
           roots = new Set        ();
          queue                   = []; // held until the server has answered initialize
  nextId = 1;
  init                  ;
  idleTimer        ;
  dead = false;

  constructor(spec      , cwd        , initParams     ) {
    this.spec = spec;
    this.proc = spawn(spec.cmd[0], spec.cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "ignore"] });
    this.proc.on("exit", (code) => this.onExit(code));
    this.proc.on("error", (e) => {
      log("server error", spec.key, String(e));
      this.onExit(null);
    });
    this.proc.stdin .on("error", () => {}); // a dead server's pipe: onExit cleans up
    this.proc.stdout .on("data", (chunk        ) => {
      for (const m of this.decoder.push(chunk)) this.onMessage(m);
    });
    log("server start", spec.key, "pid", this.proc.pid);
    const params = structuredClone(initParams ?? {});
    params.processId = null; // the server must outlive the session that started it
    params.capabilities ??= {};
    params.capabilities.textDocument ??= {};
    params.capabilities.textDocument.diagnostic ??= { dynamicRegistration: false };
    params.capabilities.workspace ??= {};
    params.capabilities.workspace.configuration = true;
    params.capabilities.workspace.workspaceFolders = true;
    // Without dynamic registration TypeScript 7 watches each project's files
    // itself, node_modules included, so a package installed in one worktree is
    // picked up there. Claude Code sends no file-change events of its own.
    params.capabilities.workspace.didChangeWatchedFiles = { dynamicRegistration: false };
    if (spec.kind === "tsls") {
      params.initializationOptions ??= {};
      params.initializationOptions.tsserver = { ...params.initializationOptions.tsserver, path: join(spec.tsDir, "lib", "tsserver.js") };
    }
    for (const f of params.workspaceFolders ?? []) this.roots.add(f.uri);
    if (!params.workspaceFolders?.length && params.rootUri) this.roots.add(params.rootUri);
    const id = this.nextId++;
    this.init = new Promise         ((resolve) => {
      this.pending.set(id, { resolve });
      this.raw({ jsonrpc: "2.0", id, method: "initialize", params });
    }).then((m) => {
      this.raw({ jsonrpc: "2.0", method: "initialized", params: {} });
      const q = this.queue ?? [];
      this.queue = null;
      for (const msg of q) this.raw(msg);
      return m;
    });
  }

          raw(msg         ) {
    if (!this.dead) this.proc.stdin .write(encode(msg));
  }
  write(msg         ) {
    if (this.queue) this.queue.push(msg);
    else this.raw(msg);
  }
  notify(method        , params         ) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  forwardRequest(client        , m         ) {
    const id = this.nextId++;
    this.pending.set(id, { client, id: m.id  });
    this.write({ ...m, id });
  }
  cancel(client        , clientId                 ) {
    for (const [sid, p] of this.pending)
      if ("client" in p && p.client === client && p.id === clientId) this.notify("$/cancelRequest", { id: sid });
  }

          onMessage(m         ) {
    if (m.method && m.id != null) return this.answerServerRequest(m);
    if (m.method) {
      if (m.method === "textDocument/publishDiagnostics") {
        // Pre-7 servers push on their own; TypeScript 7 only for tsconfig files.
        const doc = this.docs.get(uriKey((m.params       ).uri));
        for (const c of doc?.owners ?? []) c.send({ ...m, params: { ...(m.params       ), uri: doc .uri } });
      }
      return; // logs, progress, telemetry: nobody is listening
    }
    const p = this.pending.get(m.id          );
    if (!p) return;
    this.pending.delete(m.id          );
    if ("resolve" in p) p.resolve(m);
    else p.client.send({ ...m, id: p.id });
  }

          answerServerRequest(m         ) {
    let result          = null;
    if (m.method === "workspace/configuration") result = ((m.params       )?.items ?? []).map(() => ({}));
    else if (m.method === "workspace/workspaceFolders")
      result = [...this.roots].map((uri) => ({ uri, name: uri.split("/").pop() }));
    this.raw({ jsonrpc: "2.0", id: m.id, result });
  }

  addRoot(uri                    ) {
    if (!uri || this.roots.has(uri)) return;
    this.roots.add(uri);
    this.notify("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri, name: uri.split("/").pop() }], removed: [] },
    });
  }

  attach(c        ) {
    clearTimeout(this.idleTimer);
    if (this.clients.has(c)) return;
    this.clients.add(c);
    c.servers.add(this);
    this.addRoot(c.root);
  }

  detach(c        ) {
    this.clients.delete(c);
    for (const [key, doc] of this.docs) if (doc.owners.has(c)) this.release(c, key);
    for (const [sid, p] of this.pending) if ("client" in p && p.client === c) this.pending.delete(sid);
    if (this.clients.size === 0) this.idleTimer = setTimeout(() => this.stop("idle"), IDLE_MS);
  }

  open(c        , td                                                   ) {
    const key = uriKey(td.uri);
    const doc = this.docs.get(key);
    if (!doc) {
      this.docs.set(key, { uri: td.uri, version: 1, owners: new Set([c]) });
      this.notify("textDocument/didOpen", { textDocument: { ...td, version: 1 } });
    } else {
      doc.owners.add(c);
      doc.version++;
      // Already open for another session: bring the server up to this session's text.
      this.notify("textDocument/didChange", {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ text: td.text }],
      });
    }
  }

  change(params     ) {
    const doc = this.docs.get(uriKey(params.textDocument.uri));
    if (!doc) return;
    doc.version++;
    this.notify("textDocument/didChange", { ...params, textDocument: { uri: doc.uri, version: doc.version } });
  }

  release(c        , key        ) {
    const doc = this.docs.get(key);
    if (!doc) return;
    doc.owners.delete(c);
    if (doc.owners.size === 0) {
      this.docs.delete(key);
      this.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    }
  }

  stop(why        ) {
    log("server stop", this.spec.key, why);
    this.proc.kill();
  }

          onExit(code               ) {
    if (this.dead) return;
    this.dead = true;
    if (servers.get(this.spec.key) === this) servers.delete(this.spec.key);
    log("server exit", this.spec.key, "code", code);
    for (const [, p] of this.pending) {
      if ("resolve" in p) p.resolve({ jsonrpc: "2.0", error: { code: -32603, message: "server exited" } });
    }
    // Close the sessions: Claude Code restarts its shim, which starts a fresh server.
    for (const c of this.clients) c.sock.end();
    checkDaemonIdle();
  }
}

const servers = new Map                ();
const clients = new Set        ();
let daemonIdle                   ;

/** The server for `spec`, started on first use, with this session attached. */
function serverFor(c        , spec      )         {
  let s = servers.get(spec.key);
  if (!s) {
    s = new Server(spec, c.cwd ?? process.cwd(), c.initParams);
    servers.set(spec.key, s);
  }
  s.attach(c);
  return s;
}

/** The server a document belongs to, for this session. */
function routeDoc(c        , uri        )                     {
  const known = c.docServer.get(uriKey(uri));
  if (known && !known.dead) return known;
  const dir = uriDir(uri);
  const spec = dir ? specFor(dir) : null;
  return spec ? serverFor(c, spec) : c.home;
}

function checkDaemonIdle() {
  clearTimeout(daemonIdle);
  if (clients.size > 0) return;
  daemonIdle = setTimeout(() => {
    log("daemon idle exit");
    for (const s of servers.values()) s.stop("daemon exit");
    cleanup();
    process.exit(0);
  }, IDLE_MS);
}

function rssOf(pid        )         {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Math.round(Number(out || 0) / 1024);
  } catch {
    return 0;
  }
}

function status() {
  return {
    daemon: { pid: process.pid, version: VERSION, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, rssMB: rssOf(process.pid) },
    servers: [...servers.values()].map((s) => ({
      kind: s.spec.kind,
      typescript: s.spec.version,
      repo: s.spec.repo,
      typescriptDir: s.spec.tsDir,
      pid: s.proc.pid,
      rssMB: s.proc.pid ? rssOf(s.proc.pid) : 0,
      sessions: [...s.clients].map((c) => c.root ?? c.cwd),
      openDocs: [...s.docs.values()].map((d) => d.uri),
    })),
  };
}

async function onClientMessage(c        , m         ) {
  const td = (m.params       )?.textDocument;
  debug("daemon", "session", c.n, m.method ?? "response", "id", m.id, td?.uri ?? "");
  if (m.method === "hub/hello") {
    c.cwd = (m.params       ).cwd;
    return;
  }
  if (m.method === "hub/status") return c.send({ jsonrpc: "2.0", id: m.id, result: status() });

  if (m.method === "initialize") {
    const params = (m.params ?? {})       ;
    c.initParams = params;
    c.root = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? (c.cwd ? `file://${c.cwd}` : undefined);
    const spec = specFor(c.cwd ?? process.cwd());
    if (!spec)
      return c.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "shared-typescript-lsp: no TypeScript found" } });
    c.home = serverFor(c, spec);
    log("session", c.n, "attached", c.root, "home", spec.kind, spec.version);
    const init = await c.home.init;
    return c.send({ ...init, id: m.id });
  }

  if (m.method === "shutdown") return c.send({ jsonrpc: "2.0", id: m.id, result: null });
  if (m.method === "exit") return c.sock.end();
  if (m.method === "initialized") return;
  if (!c.home) {
    if (m.id != null && m.method)
      c.send({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "server not initialized" } });
    return;
  }
  if (m.method === "$/cancelRequest") {
    for (const s of c.servers) s.cancel(c, (m.params       ).id);
    return;
  }
  if (!m.method) return; // responses to server requests: the daemon already answered

  if (td?.uri) {
    const s = routeDoc(c, td.uri);
    if (!s) return;
    const key = uriKey(td.uri);
    switch (m.method) {
      case "textDocument/didOpen":
        c.docServer.set(key, s);
        return s.open(c, td);
      case "textDocument/didChange":
        return s.change(m.params);
      case "textDocument/didClose":
        c.docServer.delete(key);
        return s.release(c, key);
    }
    if (m.id != null) return s.forwardRequest(c, m);
    return s.notify(m.method, m.params); // didSave
  }
  if (m.id != null) return c.home.forwardRequest(c, m); // workspace/symbol and friends
  for (const s of c.servers) s.notify(m.method, m.params); // watched files, config changes
}

function cleanup() {
  try {
    unlinkSync(SOCKET);
  } catch {}
}

function alreadyRunning()                   {
  if (!existsSync(SOCKET)) return Promise.resolve(false);
  return new Promise((done) => {
    const s = createConnection(SOCKET);
    s.on("connect", () => {
      s.end();
      done(true);
    });
    s.on("error", () => done(false));
  });
}

export async function main() {
  mkdirSync(dirname(SOCKET), { recursive: true });
  if (await alreadyRunning()) process.exit(0);
  cleanup(); // stale socket from a daemon that died
  const server = createServer((sock) => {
    const c = new Client(sock);
    clients.add(c);
    clearTimeout(daemonIdle);
    sock.on("data", (chunk        ) => {
      for (const m of c.decoder.push(chunk)) onClientMessage(c, m).catch((e) => log("error", String(e)));
    });
    sock.on("error", (err) => log("socket error", String(err)));
    sock.on("close", () => {
      if (c.closed) return;
      c.closed = true;
      clients.delete(c);
      for (const s of c.servers) s.detach(c);
      log("session", c.n, "closed", c.root);
      checkDaemonIdle();
    });
  });
  server.on("error", (err) => {
    log("listen error", String(err));
    process.exit(1);
  });
  server.listen(SOCKET);
  log("daemon start pid", process.pid, "version", VERSION, "idle ms", IDLE_MS);
  for (const sig of ["SIGTERM", "SIGINT"]         )
    process.on(sig, () => {
      for (const s of servers.values()) s.stop(sig);
      cleanup();
      process.exit(0);
    });
  checkDaemonIdle();
}

if (isMain(import.meta.url)) main();
