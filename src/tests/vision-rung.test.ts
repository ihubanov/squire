/**
 * Vision-rung tests: the final fallback in human-driver's ladder.
 *
 *  - a DOM-missing click with a `visual` hint escalates to vision grounding
 *    and clicks the grounded coordinates (via: "vision");
 *  - a DOM-missing click with NO visual hint fails with guidance that names
 *    the `visual` escape hatch;
 *  - vision returning null (label not on screen / sidecar down) propagates
 *    the human-path error instead of pretending success.
 *
 * The sidecar itself is mocked (real-OCR coverage is the live canvas test;
 * its ping/ground protocol is smoke-tested against real tesseract in the
 * sidecar script check).
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));

// Mock ONLY the grounding client — the ladder logic under test stays real.
await jest.unstable_mockModule('../vision-grounding.js', () => ({
  groundLabelOnPage: jest.fn(async () => ({
    x: 100,
    y: 200,
    w: 120,
    h: 40,
    text: 'Sign in',
    backend: 'tesseract-mock',
  })),
  visionBackends: jest.fn(async () => ['tesseract']),
}));

const { chromium } = await import('playwright');
const { runScript } = await import('../human-driver.js');
const { groundLabelOnPage } = await import('../vision-grounding.js');

const html =
  `<!doctype html><html><body>
<div style="width:100vw;height:100vh" onclick="window.__click=(window.__click||0)+1">page</div>
<script>document.addEventListener('click', e => {
  window.__lastClick = [e.clientX, e.clientY];
});</` +
  `script>
</body></html>`;

let browser: import('playwright').Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

beforeEach(() => {
  // Call counts must not leak between tests (test 1 grounds, test 2 asserts
  // grounding never fired). Clear calls only — implementations survive.
  jest.clearAllMocks();
});

afterAll(async () => {
  await browser?.close();
});

async function freshPage(): Promise<import('playwright').Page> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.setContent(html);
  return page;
}

describe('vision rung (mocked sidecar)', () => {
  test('DOM-missing click with visual hint grounds and clicks via vision', async () => {
    const page = await freshPage();
    try {
      const res = await runScript(
        page,
        [
          {
            action: 'click',
            selector: '#not-in-dom',
            visual: 'Sign in',
          },
          { action: 'eval', script: 'window.__lastClick' },
        ],
        { stepTimeout: 700, humanize: 'auto' }
      );
      expect(res.finished).toBe(true);
      expect(res.results[0]!.status).toBe('ok');
      expect(res.results[0]!.via).toBe('vision');
      // Clicked the CENTER of the mocked region (100+120/2, 200+40/2).
      expect(await page.evaluate(() => (window as any).__lastClick)).toEqual([
        160, 220,
      ]);
      expect(groundLabelOnPage).toHaveBeenCalledWith(page, 'Sign in');
    } finally {
      await page.close();
    }
  }, 30_000);

  test('DOM-missing click without visual hint errors with guidance', async () => {
    const page = await freshPage();
    try {
      const res = await runScript(
        page,
        [{ action: 'click', selector: '#not-in-dom' }],
        { stepTimeout: 500, humanize: 'auto' }
      );
      expect(res.finished).toBe(false);
      const failed = res.results[0]!;
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/visual/);
      expect(groundLabelOnPage).not.toHaveBeenCalled();
    } finally {
      await page.close();
    }
  }, 30_000);

  test('vision miss (null region) propagates the human-path error', async () => {
    (
      groundLabelOnPage as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce(null);
    const page = await freshPage();
    try {
      const res = await runScript(
        page,
        [{ action: 'click', selector: '#not-in-dom', visual: 'Nothing' }],
        { stepTimeout: 500, humanize: 'auto' }
      );
      expect(res.finished).toBe(false);
      expect(res.results[0]!.status).toBe('failed');
      // No click happened — vision never fired.
      expect(
        await page.evaluate(() => (window as any).__lastClick)
      ).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30_000);
});
