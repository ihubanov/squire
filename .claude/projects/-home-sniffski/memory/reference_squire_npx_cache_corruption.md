---
name: reference-squire-npx-cache-corruption
description: "Squire plugin CONNECTION_CLOSED with ERR_MODULE_NOT_FOUND (@modelcontextprotocol/server) = half-finished npx cache, not a release bug"
metadata:
  node_type: memory
  type: reference
  originSessionId: 2cb4fa14-97fc-4b1e-ab73-5c6727709d5b
  modified: 2026-11-06T14:24:28.423Z
---

On 2026-11-06 the Squire plugin (pinned `@sniffski/squire@1.31.6`) died at startup with
`Cannot find package .../_npx/<hash>/node_modules/@modelcontextprotocol/server/index.js`
(imported by mcp-proxy). Cause: the npx cache dir had been reinstalled on 11-05 and the
install never finished. It had 347 packages instead of ~450–1278, Squire's own fastmcp was
missing, and `@modelcontextprotocol/server` had only `dist/`, no package.json.

Fix: check `pgrep -af _npx/<hash>`, `mv` the dir aside (don't rm), re-warm with
`npx -y @sniffski/squire@<v> --help`, then check `initialize` + `tools/list` (63 names).

How to tell: a fresh install of the same version on the Jetson works. Squire has
`package-lock=false`, so deps float. fastmcp 3 → mcp-proxy ^6.4.0 now resolves to 6.9.x,
which needs the MCP SDK v2 split packages (`@modelcontextprotocol/server`/`client` ^2).
A fresh install still works as of 1.31.6, but that float is where a real break would come from.
See [[reference_squire_release_cache_warm]].
