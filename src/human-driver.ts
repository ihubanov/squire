/**
 * Human-fallback, navigation-aware script engine.
 *
 * Drives a Playwright page through an ordered list of steps in ONE tool
 * call — the "single-call script" pattern that came out of the ShopMetrics
 * pentest work. Two things it does that a raw page.evaluate() cannot:
 *
 *  1. Navigation tolerance. A step that submits a form destroys the JS
 *     execution context ("Execution context was destroyed, most likely
 *     because of a navigation"). Instead of losing the rest of the script,
 *     the engine recognises that error, waits for the new page to load, and
 *     resumes the remaining steps in the fresh context.
 *
 *  2. Human fallback. Every actionable step is FIRST attempted the normal,
 *     fast Playwright way. Only when that hits a wall (element hidden,
 *     not actionable, pointer-intercepted) does it escalate to a humanised
 *     path: reveal the element (force-unhide ancestors, pierce shadow DOM,
 *     scroll into view), pace input like a person, and — as a last resort —
 *     dispatch the interaction in-page. This is what let us reach modals
 *     that were hidden to a plain locator click.
 *
 * The engine stops on the first failing step (by default) and reports
 * per-step results, so the caller (the LLM) can inspect and decide whether
 * to continue, adjust, or abort — it never blindly barrels through a
 * sequence that has already gone off the rails.
 */
import type { Page } from 'playwright';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { assertNotProtected } from './protected-urls.js';
import { assertNotUserFocused } from './focus-guard.js';
import { groundLabelOnPage } from './vision-grounding.js';

/** One instruction in a script. */
export interface Step {
  action:
    | 'fill'
    | 'click'
    | 'type'
    | 'press'
    | 'hover'
    | 'select'
    | 'scrollTo'
    | 'reveal'
    | 'wait'
    | 'eval'
    | 'upload';
  /** CSS by default; also accepts Playwright's `xpath=…` / `text=…` prefixes. */
  selector?: string;
  /** Text to fill/type. */
  text?: string;
  /** Key for `press` (e.g. "Enter", "Tab"). */
  key?: string;
  /** Value(s) for `select`. */
  value?: string | string[];
  /** Milliseconds for `wait`. */
  ms?: number;
  /** Page state / navigation to await for `wait`. */
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle' | 'navigation';
  /** JavaScript body for `eval`. */
  script?: string;
  /** Absolute paths of the files for `upload`. */
  files?: string[];
  /**
   * Visible label to look for ON SCREEN (OCR/vision grounding) when DOM
   * selectors fail — for canvas, WebGL, embedded viewers, images. E.g.
   * `visual: "Sign in"` clicks the pixels that read "Sign in".
   */
  visual?: string;
}

export type Humanize = 'auto' | 'always' | 'never';

export interface RunOptions {
  humanize?: Humanize;
  stopOnError?: boolean;
  /** Per-step normal-attempt timeout in ms (default 5000). */
  stepTimeout?: number;
  /**
   * Stop and hand control back after this many steps even when they all
   * succeed, returning a continuation for the rest. Lets the caller add
   * explicit checkpoints. 0 / undefined = run to the end.
   */
  pauseAfter?: number;
}

export interface StepResult {
  index: number;
  action: Step['action'];
  status: 'ok' | 'failed' | 'skipped';
  /** Which path actually did the work. */
  via?: 'normal' | 'human' | 'vision';
  /** True if this step caused a navigation the engine absorbed. */
  navigated?: boolean;
  value?: unknown;
  error?: string;
  detail?: string;
}

export interface RunResult {
  results: StepResult[];
  completed: number;
  total: number;
  finished: boolean;
  /** Present when the run stopped with steps left (error or pauseAfter). */
  remaining?: Step[];
  finalUrl: string;
}

const NAV_MARKERS = [
  'Execution context was destroyed',
  'Target closed',
  'Target page, context or browser has been closed',
  'frame was detached',
  'Navigation failed because page was closed',
];

function looksLikeNavigation(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return NAV_MARKERS.some((s) => m.includes(s));
}

/** Small randomised human pause. */
function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Run a script. Each step is guarded (protected-url + user-focus) against
 * the CURRENT page, re-checked after any navigation.
 */
