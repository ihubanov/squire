/**
 * Stable tab addressing + concurrent per-tab driving.
 *
 *  - getTabId is stable per page and unique across pages; resolvePage round-trips.
 *  - Two tabs can be driven CONCURRENTLY by id without clobbering each other or
 *    the active-page pointer — the primitive that lets one agent-per-tab work.
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
const { PlaywrightDriver } = await import('../playwright-adapter.js');
const { runScript } = await import('../human-driver.js');

const PAGE = `<!doctype html><html><body><input id="v" value=""></body></html>`;

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
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('stable tab ids', () => {
  test('are stable per page, unique across pages, and resolve back', async () => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const driver = new PlaywrightDriver(browser, context, pageA);
    try {
      const idA = driver.getTabId(pageA);
      const idB = driver.getTabId(pageB);
      expect(idA).not.toBe(idB);
      expect(driver.getTabId(pageA)).toBe(idA); // stable on re-ask
      expect(driver.resolvePage(idA)).toBe(pageA);
      expect(driver.resolvePage(idB)).toBe(pageB);
      expect(driver.resolvePage('tab-does-not-exist')).toBeUndefined();

      const tabs = driver.listTabs();
      expect(tabs.map((t) => t.id).sort()).toEqual([idA, idB].sort());
      expect(tabs.find((t) => t.id === idA)!.active).toBe(true); // pageA is active
      expect(tabs.find((t) => t.id === idB)!.active).toBe(false);
    } finally {
      await context.close();
    }
  }, 30_000);

  test('two tabs drive concurrently by id without cross-contamination', async () => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto(base);
    await pageB.goto(base);
    const driver = new PlaywrightDriver(browser, context, pageA);
    try {
      const idA = driver.getTabId(pageA);
      const idB = driver.getTabId(pageB);

      // Drive both tabs at the same time, each resolved by its own id — exactly
      // what two per-tab agents would do through playwright_run_script({tab}).
      const [resA, resB] = await Promise.all([
        runScript(
          driver.resolvePage(idA)!,
          [{ action: 'fill', selector: '#v', text: 'A' }],
          { stepTimeout: 4000 }
        ),
        runScript(
          driver.resolvePage(idB)!,
          [{ action: 'fill', selector: '#v', text: 'B' }],
          { stepTimeout: 4000 }
        ),
      ]);

      expect(resA.finished).toBe(true);
      expect(resB.finished).toBe(true);

      // Each tab kept its own value — no clobbering.
      expect(await pageA.inputValue('#v')).toBe('A');
      expect(await pageB.inputValue('#v')).toBe('B');

      // The active-page pointer never moved while driving a background tab.
      expect(driver.page).toBe(pageA);
    } finally {
      await context.close();
    }
  }, 30_000);
});
