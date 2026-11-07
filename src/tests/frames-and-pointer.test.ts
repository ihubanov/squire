/**
 * Arc dragging and frame targeting.
 *
 * A rotation dial is driven by absolute angle from its centre, delivered as
 * discrete mousemove events — exactly what a captcha dial needs. Frames are
 * listed and evaluated into so cross-origin widgets are reachable.
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
const pointerTool = (await import('../tools/web/pointer.js')).default;
const framesTool = (await import('../tools/web/frames.js')).default;
const evaluateTool = (await import('../tools/web/evaluate.js')).default;
const captchaTool = (await import('../tools/web/captcha.js')).default;

const DIAL = `
<style>
  body { margin: 0 }
  #dial { position:absolute; left:200px; top:200px; width:300px; height:300px;
          border-radius:50%; border:2px solid #333 }
  #handle { position:absolute; left:440px; top:340px; width:20px; height:20px;
            border-radius:50%; background:#c00 }
</style>
<div id="dial"></div><div id="handle"></div>
<script>
 (function () {
  const dial = document.getElementById('dial');
  const handle = document.getElementById('handle');
  let dragging = false, moves = 0, centre = null, last = null, first = null, lastPt = null;
  const angleAt = (e) => {
    const a = Math.atan2(e.clientY - centre.y, e.clientX - centre.x) * 180 / Math.PI;
    return a < 0 ? a + 360 : a;
  };
  handle.addEventListener('mousedown', (e) => {
    const b = dial.getBoundingClientRect();
    centre = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    dragging = true; moves = 0; last = first = angleAt(e);
    lastPt = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    moves++; last = angleAt(e); lastPt = { x: e.clientX, y: e.clientY };
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; window.__result = { angle: last, moves, centre, first, lastPt }; }
  });
 })();
</script>`;

let browser: Browser;
let driver: InstanceType<typeof PlaywrightDriver>;
let page: Page;
const execs: Record<string, (a: Record<string, unknown>) => Promise<any>> = {};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
  });
  page = await context.newPage();
  driver = new PlaywrightDriver(browser, context, page);
  (current as unknown) = driver;
  pointerTool({
    addTool: (t: any) => {
      execs[t.name] = (a) => t.execute(a, undefined);
    },
  } as any);
  framesTool({
    addTool: (t: any) => {
      execs[t.name] = (a) => t.execute(a, undefined);
    },
  } as any);
  evaluateTool({
    addTool: (t: any) => {
      execs[t.name] = (a) => t.execute(a, undefined);
    },
  } as any);
  captchaTool({
    addTool: (t: any) => {
      execs[t.name] = (a) => t.execute(a, undefined);
    },
  } as any);
});

afterAll(async () => {
  await browser?.close();
});

describe('playwright_drag_arc', () => {
  test('turns a dial to the requested angle through many real moves', async () => {
    await page.setContent(DIAL);
    const dialBox = await page.waitForSelector('#dial');
    const handle = await page.waitForSelector('#handle');
    const dialId = driver.registerElement(dialBox);
    const handleId = driver.registerElement(handle);

    const res = await execs.playwright_drag_arc({
      elementUUID: dialId,
      handleUUID: handleId,
      endAngle: 120,
      steps: 60,
      stepDelayMs: 5,
    });
    expect(res.content[0].text).toMatch(/Dragged from \d+° to 120°/);

    const out = await page.evaluate(() => (window as any).__result);
    expect(out.moves).toBeGreaterThan(50);
    expect(Math.abs(out.angle - 120)).toBeLessThan(4);
  }, 30_000);

  test('start angle comes from the handle, not from 0', async () => {
    await page.setContent(
      DIAL.replace('left:440px; top:340px', 'left:340px; top:190px')
    );
    const dialBox = await page.waitForSelector('#dial');
    const handle = await page.waitForSelector('#handle');
    const res = await execs.playwright_drag_arc({
      elementUUID: driver.registerElement(dialBox),
      handleUUID: driver.registerElement(handle),
      endAngle: 270,
      steps: 30,
      stepDelayMs: 4,
    });
    // Handle placed above the centre: it starts near 270°, not 0°.
    expect(res.content[0].text).toMatch(/Dragged from 2(6\d|7\d)°/);
    const out = await page.evaluate(() => (window as any).__result);
    expect(Math.abs(out.angle - 270)).toBeLessThan(5);
  }, 30_000);
});

describe('playwright_element_box', () => {
  test('reports the handle position', async () => {
    await page.setContent(DIAL);
    const handle = await page.waitForSelector('#handle');
    const res = await execs.playwright_element_box({
      elementUUID: driver.registerElement(handle),
    });
    const box = JSON.parse(res.content[0].text);
    expect(box.x).toBeCloseTo(440, 0);
    expect(box.centre.x).toBeCloseTo(450, 0);
    expect(box.frame).toBeUndefined();
  }, 15_000);

  test('an element inside a frame also reports the frame offset', async () => {
    // A cross-origin widget (card iframe, embedded dial) needs its frame's
    // position, since viewport coordinates alone say nothing about where the
    // frame sits when the caller wants to clip a screenshot of it.
    await page.setContent(
      '<iframe id="f" style="position:absolute;left:100px;top:50px;width:300px;height:200px;border:0"' +
        ' srcdoc="<div id=inner style=&quot;position:absolute;left:20px;top:10px;width:20px;height:20px&quot;></div>"></iframe>'
    );
    const frame = await (await page.waitForSelector('#f')).contentFrame();
    const inner = await frame!.waitForSelector('#inner');
    const res = await execs.playwright_element_box({
      elementUUID: driver.registerElement(inner),
    });
    const box = JSON.parse(res.content[0].text);
    expect(box.frame).toEqual({ x: 100, y: 50 });
    // The element box itself is already in page coordinates.
    expect(box.x).toBeCloseTo(120, 0);
    expect(box.y).toBeCloseTo(60, 0);
  }, 15_000);
});

describe('playwright_frames', () => {
  test('lists a child frame and evaluates into it', async () => {
    await page.setContent(
      '<iframe id="f" src="data:text/html,<p id=x>inside</p>"></iframe>'
    );
    const listed = await execs.playwright_frames({});
    expect(listed.content[0].text).toMatch(
      /\[1\] f data:text\/html,<p id=x>inside<\/p>/
    );

    const evaluated = await execs.playwright_evaluate({
      script: 'document.getElementById("x").textContent',
      frame: 'data:text/html',
    });
    expect(evaluated.content[0].text).toMatch(/Result: inside/);
  }, 15_000);
});

describe('playwright_captcha_solve', () => {
  test('drags to the angle the script asks for and stops on success', async () => {
    await page.setContent(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => 200)()',
      successScript:
        '(() => { const r = window.__result; return !!r && Math.abs(r.angle - 200) < 6; })()',
      settleMs: 150,
      maxAttempts: 3,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Solved in \d+s/);
    expect(text).toMatch(/attempt 1: -?\d+° → 200°/);
    expect(text).toContain('PASSED');
  }, 30_000);

  test('judgeScript gets a screenshot of the capture region and decides', async () => {
    await page.setContent(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => 200)()',
      // The judge sees real pixels (a PNG data URL) and the geometry, and
      // passes only when the drag reached the angle.
      judgeScript: `((arg) => ({
        ok: arg.image.startsWith('data:image/png;base64,') &&
            arg.width > 200 && arg.height > 200 &&
            Math.abs(arg.angle - 200) < 6,
        note: 'capture ' + arg.width + 'x' + arg.height,
      }))`,
      holdMs: 100,
      settleMs: 150,
      maxAttempts: 2,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Solved in \d+s/);
    expect(text).toContain('PASSED');
    expect(text).toMatch(/capture \d+x\d+/);
  }, 30_000);

  test('without either verdict script it refuses', async () => {
    await page.setContent(DIAL);
    await expect(
      execs.playwright_captcha_solve({
        dial: '#dial',
        handle: '#handle',
        angleScript: '(() => 90)()',
      })
    ).rejects.toThrow(/no verdict/);
  }, 15_000);

  test('says what is missing when a selector matches nothing', async () => {
    await page.setContent(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#nope',
      handle: '#handle',
      angleScript: '(() => 90)()',
      successScript: 'true',
    });
    expect(res.content[0].text).toMatch(/no element for selector #nope/);
  }, 15_000);
});

describe('playwright_evaluate result rendering', () => {
  const ART = `(() => {
    let s = '';
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) s += x % 3 ? '#' : '.';
      s += '\\n';
    }
    return s;
  })()`;

  test('a multi-line string arrives intact, not blanked to whitespace', async () => {
    const res = await execs.playwright_evaluate({ script: ART });
    const text = res.content[0].text as string;
    expect(text).toContain('.##.##.##.##.##.##.##.##.##.##.##.##.##.');
    expect(text.split('\n')).toHaveLength(42); // 40 rows + status line
    expect(text).not.toContain('truncated');
  }, 15_000);

  test('long values are trimmed in the middle by an explicit marker', async () => {
    const res = await execs.playwright_evaluate({
      script: ART,
      maxLength: 200,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/truncated \d+ of 1640 chars/);
    expect(text).toContain('.##.##.##.##.##.##.##.##.##.##.##.##.##.');
    expect(text.length).toBeLessThan(400);
  }, 15_000);

  test('format: "compact" drops all whitespace from structures', async () => {
    const res = await execs.playwright_evaluate({
      script: '(() => Array.from({length: 72}, (_, i) => [i, i * 2]))()',
      format: 'compact',
    });
    const text = res.content[0].text as string;
    expect(text).toContain('Result: [[0,0],[1,2],[2,4]');
    expect(text).toContain('[71,142]]');
    expect(text).not.toContain('\n  ');
  }, 15_000);

  test('format: "json" encodes a string unambiguously', async () => {
    const res = await execs.playwright_evaluate({
      script: `'line1\\nline2'`,
      format: 'json',
    });
    expect(res.content[0].text).toMatch(/Result: "line1\\nline2"/);
  }, 15_000);
});
