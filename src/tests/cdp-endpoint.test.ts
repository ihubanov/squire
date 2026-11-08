/**
 * Chrome's remote-debugging toggle has no /json discovery; the attachable
 * WebSocket URL comes from DevToolsActivePort instead.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveCdpEndpoint, toBrowserWebSocketUrl } from '../cdp-endpoint.js';

let dir: string;
let other: string;
let server: http.Server;
let discoveryPort: number;
let toggle: http.Server;
let togglePort: number;
let toggleDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cdp-'));
  other = mkdtempSync(join(tmpdir(), 'cdp-'));
  writeFileSync(
    join(dir, 'DevToolsActivePort'),
    '9333\n/devtools/browser/abc-123\n'
  );
  writeFileSync(
    join(other, 'DevToolsActivePort'),
    '9444\n/devtools/browser/zzz\n'
  );
  // A Chrome launched with --remote-debugging-port answers /json/version.
  server = http.createServer((req, res) => {
    res.statusCode = req.url === '/json/version' ? 200 : 404;
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/d',
      })
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  discoveryPort = (server.address() as AddressInfo).port;
  // The remote-debugging toggle (Chrome, Brave) answers /json/version with
  // 200 and an empty body.
  toggle = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((r) => toggle.listen(0, '127.0.0.1', r));
  togglePort = (toggle.address() as AddressInfo).port;
  toggleDir = mkdtempSync(join(tmpdir(), 'cdp-'));
  writeFileSync(
    join(toggleDir, 'DevToolsActivePort'),
    `${togglePort}\n/devtools/browser/brave-1\n`
  );
});

afterAll(() => {
  server.close();
  toggle.close();
  rmSync(toggleDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe('resolveCdpEndpoint', () => {
  test('passes a ws:// endpoint through', async () => {
    const ws = 'ws://127.0.0.1:9333/devtools/browser/x';
    expect(await resolveCdpEndpoint(ws, [dir])).toBe(ws);
  });

  test('keeps an http endpoint that has /json discovery', async () => {
    const http = `http://127.0.0.1:${discoveryPort}`;
    expect(await resolveCdpEndpoint(http, [dir])).toBe(http);
  });

  test('reads the WebSocket URL from DevToolsActivePort when discovery is missing', async () => {
    expect(
      await resolveCdpEndpoint('http://localhost:9333', [other, dir])
    ).toBe('ws://localhost:9333/devtools/browser/abc-123');
  });

  test('ignores a DevToolsActivePort for a different port', async () => {
    expect(
      await resolveCdpEndpoint('http://127.0.0.1:9555', [dir, other])
    ).toBe('http://127.0.0.1:9555');
  });

  test('skips missing profile directories', async () => {
    expect(
      await resolveCdpEndpoint('http://127.0.0.1:9333', [
        join(dir, 'nope'),
        dir,
      ])
    ).toBe('ws://127.0.0.1:9333/devtools/browser/abc-123');
  });
});

describe('the remote-debugging toggle (empty /json/version)', () => {
  test('an empty 200 is not discovery: DevToolsActivePort is used', async () => {
    expect(
      await resolveCdpEndpoint(`http://127.0.0.1:${togglePort}`, [
        dir,
        toggleDir,
      ])
    ).toBe(`ws://127.0.0.1:${togglePort}/devtools/browser/brave-1`);
  });

  test('without a DevToolsActivePort it says to pass the ws:// form', async () => {
    const endpoint = await resolveCdpEndpoint(
      `http://127.0.0.1:${togglePort}`,
      [dir]
    );
    await expect(toBrowserWebSocketUrl(endpoint)).rejects.toThrow(
      /no CDP discovery[\s\S]*ws:\/\/127\.0\.0\.1:<port>\/devtools\/browser[\s\S]*DevToolsActivePort/
    );
  });
});
