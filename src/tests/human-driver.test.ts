/**
 * Real-Chromium tests for the human-fallback script engine:
 *  - a hidden element (display:none) is revealed and clicked via the human
 *    fallback when the normal fast path can't touch it;
 *  - a step that navigates is absorbed, and the following step runs on the
 *    settled new page instead of crashing on a destroyed context;
 *  - stopOnError halts on the first failure and returns the remaining steps,
 *    which a resume run then completes.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));

const { chromium } = await import('playwright');
const { runScript } = await import('../human-driver.js');

const PAGE_A = `<!doctype html><html><body>
  <button id="hidden-btn" style="display:none" onclick="window.__hidden=true">hidden</button>
  <input id="name">
  <button id="go" onclick="location.href='/b'">go</button>
</body></html>`;

const PAGE_B = `<!doctype html><html><body><h1 id="done">done</h1></body></html>`;

let server: http.Server;
let base: string;
let browser: import('playwright').Browser;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/b' ? PAGE_B : PAGE_A);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('human-driver', () => {
  test('reveals and clicks a display:none element via the human fallback', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/a`);
      const res = await runScript(
        page,
        [{ action: 'click', selector: '#hidden-btn' }],
        { humanize: 'auto', stepTimeout: 1200 }
      );
      expect(res.finished).toBe(true);
      expect(res.results[0]!.status).toBe('ok');
      expect(res.results[0]!.via).toBe('human');
      expect(await page.evaluate(() => (window as any).__hidden)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  test('absorbs a navigation and runs the next step on the new page', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/a`);
      const res = await runScript(
        page,
        [
          { action: 'click', selector: '#go' },
          {
            action: 'eval',
            script:
              'document.getElementById("done") && document.getElementById("done").textContent',
          },
        ],
        { stepTimeout: 3000 }
      );
      expect(res.finished).toBe(true);
      expect(res.completed).toBe(2);
      expect(res.results[0]!.navigated).toBe(true);
      expect(res.results[1]!.value).toBe('done');
      expect(res.finalUrl).toContain('/b');
    } finally {
      await page.close();
    }
  }, 30_000);

  test('stops on error and resumes the remaining steps', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/a`);
      const first = await runScript(
        page,
        [
          { action: 'click', selector: '#does-not-exist' },
          { action: 'eval', script: '1 + 1' },
        ],
        { humanize: 'never', stopOnError: true, stepTimeout: 800 }
      );
      expect(first.finished).toBe(false);
      expect(first.results[0]!.status).toBe('failed');
      expect(first.remaining).toHaveLength(1);

      const second = await runScript(page, first.remaining!, {});
      expect(second.finished).toBe(true);
      expect(second.results[0]!.value).toBe(2);
    } finally {
      await page.close();
    }
  }, 30_000);
});
