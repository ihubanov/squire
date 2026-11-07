/**
 * playwright_new_tab in the background (no bringToFront) in a detached
 * browser: the session's context is not Chrome's default one, so the new
 * target has to be created in it, or the tool waits 15s for a tab that
 * never shows up there.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));
await jest.unstable_mockModule('../ai-state', () => ({
  writeAiActiveTab: jest.fn(),
}));

let current: unknown = null;
await jest.unstable_mockModule('../session-store', () => ({
  getDriver: () => current,
  isPlaywrightDriverSession: () => true,
}));

const { chromium } = await import('playwright');
const { PlaywrightDriver } = await import('../playwright-adapter.js');
const { newTab } = await import('../tools/web/tabs.js');

let browser: import('playwright').Browser;
let execute: (args: Record<string, unknown>) => Promise<any>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  newTab({
    addTool: (t: any) => {
      execute = (args) => t.execute(args, undefined);
    },
  } as any);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe('playwright_new_tab in a detached browser', () => {
  test('opens a background tab in the session context without timing out', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    current = new PlaywrightDriver(browser, context, page);
    try {
      const started = Date.now();
      const res = await execute({});
      const text = res.content[0].text as string;
      expect(text).toMatch(/New tab opened at index 1 \(in background/);
      expect(context.pages()).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await context.close();
    }
  }, 30_000);
});
