/**
 * A local relay between Playwright and the user's Chrome.
 *
 * Squire opens the one WebSocket to Chrome itself (Chrome's remote-debugging
 * toggle asks the user to click Allow for each one) and Playwright talks to
 * Chrome through this relay. That gives us three things Playwright alone
 * cannot:
 *  - We know when the user clicked Allow (the socket opened), so a later
 *    hang is reported as what it is, not as an unanswered prompt.
 *  - A tab that never answers (seen with two Chrome profiles open, and with
 *    tabs Chrome has frozen) cannot hang Playwright's connect, which waits
 *    for every tab: after a grace period the relay answers its pending
 *    commands with an error, and Playwright skips that tab.
 *  - Playwright can reconnect through the relay without a new Allow prompt.
 *    When it disconnects, the relay detaches the tab sessions it left behind.
 *
 * APPIUM_MCP_CDP_TRACE=<file> logs CDP method names (never params) for
 * debugging.
 */
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

/** How long a tab session may leave a command unanswered while it is new. */
const STUCK_MS = 8_000;
/** A tab session counts as new for this long after it attaches. */
const INIT_WINDOW_MS = 30_000;

interface Pending {
  sessionId?: string;
  method: string;
  timer?: NodeJS.Timeout;
}

export interface CdpRelay {
  /** ws:// URL Playwright should connect to. */
  readonly url: string;
  /** Whether the upstream connection to Chrome is still open. */
  isOpen(): boolean;
  /** Tabs that stopped answering during setup and were skipped. */
  readonly stuckTargets: Set<string>;
  close(): void;
  onClose(cb: () => void): void;
}

function trace(line: string): void {
  const file = process.env.APPIUM_MCP_CDP_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* tracing is best-effort */
  }
}

/**
 * Open the upstream socket to Chrome and start the relay. Resolves once
 * Chrome accepted the connection (the user clicked Allow); rejects on a
 * refused connection or after `timeoutMs`. `onWaiting` fires if Chrome has
 * not answered after a few seconds, which usually means its Allow prompt is up.
 */
export async function openCdpRelay(
  upstreamUrl: string,
  timeoutMs: number,
  onWaiting?: () => void,
  stuckMs = STUCK_MS
): Promise<CdpRelay> {
  const upstream = new WebSocket(upstreamUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    const waiting = setTimeout(() => onWaiting?.(), 3000);
    const timer = setTimeout(() => {
      upstream.terminate();
      reject(new Error(`Timeout ${timeoutMs}ms waiting for Chrome to accept the connection`));
    }, timeoutMs);
    upstream.once('open', () => {
      clearTimeout(timer);
      clearTimeout(waiting);
      resolve();
    });
    upstream.once('error', (e) => {
      clearTimeout(timer);
      clearTimeout(waiting);
      reject(e);
    });
  });
  trace(`upstream open ${upstreamUrl}`);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;

  let client: WebSocket | undefined;
  // Per downstream client: commands in flight, and tab sessions it created.
  let pending = new Map<number, Pending>();
  let sessionsBorn = new Map<string, number>();
  const stuckTargets = new Set<string>();
  const sessionTarget = new Map<string, string>();
  const closeCbs: (() => void)[] = [];
  let open = true;

  const send = (ws: WebSocket | undefined, msg: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const shutdown = () => {
    if (!open) return;
    open = false;
    trace('relay closed');
    for (const p of pending.values()) clearTimeout(p.timer);
    client?.close();
    server.close();
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    for (const cb of closeCbs) cb();
  };
  upstream.on('close', shutdown);
  upstream.on('error', shutdown);

  upstream.on('message', (data) => {
    let msg: {
      id?: number;
      method?: string;
      sessionId?: string;
      params?: { sessionId?: string; targetInfo?: { targetId?: string } };
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return; // already answered by the stuck-tab guard
      clearTimeout(p.timer);
      pending.delete(msg.id);
    } else if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
      sessionsBorn.set(msg.params.sessionId, Date.now());
      if (msg.params.targetInfo?.targetId) {
        sessionTarget.set(msg.params.sessionId, msg.params.targetInfo.targetId);
      }
    } else if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
      sessionsBorn.delete(msg.params.sessionId);
    }
    if (msg.method) trace(`<- ${msg.method}${msg.sessionId ? ' @' + msg.sessionId.slice(0, 6) : ''}`);
    client?.send(data.toString());
  });

  server.on('connection', (ws) => {
    if (client && client.readyState === WebSocket.OPEN) {
      ws.close(1013, 'Squire relay already has a client');
      return;
    }
    client = ws;
    pending = new Map();
    const born = (sessionsBorn = new Map());
    trace('client connected');
    ws.on('message', (data) => {
      let msg: { id: number; method: string; sessionId?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const entry: Pending = { sessionId: msg.sessionId, method: msg.method };
      const bornAt = msg.sessionId ? born.get(msg.sessionId) : undefined;
      if (bornAt !== undefined && Date.now() - bornAt < INIT_WINDOW_MS) {
        entry.timer = setTimeout(() => {
          if (!pending.delete(msg.id)) return;
          const target = sessionTarget.get(msg.sessionId!) ?? msg.sessionId!;
          stuckTargets.add(target);
          trace(`stuck ${msg.method} @${msg.sessionId!.slice(0, 6)} -> answered with error`);
          send(ws, {
            id: msg.id,
            sessionId: msg.sessionId,
            error: { code: -32000, message: `Squire: tab did not respond to ${msg.method}` },
          });
        }, stuckMs);
      }
      pending.set(msg.id, entry);
      trace(`-> ${msg.method}${msg.sessionId ? ' @' + msg.sessionId.slice(0, 6) : ''}`);
      upstream.send(data.toString());
    });
    ws.on('close', () => {
      if (client !== ws) return;
      client = undefined;
      for (const p of pending.values()) clearTimeout(p.timer);
      pending = new Map();
      // Detach the tab sessions this client left attached, so Chrome
      // stops treating those tabs as being debugged.
      let id = 2_000_000_000;
      for (const sessionId of born.keys()) {
        send(upstream, { id: id++, method: 'Target.detachFromTarget', params: { sessionId } });
      }
      born.clear();
      send(upstream, { id: id++, method: 'Target.setAutoAttach', params: { autoAttach: false, waitForDebuggerOnStart: false } });
      trace('client disconnected');
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/squire-relay`,
    isOpen: () => open,
    stuckTargets,
    close: shutdown,
    onClose: (cb) => closeCbs.push(cb),
  };
}
