/**
 * One connection to the user's Chrome per server lifetime.
 *
 * Chrome's remote-debugging toggle asks the user to click Allow on every
 * new WebSocket connection, so Squire holds one (through the relay in
 * cdp-proxy.ts) and every session shares it. When the last session ends,
 * the connection is kept for a while (APPIUM_MCP_CDP_IDLE_MS, default
 * 10 minutes) so the next task needs no new Allow, then closed so Chrome
 * drops its "controlled by automated software" state.
 */
import type { Browser } from 'playwright';
import { openCdpRelay, type CdpRelay } from './cdp-proxy.js';

type Connect = (endpoint: string) => Promise<Browser>;

let shared: { endpoint: string; browser: Browser } | undefined;
let pending: { endpoint: string; promise: Promise<Browser> } | undefined;
let relay: CdpRelay | undefined;
let relayPending: Promise<CdpRelay> | undefined;
let users = 0;
let idleTimer: NodeJS.Timeout | undefined;

/** The relay to the user's Chrome, opening it (one Allow prompt) if needed. */
export async function getRelay(
  upstreamUrl: string,
  timeoutMs: number,
  onWaiting?: () => void
): Promise<{ relay: CdpRelay; fresh: boolean }> {
  if (relay?.isOpen()) return { relay, fresh: false };
  if (!relayPending) {
    relayPending = openCdpRelay(upstreamUrl, timeoutMs, onWaiting).then(
      (r) => {
        relay = r;
        r.onClose(() => {
          if (relay === r) relay = undefined;
        });
        relayPending = undefined;
        return r;
      },
      (e) => {
        relayPending = undefined;
        throw e;
      }
    );
  }
  return { relay: await relayPending, fresh: true };
}

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
        if (shared?.browser === b) {
          shared = undefined;
          users = 0;
        }
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

function idleMs(): number {
  if (process.env.APPIUM_MCP_CDP_KEEP_CONNECTION === '0') return 0;
  const v = parseInt(process.env.APPIUM_MCP_CDP_IDLE_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000;
}

/** A session started using the shared connection. */
export function acquireUserBrowser(): void {
  users++;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

/** A session stopped using it; close it once nobody has for a while. */
export function releaseUserBrowser(): void {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  clearTimeout(idleTimer);
  const close = () => {
    idleTimer = undefined;
    if (users > 0) return;
    const b = shared?.browser;
    shared = undefined;
    void b?.close().catch(() => {});
    relay?.close();
    relay = undefined;
  };
  const ms = idleMs();
  if (ms === 0) {
    close();
    return;
  }
  idleTimer = setTimeout(close, ms);
  idleTimer.unref();
}

/** For tests. */
export function resetUserBrowser(): void {
  shared = undefined;
  pending = undefined;
  relay = undefined;
  relayPending = undefined;
  users = 0;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}
