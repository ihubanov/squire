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

/**
 * The same dial with a refresh control and a click counter. Lets a test make
 * the first fit bad and later ones good, the way an adversarial puzzle does,
 * and then prove the bad fit was never dragged.
 */
const GATED_DIAL = DIAL.replace(
  '<div id="dial"></div><div id="handle"></div>',
  '<div id="dial"></div><div id="handle"></div>' +
    '<button id="refresh" style="position:absolute;left:10px;top:10px">r</button>'
).replace(
  '</script>',
  `  document.getElementById('refresh').addEventListener('click', () => {
    window.__refreshes = (window.__refreshes || 0) + 1;
  });
</script>`
);

/**
 * A dial whose knob is not an element — the thumb of a range input, a canvas
 * sprite. The caller can only aim it by bearing, so the geometry has to come
 * from the angleScript. Starts at 30° on a 120px radius.
 */
const THUMB_DIAL = `
<style>
  body { margin: 0 }
  #dial { position:absolute; left:200px; top:200px; width:300px; height:300px;
          border-radius:50%; border:2px solid #333 }
  #thumb { position:absolute; width:16px; height:16px; border-radius:50%;
           background:#c00; transform:translate(-50%,-50%) }
</style>
<div id="dial"></div><div id="thumb"></div>
<script>
 (function () {
  const dial = document.getElementById('dial');
  const thumb = document.getElementById('thumb');
  const R = 120, START = 30;
  const b = dial.getBoundingClientRect();
  const centre = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const place = (a) => {
    thumb.style.left = centre.x + R * Math.cos(a * Math.PI / 180) + 'px';
    thumb.style.top  = centre.y + R * Math.sin(a * Math.PI / 180) + 'px';
  };
  place(START);
  let dragging = false, last = START, downAt = null, moves = 0;
  document.addEventListener('mousedown', (e) => {
    dragging = true; moves = 0; downAt = { x: e.clientX, y: e.clientY };
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    moves++;
    const a = Math.atan2(e.clientY - centre.y, e.clientX - centre.x) * 180 / Math.PI;
    last = a < 0 ? a + 360 : a;
    place(last);
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; window.__result = { angle: last, moves, downAt }; }
  });
 })();
</script>`;

/**
 * Same dial, but it behaves like one that is still animating: the first
 * release is thrown away — the thumb snaps back to its start bearing and the
 * "user moved it" flag stays down. The widget only accepts a value once it is
 * settled, so a solver that presses submit mid-flight loses the attempt and one
 * that re-reads the knob position recovers.
 */
