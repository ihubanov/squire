---
name: release
description: Publish a new Squire version correctly — preflight the tree, tag the version-bump commit (never a stale one), push to `fork`, watch the Release workflow to green, and verify npm/registry. Use whenever a release is cut, a tag is pushed, or a publish "came out empty".
---

# Cutting a Squire release

Everything here happens on GitHub runners — never run the build, lint, format or test steps on the local machine. Push and read CI (see the `ci` skill). The Release workflow runs the **full** `npm test` before `npm publish`, so a red suite blocks the release; do not tag until a CI run of the same tree is green. Never substitute a targeted test run — a targeted pass is how a red release once shipped.

Publishing is driven entirely by the `Release` GitHub workflow, which fires on any `v*` tag pushed to `fork`. The authoritative version lives in `package.json`; `server.json` is synced from it by the `version` hook.

npm authenticates that workflow through its **Trusted Publisher (OIDC)** setting for `@sniffski/squire` — there is no `NPM_TOKEN` secret and no 2FA prompt. **Never ask the user to `npm login` or re-auth before a release.** A local `npm whoami` returning `E401` is expected and irrelevant: the publish happens on the runner, not on this machine. The registry is only useful locally for read-back verification (`npm view`).

## Preflight (all must pass before tagging)

```sh
git status --porcelain          # must be empty
git rev-parse --abbrev-ref HEAD # must be main
git pull --ff-only
node -p "require('./package.json').version"   # the version you are about to tag
```

The last command's value and the tag name are the same thing: tag `vX.Y.Z` iff `package.json` says `X.Y.Z`.

The plugin has its own version, and it lives in **two** places that must match: `plugin/.claude-plugin/plugin.json` and the `squire` entry in `.claude-plugin/marketplace.json`. `/plugin` resolves updates from the marketplace entry alone, so a bump that only touches `plugin.json` looks published but every client keeps reporting the old version as "latest". Check them before tagging:

```sh
node -p "require('./plugin/.claude-plugin/plugin.json').version"
node -p "require('./.claude-plugin/marketplace.json').plugins.find(p=>p.name==='squire').version"
```

Both must be equal and both must have been bumped for a plugin change. `node scripts/sync-version.mjs` does all of this — the plugin pin in `plugin/.mcp.json`, both plugin versions, and `server.json` — and bumps the plugin patch when the pin moves. Run it after bumping `package.json`; it is idempotent. `claude plugin tag <path> --dry-run` performs the same version check (and refuses a mismatch) if you want the tool to confirm it.

`node scripts/verify-pins.mjs` is the gate: it fails when the plugin pin, the two plugin versions, `server.json`, the launcher wiring or the README/docs pinned launch commands drift from `package.json`. CI and the Release workflow run it; `src/tests/release-pins.test.ts` mirrors it in `npm test`. The Release workflow also runs the sync step and pushes any resulting pin commit to `main` after a successful publish, so a forgotten pin file cannot survive a release. The launch path itself (the cache-repairing shim) is documented in the `mcp-lifecycle` skill.

## Never push the bump to main before the tag publishes

The release commit moves `package.json` and the plugin pin to a version that does **not exist on npm yet**. If that commit reaches `main` first, every `/plugin update` installs a pin that cannot resolve — a dead MCP for every user. `main` must only ever advertise a version npm can resolve.

So commit locally, tag it, and push **only the tag**:

```sh
git push fork vX.Y.Z     # not `git push fork main`
```

The Release workflow publishes, waits until `npm view @sniffski/squire@X.Y.Z` resolves, then fast-forwards `main` to the tag commit and pushes it. `ci.yml` also refuses a `main` pin that is not on npm, as a backstop against a hand-pushed bump. If the workflow fails before publishing, `main` still points at the last published, working pin.

Then check the tag itself:

```sh
git tag -l vX.Y.Z
git rev-parse vX.Y.Z^{}          # committed tag; compare with HEAD
```

- **Tag absent** → create it on `HEAD`.
- **Tag exists and resolves to `HEAD`** → push it; nothing to redo.
- **Tag exists elsewhere** → check that commit: `git show vX.Y.Z:package.json | grep '"version"'`. If it does *not* say `X.Y.Z`, the tag is on the wrong commit (a stale/foreign tag); re-point it at `HEAD` with an annotated force-push. If it *does* say `X.Y.Z` but `HEAD` is ahead, release from the tag as-is rather than moving it.

The workflow's first step is `Tag must match package.json`; a red run there means the tag is on the wrong commit and **nothing** gets published. Guessing from this is the single most common release failure.

## Tag and push

```sh
git tag -a vX.Y.Z -F - <<<'<one-line summary>'
git push fork vX.Y.Z          # tag only; the workflow moves main after publish
```

A tag ruleset governs `v*`; branch/fork admins carry a bypass so a corrected re-point is allowed. Non-admins need the ruleset lifted first.

## Watch to green

```sh
rid=$(gh run list -R ihubanov/squire --workflow Release --limit 5 \
        --json databaseId,headSha --jq ".[]|select(.headSha==\"$(git rev-parse HEAD)\")|.databaseId" | head -1)
gh run watch "$rid" -R ihubanov/squire --exit-status
```

Do not report a release as done until the run is `completed/success`. Fetch unfiltered job state while it runs; `gh run list` hides in-progress runs on some filters.

## Verify the artifacts

```sh
npm view @sniffski/squire dist-tags --json          # latest must be X.Y.Z
gh release view vX.Y.Z -R ihubanov/squire --json isDraft,isPrerelease
```

The registry (MCP) entry and the GitHub release are job steps of the same run — if they are missing, the run did not succeed, whatever the dist-tag says.

Note that npm's CDN makes a fresh version 404 for several minutes after a successful publish; the workflow polls through that lag itself, so a temporary 404 is not evidence of failure.

## Failure modes and what they mean

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Tag must match package.json` fails | Tag pushed on a commit older than the bump | Delete and re-push the tag on the bump commit |
| No workflow run at all | Tag pushed to `origin` (upstream), or tag already existed so push was a no-op | Push to `fork`; verify with `gh run list` after every tag push |
| `npm publish` fails auth/`EOTP` | Trusted Publisher (OIDC) binding broken for `@sniffski/squire` — not a missing token | Owner re-binds the Trusted Publisher on npmjs; no local login is needed |
| Local `npm whoami` says `E401` | Normal; local npm is unrelated to CI publishing | Ignore it — verify with `npm view`, never by logging in |
| Tag present locally, absent on fork | `git push fork vX.Y.Z` skipped | Push it explicitly |
| `Verify release pins` fails | A released artifact still disagrees with `package.json` after sync (launcher wiring, a pinned mention, or plugin versions) | Fix the named file and re-push the tag; the `mcp-lifecycle` skill lists the ownership of each pin |
| MCP starts nowhere / tools missing after an update | A half-installed `_npx/<hash>` (node_modules, no root package.json) — npx dies with ENOENT | The plugin launcher repairs it automatically; otherwise `squire doctor --fix` |
