import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin's version. Each version runs its own daemon, so an update never
 * swaps the code under sessions already attached to the old one. */
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return "dev";
  }
})();

export const HUB_DIR = process.env.SHARED_TS_LSP_DIR ?? join(homedir(), ".cache", "shared-typescript-lsp");
export const SOCKET = join(HUB_DIR, `daemon-${VERSION}.sock`);
export const LOG = join(HUB_DIR, "daemon.log");

/** Close a server, and then the daemon, after this long with no sessions. */
export const IDLE_MS = Number(process.env.SHARED_TS_LSP_IDLE_MS ?? 10 * 60 * 1000);

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
