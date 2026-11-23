#!/usr/bin/env node

import log from './logger.js';
import { runDoctor, CURRENT_VERSION } from './doctor.js';
import { refuseIfDuplicateSquireServer } from './duplicate-guard.js';
import { repairNpxCache } from './npx-cache.js';
import { reapAbandonedServers } from './stale-reaper.js';
import { installStdioGuards, isTransportError } from './transport-guard.js';

// Parse command line arguments
const args = process.argv.slice(2);
const useHttpStream = args.includes('--httpStream');
const port =
  args.find((arg) => arg.startsWith('--port='))?.split('=')[1] || '8080';

// A dead client must not be able to make us spin. See transport-guard.ts for
// the orphaned-server incident this prevents.
const onTransportError = installStdioGuards({
  useHttpStream,
  onClientGone: () => process.kill(process.pid, 'SIGTERM'),
});

// Playwright and the CDP relay throw from inside event handlers when a
// browser sends something the bundled Playwright build does not expect (e.g.
// Chrome 155 attaching a `shared_worker` target with no browserContextId —
// that killed the whole server on the first tool call after an attach).
// Those throws are not fatal to our state: the target is simply skipped.
// Log and keep serving instead of letting the process die and take every
// session's transport with it.
//
// The one exception is a transport error: logging it would write to the same
// dead stream that raised it, so hand it to the stdio guard instead. The
// `reportingFatal` latch stops a synchronous throw inside `log.error` from
// re-entering this handler.
let reportingFatal = false;
function reportFatal(message: string, detail: unknown): void {
  if (isTransportError(detail)) {
    onTransportError(detail);
    return;
  }
  if (reportingFatal) {
    return;
  }
  reportingFatal = true;
  try {
    log.error(message, detail);
  } finally {
    reportingFatal = false;
  }
}
process.on('uncaughtException', (err) => {
  reportFatal('Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  reportFatal('Unhandled rejection (server kept alive):', reason);
});

async function startServer(): Promise<void> {
  // Load the server and its heavy dependencies only when actually serving;
  // `squire doctor` and `--version` must stay fast and quiet.
  const { default: server } = await import('./server.js');

  log.info(`Starting Squire ${CURRENT_VERSION} MCP Server...`);

  try {
    if (useHttpStream) {
      server.start({
        transportType: 'httpStream',
        httpStream: {
          endpoint: '/sse',
          port: parseInt(port, 10),
        },
      });

      log.info(
        `Server started with httpStream transport on http://localhost:${port}/sse`
      );
      log.info('Waiting for client connections...');
    } else {
      // The client is gone when stdin ends, closes, or errors. Exit (through
      // the SIGTERM cleanup) instead of lingering and holding browser
      // connections. Armed before start() so the first broken transport write
      // cannot race it — a lost race is how the orphaned server survived.
      const onClientGone = () => process.kill(process.pid, 'SIGTERM');
      process.stdin.on('end', onClientGone);
      process.stdin.on('close', onClientGone);
      process.stdin.on('error', onClientGone);

      // Start with stdio transport
      server.start({
        transportType: 'stdio',
      });

      log.info('Server started with stdio transport');
      log.info('Waiting for client connections...');
    }
  } catch (error: any) {
    log.error('Error starting server:', error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // `squire --version` proves which pinned release answers, without starting
  // a server that then waits on stdio.
  if (args.includes('--version') || args.includes('-v')) {
    console.log(CURRENT_VERSION);
    process.exit(0);
  }

  // `squire doctor` is a human CLI, not an MCP server: report and exit.
  if (args[0] === 'doctor') {
    process.exit(await runDoctor({ fix: args.includes('--fix') }));
  }

  // Self-heal the npx cache this process was launched from. A launch that
  // reached us proves this spec's install is usable, but an interrupted
  // sibling install in `_npx/` would kill its own next launch with ENOENT
  // before any code runs. Removing only structurally-broken Squire entries
  // is safe; the age guard inside skips a concurrent install.
  try {
    const repaired = repairNpxCache();
    if (repaired.length > 0) {
      log.warn(
        `Repaired ${repaired.length} corrupt npx cache install(s): ` +
          repaired.join(', ')
      );
    }
  } catch (error) {
    // Best-effort: never let cache housekeeping block the server.
    log.warn('npx cache check failed (continuing):', error);
  }

  // The plugin and a hand-written `.mcp.json` entry would otherwise load two
  // servers, with every tool twice. Keep one per client session.
  refuseIfDuplicateSquireServer();

  // A new release must not leave older servers running from dead sessions.
  // Fire-and-forget: the scan is synchronous but the graceful stop waits up
  // to ~2s, and none of that may delay or break startup. It only touches
  // provably abandoned, older-version servers (see stale-reaper.ts).
  void reapAbandonedServers().catch((error) => {
    try {
      log.warn('stale-server reaper failed (continuing):', error);
    } catch {
      // Never let housekeeping take down the server.
    }
  });

  await startServer();
}

void main();
