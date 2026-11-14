# shared-typescript-lsp

A plugin for [Claude Code](https://claude.com/claude-code), Anthropic's coding agent, that runs one shared TypeScript language server for all your sessions. It also passes type errors back to Claude after each edit on TypeScript 7, whose built-in server doesn't send them on its own.

A language server is the background process that works out type errors, definitions and references for an editor. Claude Code starts one for each session so the agent can see the same errors you would.

## The problem

I run a lot of Claude Code sessions at once, each in its own git worktree (a second checkout of the same repo, on another branch). Claude Code starts a separate TypeScript language server for every session. In blackhole, a mid-size TypeScript monorepo of mine (one repository holding many packages), each one grows to about 590 MB once a couple of packages are loaded. At that size, five sessions in five worktrees would come to about three gigabytes of servers, holding mostly the same type information. The measured saving is under "Memory" below.

TypeScript 7 adds a second problem. Its built-in server (`tsc --lsp`) only reports type errors when the client asks for them. Here the client is Claude Code, and in the versions I've used it doesn't ask: it waits for the server to send errors on its own after an edit. So with TypeScript 7 the agent edits a file, breaks the types and gets no error back.

## What it does

- **One server per TypeScript install.** Each file goes to the server for the nearest `node_modules/typescript` above it. Worktrees that install from the same package cache (one folder on disk that every checkout's packages link back to) resolve to the same install, so they share one server. Bun, the JavaScript runtime this plugin runs on, installs from a cache like that by default. A repo that mixes TypeScript versions gets the right server for each package.
- **Each session sees only its own worktree.** A small daemon (a background process that the first session starts) sits between the sessions and the server. Each session talks to the daemon through a shim, a small process of its own. The daemon keeps each session's requests and replies apart, so a session gets only its own type errors and find-references results.
- **Type errors after every edit.** After each open, change or save, the plugin asks TypeScript 7's server for errors on the session's open files and sends them to Claude Code. The edited file goes first, because Claude Code checks for errors as soon as the edit returns, and I think it stops waiting soon after.
- **Older TypeScript still works.** Files under TypeScript 6 or earlier go to [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server), the open-source language server most editors use for those versions, shared in the same way. That server sends its own errors.
- **A warm start.** As I understand it, Claude Code starts a language server on a session's first edit, and checks for errors as soon as the edit returns. A server that is still starting has no errors ready by then. The plugin adds a SessionStart hook (a command Claude Code runs each time a session opens) that starts the shared server straight away, so the first edit gets its errors too.
- **It shuts down when idle.** A server stops 10 minutes after its last session leaves, and the daemon stops 10 minutes after that.

## Requirements

- **Claude Code**, recent enough to run language servers from plugins. Anthropic's own TypeScript plugin (`typescript-lsp`) needs the same support, as I understand it. If it works for you, I'd expect this one to as well.
- **Bun**, at `~/.bun/bin/bun` or on your `PATH`. The daemon is a few hundred lines of TypeScript run by Bun, with no packages to install. Get Bun from [bun.sh](https://bun.sh).
- **macOS, and probably Linux.** I've only run it on macOS. It should work on Linux, since it needs only bash and Unix sockets (the way two processes on one machine talk to each other), but I haven't tested it there. For the same reason it won't run on Windows as it stands.
- **typescript-language-server**, only for repos on TypeScript 6 or earlier: `bun add -g typescript-language-server`. TypeScript 7 repos need nothing extra, since the plugin uses `tsc`, TypeScript's own command, from the repo's `node_modules`.

## Install

Claude Code installs plugins from a marketplace, which is a repo that lists them. This repo is its own marketplace, so there are two steps. In a Claude Code session:

```
/plugin marketplace add stefl/shared-typescript-lsp
```

```
/plugin install shared-typescript-lsp@shared-typescript-lsp
```

Or from a terminal:

```bash
claude plugin marketplace add stefl/shared-typescript-lsp
```

```bash
claude plugin install shared-typescript-lsp@shared-typescript-lsp
```

If you also have Anthropic's own TypeScript plugin turned on, turn it off, so the two don't both start a server for the same files:

```bash
claude plugin disable typescript-lsp@claude-plugins-official
```

New sessions pick the plugin up. Sessions that are already running keep their old server until you restart them.

## Check it works

Open a new session in a TypeScript repo and ask Claude to add a line that can't type-check, such as `const n: number = "x";`. Claude Code should show the type error in the same turn as the edit. Then ask it to remove the line again.

The plugin doesn't put a command on your `PATH`, so to see what the daemon is running, clone this repo and run, from the clone:

```bash
bin/shared-typescript-lsp status
```

It lists each shared server, its TypeScript version, the sessions using it, the files they have open, and how much memory each process is using. The daemon writes a log to `~/.cache/shared-typescript-lsp/daemon.log`.

## Turn it off

- **For one session:** start Claude Code with `SHARED_TS_LSP_OFF=1 claude`. That session runs the repo's TypeScript server by itself, as Claude Code would without the plugin, and on TypeScript 7 you lose the type errors after each edit.
- **Everywhere:** `claude plugin disable shared-typescript-lsp@shared-typescript-lsp`, then restart your sessions. The daemon stops on its own 10 minutes after the last one leaves, or straight away, from a clone of this repo, with `bin/shared-typescript-lsp stop`.

## Memory

I measured this in blackhole, the same monorepo, on TypeScript 7.0.2, using the resident memory that `ps` reports (the RAM each process actually holds).

| Setup | Memory |
| --- | --- |
| Without the plugin: one server per session, two packages loaded | about 590 MB per session |
| One server, one worktree, one file open | 205 MB |
| The same server with a second worktree's copy of that file open | 257 MB |
| Two live Claude Code sessions in two worktrees | 399 MB server, 21 MB daemon, 20 MB for each session's shim |

The first row isn't like for like: it had two packages loaded, where rows two and three had one file. The fair comparison is rows two and three. Two separate servers with that one file open would be about 410 MB, and one shared server holding both worktrees is 257 MB. The last row comes from two real sessions rather than a test, so what they had open differs from the rows above.

I've measured it with two sessions. I'd expect the saving to grow with each extra one, because the types for your dependencies load once.

## Limits

- **Cloud sessions.** Claude Code can also run sessions on Anthropic's servers instead of your machine. As far as I can tell it doesn't start language servers there, so the plugin does nothing.
- **One machine.** Sessions share a server only when they run on the same machine as the same user.
- **Restarts.** A session that's already running when you install or turn off the plugin keeps whatever server it started with.
- **Memory still grows with what's open.** One shared server is smaller than several separate ones, but I'd expect a big repo with many packages open to still take a gigabyte or more.

## Tests

From a clone of this repo, the unit tests cover how language server messages are split and joined as they pass between the processes:

```bash
bun test test/framing.test.ts
```

The end-to-end test runs two simulated sessions through `bin/shared-typescript-lsp`, the same command Claude Code starts, against two checkouts of a TypeScript 7 repo with packages installed. It starts its own daemon in a temporary folder, so it doesn't touch sessions you have running:

```bash
SHARED_TS_LSP_E2E_A=<first checkout> SHARED_TS_LSP_E2E_B=<second checkout> bun test test/e2e.test.ts
```

By default it opens a file and a function from blackhole, which your repo won't have. Set `SHARED_TS_LSP_E2E_FILE` (a path inside the checkout) and `SHARED_TS_LSP_E2E_SYMBOL` (the text of a declaration in that file, such as `export function myFunction`) to use your own.

## Technical detail

- **Commands.** `bin/shared-typescript-lsp` is the command Claude Code starts. It runs the shim (`src/shim.ts`), one per session. The shim talks to Claude Code over standard input and output, and to the daemon (`src/daemon.ts`) over a Unix socket at `~/.cache/shared-typescript-lsp/daemon.sock`. It starts the daemon if it isn't running. `status` and `stop` are described above. `warm` starts the shared server without opening a file, and is what the SessionStart hook runs.
- **Request IDs.** Each request carries an ID that its reply repeats. The daemon rewrites those IDs so each session gets only its own replies, and counts opens per file so one session closing a file doesn't close it for another.
- **Asking for errors, then sending them on.** TypeScript 7 answers `textDocument/diagnostic` requests but doesn't send `textDocument/publishDiagnostics`. The shim asks for the errors on each open file (a pull) and sends the result to Claude Code as `publishDiagnostics`.
- **Settings.** `SHARED_TS_LSP_IDLE_MS` changes the idle timeout (default 600000). `SHARED_TS_LSP_DIR` moves the socket and log folder. For a full trace of every message, both the errors the shim asks for (pull) and the ones it sends on (push), set `SHARED_TS_LSP_DEBUG=1` or create `~/.cache/shared-typescript-lsp/debug.on`; it writes `debug.log` in the same folder.
- **The plugin files.** `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` make the repo both a plugin and a one-plugin marketplace. `.lsp.json` runs the bundled command through `${CLAUDE_PLUGIN_ROOT}`, the folder Claude Code installs the plugin into, and `hooks/hooks.json` runs `warm` at session start.

## Licence

MIT. See [LICENSE](LICENSE).

## Feedback

If you try it, I'd like to hear how it goes, especially on Linux. An issue on this repo is the best place.
