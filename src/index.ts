#!/usr/bin/env node

import server from './server.js';
import log from './logger.js';

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
  log.info('Starting MCP Appium MCP Server...');

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

// Start the server
startServer();