export async function runScript(
  page: Page,
  steps: Step[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const humanize = opts.humanize ?? 'auto';
  const stopOnError = opts.stopOnError ?? true;
  const timeout = opts.stepTimeout ?? 5000;
  const pauseAfter =
    opts.pauseAfter && opts.pauseAfter > 0 ? opts.pauseAfter : 0;

  const results: StepResult[] = [];
  let completed = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const res: StepResult = { index: i, action: step.action, status: 'ok' };

    // Guard against the live page (URL may have changed via navigation).
    const mutating = step.action !== 'wait';
    try {
      if (mutating) {
        assertNotProtected(page.url(), `run "${step.action}" step on`);
        await assertNotUserFocused(page, `run "${step.action}" step on`);
      }

      const urlBefore = page.url();

      switch (step.action) {
        case 'wait':
          res.detail = await runWait(page, step, timeout);
          break;
        case 'eval': {
          if (!step.script) {
            throw new Error('eval step requires `script`');
          }
          res.value = await page.evaluate(step.script);
          break;
        }
        case 'reveal': {
          if (!step.selector) {
            throw new Error('reveal step requires a selector');
          }
          res.value = await reveal(page, step.selector, timeout);
          break;
        }
        case 'press': {
          if (!step.key) {
            throw new Error('press step requires `key`');
          }
          if (step.selector) {
            await page
              .locator(step.selector)
              .first()
              .press(step.key, { timeout });
          } else {
            await page.keyboard.press(step.key);
          }
          break;
        }
        case 'upload':
          res.detail = await upload(page, step, timeout);
          break;
        default:
          res.via = await runActionable(page, step, humanize, timeout);
      }

      // Absorb any navigation the step kicked off so the NEXT step runs in
      // the settled context rather than a torn-down one.
      if (page.url() !== urlBefore) {
        res.navigated = true;
        await page.waitForLoadState('load', { timeout }).catch(() => {});
      }
      completed++;
    } catch (err) {
      // A closed page (or a browser connection that went away, e.g. the
      // user took control) is not a navigation: every later step would
      // "succeed" the same way.
      if (looksLikeNavigation(err) && !page.isClosed()) {
        // The step DID its job — it navigated, taking its own execution
        // context down with it. Treat as success and settle the new page.
        res.status = 'ok';
        res.navigated = true;
        await page.waitForLoadState('load', { timeout }).catch(() => {});
        completed++;
      } else {
        res.status = 'failed';
        res.error = err instanceof Error ? err.message : String(err);
        results.push(res);
        if (stopOnError) {
          return {
            results,
            completed,
            total: steps.length,
            finished: false,
            remaining: steps.slice(i + 1),
            finalUrl: safeUrl(page),
          };
        }
        continue;
      }
    }

    results.push(res);

    if (pauseAfter && completed >= pauseAfter && i + 1 < steps.length) {
      return {
        results,
        completed,
        total: steps.length,
        finished: false,
        remaining: steps.slice(i + 1),
        finalUrl: safeUrl(page),
      };
    }
  }

  return {
    results,
    completed,
    total: steps.length,
    finished: true,
    finalUrl: safeUrl(page),
  };
}

/**
 * Put files into a file input. The selector may point at the
 * `<input type=file>` itself (hidden ones are fine) or at the button that
 * opens the file picker; for a button the picker is intercepted, so no
 * native dialog appears. If Playwright cannot set the files (seen on some
 * attached browsers) it falls back to CDP DOM.setFileInputFiles.
 */
async function upload(
  page: Page,
  step: Step,
  timeout: number
): Promise<string> {
  const sel = step.selector;
  if (!sel) {
    throw new Error('upload step requires a selector');
  }
  const files = step.files ?? [];
  if (!files.length) {
    throw new Error('upload step requires `files` (absolute paths)');
  }
  for (const f of files) {
    if (!isAbsolute(f)) {
      throw new Error(`upload: "${f}" is not an absolute path`);
    }
    const st = await stat(f).catch(() => undefined);
    if (!st?.isFile()) {
      throw new Error(`upload: "${f}" does not exist or is not a file`);
    }
  }
  const all = page.locator(sel);
  const count = await all.count();
  const locator = all.first();
  const isFileInput = await locator
    .evaluate(
      (el) => el instanceof HTMLInputElement && el.type === 'file',
      undefined,
      { timeout }
    )
    .catch(() => false);
  const note =
    count > 1
      ? ` (${count} elements matched; used the first, scope the selector if that was the wrong one)`
      : '';
  const what = `${files.length} file${files.length > 1 ? 's' : ''}`;

  if (!isFileInput) {
    // A button that opens the file picker: take the picker instead.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout }),
      locator.click({ timeout }),
    ]);
    await chooser.setFiles(files, { timeout });
    return `set ${what} through the file picker${note}`;
  }
  try {
    await locator.setInputFiles(files, { timeout });
    return `set ${what} on the file input${note}`;
  } catch (err) {
    if (looksLikeNavigation(err)) {
      throw err;
    }
    await setFilesViaCdp(page, locator, files);
    return `set ${what} on the file input via CDP${note}`;
  }
}