const CLOBBER_DIAL = THUMB_DIAL.replace(
  'let dragging = false, last = START, downAt = null, moves = 0;',
  `let dragging = false, last = START, downAt = null, moves = 0, drags = 0;
  window.__armed = false;`
)
  .replace(
    `  document.addEventListener('mousedown', (e) => {
    dragging = true; moves = 0; downAt = { x: e.clientX, y: e.clientY };
  });`,
    `  document.addEventListener('mousedown', (e) => {
    dragging = true; moves = 0; downAt = { x: e.clientX, y: e.clientY };
    window.__armed = false;
  });`
  )
  .replace(
    `  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; window.__result = { angle: last, moves, downAt }; }
  });`,
    `  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; drags++;
    if (drags === 1) {
      // Mid-animation: the value is clobbered and the flag stays down.
      last = START; place(START);
    } else {
      window.__armed = true;
    }
    window.__result = { angle: last, moves, downAt, drags };
  });`
  );

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
  // setContent reuses the same window, so globals from the previous test
  // (window.__result) leak into the next one. A real navigation clears them.
  let loads = 0;
  load = async (html: string) => {
    // Unique commit target: repeating the same about:blank navigation races
    // the previous one and gets reported as interrupted.
    await page.goto(`about:blank?${++loads}`);
    await page.setContent(html);
  };
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
    await load(DIAL);
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
    await load(DIAL.replace('left:440px; top:340px', 'left:340px; top:190px'));
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
    await load(DIAL);
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
    await load(
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
    await load(
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
    await load(DIAL);
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
    await load(DIAL);
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

  test('hunch is off by default: no hunchGate, no judge call', async () => {
    await load(DIAL);
    const savedUrl = process.env.SQUIRE_HUNCH_BACKEND_URL;
    const savedLegacy = process.env.HUNCH_BACKEND_URL;
    delete process.env.SQUIRE_HUNCH_BACKEND_URL;
    delete process.env.HUNCH_BACKEND_URL;
    try {
      const res = await execs.playwright_captcha_solve({
        dial: '#dial',
        handle: '#handle',
        angleScript: '(() => 200)()',
        // A judge that returns a strip, which is the input a hunch gate
        // would act on. The shipped default must still not look at it.
        judgeScript: `((arg) => ({
          ok: Math.abs(arg.angle - 200) < 6,
          strip: arg.image,
        }))`,
        holdMs: 100,
        settleMs: 150,
        maxAttempts: 2,
      });
      const text = res.content[0].text as string;
      expect(text).toContain('PASSED');
      expect(text).not.toMatch(/vision/);
    } finally {
      if (savedUrl !== undefined) {
        process.env.SQUIRE_HUNCH_BACKEND_URL = savedUrl;
      }
      if (savedLegacy !== undefined) {
        process.env.HUNCH_BACKEND_URL = savedLegacy;
      }
    }
  }, 30_000);

  test('hunch runs only when hunchGate is given', async () => {
    await load(DIAL);
    const savedUrl = process.env.SQUIRE_HUNCH_BACKEND_URL;
    const savedLegacy = process.env.HUNCH_BACKEND_URL;
    delete process.env.SQUIRE_HUNCH_BACKEND_URL;
    delete process.env.HUNCH_BACKEND_URL;
    try {
      const res = await execs.playwright_captcha_solve({
        dial: '#dial',
        handle: '#handle',
        angleScript: '(() => 200)()',
        judgeScript: `((arg) => ({
          ok: Math.abs(arg.angle - 200) < 6,
          strip: arg.image,
        }))`,
        hunchGate: 0.5,
        holdMs: 100,
        settleMs: 150,
        maxAttempts: 2,
      });
      const text = res.content[0].text as string;
      // No backend URL in the test env, so the call is skipped but the gate
      // path is visibly taken and reported as unavailable.
      expect(text).toContain('PASSED');
      expect(text).toContain('vision unavailable');
    } finally {
      if (savedUrl !== undefined) {
        process.env.SQUIRE_HUNCH_BACKEND_URL = savedUrl;
      }
      if (savedLegacy !== undefined) {
        process.env.HUNCH_BACKEND_URL = savedLegacy;
      }
    }
  }, 30_000);

  test('a knob that is not an element is aimed by bearing from the script', async () => {
    // A range-input thumb has no usable box: the input's box spans the whole
    // track. With no handle selector, the script has to say where the knob is.
    await load(THUMB_DIAL);
    const geo = await page.evaluate(() => {
      const d = document.getElementById('dial')!.getBoundingClientRect();
      const t = document.getElementById('thumb')!.getBoundingClientRect();
      return {
        thumb: { x: t.left + t.width / 2, y: t.top + t.height / 2 },
        offset: {
          x: t.left + t.width / 2 - d.left,
          y: t.top + t.height / 2 - d.top,
        },
      };
    });
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      // grab offsets are px from the dial box top-left, so the frame's own
      // offset never leaks into the caller's numbers.
      angleScript: `(() => ({ angle: 60, grab: { x: ${geo.offset.x}, y: ${geo.offset.y} } }))()`,
      successScript:
        '(() => { const r = window.__result; return !!r && Math.abs(r.angle - 60) < 5; })()',
      settleMs: 150,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Solved in \d+s/);
    // 30° derived from the grab point, then +30° the short way round.
    expect(text).toMatch(/attempt 1: 30° → 60°/);

    const out = await page.evaluate(() => (window as any).__result);
    // The press landed on the thumb, not on the track centre.
    expect(
      Math.hypot(out.downAt.x - geo.thumb.x, out.downAt.y - geo.thumb.y)
    ).toBeLessThan(3);
    expect(Math.abs(out.angle - 60)).toBeLessThan(5);
  }, 30_000);

  test('startAngle and radius alone drive the press point', async () => {
    await load(THUMB_DIAL);
    const thumb = await page.evaluate(() => {
      const t = document.getElementById('thumb')!.getBoundingClientRect();
      return { x: t.left + t.width / 2, y: t.top + t.height / 2 };
    });
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      angleScript: '(() => ({ angle: 150, startAngle: 30, radius: 120 }))()',
      successScript:
        '(() => { const r = window.__result; return !!r && Math.abs(r.angle - 150) < 5; })()',
      settleMs: 150,
      maxAttempts: 1,
    });
    expect(res.content[0].text).toMatch(/^Solved in \d+s/);
    const out = await page.evaluate(() => (window as any).__result);
    expect(
      Math.hypot(out.downAt.x - thumb.x, out.downAt.y - thumb.y)
    ).toBeLessThan(3);
    expect(Math.abs(out.angle - 150)).toBeLessThan(5);
  }, 30_000);

  test('the clobber fixture really clobbers', () => {
    // The fixture is built by string replacement; a silent miss would leave a
    // well-behaved dial and the repeat test below would prove nothing.
    expect(CLOBBER_DIAL).not.toBe(THUMB_DIAL);
    expect(CLOBBER_DIAL).toContain('drags === 1');
    expect(CLOBBER_DIAL).toContain('window.__armed = true');
  });

  test('repeats a drag the widget discarded until it settles', async () => {
    await load(CLOBBER_DIAL);
    // The script reads the thumb from live state on every call, as a
    // range-thumb solver must: the first drag is thrown back to 30°, and a
    // constant grab would press empty space on the repeat.
    const angleScript = `(() => {
      const d = document.getElementById('dial').getBoundingClientRect();
      const t = document.getElementById('thumb').getBoundingClientRect();
      return {
        angle: 60,
        grab: { x: t.left + t.width / 2 - d.left, y: t.top + t.height / 2 - d.top },
      };
    })()`;
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      angleScript,
      settleScript: '(() => window.__armed === true)()',
      successScript: '(() => window.__armed === true)()',
      settleTimeoutMs: 400,
      settleMs: 100,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/drag not recorded yet — repeating \(1\/2\)/);
    expect(text).toMatch(/^Solved in \d+s/);

    const out = await page.evaluate(() => (window as any).__result);
    expect(out.drags).toBe(2);
    expect(Math.abs(out.angle - 60)).toBeLessThan(5);
  }, 30_000);

  test('an unsettled dial is a miss even when the picture looks right', async () => {
    await load(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => 200)()',
      // A judge that is happy with the geometry but the widget never arms.
      judgeScript: '((arg) => ({ ok: true, note: "angle " + arg.angle }))',
      settleScript: '(() => false)()',
      settleTimeoutMs: 250,
      settleMs: 100,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Not solved/);
    expect(text).toMatch(/never settled/);
    expect(text).not.toContain('PASSED');
  }, 30_000);

  test('a picture replaced mid-attempt is a miss and skips the score', async () => {
    await load(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => 200)()',
      // The fixture sets window.__result on release, so the identity moves
      // exactly when the picture would have been swapped under the drag.
      identityScript: "(() => (window.__result ? 'after' : 'before'))()",
      judgeScript: '(() => ({ ok: true, note: "SHOULDNOTAPPEAR" }))',
      settleMs: 100,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Not solved/);
    expect(text).toContain('picture was replaced mid-attempt');
    expect(text).not.toContain('SHOULDNOTAPPEAR');
  }, 30_000);

  test('a stable identity lets the score decide', async () => {
    await load(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => 200)()',
      identityScript: "(() => 'same-puzzle')()",
      judgeScript: '(() => ({ ok: true, note: "scored" }))',
      settleMs: 100,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Solved in \d+s/);
    expect(text).toContain('scored');
  }, 30_000);

  test('identical scores across attempts point at the grab', async () => {
    await load(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => 200)()',
      // A flat judge: the same wrong score however far the dial turned.
      judgeScript: '(() => 0.25)',
      settleMs: 100,
      maxAttempts: 2,
    });
    const text = res.content[0].text as string;
    expect(text).toMatch(/^Not solved/);
    expect(text).toContain('suspect the grab');
  }, 30_000);

  test('a low-confidence fit buys a new picture instead of a drag', async () => {
    await load(GATED_DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      // Adversarial fit: coin toss until the picture has been refreshed.
      angleScript:
        '(() => ({ angle: 200, confidence: window.__refreshes ? 0.9 : 0.2 }))()',
      successScript:
        '(() => { const r = window.__result; return !!r && Math.abs(r.angle - 200) < 6; })()',
      refresh: '#refresh',
      minAngleConfidence: 0.5,
      settleMs: 100,
      maxAttempts: 3,
    });
    const text = res.content[0].text as string;
    expect(text).toContain('refreshed instead of dragging');
    expect(text).toMatch(/^Solved in \d+s/);
    // Only the good fit was dragged.
    expect(await page.evaluate(() => (window as any).__refreshes)).toBe(1);
  }, 30_000);

  test('without a refresh control a weak fit is dragged and logged', async () => {
    await load(DIAL);
    const res = await execs.playwright_captcha_solve({
      dial: '#dial',
      handle: '#handle',
      angleScript: '(() => ({ angle: 200, confidence: 0.1 }))()',
      successScript:
        '(() => { const r = window.__result; return !!r && Math.abs(r.angle - 200) < 6; })()',
      minAngleConfidence: 0.5,
      settleMs: 100,
      maxAttempts: 1,
    });
    const text = res.content[0].text as string;
    expect(text).toContain('angle fit confidence 0.10');
    expect(text).toContain('no refresh control — dragging anyway');
    expect(text).toMatch(/^Solved in \d+s/);
  }, 30_000);

  test('without either verdict script it refuses', async () => {
    await load(DIAL);
    await expect(
      execs.playwright_captcha_solve({
        dial: '#dial',
        handle: '#handle',
        angleScript: '(() => 90)()',
      })
    ).rejects.toThrow(/no verdict/);
  }, 15_000);

  test('says what is missing when a selector matches nothing', async () => {
    await load(DIAL);
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
