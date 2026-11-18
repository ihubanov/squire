#!/usr/bin/env node

import log from './logger.js';
import { runDoctor, CURRENT_VERSION } from './doctor.js';
import { refuseIfDuplicateSquireServer } from './duplicate-guard.js';
import { repairNpxCache } from './npx-cache.js';

// Playwright and the CDP relay throw from inside event handlers when a
// browser sends something the bundled Playwright build does not expect (e.g.
// Chrome 155 attaching a `shared_worker` target with no browserContextId —
// that killed the whole server on the first tool call after an attach).
// Those throws are not fatal to our state: the target is simply skipped.
// Log and keep serving instead of letting the process die and take every
// session's transport with it.
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection (server kept alive):', reason);
});

// Parse command line arguments
const args = process.argv.slice(2);
const useHttpStream = args.includes('--httpStream');
const port =
  args.find((arg) => arg.startsWith('--port='))?.split('=')[1] || '8080';

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
      // Start with stdio transport
      server.start({
        transportType: 'stdio',
      });

      log.info('Server started with stdio transport');
      log.info('Waiting for client connections...');
      // The client is gone when stdin closes. Exit (through the SIGTERM
      // cleanup) instead of lingering and holding browser connections.
      process.stdin.on('end', () => process.kill(process.pid, 'SIGTERM'));
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

  await startServer();
}

void main();
