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
- `squire doctor` lists every live server with its version and every npx install.
- `squire doctor --fix` stops duplicate servers, keeping the oldest in each client session; it never stops a single stale server, because that session's browser would vanish mid-task. Restart that client instead.

```sh
npx @sniffski/squire@<pin> doctor
npx @sniffski/squire@<pin> doctor --fix
```

Detection reads `/proc`, so server listing is Linux-only and empty elsewhere. Cache scanning and repair work on Linux, macOS and Windows.

## Shipping a version (maintainer)

1. Bump `package.json` with `npm version <x.y.z>` (or edit it and run `node scripts/sync-version.mjs`). This rewrites `server.json`, `plugin/.mcp.json` (pin + shim), and bumps the plugin patch version in `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Idempotent.
2. `node scripts/verify-pins.mjs` must pass. It checks the shim launch, the exact pin, plugin/marketplace version agreement, `server.json`, and every pinned mention in README/docs/plugin/examples/scripts.
3. Tag and push **the tag only** to `fork` (see the `release` skill). `.github/workflows/publish.yml` runs sync + verify before publishing, waits for the new version to resolve on npm, then fast-forwards `main` to the tag commit — so `main` never pins an unpublished version. `.github/workflows/ci.yml` runs verify on every push/PR, refuses a pin that is not on npm, and `npm test` also runs `src/tests/release-pins.test.ts`.
4. After the release: `npm view @sniffski/squire dist-tags` shows the new `latest`; `/plugin marketplace update squire` (or autoUpdate) pulls the new plugin version and pin; restart the session; `squire doctor` shows only the new version.

Never publish with a stale pin, and never tell a user to launch the package without an exact `@x.y.z` spec after the name.

### Where a launch-path fix is allowed to live

The launcher, the shim and `doctor` are **source files in this repo**. The copies under `~/.claude-local/plugins/cache/...` and `~/.claude-local/plugins/marketplaces/...` are build outputs of `/plugin update` — patching them fixes one laptop and nothing else, and the next update silently overwrites the patch. Every launcher/shim fix therefore goes: edit the repo → `verify-pins` → commit → tag → Release workflow → `/plugin update`. If a user is blocked *right now*, the honest answer is "plugin `<next>` is being cut", not a hand-edited cache file.

The launcher must spawn `npx` from a **neutral cwd** (`cwd: tmpdir()`). `npm exec` treats a requested package that matches the manifest in the cwd or any ancestor as the *local project* and runs `sh -c '<bin>'` without linking it, so launching with the client's cwd inside a Squire checkout at exactly the pinned version dies with `sh: 1: squire: not found` before any server code runs. This is the failure you see while developing Squire itself, not for normal users.

### The exactly-one rule

A user must end up with **one** Squire server: the plugin. A hand-written `mcpServers` entry with the same name (or a leftover from the pre-plugin `appium-mcp` era) gives a session two copies — duplicated tools, and answers from two different versions. Never document, and never add, a manual entry alongside the plugin; manual `npx` installs are for non-plugin clients that have no plugin at all.

**The pin reaches `main` only after `npm publish` succeeds.** A tag-first release pushes the tag alone; the Release workflow waits for `npm view @sniffski/squire@<new>` to resolve, then fast-forwards `main`. Pushing a version bump to `main` before its tag publishes advertises an unpublishable pin and disconnects every plugin user. `ci.yml` refuses a `main` pin that is not on npm, and the launcher falls back to `latest`, but neither is a substitute for the ordering.
