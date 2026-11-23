#!/usr/bin/env bash
#
# install-backend.sh — RETIRED installer for the legacy shared appium-mcp
# HTTP backend.
#
# The supported path is the Squire Claude Code plugin: it launches a pinned
# stdio server (@sniffski/squire@<version>) and moves that pin with the
# plugin. This script instead builds a local dist/ and installs systemd USER
# units that run it over httpStream — no version pin, no upgrade path. On a
# machine that also has the plugin it is a second, unbounded MCP server.
#
# Running with no flags therefore prints the retirement notice and exits 0,
# so claude-local's first-run `--quiet` auto-install stops creating those
# units without being treated as a failure.
#
# Options:
#   --uninstall         stop + disable + delete the three legacy user units
#                       (idempotent; safe on a machine with none installed)
#   --legacy-backend    actually install/refresh the legacy backend. The units
#                       are: appium-mcp-backend.service (node dist/index.js
#                       --httpStream :18766), appium-mcp.socket (listener on
#                       127.0.0.1:8766) and appium-mcp.service (proxy).
#                       Unsupported: no version pin.
#   --port N            backend port          (default 18766)
#   --proxy-port N      stable proxy port     (default 8766)
#   --cdp-endpoint URL  attach to a shared Chromium (herdr-share gate, the
#                       user's own browser, ...) instead of detached launches
#   --cdp-required      failed attach THROWS instead of falling back to a
#                       detached launch (loud, for shared-display boxes)
#   --with-vision       build the OCR+YOLO sidecar venv and fetch the MIT
#                       OmniParser icon-detect weights (needs python3.11)
#   --with-chromium     install Playwright's chromium for detached mode
#   --quiet             fire-and-forget: all output to --log-file, silent
#                       terminal, machine-readable exit (0=ok, 1=failed);
#                       final log line is always "RESULT: ..."
#   --log-file PATH     where --quiet logs (default
#                       $XDG_CACHE_HOME/appium-mcp/install-backend.log)
#   --force             overwrite existing unit files (drop-ins are kept)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${APPIUM_MCP_BACKEND_PORT:-18766}"
PROXY_PORT="${APPIUM_MCP_PROXY_PORT:-8766}"
UNITS_DIR="$HOME/.config/systemd/user"
FORCE=0 WITH_VISION=0 WITH_CHROMIUM=0 CDP_REQUIRED=0 QUIET=0
LEGACY=0 UNINSTALL=0
CDP_ENDPOINT=""
LOG_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/appium-mcp/install-backend.log"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) BACKEND_PORT="$2"; shift 2 ;;
    --proxy-port) PROXY_PORT="$2"; shift 2 ;;
    --cdp-endpoint) CDP_ENDPOINT="$2"; shift 2 ;;
    --cdp-required) CDP_REQUIRED=1; shift ;;
    --with-vision) WITH_VISION=1; shift ;;
    --with-chromium) WITH_CHROMIUM=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --legacy-backend) LEGACY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) grep '^# \{0,1\}' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# --quiet: fire-and-forget mode for orchestrators (claude-local's first-run
# auto-install). ALL output goes to LOG_FILE, stdout/stderr stay silent, and
# the exit code is machine-readable: 0 = installed & healthy, 1 = failed
# (last log lines explain why). A RESULT: line is always the final line.
if [ "$QUIET" = 1 ]; then
  mkdir -p "$(dirname "$LOG_FILE")"
  exec >>"$LOG_FILE" 2>&1
  echo ""
  echo "=== install-backend.sh --quiet run at $(date -Is) ==="
fi
result() { echo "RESULT: $1"; }
trap 'result "FAILED (see lines above)"; exit 1' ERR

step() { printf '\n==> %s\n' "$*"; }
die()  { echo "ERROR: $*" >&2; result "FAILED — $*"; exit 1; }

