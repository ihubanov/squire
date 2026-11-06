/**
 * One connection per attached Chrome per server lifetime.
 *
 * Chrome's remote-debugging toggle asks the user to click Allow on every
 * new WebSocket connection, so Squire holds one (through the relay in
 * cdp-proxy.ts) per browser and every session on that browser shares it.
 * A shared backend can serve several browsers at once (one per pane), so
 * each browser, keyed by its upstream WebSocket URL, has its own relay,
 * session count and idle timer. When the last session on a browser ends,
 * its connection is kept for a while (APPIUM_MCP_CDP_IDLE_MS, default
 * 10 minutes) so the next task needs no new Allow, then closed so Chrome
 * drops its "controlled by automated software" state.
 */
import type { Browser } from 'playwright';
import { openCdpRelay, type CdpRelay } from './cdp-proxy.js';

type Connect = (endpoint: string) => Promise<Browser>;

/** Per attached browser, keyed by its upstream WebSocket URL. */
interface Pool {
  relay?: CdpRelay;
  relayPending?: Promise<CdpRelay>;
  users: number;
  idleTimer?: NodeJS.Timeout;
}

/** Playwright Browser per endpoint it was connected through (the relay URL). */
interface Shared {
  browser?: Browser;
  pending?: Promise<Browser>;
}

const pools = new Map<string, Pool>();
const browsers = new Map<string, Shared>();

function pool(key: string): Pool {
  let p = pools.get(key);
  if (!p) {
    p = { users: 0 };
    pools.set(key, p);
  }
  return p;
}

/** The relay to the Chrome at `upstreamUrl`, opening it (one Allow prompt) if needed. */
export async function getRelay(
  upstreamUrl: string,
  timeoutMs: number,
  onWaiting?: () => void
): Promise<{ relay: CdpRelay; fresh: boolean }> {
  const p = pool(upstreamUrl);
  if (p.relay?.isOpen()) {
    return { relay: p.relay, fresh: false };
  }
  if (!p.relayPending) {
    const pending = openCdpRelay(upstreamUrl, timeoutMs, onWaiting).then(
      (r) => {
        p.relay = r;
        r.onClose(() => {
          if (p.relay === r) {
            p.relay = undefined;
          }
        });
        p.relayPending = undefined;
        return r;
      },
      (e) => {
        p.relayPending = undefined;
        throw e;
      }
    );
    p.relayPending = pending;
  }
  return { relay: await p.relayPending, fresh: true };
}

export async function getUserBrowser(
  endpoint: string,
  connect: Connect
): Promise<{ browser: Browser; reused: boolean }> {
  let s = browsers.get(endpoint);
  if (s?.browser?.isConnected()) {
    return { browser: s.browser, reused: true };
  }
  if (!s) {
    s = {};
    browsers.set(endpoint, s);
  }
  const entry = s;
  if (!entry.pending) {
    const promise = connect(endpoint).then((b) => {
      entry.browser = b;
      b.on('disconnected', () => {
        if (entry.browser === b) {
          entry.browser = undefined;
          for (const p of pools.values()) {
            if (p.relay?.url === endpoint) {
              p.users = 0;
            }
          }
        }
      });
      return b;
    });
    entry.pending = promise;
    const clear = () => {
      if (entry.pending === promise) {
        entry.pending = undefined;
      }
    };
    promise.then(clear, clear);
  }
  return { browser: await entry.pending, reused: false };
}

/** A session started using the connection to the Chrome at `upstreamUrl`. */
export function acquireUserBrowser(upstreamUrl: string): void {
  const p = pool(upstreamUrl);
  p.users++;
  clearTimeout(p.idleTimer);
  p.idleTimer = undefined;
}

/** A session stopped using it; close it once nobody has for a while. */
export function releaseUserBrowser(upstreamUrl: string): void {
  const p = pools.get(upstreamUrl);
  if (!p) {
    return;
  }
  p.users = Math.max(0, p.users - 1);
  if (p.users > 0) {
    return;
  }
  clearTimeout(p.idleTimer);
  const close = () => {
    p.idleTimer = undefined;
    if (p.users > 0) {
      return;
    }
    const endpoint = p.relay?.url;
    if (endpoint) {
      const b = browsers.get(endpoint)?.browser;
      browsers.delete(endpoint);
      void b?.close().catch(() => {});
    }
    p.relay?.close();
    if (pools.get(upstreamUrl) === p) {
      pools.delete(upstreamUrl);
    }
  };
  const ms = idleMs();
  if (ms === 0) {
    close();
    return;
  }
  p.idleTimer = setTimeout(close, ms);
  p.idleTimer.unref();
}

/** Sessions currently using the Chrome at `upstreamUrl` (for tests). */
export function userCount(upstreamUrl: string): number {
  return pools.get(upstreamUrl)?.users ?? 0;
}

/** For tests. */
export function resetUserBrowser(): void {
  for (const p of pools.values()) {
    clearTimeout(p.idleTimer);
  }
  pools.clear();
  browsers.clear();
}

function idleMs(): number {
  if (process.env.APPIUM_MCP_CDP_KEEP_CONNECTION === '0') {
    return 0;
  }
  const v = parseInt(process.env.APPIUM_MCP_CDP_IDLE_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000;
}
