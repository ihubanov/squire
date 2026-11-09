/**
 * Real-Chromium tests for watch mode:
 *  - a click cue installs the overlay, boxes the target and drops a ripple;
 *  - the cue disappears on its own;
 *  - nothing is drawn while the flag is off.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cueAt } from '../watch.js';

const chromium = (await import('playwright')).chromium;

const PAGE = `<!doctype html><html><body style="height:2000px">
  <button id="go" style="margin:120px 80px;padding:12px 20px">Go</button>
</body></html>`;

let server: http.Server;
let base: string;
let browser: import('playwright').Browser;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  delete process.env.APPIUM_MCP_WATCH;
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const probe = (page: import('playwright').Page) =>
  page.evaluate(() => {
    const api = (window as any).__squirePresenter;
    const root = api?.host?.shadowRoot;
    const spot = root?.querySelector('.spot');
    return {
      installed: Boolean(api),
      ambient: Boolean(root?.querySelector('.wrap.ambient')),
      boxed: Boolean(spot?.classList.contains('on') && spot.style.width),
      ripples: root?.querySelectorAll('.ripple').length ?? 0,
    };
  });

describe('watch cues', () => {
  test('a click cue highlights the target and ripples', async () => {
    process.env.APPIUM_MCP_WATCH = '1';
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/`);
      await cueAt(page, page.locator('#go'), 'click');
      const s = await probe(page);
      expect(s.installed).toBe(true);
      expect(s.ambient).toBe(true);
      expect(s.boxed).toBe(true);
      expect(s.ripples).toBe(1);

      await page.waitForFunction(
        () => {
          const root = (window as any).__squirePresenter?.host?.shadowRoot;
          return !root?.querySelector('.spot.on');
        },
        null,
        { timeout: 5000 }
      );
    } finally {
      await page.close();
    }
  });

  test('off by default', async () => {
    delete process.env.APPIUM_MCP_WATCH;
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/`);
      await cueAt(page, page.locator('#go'), 'click');
      expect((await probe(page)).installed).toBe(false);
    } finally {
      await page.close();
    }
  });
});