# Retire the legacy units. Idempotent: succeeds on a machine with none.
uninstall_units() {
  step "Retiring legacy appium-mcp systemd units"
  systemctl --user disable --now \
    appium-mcp.socket appium-mcp.service appium-mcp-backend.service \
    2>/dev/null || true
  # The proxy is static, so `disable` alone may not stop it.
  systemctl --user stop \
    appium-mcp.socket appium-mcp.service appium-mcp-backend.service \
    2>/dev/null || true
  rm -f "$UNITS_DIR/appium-mcp.socket" \
        "$UNITS_DIR/appium-mcp.service" \
        "$UNITS_DIR/appium-mcp-backend.service"
  rm -rf "$UNITS_DIR/appium-mcp-backend.service.d"
  rm -f "$UNITS_DIR/sockets.target.wants/appium-mcp.socket" \
        "$UNITS_DIR/default.target.wants/appium-mcp-backend.service"
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user reset-failed 2>/dev/null || true

  local lingering=0 unit state
  for unit in appium-mcp.socket appium-mcp.service appium-mcp-backend.service; do
    state="$(systemctl --user show "$unit" -p LoadState --value 2>/dev/null || true)"
    if [ -n "$state" ] && [ "$state" != "not-found" ]; then
      echo "  WARNING: $unit is still LoadState=$state"
      lingering=1
    fi
  done
  if [ "$lingering" = 0 ]; then
    result "UNINSTALLED"
    return 0
  fi
  result "FAILED — legacy units are still loaded"
  return 1
}

if [ "$UNINSTALL" = 1 ]; then
  uninstall_units || exit $?
  exit 0
fi

# The plugin is the supported path. Do not create a second, unversioned
# server unless the caller explicitly asks for the legacy backend.
if [ "$LEGACY" != 1 ]; then
  echo "RETIRED: install-backend.sh no longer provisions a backend by default."
  echo "The Squire plugin launches a pinned stdio MCP server and updates it with the plugin."
  echo "A local-build httpStream backend has no version pin and never upgrades, so it becomes"
  echo "a second, stale MCP next to the plugin's server."
  echo "  - retire an existing install: $0 --uninstall"
  echo "  - rebuild the legacy shared backend anyway (unsupported): $0 --legacy-backend"
  result "RETIRED (plugin provides the server)"
  exit 0
fi

step "Legacy backend selected (unsupported: no version pin)"

[ "$(id -u)" -ne 0 ] || die "run as your normal user — everything here is user-level"
step "Sanity checks"
systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user session (log in via a real session, not ssh -p ... bare)"
NODE_BIN="$(command -v node)" || die "node not in PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v)); recommend the LTS you already use"
echo "node $(node -v) at $NODE_BIN, repo at $REPO_ROOT"

step "Dependencies + build"
cd "$REPO_ROOT"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build
[ -f dist/index.js ] || die "build did not produce dist/index.js"

if [ "$WITH_CHROMIUM" = 1 ]; then
  step "Playwright chromium (detached mode)"
  npx playwright install chromium
fi

if [ "$WITH_VISION" = 1 ]; then
  step "Vision sidecar (OCR + YOLO icon detector)"
  command -v python3.11 >/dev/null || die "--with-vision needs python3.11 (onnxruntime has no wheels for newer pythons)"
  [ -d .venv-vision ] || python3.11 -m venv .venv-vision
  .venv-vision/bin/pip install --quiet --upgrade pip
  .venv-vision/bin/pip install --quiet onnxruntime opencv-python-headless pillow numpy pytesseract
  mkdir -p .vision-model
  if [ ! -f .vision-model/icon_detect.onnx ]; then
    curl -fL --progress-bar \
      -o .vision-model/icon_detect.onnx \
      "https://huggingface.co/onnx-community/OmniParser-icon_detect/resolve/main/icon_detect.onnx"
    curl -fL --progress-bar \
      -o .vision-model/preprocessor_config.json \
      "https://huggingface.co/onnx-community/OmniParser-icon_detect/resolve/main/preprocessor_config.json" \
      || true # cosmetic; the sidecar works without it
  fi
  command -v tesseract >/dev/null || echo "NOTE: install the tesseract binary (apt install tesseract-ocr) for OCR grounding"
fi

step "Systemd user units"
mkdir -p "$UNITS_DIR"

