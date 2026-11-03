import { FastMCP } from 'fastmcp';
import registerTools from './tools/index.js';
import registerResources from './resources/index.js';
import {
  listSessions,
  safeDeleteAllSessions,
  reapIdleSessions,
  safeDeleteSessionsForConnection,
} from './session-store.js';
import { runWithConnection } from './connection-context.js';
import log from './logger.js';

const server = new FastMCP({
  name: 'MCP Appium',
  version: '1.0.0',
  instructions:
    'Intelligent MCP server providing AI assistants with powerful tools and resources for Appium mobile automation and Playwright web browser automation',
});

// Run every tool's execute() inside its MCP connection's async context so
// session-store / select-device can partition their state per client. Without
// this, a single shared httpStream backend lets one client's create/select
// session repoint every other client (they'd end up driving the wrong
// browser/device). `context.sessionId` is the stable mcp-session-id in stateful
// httpStream; it's undefined for stdio, which harmlessly maps to one shared
// bucket. Wrapping addTool here means no individual tool needs to change.
const originalAddTool = server.addTool.bind(server);
(server as unknown as { addTool: (config: any) => unknown }).addTool = (
  toolConfig: any
) => {
  if (toolConfig && typeof toolConfig.execute === 'function') {
    const originalExecute = toolConfig.execute;
    toolConfig.execute = (args: any, context: any) =>
      runWithConnection(context?.sessionId, () =>
        originalExecute(args, context)
      );
  }
  return originalAddTool(toolConfig);
};

registerResources(server);
registerTools(server);

// Whether to tear down browser/device sessions when a *client transport*
// disconnects. For stdio this is correct (disconnect == client gone). For
// httpStream/SSE the transport cycles the FastMCP connection between tool
// calls, so auto-cleanup here destroys live sessions mid-task (the browser
// window vanishes and the next call reports "no session"). Default: only
// clean up on disconnect for stdio. Override with
// APPIUM_MCP_CLEANUP_ON_DISCONNECT=true|false.
const isHttpStream = process.argv.includes('--httpStream');
const cleanupEnv = process.env.APPIUM_MCP_CLEANUP_ON_DISCONNECT;
const cleanupOnDisconnect =
  cleanupEnv != null
    ? !['false', '0', 'no'].includes(cleanupEnv.trim().toLowerCase())
    : !isHttpStream;

// Handle client connection and disconnection events
server.on('connect', (event) => {
  log.info('Client connected:', event.session);
});

server.on('disconnect', async (event) => {
  log.info('Client disconnected:', event.session);
  if (!cleanupOnDisconnect) {
    log.info(
      'Skipping session cleanup on disconnect (httpStream mode; sessions ' +
        'persist across transport reconnects). Set ' +
        'APPIUM_MCP_CLEANUP_ON_DISCONNECT=true to restore the old behavior.'
    );
    return;
  }
  const sessions = listSessions();
  if (sessions.length === 0) {
    log.info('No active sessions to clean up on disconnect.');
    return;
  }

  // Prefer tearing down only the sessions owned by the disconnecting client so
  // one client's disconnect never destroys another client's live session. Fall
  // back to clearing everything only if the disconnect event carries no
  // identifiable connection id.
  const connectionId = (event.session as { sessionId?: string } | undefined)
    ?.sessionId;
  try {
    if (connectionId) {
      log.info(
        `Cleaning up sessions owned by disconnected client ${connectionId}...`
      );
      const deletedCount = await safeDeleteSessionsForConnection(connectionId);
      log.info(
        `${deletedCount} session(s) for client ${connectionId} cleaned up on disconnect.`
      );
    } else {
      log.info(
        `${sessions.length} active session(s) detected on disconnect (no client id), cleaning up all...`
      );
      const deletedCount = await safeDeleteAllSessions();
      log.info(
        `${deletedCount} session(s) cleaned up successfully on disconnect.`
      );
    }
  } catch (error) {
    log.error('Error cleaning up session on disconnect:', error);
  }
});

// Clean up real sessions on process shutdown so headed browsers (and Appium
// drivers) don't leak when the service is stopped/restarted. With
// disconnect-cleanup disabled in httpStream mode, this is the only place
// sessions get torn down automatically.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info(`Received ${signal}, cleaning up active sessions before exit...`);
  try {
    const deletedCount = await safeDeleteAllSessions();
    log.info(`${deletedCount} session(s) cleaned up on shutdown.`);
  } catch (error) {
    log.error('Error cleaning up sessions on shutdown:', error);
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// ── Idle session reaper ────────────────────────────────────────────────────
// "Clean up browsers when not needed." In the shared httpStream backend a
// client that walks away leaves its browser running (transport disconnect is
// not a reliable client-gone signal, so it's ignored). The reaper closes any
// session with no tool activity for APPIUM_MCP_IDLE_REAP_MS (default 5 min;
// set 0 to disable). It runs on a timer AND on demand via SIGUSR2 — the plugin's
// session-end hook sends SIGUSR2 so idle browsers are cleaned the moment a
// Claude session ends, without waiting for the next tick. A session another
// client is still driving keeps a fresh activity clock and is never reaped.
function idleReapMs(): number {
  const raw = process.env.APPIUM_MCP_IDLE_REAP_MS;
  if (raw == null || raw.trim() === '') {
    return 5 * 60 * 1000;
  }
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
}

async function reapNow(trigger: string): Promise<void> {
  const idleMs = idleReapMs();
  if (idleMs === 0) {
    return;
  } // disabled
  try {
    const { reaped, ids } = await reapIdleSessions(idleMs);
    if (reaped > 0) {
      log.info(
        `Idle reaper (${trigger}) closed ${reaped} session(s): ${ids.join(', ')}`
      );
    }
  } catch (error) {
    log.error(`Idle reaper (${trigger}) error:`, error);
  }
}

if (idleReapMs() > 0) {
  // Sweep on a timer as the autonomous backstop. Interval is a quarter of the
  // idle window, clamped to [30s, 5m], so a stale browser is caught promptly
  // without busy-looping.
  const tick = Math.min(
    5 * 60 * 1000,
    Math.max(30 * 1000, Math.floor(idleReapMs() / 4))
  );
  const timer = setInterval(() => void reapNow('timer'), tick);
  timer.unref?.(); // never keep the process alive just for the reaper
}

// On-demand sweep: the plugin session-end hook sends SIGUSR2 to force an
// immediate cleanup of idle browsers when a Claude session ends.
process.on('SIGUSR2', () => void reapNow('SIGUSR2'));

export default server;
