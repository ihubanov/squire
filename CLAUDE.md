# CLAUDE.md

## Build, lint, format and test — GitHub Actions only

The local machine is **not** a build box. Never run `npm install`, `npm ci`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run test`, `npx tsc`, `npx prettier` or `npx eslint` here.

Push to `fork` and let the runners do it: `.github/workflows/ci.yml` on push/PR to `main`, `.github/workflows/publish.yml` on a `v*` tag. Watch with `gh run watch`, read failures with `gh run view <id> --log-failed`, then fix and push again. Full procedure: `plugin/skills/ci/SKILL.md`; release flow: `plugin/skills/release/SKILL.md`.

## SAGE — Persistent Memory

You have persistent institutional memory via SAGE MCP.

### Boot Sequence (IMPORTANT)
1. Call `sage_inception` as your first action in every new conversation, before responding to the user
2. This loads the context stored in previous sessions, so it must run first
3. Follow the instructions returned by inception (they adapt to the user's settings)

### If SAGE MCP is not connected
Start the node: `sage-gui serve`
MCP config is in `.mcp.json` at project root. Restart your session after starting.
