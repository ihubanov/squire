/**
 * reCAPTCHA v2/v3 solver.
 *
 * Cross-origin widget frames cannot be faked with a plain selector, so each
 * fixture puts the anchor in a real title="reCAPTCHA" iframe and opens the
 * challenge bframe from the main page on a message from the anchor. Same
 * origin (srcdoc) only to keep the harness dependency-free; the tool still
 * resolves frames by title, the way it does against Google.
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

// Without this the tool would pick up a machine-local hunch config and send
// the blank fixture tiles to a vision endpoint. Tests pin the no-vision path.
process.env.APPIUM_MCP_CAPTCHA_VLM = '0';

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
const recaptchaTool = (await import('../tools/web/captcha-recaptcha.js'))
  .default;

const ANCHOR = `
<button id="recaptcha-anchor" role="checkbox" aria-checked="false"
  style="width:28px;height:28px;margin:6px"> </button>
<script>
  const a = document.getElementById('recaptcha-anchor');
  a.addEventListener('click', () => {
    a.setAttribute('aria-checked', 'true');
    parent.postMessage({ t: 'check' }, '*');
  });
</script>`;

const js = (s: string) => JSON.stringify(s).replace(/<\//g, '<\\/');

// Real widgets are 3x3 (and escalate to 4x4); the fixture is laid out the
// same way so tile geometry and the crop-to-tiles image match Google's.
const TILES = Array.from(
  { length: 3 },
  (_, r) =>
    `<tr>${Array.from(
      { length: 3 },
      (_, c) => `<td class="rc-imageselect-tile" data-i="${r * 3 + c}"></td>`
    ).join('')}</tr>`
).join('');

const GRID = `
<style>
  body { margin: 0 }
  td { width: 96px; height: 96px; border: 1px solid #333;
       background: #d9d9d9 }
  td.selected { background: #2a7 }
</style>
<div class="rc-imageselect">
  <div class="rc-imageselect-desc">Select all images with a bus</div>
  <table class="rc-imageselect-table"><tbody>
    ${TILES}
  </tbody></table>
</div>
<button id="recaptcha-reload-button">reload</button>
<button id="recaptcha-verify-button">Verify</button>
<div id="extra"></div>
<script>
  const selected = new Set();
  document.querySelectorAll('.rc-imageselect-tile').forEach((td) => {
    td.addEventListener('click', () => {
      const i = Number(td.dataset.i);
      selected.has(i) ? selected.delete(i) : selected.add(i);
      td.classList.toggle('selected');
      parent.postMessage({ t: 'tile', i }, '*');
    });
  });
  document.getElementById('recaptcha-verify-button').addEventListener(
    'click',
    () => parent.postMessage({ t: 'verify' }, '*')
  );
  document.getElementById('recaptcha-reload-button').addEventListener(
    'click',
    () => parent.postMessage({ t: 'reload' }, '*')
  );
</script>`;

const AUDIO = `
<style> body { margin: 0 } </style>
<div class="rc-audiochallenge">
  <div class="rc-audiochallenge-instructions">Type what you hear</div>
  <a class="rc-audiochallenge-tdownload-link"
     href="https://example.test/clip.mp3">download</a>
</div>
<input id="audio-response">
<button id="recaptcha-verify-button">Verify</button>
<script>
  document.getElementById('recaptcha-verify-button').addEventListener(
    'click',
    () => parent.postMessage({ t: 'verify' }, '*')
  );
</script>`;

/** Main page: anchor iframe, token field, and a per-test scenario object. */
const HOST = (extraScript = '') => `
<textarea id="g-recaptcha-response" style="display:none"></textarea>
<iframe title="reCAPTCHA" style="position:absolute;left:10px;top:10px;
  width:60px;height:50px;border:0" srcdoc="${ANCHOR.replace(/"/g, '&quot;')}"></iframe>
<script>
  window.__anchorClicks = 0;
  window.__verifies = 0;
  window.__reloads = 0;
  window.__selected = [];
  const setToken = (v) =>
    (document.getElementById('g-recaptcha-response').value = v);
  const openChallenge = (html) => {
    const f = document.createElement('iframe');
    f.title = 'recaptcha challenge expires in two minutes';
    f.style = 'position:absolute;left:320px;top:10px;width:420px;height:520px;border:0';
    f.srcdoc = html;
    document.body.appendChild(f);
    return f;
  };
  addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t === 'check') {
      window.__anchorClicks++;
      window.__scenario.check();
    }
    if (m.t === 'tile') { window.__selected.push(m.i); }
    if (m.t === 'verify') {
      window.__verifies++;
      window.__scenario.verify();
    }
    if (m.t === 'reload') {
      window.__reloads++;
      window.__scenario.reload();
    }
  });
  const chal = () =>
    document.querySelector('iframe[title*="challenge"]')?.contentDocument;
  const say = (t) => {
    const d = chal()?.querySelector('.rc-imageselect-desc, #extra');
    if (d) { d.textContent = t; }
  };
  window.__scenario = { check() {}, verify() {}, reload() {} };
  ${extraScript}
</script>`;

