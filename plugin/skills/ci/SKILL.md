---
name: ci
description: Verify a Squire change with GitHub Actions, never on the local machine. Use whenever a change needs checking, or before running npm install, npm run build, lint, format:check, test, npx tsc or npx prettier in this repo.
---

# Verify on CI — the local machine is not a build box

This repo has one build/test environment: the GitHub Actions runners. Do **not** run installs, builds, lint, format or tests locally. Not to "just check", not to pre-empt a CI failure, not to reproduce one.

## What CI is

| Workflow | Trigger | Gate |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push / PR to `main` | plugin-pin check, install, ESLint, Prettier check, build, Chromium install, tests |
| `.github/workflows/publish.yml` | push of a `v*` tag to `fork` | the same gate, then `npm publish` via Trusted Publisher (OIDC) |

Runners are ephemeral and destroyed after each job — that is the isolation, and it is the only valid place for a build.

## Forbidden locally

```sh
npm install / npm ci / sfw npm install
npm run build | npm run lint | npm run format:check | npm run test
npx tsc | npx prettier | npx eslint
```

These produce a local `dist/`, local `node_modules` churn, and a "green" opinion that is not the gate anyone else sees. `.npmrc` sets `package-lock=false`, so a local install also resolves floating versions that may differ from the runner.

## The correct loop

```sh
git push fork HEAD:main          # or open a PR
rid=$(gh run list -R ihubanov/squire --workflow CI --branch main --limit 5 \
        --json databaseId,headSha --jq ".[]|select(.headSha==\"$(git rev-parse HEAD)\")|.databaseId" | head -1)
gh run watch "$rid" -R ihubanov/squire --exit-status
```

On failure, read the runner's output — do not re-run it locally:

```sh
gh run view "$rid" -R ihubanov/squire --log-failed
```

Fix, commit, push again; the next run is the re-check.

## Exceptions

There are none in normal work. If CI is unavailable or a failure genuinely cannot be diagnosed from the logs, stop and ask the user — do not silently fall back to a local build.

Release steps that depend on this gate are in the `release` skill.
