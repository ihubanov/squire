/**
 * Cloudflare Turnstile solver: surface discrimination, shadow-root press,
 * token/callback ordering, retry and abort mapping. No network: the widget is
 * a local srcdoc iframe with its own shadow root.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import type { Browser, Page } from 'playwright';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));
await jest.unstable_mockModule('../ai-state', () => ({
  writeAiActiveTab: jest.fn(),
}));
await jest.unstable_mockModule('../protected-urls', () => ({
  assertNotProtected: jest.fn(),
}));
await jest.unstable_mockModule('../focus-guard', () => ({
  assertNotUserFocused: jest.fn(async () => {}),
}));

let current: unknown = null;
await jest.unstable_mockModule('../session-store', () => ({
  getDriver: () => current,
  isPlaywrightDriverSession: () => true,
}));

const { chromium } = await import('playwright');
const { PlaywrightDriver } = await import('../playwright-adapter.js');
const turnstileTool = (await import('../tools/web/captcha-turnstile.js'))
  .default;

const TOKEN = '0.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.token-value';

const FRAME = `<div id='host' style='position:relative;width:300px;height:80px'></div>
<script>
 (function () {
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  const box = document.createElement('button');
  box.setAttribute('role', 'checkbox');
  box.style.cssText = 'position:absolute;left:20px;top:20px;width:40px;height:40px';
  box.textContent = 'x';
  root.appendChild(box);
  box.addEventListener('click', () => {
    parent.document.querySelector('[name=cf-turnstile-response]').value = '${TOKEN}';
    parent.__pressed = (parent.__pressed || 0) + 1;
  });
 })();
</script>`;

/** A widget whose frame has a shadow root; callback optional. */
function widget(o: { callback?: boolean; frame?: string } = {}) {
  return `
<style>body { margin: 0 }</style>
<input type="hidden" name="cf-turnstile-response">
<div class="cf-turnstile" data-sitekey="3x00000000000000000000FF"${
    o.callback ? ' data-callback="tsCallback"' : ''
  } style="position:absolute;left:100px;top:100px;width:300px;height:80px">
  <iframe class="cf-challenge" style="width:300px;height:80px;border:0" srcdoc="${
    o.frame ?? FRAME
  }"></iframe>
</div>
<script>
 window.__cbCalls = 0;
 window.tsCallback = function (t) {
   window.__cbCalls++;
   window.__cbSawField = document.querySelector('[name=cf-turnstile-response]').value;
   document.querySelector('[name=cf-turnstile-response]').value = t;
 };
</script>`;
}

/** The callback fires with a value before the solver can see the field. */
const PRE_FIRED = `<div id='host' style='width:300px;height:80px'></div>
<script>
 (function () {
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  const box = document.createElement('button');
  box.setAttribute('role', 'checkbox');
  box.style.cssText = 'position:absolute;left:20px;top:20px;width:40px;height:40px';
  box.textContent = 'x';
  root.appendChild(box);
  box.addEventListener('click', () => {
    parent.__pressed = (parent.__pressed || 0) + 1;
    parent.tsCallback('${TOKEN}');
  });
 })();
</script>`;

/** First press does nothing; later presses produce a token. */
const LATE = `<div id='host' style='width:300px;height:80px'></div>
<script>
 (function () {
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  const box = document.createElement('button');
  box.setAttribute('role', 'checkbox');
  box.style.cssText = 'position:absolute;left:20px;top:20px;width:40px;height:40px';
  box.textContent = 'x';
  root.appendChild(box);
  box.addEventListener('click', () => {
    parent.__pressed = (parent.__pressed || 0) + 1;
    if (parent.__pressed > 1) {
      parent.document.querySelector('[name=cf-turnstile-response]').value = '${TOKEN}';
    }
  });
 })();
</script>`;

/** The widget reports the domain-mismatch code instead of a token. */
const DOMAIN = `<div id='host' style='width:300px;height:80px'></div>
<script>
 (function () {
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  const box = document.createElement('button');
  box.setAttribute('role', 'checkbox');
  box.style.cssText = 'position:absolute;left:20px;top:20px;width:40px;height:40px';
  box.textContent = 'x';
  root.appendChild(box);
  const msg = document.createElement('div');
  msg.id = 'msg';
  root.appendChild(msg);
  box.addEventListener('click', () => {
    parent.__pressed = (parent.__pressed || 0) + 1;
    msg.textContent = 'Error 110200: domain not allowed';
  });
 })();
</script>`;

