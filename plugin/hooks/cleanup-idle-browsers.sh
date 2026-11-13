#!/usr/bin/env bash
#
# Clean up after Squire when a Claude session ends.
#
# Browsers Squire launches carry SQUIRE_OWNED_BROWSER=1 and the pid of the
# server that started them (SQUIRE_OWNER_PID). That marker survives the
# server, which is what makes an out-of-process hook able to find leftovers
# regardless of how Squire was installed (`npx @sniffski/squire` has a
# different argv from the systemd backend).
#
# Two steps, both safe for other sessions:
#   1. Signal live Squire servers with SIGUSR2: reap sessions idle for
#      APPIUM_MCP_IDLE_REAP_MS. It is only the idle reaper — an active browser
#      another Claude instance is driving keeps a fresh activity clock. A
#      private stdio server closes all its sessions on its own when the client
#      closes its stdin; the hook does not try to pick which stdio server
#      belongs to this session (it cannot prove that, and closing the wrong
#      one would kill another session's browser).
#   2. Browsers whose owning server is gone (crashed, SIGKILLed) are killed
#      here. A browser with a live owner is left alone.
#
# Always exits 0 so a missing/renamed server never blocks session exit.
# SessionEnd hooks share a ~1.5s budget; everything below is /proc reads and
# one short grace sleep.

cat >/dev/null 2>&1 || true

squire_server() {
  case "$1" in
    *@sniffski/squire/dist/index.js* | *appium-mcp/dist/index.js*) return 0 ;;
  esac
  return 1
}

# 1. Signal live servers: the idle reaper is server-defined and never kills an
# active session. Covers the shared httpStream backend and stdio children.
# One grep finds candidates; tr runs only on those, keeping the scan fast.
for cmdline_file in $(grep -al 'dist/index.js' /proc/[0-9]*/cmdline 2>/dev/null); do
  cmd=$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null) || continue
  squire_server "$cmd" || continue
  pid=${cmdline_file#/proc/}
  pid=${pid%/cmdline}
  kill -USR2 "$pid" 2>/dev/null || true
done

# 2. Orphan sweep: browsers carrying Squire's marker whose owner pid is gone.
# /proc/<pid>/environ is readable only for our own processes, so failures are
# expected and skipped.
killed=""
for env_file in $(grep -al 'SQUIRE_OWNED_BROWSER=1' /proc/[0-9]*/environ 2>/dev/null); do
  pid=${env_file#/proc/}
  pid=${pid%/environ}
  [ "$pid" = "$$" ] && continue
  env=$(tr '\0' '\n' <"$env_file" 2>/dev/null) || continue
  owner=$(printf '%s\n' "$env" | sed -n 's/^SQUIRE_OWNER_PID=//p' | head -n1)
  if [ -n "$owner" ] && [ -d "/proc/$owner" ]; then
    continue
  fi
  kill -TERM "$pid" 2>/dev/null || true
  killed="$killed $pid"
done

if [ -n "$killed" ]; then
  sleep 0.3
  for pid in $killed; do
    kill -KILL "$pid" 2>/dev/null || true
  done
fi

exit 0