let browser: Browser;
let driver: InstanceType<typeof PlaywrightDriver>;
let page: Page;
let load: (html: string) => Promise<void>;
const execs: Record<string, (a: Record<string, unknown>) => Promise<any>> = {};

const parse = (text: string) => {
  const m = /\{[\s\S]*\}$/.exec(text);
  return JSON.parse(m![0]);
};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  page = await context.newPage();
  let loads = 0;
  load = async (html: string) => {
    await page.goto(`about:blank?${++loads}`);
    await page.setContent(html);
  };
  driver = new PlaywrightDriver(browser, context, page);
  (current as unknown) = driver;
  recaptchaTool({
    addTool: (t: any) => {
      execs[t.name] = (a) => t.execute(a, undefined);
    },
  } as any);
});

afterAll(async () => {
  await browser?.close();
});

describe('playwright_captcha_recaptcha', () => {
  test('clicks the anchor, sees the checked state and the token, passes', async () => {
    await load(
      HOST(
        `window.__scenario.check = () => setTimeout(() => setToken('tok-123456789012345678901234'), 120);`
      )
    );
    const res = await execs.playwright_captcha_recaptcha({
      verifyMs: 3000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: pass/);
    expect(parse(text).token).toMatch(/^tok-/);
    expect(parse(text).verified).toBe(true);
    expect(await page.evaluate(() => (window as any).__anchorClicks)).toBe(1);
  }, 30_000);

  test('captures the grid as a PNG with tile geometry', async () => {
    await load(
      HOST(`window.__scenario.check = () => openChallenge(${js(GRID)});`)
    );
    const res = await execs.playwright_captcha_recaptcha({
      verifyMs: 2000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: needs_answer/);
    const payload = parse(text);
    expect(payload.status).toBe('needs_answer');
    expect(payload.failure.code).toBe('needs_answer');
    expect(payload.challenge.type).toBe('grid');
    expect(payload.challenge.image).toMatch(/^data:image\/png;base64,/);
    expect(payload.challenge.tiles).toHaveLength(9);
    expect(payload.challenge.tiles[4].index).toBe(4);
    expect(payload.challenge.tiles[4].imageX).toBeGreaterThan(0);
    // The capture is of the grid, not the whole page.
    expect(payload.challenge.imageBox.width).toBeLessThanOrEqual(420);
  }, 30_000);

  test('a reasoning-only vision reply is still read', async () => {
    process.env.APPIUM_MCP_CAPTCHA_VLM = '1';
    process.env.APPIUM_MCP_CAPTCHA_VLM_URL = 'http://vision.test/v1';
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  reasoning:
                    'Looking at the tiles, images 2 and 5 hold the object.\n{"select":[2,5]}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    try {
      await load(
        HOST(
          `window.__scenario.check = () => openChallenge(${js(GRID)});
           window.__scenario.verify = () => setTimeout(() => setToken('tok-vision'), 100);`
        )
      );
      const res = await execs.playwright_captcha_recaptcha({
        verifyMs: 3000,
        maxAttempts: 1,
      });
      const text = res.content[0].text as string;
      expect(text).toMatch(/^Captcha recaptcha v2: pass/);
      expect(text).toContain('vision selected 2,5');
    } finally {
      spy.mockRestore();
      process.env.APPIUM_MCP_CAPTCHA_VLM = '0';
      delete process.env.APPIUM_MCP_CAPTCHA_VLM_URL;
    }
  }, 30_000);

  test('the vision endpoint picks the tiles and the token passes', async () => {
    process.env.APPIUM_MCP_CAPTCHA_VLM = '1';
    process.env.APPIUM_MCP_CAPTCHA_VLM_URL = 'http://vision.test/v1';
    const calls: string[] = [];
    const bodies: any[] = [];
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: unknown, init?: any) => {
        calls.push(String(url));
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"select":[1,4]}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
    try {
      await load(
        HOST(
          `window.__scenario.check = () => openChallenge(${js(GRID)});
           window.__scenario.verify = () => setTimeout(() => setToken('tok-vision'), 100);`
        )
      );
      const res = await execs.playwright_captcha_recaptcha({
        verifyMs: 3000,
        maxAttempts: 1,
      });
      const text = res.content[0].text as string;
      expect(text).toMatch(/^Captcha recaptcha v2: pass/);
      expect(calls[0]).toBe('http://vision.test/v1/chat/completions');
      // One whole-grid image with the challenge named, not per-tile crops:
      // a model that sees only crops cannot tell what to look for.
      expect(bodies[0].messages[0].content).toHaveLength(2);
      expect(bodies[0].messages[0].content[0].text).toContain(
        'Challenge instruction: "Select all images with a bus"'
      );
      expect(bodies[0].messages[0].content[1].type).toBe('image_url');
      // A reasoning model needs room to finish a long grid's JSON.
      expect(bodies[0].max_tokens).toBe(8192);
      const selected = await page.evaluate(
        () => (window as any).__selected as number[]
      );
      expect(selected.sort((a, b) => a - b)).toEqual([1, 4]);
      expect(text).toContain('vision selected 1,4');
    } finally {
      spy.mockRestore();
      process.env.APPIUM_MCP_CAPTCHA_VLM = '0';
      delete process.env.APPIUM_MCP_CAPTCHA_VLM_URL;
    }
  }, 30_000);

  test('an unusable whole-grid answer falls back to per-tile crops', async () => {
    process.env.APPIUM_MCP_CAPTCHA_VLM = '1';
    process.env.APPIUM_MCP_CAPTCHA_VLM_URL = 'http://vision.test/v1';
    const bodies: any[] = [];
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url: unknown, init?: any) => {
        bodies.push(JSON.parse(String(init?.body)));
        // First call is the whole grid and carries no JSON (the live 4x4
        // failure mode); every per-tile call then answers yes.
        const reply = bodies.length === 1 ? 'I cannot tell.' : '{"yes":true}';
        return new Response(
          JSON.stringify({ choices: [{ message: { content: reply } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
    try {
      await load(
        HOST(
          `window.__scenario.check = () => openChallenge(${js(GRID)});
           window.__scenario.verify = () => setTimeout(() => setToken('tok-per-tile'), 100);`
        )
      );
      const res = await execs.playwright_captcha_recaptcha({
        verifyMs: 3000,
        maxAttempts: 1,
      });
      const text = res.content[0].text as string;
      expect(text).toMatch(/^Captcha recaptcha v2: pass/);
      expect(text).toContain(
        'vision gave no usable answer — asking tile by tile'
      );
      expect(bodies).toHaveLength(1 + 9);
      expect(bodies[1].messages[0].content[0].text).toContain(
        'This is ONE tile cropped'
      );
      expect(bodies[1].messages[0].content[0].text).toContain(
        'Whole-grid instruction: "Select all images with a bus"'
      );
      expect(text).toContain('per-tile vision selected 0,1,2,3,4,5,6,7,8');
      const selected = await page.evaluate(
        () => (window as any).__selected as number[]
      );
      expect(selected.sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    } finally {
      spy.mockRestore();
      process.env.APPIUM_MCP_CAPTCHA_VLM = '0';
      delete process.env.APPIUM_MCP_CAPTCHA_VLM_URL;
    }
  }, 30_000);

  test('tilesScript presses the chosen tile and the token passes', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(GRID)});
        window.__scenario.verify = () => {
          if (window.__selected.includes(4)) {
            setToken('tok-tile-ok-1234567890123456');
          } else {
            document.querySelector('.rc-imageselect-desc').textContent =
              'Please select all matching images.';
          }
        };
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      // Returns the tile to press; the tool presses it and verify.
      tilesScript: '(() => [4])',
      verifyMs: 2000,
      maxAttempts: 2,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: pass/);
    expect(parse(text).token).toBe('tok-tile-ok-1234567890123456');
    expect(await page.evaluate(() => (window as any).__selected)).toContain(4);
  }, 30_000);

  test('a tilesScript that verifies itself is not verified twice', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(GRID)});
        window.__scenario.verify = () => setToken('tok-script-verify-12345678');
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      tilesScript: `(() => {
        document.querySelectorAll('.rc-imageselect-tile')[2].click();
        document.getElementById('recaptcha-verify-button').click();
        return { pressed: true };
      })`,
      verifyMs: 2000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: pass/);
    expect(await page.evaluate(() => (window as any).__verifies)).toBe(1);
  }, 30_000);

  test('"Try again later" aborts instead of burning attempts', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(GRID)});
        window.__scenario.verify = () => say('Try again later.');
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      tiles: [0],
      verifyMs: 1000,
      maxAttempts: 5,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: not_solved/);
    expect(parse(text).failure.code).toBe('bot_suspected');
    expect(await page.evaluate(() => (window as any).__verifies)).toBe(1);
  }, 30_000);

  test('a rejected selection retries the grid and can pass', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(GRID)});
        window.__scenario.verify = () => {
          if (window.__verifies >= 2) {
            setToken('tok-after-retry-123456789012');
          } else {
            say('Please select all matching images.');
          }
        };
        window.__scenario.reload = () => {
          document.querySelector('.rc-imageselect-desc').textContent =
            'Select all images with a bus';
          setToken('');
        };
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      tiles: [0, 1, 2],
      verifyMs: 1500,
      maxAttempts: 5,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: pass/);
    expect(text).toMatch(/attempt 1: selection rejected \(tiles_rejected\)/);
  }, 30_000);

  test('"Verification challenge expired" reloads and retries', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(GRID)});
        window.__scenario.verify = () => {
          if (window.__verifies >= 2) {
            setToken('tok-after-expiry-123456789012');
          } else {
            say('Verification challenge expired.');
          }
        };
        window.__scenario.reload = () => {
          say('Select all images with a bus');
          setToken('');
        };
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      tiles: [3],
      verifyMs: 1500,
      maxAttempts: 5,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: pass/);
    expect(await page.evaluate(() => (window as any).__reloads)).toBe(1);
  }, 30_000);

  test('reaching the retry cap aborts with retry_cap', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(GRID)});
        window.__scenario.verify = () => {
          document.querySelector('.rc-imageselect-desc').textContent =
            'Please select all matching images.';
        };
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      tiles: [0],
      verifyMs: 800,
      maxAttempts: 5,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: not_solved/);
    expect(parse(text).failure.code).toBe('retry_cap');
    expect(await page.evaluate(() => (window as any).__verifies)).toBe(5);
  }, 30_000);

  test('an audio challenge and no audioScript reports the clip URL', async () => {
    await load(
      HOST(`window.__scenario.check = () => openChallenge(${js(AUDIO)});`)
    );
    const res = await execs.playwright_captcha_recaptcha({
      audio: true,
      verifyMs: 1500,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: needs_answer/);
    const payload = parse(text);
    expect(payload.challenge.type).toBe('audio');
    expect(payload.challenge.audioUrl).toBe('https://example.test/clip.mp3');
    expect(payload.failure.code).toBe('audio_unavailable');
  }, 30_000);

  test('audioScript transcribes and the answer passes', async () => {
    await load(
      HOST(`
        window.__scenario.check = () => openChallenge(${js(AUDIO)});
        window.__scenario.verify = () => setToken('tok-audio-12345678901234');
      `)
    );
    const res = await execs.playwright_captcha_recaptcha({
      audio: true,
      audioScript: '(({ url }) => "12345")',
      verifyMs: 2000,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v2: pass/);
    const frame = page
      .frames()
      .find((f) => f.url() === 'about:srcdoc' && f !== page.mainFrame());
    expect(frame).toBeTruthy();
  }, 30_000);

  test('v3 execute returns the token but stays unverified', async () => {
    await load(`
      <textarea id="g-recaptcha-response" style="display:none"></textarea>
      <script>
        window.grecaptcha = {
          execute: async (key, opts) => {
            window.__executed = { key, action: opts.action };
            return 'v3-token-abcdefghijklmnop123456';
          },
        };
      </script>`);
    const res = await execs.playwright_captcha_recaptcha({
      sitekey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
      action: 'login',
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Captcha recaptcha v3: unverified/);
    const payload = parse(text);
    expect(payload.verified).toBe(false);
    expect(payload.token).toBe('v3-token-abcdefghijklmnop123456');
    expect(await page.evaluate(() => (window as any).__executed)).toEqual({
      key: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
      action: 'login',
    });
  }, 30_000);

  test('with no widget at all it throws widget_missing', async () => {
    await load('<p>nothing here</p>');
    await expect(execs.playwright_captcha_recaptcha({})).rejects.toThrow(
      /no reCAPTCHA widget/
    );
  }, 15_000);
});
