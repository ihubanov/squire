---
name: mcp-lifecycle
description: How the Squire MCP server launches, how its npx cache breaks, how `squire doctor` reports and fixes it, and what a maintainer must do so every install runs exactly one latest server. Use when an MCP server fails to start, tools are missing or duplicated, versions disagree, or a version is being shipped.
---

# Squire MCP lifecycle: launch, heal, ship

The server is not a daemon. Each client session launches its own copy, pinned to a version:

- **Plugin**: `node ${CLAUDE_PLUGIN_ROOT}/bin/squire-mcp.mjs @sniffski/squire@<pin>`
  (from `plugin/.mcp.json`), which runs `npx -y @sniffski/squire@<pin>`.
- **Manual install**: `npx @sniffski/squire@<pin>` from the user's MCP config.

The pin lives in `plugin/.mcp.json` and always equals `package.json`'s version. Updating the plugin is what moves the pin; that is the only supported upgrade path for plugin users.

**End state, by construction:** exactly one MCP registration — the plugin's, named `squire` (`mcp__plugin_squire_squire__*`), launched at the plugin's exact pin and moved by each plugin update. Remove a stale `appium-mcp`/`squire` registration with `claude mcp list`, then `claude mcp remove <name>`. Remove the legacy systemd backend with `scripts/install-backend.sh --uninstall`. Nothing else may install a server.

## Failure class 1 — a corrupt npx cache

`npx` installs into `~/.npm/_npx/<hash>/` and then trusts that directory. If npm is interrupted mid-install, the directory can contain `node_modules/` but **no root `package.json`**. Every later launch of that spec dies with:

```
ENOENT .../_npx/<hash>/package.json
```

before any Squire code runs. npx does not validate the cache, so nothing recovers on its own. This is not a stale version and not a bad publish.

**Healing, in three layers:**

1. `plugin/bin/squire-mcp.mjs` scans `_npx/*` before launching. It removes a directory only when it holds `@sniffski/squire` (or `appium-mcp`) under `node_modules` **and** has no usable root `package.json`. Directories touched within the last 10s are left alone (a concurrent install looks the same). If npx still fails early with a `package.json`/ENOENT error and produced no stdout, the shim repairs again and retries once. If npx instead reports the pinned version itself is missing (`ETARGET`, `E404`, "No matching version"), the shim retries once as `@sniffski/squire@latest` and logs the substitution — a pin pushed before its release published still yields a working server.
2. A running server repairs sibling broken entries at startup (`src/index.ts`), so a manual-install user who launches successfully also repairs the cache for the next launch.
3. `squire doctor --fix` removes them on demand.

A healthy cache entry looks like this — root `package.json`, `package-lock.json`, and `node_modules/`:

```json
{ "dependencies": { "@sniffski/squire": "^X.Y.Z" },
  "_npx": { "packages": ["@sniffski/squire@X.Y.Z"] } }
```

If a broken entry was created less than 10 seconds ago, the age guard skips it; rerun after a moment, or delete it by hand (`npx` reinstalls it):

```sh
ls ~/.npm/_npx/          # find the entry with node_modules but no package.json
rm -rf ~/.npm/_npx/<hash>
```

## Failure class 2 — two servers, or a stale one

A client can be given Squire twice (plugin plus a hand-written `.mcp.json` entry) or keep an old process alive after an upgrade. Two servers in one session expose every tool twice and can answer from different versions.