async function setFilesViaCdp(
  page: Page,
  locator: ReturnType<Page['locator']>,
  files: string[]
): Promise<void> {
  const mark = `squire-upload-${Date.now()}`;
  await locator.evaluate(
    (el, m) => el.setAttribute('data-squire-upload', m),
    mark
  );
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = (await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-squire-upload="${mark}"]')`,
    })) as { result: { objectId?: string } };
    if (!result.objectId) {
      throw new Error(
        'upload: could not reach the file input over CDP (is it inside an iframe?)'
      );
    }
    await cdp.send('DOM.setFileInputFiles', {
      files,
      objectId: result.objectId,
    });
  } finally {
    await locator
      .evaluate((el) => el.removeAttribute('data-squire-upload'))
      .catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

/**
 * Runs INSIDE the page. Force-reveals `el` and every ancestor (including
 * shadow hosts): unhide display/visibility/opacity, drop `hidden` and
 * `aria-hidden`, then scroll it into view. Returns its post-reveal rect.
 */
function revealInPage(el: Element): { revealed: boolean; rect: DOMRect } {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const style = (node as HTMLElement).style;
    if (style) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none') {
        style.setProperty('display', 'block', 'important');
      }
      if (cs.visibility === 'hidden') {
        style.setProperty('visibility', 'visible', 'important');
      }
      if (parseFloat(cs.opacity || '1') === 0) {
        style.setProperty('opacity', '1', 'important');
      }
    }
    if (node.hasAttribute('hidden')) {
      node.removeAttribute('hidden');
    }
    if (node.getAttribute('aria-hidden') === 'true') {
      node.removeAttribute('aria-hidden');
    }
    // Climb past shadow boundaries too.
    const parent = node.parentElement;
    if (parent) {
      node = parent;
    } else {
      const root = node.getRootNode() as ShadowRoot | Document;
      node = (root as ShadowRoot).host ?? null;
    }
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  return { revealed: true, rect: el.getBoundingClientRect() };
}

