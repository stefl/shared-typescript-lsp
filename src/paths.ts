import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The plugin's version. Each version runs its own daemon, so an update never
 * swaps the code under sessions already attached to the old one. */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(here, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return "dev";
  }
})();

export const HUB_DIR = process.env.SHARED_TS_LSP_DIR ?? join(homedir(), ".cache", "shared-typescript-lsp");
/** The daemon's socket. Unix socket paths are capped at about 104 bytes, so a
 * long folder falls back to a short name in /tmp, unique to that folder. */
export const SOCKET = (() => {
  const p = join(HUB_DIR, `daemon-${VERSION}.sock`);
  if (Buffer.byteLength(p) < 100) return p;
  return join("/tmp", `shared-ts-lsp-${createHash("sha256").update(p).digest("hex").slice(0, 16)}.sock`);
})();
export const LOG = join(HUB_DIR, "daemon.log");

/** Close a server, and then the daemon, after this long with no sessions. */
export const IDLE_MS = Number(process.env.SHARED_TS_LSP_IDLE_MS ?? 10 * 60 * 1000);

/** Restart a server whose full memory (swapped and compressed included) passes
 * this many MB. 0 turns the cap off. A big monorepo's server can start at 4 to
 * 6 GB, so the default leaves room for several worktrees above that. */
export const MAX_MB = Number(process.env.SHARED_TS_LSP_MAX_MB ?? 12 * 1024);

/** How often the daemon reads each server's memory. */
export const CHECK_MS = Number(process.env.SHARED_TS_LSP_CHECK_MS ?? 60 * 1000);

/** Case-folded key for a file URI: the server lower-cases paths on macOS. */
export const uriKey = (uri: string) => uri.toLowerCase();

/**
 * Debug log, for seeing what a live Claude Code session sends and gets.
 * On when SHARED_TS_LSP_DEBUG=1 or the file ~/.cache/shared-typescript-lsp/debug.on exists.
 * Written to ~/.cache/shared-typescript-lsp/debug.log, never to stdout (the LSP channel).
 */
import { appendFileSync, existsSync } from "node:fs";
export const DEBUG_LOG = join(HUB_DIR, "debug.log");
const debugOn = process.env.SHARED_TS_LSP_DEBUG === "1" || existsSync(join(HUB_DIR, "debug.on"));
export function debug(who: string, ...parts: unknown[]) {
  if (!debugOn) return;
  const line = parts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${who}[${process.pid}] ${line}\n`);
  } catch {}
}

/** True when this module is the script Node or Bun was started with. */
export function isMain(url: string): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