- On Linux, a new server refuses to start when an older Squire server is already in the same process group (`SQUIRE_ALLOW_MULTIPLE_SERVERS=1` overrides). It is a no-op on macOS/Windows.
- On startup a new server also **reaps provably abandoned older-version servers** (`src/stale-reaper.ts`). It signals a server only when every one of these holds: its on-disk version is not the current one, its parent chain has no `claude` ancestor, the chain is readable and reaches init/systemd --user (reparented), it is not in the new server's process group, and its cgroup is not a systemd `.service`.
- It deliberately leaves alone: a server a live `claude` session still owns (killing it would remove that session's tools mid-task); a **same-version** orphan (the transport guard owns that shutdown, and a race here could kill a client that is still attached); and any systemd-owned `appium-mcp-*`/`squire*` unit (systemd would restart it, so it prints the exact `systemctl --user disable --now ...` command instead). An unreadable `/proc` ancestry or cgroup also means "leave it".
- `SQUIRE_NO_REAP=1` disables the startup reaper; `SQUIRE_ALLOW_MULTIPLE_SERVERS=1` disables both the duplicate guard and the reaper.
- `squire doctor` lists every live server with its version, every npx install, and every systemd-owned backend with the disable command.
- `squire doctor --fix` reaps abandoned stale servers and stops duplicate servers, keeping the oldest in each client session. It never stops a live session's server or a systemd unit; restart that client or retire the unit.

```sh
npx @sniffski/squire@<pin> doctor
npx @sniffski/squire@<pin> doctor --fix
```

Detection reads `/proc`, so server listing is Linux-only and empty elsewhere. Cache scanning and repair work on Linux, macOS and Windows.

### Retiring the legacy systemd backend

`scripts/install-backend.sh` used to install `appium-mcp-backend.service`, `appium-mcp.socket` and `appium-mcp.service` — a local `dist/index.js --httpStream` server with no version pin and no upgrade path. Next to the plugin's pinned stdio server that is a second, unversioned MCP. Installing is now opt-in (`--legacy-backend`) and unsupported; retire an existing install with:

```sh
scripts/install-backend.sh --uninstall
```

It stops/disables/deletes the three units and the drop-in, reloads systemd and verifies `LoadState=not-found`. It is idempotent and safe when nothing is installed. Never edit unit files or plugin-cache copies by hand — they are build outputs.

## Failure class 3 — a server that outlives its client

A stdio server whose client disappears must **exit**. If it does not, it burns a whole core for days and nobody notices until the machine is slow.

The signature: `PPID 1` (reparented to systemd --user), `STAT Rl`, ~99–100% CPU, no TCP sockets, `ss -lxnp` shows no listener, and `process.stdin` fds are socketpairs with no peer. Confirm with `/proc/<pid>/io`: `syscw` climbs ~3,000/s while `write_bytes` stays 0 — writes that deliver nothing. `kill -9`, not `kill`: SIGTERM reaches the same dead stream.

Why it spins: the client's end of the socketpair is closed, so the next write fails `EPIPE` (SIGPIPE is ignored, so Node emits `'error'` instead). With no `'error'` listener that becomes an `uncaughtException`, and an `uncaughtException` handler that calls `log.error` writes to the **same dead stderr** — re-entering itself forever. Real incident: PID 3926556, 1.34.16, 3.6 days at 99.6%, needed SIGKILL.

The rules that keep it fixed (`src/transport-guard.ts`, tested in `src/tests/transport-guard.test.ts`):

- `stdout`/`stderr` carry an `'error'` listener that ends the process through the normal SIGTERM shutdown. An httpStream server swallows instead — it still serves over TCP, and a dead log sink must not take it down.
- The `uncaughtException`/`unhandledRejection` keep-alive handlers stay (they exist for Playwright/CDP throws), but they hand transport errors to that guard and never log them.
- Client-gone detection covers stdin `'end'`, `'close'` and `'error'`, and is armed **before** `server.start()` — losing that race is how the orphaned server survived.

Do not "fix" this by patching a copy under `~/.claude-local/plugins/cache/`; it is a source change that ships through the release workflow like any other.

## Shipping a version (maintainer)

1. Bump `package.json` with `npm version <x.y.z>` (or edit it and run `node scripts/sync-version.mjs`). This rewrites `server.json`, `plugin/.mcp.json` (pin + shim), and bumps the plugin patch version in `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Idempotent.
2. `node scripts/verify-pins.mjs` must pass. It checks the shim launch, the exact pin, plugin/marketplace version agreement, `server.json`, and every pinned mention in README/docs/plugin/examples/scripts.
3. Tag and push **the tag only** to `fork` (see the `release` skill). `.github/workflows/publish.yml` runs sync + verify before publishing, waits for the new version to resolve on npm, then fast-forwards `main` to the tag commit — so `main` never pins an unpublished version. `.github/workflows/ci.yml` runs verify on every push/PR, refuses a pin that is not on npm, and `npm test` also runs `src/tests/release-pins.test.ts`.
4. After the release: `npm view @sniffski/squire dist-tags` shows the new `latest`; `/plugin marketplace update squire` (or autoUpdate) pulls the new plugin version and pin. Restart one session: the new server reaps abandoned older-version servers on start, and `squire doctor` shows exactly one live server at the new version. A systemd-owned `appium-mcp-*` backend is never reaped — retire it once with `scripts/install-backend.sh --uninstall`.

Never publish with a stale pin, and never tell a user to launch the package without an exact `@x.y.z` spec after the name.

### Where a launch-path fix is allowed to live

The launcher, the shim and `doctor` are **source files in this repo**. The copies under `~/.claude-local/plugins/cache/...` and `~/.claude-local/plugins/marketplaces/...` are build outputs of `/plugin update` — patching them fixes one laptop and nothing else, and the next update silently overwrites the patch. Every launcher/shim fix therefore goes: edit the repo → `verify-pins` → commit → tag → Release workflow → `/plugin update`. If a user is blocked *right now*, the honest answer is "plugin `<next>` is being cut", not a hand-edited cache file.

The launcher must spawn `npx` from a **neutral cwd** (`cwd: tmpdir()`). `npm exec` treats a requested package that matches the manifest in the cwd or any ancestor as the *local project* and runs `sh -c '<bin>'` without linking it, so launching with the client's cwd inside a Squire checkout at exactly the pinned version dies with `sh: 1: squire: not found` before any server code runs. This is the failure you see while developing Squire itself, not for normal users.

### The exactly-one rule

A user must end up with **one** Squire server: the plugin. A hand-written `mcpServers` entry with the same name (or a leftover from the pre-plugin `appium-mcp` era) gives a session two copies — duplicated tools, and answers from two different versions. Never document, and never add, a manual entry alongside the plugin; manual `npx` installs are for non-plugin clients that have no plugin at all.

**The pin reaches `main` only after `npm publish` succeeds.** A tag-first release pushes the tag alone; the Release workflow waits for `npm view @sniffski/squire@<new>` to resolve, then fast-forwards `main`. Pushing a version bump to `main` before its tag publishes advertises an unpublishable pin and disconnects every plugin user. `ci.yml` refuses a `main` pin that is not on npm, and the launcher falls back to `latest`, but neither is a substitute for the ordering.
