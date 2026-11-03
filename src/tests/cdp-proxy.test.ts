/**
 * The relay between Playwright and the user's Chrome: one upstream socket,
 * a tab that never answers cannot hang setup, and a reconnecting client
 * needs no new upstream connection.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { openCdpRelay, type CdpRelay } from '../cdp-proxy.js';

let chrome: WebSocketServer;
let chromeUrl: string;
let upstreamConnections: number;
let received: { method: string; sessionId?: string }[];
let relay: CdpRelay | undefined;

beforeEach(async () => {
  upstreamConnections = 0;
  received = [];
  chrome = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => chrome.once('listening', () => r()));
  chromeUrl = `ws://127.0.0.1:${(chrome.address() as AddressInfo).port}/devtools/browser/x`;
  chrome.on('connection', (ws) => {
    upstreamConnections++;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      received.push({ method: m.method, sessionId: m.sessionId });
      if (m.method === 'Target.setAutoAttach' && m.params?.autoAttach) {
        ws.send(JSON.stringify({ id: m.id, result: {} }));
        ws.send(
          JSON.stringify({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'S-frozen',
              targetInfo: { targetId: 'T1', type: 'page' },
            },
          })
        );
      } else if (m.sessionId === 'S-frozen') {
        // A frozen tab: never answers.
      } else if (m.id !== undefined) {
        ws.send(JSON.stringify({ id: m.id, result: { ok: true } }));
      }
    });
  });
});

afterEach(async () => {
  relay?.close();
  relay = undefined;
  await new Promise<void>((r) => chrome.close(() => r()));
});

function client(url: string) {
  const ws = new WebSocket(url);
  const replies = new Map<number, unknown>();
  const opened = new Promise<void>((r) => ws.once('open', () => r()));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id !== undefined) {
      replies.set(m.id, m);
    }
  });
  const call = async (msg: { id: number; [k: string]: unknown }) => {
    ws.send(JSON.stringify(msg));
    for (let i = 0; i < 100 && !replies.has(msg.id); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return replies.get(msg.id) as {
      result?: unknown;
      error?: { message: string };
    };
  };
  return { ws, opened, call };
}

describe('openCdpRelay', () => {
  test('relays commands to Chrome over one upstream socket', async () => {
    relay = await openCdpRelay(chromeUrl, 2000, undefined, 200);
    const c = client(relay.url);
    await c.opened;
    expect(
      (await c.call({ id: 1, method: 'Browser.getVersion' })).result
    ).toEqual({ ok: true });
    c.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const c2 = client(relay.url);
    await c2.opened;
    expect(
      (await c2.call({ id: 1, method: 'Browser.getVersion' })).result
    ).toEqual({ ok: true });
    c2.ws.close();
    expect(upstreamConnections).toBe(1);
  });

  test('a tab that never answers gets an error instead of hanging', async () => {
    relay = await openCdpRelay(chromeUrl, 2000, undefined, 200);
    const c = client(relay.url);
    await c.opened;
    await c.call({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true },
    } as never);
    await new Promise((r) => setTimeout(r, 50));
    const reply = await c.call({
      id: 2,
      method: 'Page.enable',
      sessionId: 'S-frozen',
    } as never);
    expect(reply.error?.message).toMatch(/did not respond to Page.enable/);
    expect([...relay.stuckTargets]).toEqual(['T1']);
    c.ws.close();
  });

  test('detaches the sessions a client leaves behind', async () => {
    relay = await openCdpRelay(chromeUrl, 2000, undefined, 200);
    const c = client(relay.url);
    await c.opened;
    await c.call({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true },
    } as never);
    await new Promise((r) => setTimeout(r, 50));
    c.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(received.map((m) => m.method)).toContain('Target.detachFromTarget');
  });

  test('a refused connection rejects', async () => {
    await expect(
      openCdpRelay('ws://127.0.0.1:1/devtools/browser/x', 2000)
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
