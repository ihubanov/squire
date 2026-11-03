/**
 * TCP port probing for the launched browser's CDP endpoint.
 *
 * A pre-existing Chrome/Chromium often already holds the conventional
 * debug port (9222). If we blindly passed that to --remote-debugging-port
 * the new browser would fail to bind it, and any later connectOverCDP to
 * that port would land in the *user's* browser instead of ours. So we
 * verify the port is actually free before using it and walk upward to the
 * next free one if not.
 */
import net from 'node:net';

/** True if we can bind `port` on `host` right now. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Return `preferred` if free, otherwise the next free port above it
 * (up to `maxTries` candidates). Falls back to an OS-assigned ephemeral
 * port if the whole range is occupied.
 */
export async function findFreePort(
  preferred: number,
  maxTries = 50,
  host = '127.0.0.1'
): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const candidate = preferred + i;
    if (candidate > 65535) {
      break;
    }
    if (await isPortFree(candidate, host)) {
      return candidate;
    }
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
