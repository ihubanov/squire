/**
 * One CDP connection to the user's Chrome per server lifetime.
 *
 * Chrome's remote-debugging toggle asks the user to click Allow on every
 * new WebSocket connection, so reconnecting per session means a prompt per
 * session. Sessions share this connection; deleting one leaves it open.
 * A new connection is made only after the old one drops.
 */
import type { Browser } from 'playwright';

type Connect = (endpoint: string) => Promise<Browser>;

let shared: { endpoint: string; browser: Browser } | undefined;
let pending: { endpoint: string; promise: Promise<Browser> } | undefined;

export async function getUserBrowser(
  endpoint: string,
  connect: Connect
): Promise<{ browser: Browser; reused: boolean }> {
  if (shared?.endpoint === endpoint && shared.browser.isConnected()) {
    return { browser: shared.browser, reused: true };
  }
  if (pending?.endpoint !== endpoint) {
    const promise = connect(endpoint).then((b) => {
      shared = { endpoint, browser: b };
      b.on('disconnected', () => {
        if (shared?.browser === b) shared = undefined;
      });
      return b;
    });
    pending = { endpoint, promise };
    promise.then(
      () => { if (pending?.promise === promise) pending = undefined; },
      () => { if (pending?.promise === promise) pending = undefined; }
    );
  }
  return { browser: await pending.promise, reused: false };
}

/** Whether delete_session should keep the shared connection (default yes). */
export function keepUserBrowserConnection(): boolean {
  return process.env.APPIUM_MCP_CDP_KEEP_CONNECTION !== '0';
}

/** For tests. */
export function resetUserBrowser(): void {
  shared = undefined;
  pending = undefined;
}