let browser: Browser;
let driver: InstanceType<typeof PlaywrightDriver>;
let page: Page;
let load: (html: string) => Promise<void>;
const execs: Record<string, (a: Record<string, unknown>) => Promise<any>> = {};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
  });
  page = await context.newPage();
  let loads = 0;
  load = async (html: string) => {
    await page.goto(`about:blank?${++loads}`);
    await page.setContent(html);
  };
  driver = new PlaywrightDriver(browser, context, page);
  (current as unknown) = driver;
  turnstileTool({
    addTool: (t: any) => {
      execs[t.name] = (a) => t.execute(a, undefined);
    },
  } as any);
});

afterAll(async () => {
  await browser?.close();
});

describe('playwright_captcha_turnstile', () => {
  test('detects the widget, presses through the shadow root, and passes', async () => {
    await load(widget());
    const res = await execs.playwright_captcha_turnstile({
      tokenTtlMs: 1_000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha turnstile: solved \(1 attempt/);
    expect(text).toContain('pressing checkbox');
    expect(text).toContain('surface: widget');
    expect(await page.evaluate(() => (window as any).__pressed)).toBe(1);
    expect(
      await page.evaluate(
        () =>
          (
            document.querySelector(
              '[name=cf-turnstile-response]'
            ) as HTMLInputElement
          ).value
      )
    ).toBe(TOKEN);
    expect(text).toContain('"status":"solved"');
  }, 20_000);

  test('writes the token before invoking the callback it had to fire', async () => {
    await load(widget({ callback: true }));
    const res = await execs.playwright_captcha_turnstile({
      tokenTtlMs: 1_000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha turnstile: solved/);
    expect(text).toContain('callback invoked');
    expect(await page.evaluate(() => (window as any).__cbCalls)).toBe(1);
    // The callback read a non-empty field: the write happened first.
    expect(await page.evaluate(() => (window as any).__cbSawField)).toBe(TOKEN);
  }, 20_000);

  test('a callback that pre-fired with a value is not invoked twice', async () => {
    await load(widget({ callback: true, frame: PRE_FIRED }));
    const res = await execs.playwright_captcha_turnstile({
      tokenTtlMs: 1_000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha turnstile: solved/);
    expect(text).toContain('callback pre-fired');
    expect(await page.evaluate(() => (window as any).__cbCalls)).toBe(1);
    expect(
      await page.evaluate(
        () =>
          (
            document.querySelector(
              '[name=cf-turnstile-response]'
            ) as HTMLInputElement
          ).value
      )
    ).toBe(TOKEN);
  }, 20_000);

  test('a token timeout retries and the second press passes', async () => {
    await load(widget({ frame: LATE }));
    const res = await execs.playwright_captcha_turnstile({
      tokenTtlMs: 600,
      maxAttempts: 3,
    });
    const text = res.content[0].text as string;
    expect(text).toContain('token_absent');
    expect(text).toMatch(/^Captcha turnstile: solved \(2 attempts/);
    expect(await page.evaluate(() => (window as any).__pressed)).toBe(2);
  }, 20_000);

  test('110200 aborts on the first attempt', async () => {
    await load(widget({ frame: DOMAIN }));
    const res = await execs.playwright_captcha_turnstile({
      tokenTtlMs: 2_000,
      maxAttempts: 5,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha turnstile: not solved \(1 attempt\)/);
    expect(text).toContain('domain_mismatch');
    expect(await page.evaluate(() => (window as any).__pressed)).toBe(1);
  }, 20_000);

  test('an interstitial waits for its challenge iframe', async () => {
    await load(`<form id="challenge-form">
  <input type="hidden" name="cf-turnstile-response">
</form>
<script>
 setTimeout(() => {
   const f = document.createElement('iframe');
   f.className = 'cf-challenge';
   f.style.cssText = 'position:absolute;left:100px;top:100px;width:300px;height:80px;border:0';
   f.srcdoc = ${JSON.stringify(FRAME).replace(/<\/script>/g, '<\\/script>')};
   document.body.appendChild(f);
 }, 400);
</script>`);
    const res = await execs.playwright_captcha_turnstile({
      tokenTtlMs: 2_000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toContain('surface: interstitial');
    expect(text).toMatch(/^Captcha turnstile: solved/);
  }, 20_000);

  test('a page with no Turnstile surface is a widget_missing failure', async () => {
    await load('<p>nothing here</p>');
    const res = await execs.playwright_captcha_turnstile({});
    expect(res.content[0].text).toMatch(
      /not solved \(0 attempts\) — widget_missing/
    );
  }, 15_000);
});