write_unit() { # path content
  local path="$1" content="$2"
  if [ -f "$path" ] && [ "$FORCE" != 1 ]; then
    echo "  keep existing $(basename "$path") (use --force to overwrite)"
  else
    printf '%s\n' "$content" > "$path"
    echo "  wrote $(basename "$path")"
  fi
}

NODE_ABS="$(readlink -f "$NODE_BIN")"
write_unit "$UNITS_DIR/appium-mcp-backend.service" \
"[Unit]
Description=MCP appium backend

[Service]
Type=simple
ExecStart=$NODE_ABS $REPO_ROOT/dist/index.js --httpStream --port=$BACKEND_PORT
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target"

write_unit "$UNITS_DIR/appium-mcp.socket" \
"[Unit]
Description=MCP appium socket (stable public port)

[Socket]
ListenStream=127.0.0.1:$PROXY_PORT

[Install]
WantedBy=sockets.target"

write_unit "$UNITS_DIR/appium-mcp.service" \
"[Unit]
Description=MCP appium proxy (activates backend on demand)
Requires=appium-mcp-backend.service
After=appium-mcp-backend.service

[Service]
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 150); do ss -tln 2>/dev/null | grep -q \":$BACKEND_PORT \" && exit 0; sleep 0.2; done; exit 1'
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:$BACKEND_PORT"

# Optional env drop-ins (never touch existing drop-ins — they may hold
# hand-tuned settings like the focus-guard kill switch on this box).
dropin_dir="$UNITS_DIR/appium-mcp-backend.service.d"
mkdir -p "$dropin_dir"
if [ -n "$CDP_ENDPOINT" ] || [ "$CDP_REQUIRED" = 1 ]; then
  [ -n "$CDP_ENDPOINT" ] || die "--cdp-required needs --cdp-endpoint (or an endpoint already configured in a drop-in)"
  { echo "[Service]"
    echo "Environment=APPIUM_MCP_CDP_ENDPOINT=$CDP_ENDPOINT"
    [ "$CDP_REQUIRED" = 1 ] && echo "Environment=APPIUM_MCP_CDP_REQUIRED=1"
  } > "$dropin_dir/cdp-attach.conf"
  REQ_NOTE=""
  [ "$CDP_REQUIRED" = 1 ] && REQ_NOTE=", hard-fail on attach loss"
  echo "  wrote drop-in cdp-attach.conf (endpoint=$CDP_ENDPOINT$REQ_NOTE)"
fi
if [ "$WITH_VISION" = 1 ]; then
  { echo "[Service]"
    echo "Environment=APPIUM_MCP_VISION_MODEL=$REPO_ROOT/.vision-model/icon_detect.onnx"
    echo "Environment=APPIUM_MCP_VISION_PYTHON=$REPO_ROOT/.venv-vision/bin/python"
  } > "$dropin_dir/vision.conf"
  echo "  wrote drop-in vision.conf"
fi

step "Enable + start"
systemctl --user daemon-reload
systemctl --user enable --now appium-mcp-backend.service
# The proxy service is socket-activated by appium-mcp.socket — enabling it
# directly only prints a "no installation config" warning. Start it once so
# the health check below passes even before the first socket connection.
systemctl --user start appium-mcp.service 2>/dev/null || true
systemctl --user enable --now appium-mcp.socket

step "Health check (MCP initialize handshake via proxy :$PROXY_PORT)"
HDR="$(mktemp)"; trap 'rm -f "$HDR"' EXIT
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    -D "$HDR" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -X POST "http://127.0.0.1:$PROXY_PORT/sse" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install-backend","version":"0"}}}' \
    || true)"
  if [ "$code" = "200" ] && grep -qi '^mcp-session-id:' "$HDR"; then
    echo "OK — backend answered an initialize handshake on 127.0.0.1:$PROXY_PORT/sse"
    echo
    echo "Done. Clients (claude-local plugin manifest, official global config) should point at:"
    echo "  http://127.0.0.1:$PROXY_PORT/sse"
    result "OK"
    exit 0
  fi
  sleep 1
done
die "backend did not answer the initialize handshake in 30s — check: journalctl --user -u appium-mcp-backend.service"