/** Reveal the element a locator points at; best-effort. */
async function reveal(
  page: Page,
  selector: string,
  timeout: number
): Promise<unknown> {
  const handle = await page
    .locator(selector)
    .first()
    .elementHandle({ timeout });
  if (!handle) {
    throw new Error(`No element matched "${selector}" to reveal`);
  }
  try {
    return await handle.evaluate(revealInPage);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * Execute a single actionable step, normal path first then human fallback.
 * Returns the path that worked. Throws only if both paths fail (or the
 * caller asked for `never` and normal failed).
 */
async function runActionable(
  page: Page,
  step: Step,
  humanize: Humanize,
  timeout: number
): Promise<'normal' | 'human' | 'vision'> {
  const sel = step.selector;
  if (!sel) {
    throw new Error(`Step "${step.action}" requires a selector`);
  }
  const locator = page.locator(sel).first();

  const normal = async (): Promise<void> => {
    switch (step.action) {
      case 'fill':
        await locator.fill(step.text ?? '', { timeout });
        break;
      case 'type':
        await locator.pressSequentially(step.text ?? '', { timeout });
        break;
      case 'click':
        await locator.click({ timeout });
        break;
      case 'hover':
        await locator.hover({ timeout });
        break;
      case 'select':
        await locator.selectOption(step.value as string | string[], {
          timeout,
        });
        break;
      case 'scrollTo':
        await locator.scrollIntoViewIfNeeded({ timeout });
        break;
      default:
        throw new Error(`Not an actionable step: ${step.action}`);
    }
  };

  const human = async (): Promise<void> => {
    // Reveal first, then act slowly. Reveal failures shouldn't mask the
    // real interaction error, so they're swallowed.
    await reveal(page, sel, timeout).catch(() => {});
    await sleep(jitter(120, 320));
    switch (step.action) {
      case 'fill':
      case 'type': {
        try {
          await locator.click({ timeout, force: true });
        } catch {
          /* focus is best-effort */
        }
        await locator.pressSequentially(step.text ?? '', {
          delay: jitter(40, 90),
          timeout,
        });
        break;
      }
      case 'click': {
        try {
          await locator.click({ timeout, force: true });
        } catch {
          // Last resort: dispatch the click in-page (reaches nodes even
          // pointer-events / overlays would block).
          await locator.dispatchEvent('click', undefined, { timeout });
        }
        break;
      }
      case 'hover':
        await locator.hover({ timeout, force: true });
        break;
      case 'select':
        await locator.selectOption(step.value as string | string[], {
          timeout,
          force: true,
        });
        break;
      case 'scrollTo':
        await reveal(page, sel, timeout);
        break;
      default:
        throw new Error(`Not an actionable step: ${step.action}`);
    }
  };

  if (humanize === 'always') {
    await human();
    return 'human';
  }
  try {
    await normal();
    return 'normal';
  } catch (err) {
    if (looksLikeNavigation(err)) {
      throw err;
    } // let the caller absorb it
    if (humanize === 'never') {
      throw err;
    }
    try {
      await human();
      return 'human';
    } catch (humanErr) {
      if (looksLikeNavigation(humanErr)) {
        throw humanErr;
      }
      // Vision rung: the DOM has nothing for this selector — the element
      // may only exist as pixels (canvas, WebGL, embedded viewer, image).
      // If the step names what it LOOKS like, ground that label on screen
      // and act at the coordinates.
      const vres = await actViaVision(page, step);
      if (vres) {
        return 'vision';
      }
      // No visual hint (or nothing matched): rethrow with guidance.
      const notFound = /waiting for|not found|no element|does not exist/i.test(
        humanErr instanceof Error ? humanErr.message : String(humanErr)
      );
      if (notFound && !step.visual) {
        throw new Error(
          `${humanErr instanceof Error ? humanErr.message : String(humanErr)} — ` +
            `if the control is only rendered as pixels (canvas/WebGL/embedded ` +
            `viewer/image), add a "visual" hint naming its visible label, e.g. ` +
            `{"action":"click","selector":"...","visual":"Sign in"}.`
        );
      }
      throw humanErr;
    }
  }
}

/**
 * Final fallback rung: ground the step's `visual` label on screen (OCR/vision
 * sidecar) and act at the returned coordinates. Only click / fill / type are
 * vision-capable — hover/select need richer semantics than a pixel box gives.
 * Returns the rung's success, or null when it couldn't fire (no hint, no
 * match, vision disabled) so the caller falls back to rethrowing.
 */
async function actViaVision(page: Page, step: Step): Promise<boolean> {
  if (!step.visual) {
    return false;
  }
  if (
    step.action !== 'click' &&
    step.action !== 'fill' &&
    step.action !== 'type'
  ) {
    return false;
  }
  const region = await groundLabelOnPage(page, step.visual);
  if (!region) {
    return false;
  }
  const cx = region.x + Math.floor(region.w / 2);
  const cy = region.y + Math.floor(region.h / 2);
  await page.mouse.click(cx, cy);
  if (step.action === 'fill' || step.action === 'type') {
    // Focus landed on whatever draws those pixels; type into it.
    await page.keyboard.type(step.text ?? '', { delay: jitter(40, 90) });
  }
  return true;
}

/** Wait for a page state, a delay, or a navigation. */
async function runWait(
  page: Page,
  step: Step,
  timeout: number
): Promise<string> {
  if (step.waitFor === 'navigation') {
    await page.waitForLoadState('load', { timeout }).catch(() => {});
    return 'navigation';
  }
  if (step.waitFor) {
    await page.waitForLoadState(step.waitFor, { timeout });
    return step.waitFor;
  }
  const ms = step.ms ?? 500;
  await sleep(ms);
  return `${ms}ms`;
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}
