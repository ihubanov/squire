/**
 * Presenter: walk a person through a website with an animated spotlight,
 * pointing arrow and caption bubble drawn over the live page.
 *
 * Two modes:
 *  - guided: Squire only points and explains; the PERSON does each step.
 *    A step advances when they press Next, click the highlighted element,
 *    fill it in, or navigate (per the step's `advance`). Waiting is bounded
 *    per call — when the budget runs out the tour stays on screen and the
 *    caller resumes it, so a slow human never trips an MCP timeout.
 *  - demo: Squire performs each step itself, at human pace, with a visible
 *    cursor gliding to the target and a click ripple. It refuses to type
 *    into password fields; those steps fall back to guided and wait for
 *    the person.
 *
 * The overlay itself lives in presenter-overlay.ts and is (re)injected per
 * page, so a tour survives navigations: after a page change the current
 * step is re-shown on the new document.
 */
import type { ElementHandle, Page } from 'playwright';
import { installPresenter } from './presenter-overlay.js';
import { groundLabelOnPage } from './vision-grounding.js';

export type PresentMode = 'guided' | 'demo';
export type Advance = 'next' | 'click' | 'input' | 'navigation';
export type PresentAction =
  'none' | 'click' | 'fill' | 'type' | 'hover' | 'select' | 'press';

export interface PresentStep {
  /** CSS selector (Playwright `xpath=` / `text=` prefixes also work). */
  selector?: string;
  /** Visible label or position hint, grounded via OCR/vision when the DOM has nothing. */
  visual?: string;
  /** Short heading for the caption bubble. */
  title?: string;
  /** What to tell the person at this step. */
  text: string;
  /** Guided: what moves the tour on. Defaults from `action` (click→click, fill/type/select→input, else next). */
  advance?: Advance;
  /** What the step does — performed by Squire in demo mode, by the person in guided mode. */
  action?: PresentAction;
  /** Text for fill/type, option value for select. */
  value?: string;
  /** Key for press. */
  key?: string;
  /** Demo: how long to let the caption be read before acting (ms). */
  readMs?: number;
}

export interface PresentStepResult {
  index: number;
  status: 'shown' | 'done' | 'failed';
  /** Who/what finished the step: next, target-click, target-input, navigation, squire. */
  by?: string;
  target: 'element' | 'visual' | 'none';
  detail?: string;
}

export interface TourStatus {
  finished: boolean;
  stoppedByUser: boolean;
  /** Guided: the person hasn't finished the current step yet — resume to keep waiting. */
  waiting: boolean;
  failed: boolean;
  /** Zero-based index of the step on screen (or `total` when finished). */
  at: number;
  completed: number;
  total: number;
  finalUrl: string;
  steps: PresentStepResult[];
}

interface Target {
  handle: ElementHandle<Element> | null;
  rect: { x: number; y: number; w: number; h: number } | null;
}

interface PresenterEvent {
  seq: number;
  type: string;
}

type WaitOutcome =
  | { kind: 'events'; events: PresenterEvent[] }
  | { kind: 'nav'; alive: boolean }
  | { kind: 'timeout' }
  | { kind: 'closed' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Demo mode: how long each step stays on screen before Squire performs it. */
const DEMO_HOLD_MS = 5000;
/** The cursor glides over in the last part of the hold. */
const CURSOR_GLIDE_MS = 1200;

export class Tour {
  private index = 0;
  private shownIndex = -1;
  private seqSeen = 0;
  private stopped = false;
  private failed = false;
  private started = false;
  private target: Target = { handle: null, rect: null };
  private readonly results = new Map<number, PresentStepResult>();
  private readonly stepUrls: string[] = [];
  /** Steps that must wait for the person even in demo mode (e.g. passwords). */
  private readonly handedToUser = new Set<number>();
  /** Steps whose completion navigated, so Back goes back in the browser too. */
  private readonly navigated = new Set<number>();
  /** Target's form value when the step was shown, to tell whether the person already filled it. */
  private shownValue: string | null = null;

  constructor(
    readonly page: Page,
    readonly steps: PresentStep[],
    readonly mode: PresentMode = 'guided',
    readonly accent?: string
  ) {
    if (steps.length === 0) {
      throw new Error('A tour needs at least one step.');
    }
  }

  /**
   * Advance the tour for at most `budgetMs`. Returns when it finishes, the
   * person stops it, a demo action fails, or (guided) the budget runs out
   * while still waiting on the person — then call run() again to resume.
   */
  async run(budgetMs: number, onTick?: () => void): Promise<TourStatus> {
    const deadline = Date.now() + budgetMs;
    this.failed = false;
    if (!this.started) {
      this.started = true;
      // The person has to see it: surface the tab.
      await this.page.bringToFront().catch(() => {});
    }

    while (this.index < this.steps.length && !this.stopped) {
      const i = this.index;
      const step = this.steps[i]!;
      if (this.shownIndex !== i || !(await this.overlayAlive())) {
        await this.showStep(i);
      }

      if (this.mode === 'demo' && !this.handedToUser.has(i)) {
        if (await this.userStopped()) {
          break;
        }
        const ok = await this.demoStep(i, step);
        if (!ok) {
          this.failed = true;
          return this.status(false);
        }
        if (this.stopped) {
          break;
        }
        if (this.handedToUser.has(i)) {
          continue;
        } // re-show as a guided step
        this.index++;
        continue;
      }

      const outcome = await this.waitForPerson(deadline - Date.now(), onTick);
      if (outcome.kind === 'timeout') {
        return this.status(true);
      }
      if (outcome.kind === 'closed') {
        this.stopped = true;
        break;
      }
      const advance = defaultAdvance(step);
      if (outcome.kind === 'nav') {
        if (advance === 'click' || advance === 'navigation') {
          this.finishStep(i, 'navigation');
          this.navigated.add(i);
          this.index++;
        } else if (!outcome.alive) {
          this.shownIndex = -1; // new document: re-show this step there
        }
        continue;
      }
      for (const ev of outcome.events) {
        if (ev.type === 'skip') {
          this.stopped = true;
          break;
        }
      }
      if (this.stopped) {
        break;
      }
      const ev = outcome.events[0]!;
      if (ev.type === 'back') {
        if (i > 0 && this.navigated.has(i - 1)) {
          // The previous step moved us here: go back in the browser too.
          this.navigated.delete(i - 1);
          await this.page
            .goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 })
            .catch(() => {});
          this.index = i - 1;
          this.shownIndex = -1;
        } else if (i > 0 && this.stepUrls[i - 1] === this.page.url()) {
          this.index = i - 1;
        }
        continue;
      }
      if (ev.type === 'next') {
        // Next does the step for the person, unless they already did it.
        await this.performOnNext(i, step);
      }
      // next / target-click / target-input
      this.finishStep(i, ev.type);
      this.index++;
    }

    if (this.stopped) {
      await this.evalOverlay(() =>
        (window as any).__squirePresenter?.destroy()
      );
    } else if (this.index >= this.steps.length) {
      await this.evalOverlay(() => (window as any).__squirePresenter?.finish());
    }
    return this.status(false);
  }

  /** Tear the overlay down and end the tour. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.evalOverlay(() => (window as any).__squirePresenter?.destroy());
  }

  get done(): boolean {
    return this.stopped || this.index >= this.steps.length;
  }

  // ── internals ────────────────────────────────────────────────────────

  private status(waiting: boolean): TourStatus {
    const steps = [...this.results.values()].sort((a, b) => a.index - b.index);
    return {
      finished: !this.stopped && this.index >= this.steps.length,
      stoppedByUser: this.stopped,
      waiting,
      failed: this.failed,
      at: this.index,
      completed: steps.filter((s) => s.status === 'done').length,
      total: this.steps.length,
      finalUrl: this.page.isClosed() ? '' : this.page.url(),
      steps,
    };
  }

  private finishStep(i: number, by: string): void {
    const r = this.results.get(i);
    if (r) {
      r.status = 'done';
      r.by = by;
    }
  }

  private async evalOverlay(fn: () => unknown): Promise<void> {
    if (this.page.isClosed()) {
      return;
    }
    await this.page.evaluate(fn).catch(() => {});
  }

  private async overlayAlive(): Promise<boolean> {
    if (this.page.isClosed()) {
      return false;
    }
    return this.page
      .evaluate(() => !!(window as any).__squirePresenter?.host?.isConnected)
      .catch(() => false);
  }

  private async userStopped(): Promise<boolean> {
    const events: PresenterEvent[] = await this.page
      .evaluate(
        (s) =>
          ((window as any).__squirePresenter?.events ?? []).filter(
            (e: any) => e.seq > s
          ),
        this.seqSeen
      )
      .catch(() => []);
    if (events.length > 0) {
      this.seqSeen = Math.max(...events.map((e) => e.seq));
    }
    if (events.some((e) => e.type === 'skip')) {
      this.stopped = true;
      return true;
    }
    return false;
  }

  private async resolveTarget(step: PresentStep): Promise<Target> {
    let handle: ElementHandle<Element> | null = null;
    if (step.selector) {
      try {
        const loc = this.page.locator(step.selector).first();
        await loc.waitFor({ state: 'attached', timeout: 5000 });
        handle = await loc.elementHandle({ timeout: 2000 });
      } catch {
        handle = null;
      }
    }
    if (handle) {
      return { handle, rect: null };
    }
    if (step.visual) {
      // The overlay must not be in the screenshot we ground against.
      await this.evalOverlay(() => (window as any).__squirePresenter?.hide());
      const region = await groundLabelOnPage(this.page, step.visual).catch(
        () => null
      );
      if (region) {
        return { handle: null, rect: region };
      }
    }
    return { handle: null, rect: null };
  }

  /**
   * Show step i, retrying while a navigation is still tearing the old
   * document down ("Execution context was destroyed").
   */
  private async showStep(i: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.showStepOnce(i);
        return;
      } catch (err) {
        if (attempt >= 3 || this.page.isClosed()) {
          throw err;
        }
        await this.page
          .waitForLoadState('domcontentloaded', { timeout: 10_000 })
          .catch(() => {});
        await sleep(200);
      }
    }
  }

  private async showStepOnce(i: number): Promise<void> {
    const step = this.steps[i]!;
    await this.page.evaluate(installPresenter, {
      accent: this.accent,
      compact: true,
    });
    this.stepUrls[i] = this.page.url();
    this.seqSeen = await this.page
      .evaluate(() => (window as any).__squirePresenter?.seq ?? 0)
      .catch(() => 0);

    const guidedHere = this.mode === 'guided' || this.handedToUser.has(i);
    const opts = {
      title: step.title ?? '',
      text: step.text,
      hint:
        this.handedToUser.has(i) && this.mode === 'demo'
          ? "I won't type this one for you — please fill it in yourself, then press Next."
          : undefined,
      advance: defaultAdvance(step),
      index: i,
      total: this.steps.length,
      isLast: i === this.steps.length - 1,
      showBack:
        guidedHere &&
        i > 0 &&
        (this.stepUrls[i - 1] === this.page.url() || this.navigated.has(i - 1)),
      mode: guidedHere ? 'guided' : 'demo',
      holdMs: guidedHere ? 0 : this.holdMs(step),
    };
    const hasTarget = Boolean(step.selector || step.visual);
    // Caption first; the spotlight follows once the element is found.
    await this.page.evaluate((o) => (window as any).__squirePresenter.show(o), {
      ...opts,
      pending: hasTarget,
    });
    if (hasTarget) {
      this.target = await this.resolveTarget(step);
      await this.page.evaluate(
        ([el, o]) =>
          (window as any).__squirePresenter.setTarget({ ...(o as any), el }),
        [
          this.target.handle,
          { selector: cssOnly(step.selector), rect: this.target.rect },
        ] as const
      );
    } else {
      this.target = { handle: null, rect: null };
    }
    this.shownValue = this.target.handle
      ? await this.target.handle
          .evaluate((e: any) => ('value' in e ? String(e.value) : null))
          .catch(() => null)
      : null;

    const kind: PresentStepResult['target'] = this.target.handle
      ? 'element'
      : this.target.rect
        ? 'visual'
        : 'none';
    const prev = this.results.get(i);
    this.results.set(i, {
      index: i,
      status: prev?.status === 'done' ? 'done' : 'shown',
      ...(prev?.by ? { by: prev.by } : {}),
      ...(prev?.detail ? { detail: prev.detail } : {}),
      target: kind,
      ...((step.selector || step.visual) && kind === 'none'
        ? {
            detail: 'target not found — showed the caption without a spotlight',
          }
        : {}),
    });
    this.shownIndex = i;
  }

  /**
   * Guided Next on a step with an action: do it for the person (same path as
   * demo mode), unless they already did it or it's a sensitive field.
   */
  private async performOnNext(i: number, step: PresentStep): Promise<void> {
    const action = step.action ?? 'none';
    if (action === 'none') {
      return;
    }
    const handle = this.target.handle;
    if (this.page.isClosed() || this.page.url() !== this.stepUrls[i]) {
      return;
    }
    const touched = await this.page
      .evaluate(() => !!(window as any).__squirePresenter?.touched)
      .catch(() => false);
    if (touched) {
      return;
    }
    if (handle) {
      if (action === 'fill' || action === 'type' || action === 'select') {
        const now = await handle
          .evaluate((e: any) => ('value' in e ? String(e.value) : null))
          .catch(() => null);
        if (now !== this.shownValue) {
          return;
        }
      }
      if (
        (action === 'fill' || action === 'type') &&
        (await isSensitive(handle))
      ) {
        const r = this.results.get(i);
        if (r) {
          r.detail = 'sensitive field — left for the person, not typed';
        }
        return;
      }
    }
    const pt = await this.targetPoint();
    if (!handle && !pt) {
      return;
    }
    if (pt) {
      await this.page
        .evaluate(
          ([x, y]) => (window as any).__squirePresenter?.moveCursor(x, y),
          [pt.x, pt.y] as const
        )
        .catch(() => {});
    }
    const before = this.page.url();
    try {
      await this.performAction(action, step, handle, pt);
      // Commit the edit now, so its change event can't count for the next step.
      await handle?.evaluate((e: any) => e.blur?.()).catch(() => {});
      const r = this.results.get(i);
      if (r) {
        r.detail = 'Squire did this step when Next was pressed';
      }
    } catch (err: any) {
      const r = this.results.get(i);
      if (r) {
        r.detail = `Next: couldn't ${action}: ${String(err?.message ?? err).split('\n')[0]}`;
      }
      return;
    }
    if (!this.page.isClosed() && this.page.url() !== before) {
      this.navigated.add(i);
    }
  }

  /** Viewport centre of the current target, if it has one. */
  private async targetPoint(): Promise<{ x: number; y: number } | null> {
    if (this.target.handle) {
      const box = await this.target.handle.boundingBox().catch(() => null);
      if (box) {
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
    if (this.target.rect) {
      const r = this.target.rect;
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }
    return null;
  }

  private holdMs(step: PresentStep): number {
    return step.readMs ?? DEMO_HOLD_MS;
  }

  /** Demo mode: narrate, glide the cursor over, then do the step. */
  private async demoStep(i: number, step: PresentStep): Promise<boolean> {
    const action = step.action ?? 'none';
    const handle = this.target.handle;

    if ((action === 'fill' || action === 'type') && handle) {
      if (await isSensitive(handle)) {
        this.handedToUser.add(i);
        this.shownIndex = -1;
        const r = this.results.get(i);
        if (r) {
          r.detail =
            'sensitive field — handed to the person instead of typing it';
        }
        return true;
      }
    }

    // Hold the step on screen (spotlight, caption, countdown bar) so the
    // person can follow; the cursor glides over in the last second.
    const holdUntil = Date.now() + this.holdMs(step);
    await sleep(holdUntil - Date.now() - CURSOR_GLIDE_MS);
    const pt = await this.targetPoint();
    if (pt) {
      await this.page
        .evaluate(
          ([x, y]) => (window as any).__squirePresenter?.moveCursor(x, y),
          [pt.x, pt.y] as const
        )
        .catch(() => {});
    }
    await sleep(holdUntil - Date.now());
    if (await this.userStopped()) {
      return true;
    }

    if (action === 'none') {
      this.finishStep(i, 'squire');
      return true;
    }
    if (!handle && !pt) {
      const r = this.results.get(i);
      if (r) {
        r.status = 'failed';
        r.detail = `can't ${action}: target not found`;
      }
      return false;
    }

    try {
      const before = this.page.url();
      await this.performAction(action, step, handle, pt);
      if (!this.page.isClosed() && this.page.url() !== before) {
        this.navigated.add(i);
      }
      this.finishStep(i, 'squire');
      return true;
    } catch (err: any) {
      const r = this.results.get(i);
      if (r) {
        r.status = 'failed';
        r.detail = String(err?.message ?? err).split('\n')[0];
      }
      return false;
    }
  }

  /** Do a step's action on the page, with a ripple where it lands. */
  private async performAction(
    action: PresentAction,
    step: PresentStep,
    handle: ElementHandle<Element> | null,
    pt: { x: number; y: number } | null
  ): Promise<void> {
    if (pt && (action === 'click' || action === 'fill' || action === 'type')) {
      await this.page
        .evaluate(([x, y]) => (window as any).__squirePresenter?.ripple(x, y), [
          pt.x,
          pt.y,
        ] as const)
        .catch(() => {});
    }
    const value = step.value ?? '';
    // `fill` on input[type=range] waits for a text cursor that never appears
    // and times out; setting the value and firing the events is what a drag
    // amounts to.
    if (
      action === 'fill' &&
      handle &&
      (await handle
        .evaluate((e: any) => String(e.type).toLowerCase() === 'range')
        .catch(() => false))
    ) {
      await handle.evaluate((e: any, v: string) => {
        const n = Number(v);
        e.value = Number.isFinite(n) ? String(n) : v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      return;
    }
    if (handle) {
      switch (action) {
        case 'click':
          await handle.click({ timeout: 5000 }).catch(async () => {
            // Fall back to an in-page click if something intercepts it.
            await handle.evaluate((e: any) => e.click());
          });
          break;
        case 'fill':
          await handle.fill(value, { timeout: 5000 });
          break;
        case 'type':
          await handle.focus();
          await this.page.keyboard.type(value, { delay: 55 });
          break;
        case 'hover':
          await handle.hover({ timeout: 5000 });
          break;
        case 'select':
          await handle.selectOption(value, { timeout: 5000 });
          break;
        case 'press':
          await handle.press(step.key ?? 'Enter', { timeout: 5000 });
          break;
      }
    } else if (pt) {
      // Vision-grounded target: act on the pixels.
      if (action === 'hover') {
        await this.page.mouse.move(pt.x, pt.y);
      } else {
        await this.page.mouse.click(pt.x, pt.y);
        if (action === 'fill' || action === 'type') {
          await this.page.keyboard.type(value, { delay: 55 });
        } else if (action === 'press') {
          await this.page.keyboard.press(step.key ?? 'Enter');
        }
      }
    }
    if (action === 'click' || action === 'press') {
      // Let a navigation the action triggered settle before the next step.
      await sleep(300);
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: 10_000 })
        .catch(() => {});
    }
  }

  /** Guided: wait (bounded) for the person to act on the current step. */
  private async waitForPerson(
    ms: number,
    onTick?: () => void
  ): Promise<WaitOutcome> {
    if (ms <= 0) {
      return { kind: 'timeout' };
    }
    const page = this.page;
    let onNav: ((f: unknown) => void) | undefined;
    const navP = new Promise<'nav'>((resolve) => {
      onNav = (f) => {
        if (f === page.mainFrame()) {
          resolve('nav');
        }
      };
      page.on('framenavigated', onNav);
    });
    let onClose: (() => void) | undefined;
    const closeP = new Promise<'closed'>((resolve) => {
      onClose = () => resolve('closed');
      page.on('close', onClose);
    });
    // Hard stop, in case the page context dies without a navigation event.
    let guard: ReturnType<typeof setTimeout> | undefined;
    const guardP = new Promise<'timeout'>((resolve) => {
      guard = setTimeout(() => resolve('timeout'), ms + 1000);
    });
    const tick = onTick ? setInterval(onTick, 10_000) : undefined;

    type Raw =
      | { kind: 'events'; events: PresenterEvent[] }
      | { kind: 'timeout' }
      | { kind: 'navraw' };
    const evP: Promise<Raw> = page
      .waitForFunction(
        (s) => {
          const p = (window as any).__squirePresenter;
          if (!p || p.seq <= s) {
            return false;
          }
          return p.events.filter((e: any) => e.seq > s);
        },
        this.seqSeen,
        { timeout: ms, polling: 150 }
      )
      .then(async (h): Promise<Raw> => ({
        kind: 'events',
        events: (await h.jsonValue()) as PresenterEvent[],
      }))
      .catch((err): Raw | Promise<Raw> =>
        /timeout/i.test(String(err))
          ? { kind: 'timeout' }
          : // Context destroyed — a navigation; let the nav branch report it.
            navP.then((): Raw => ({ kind: 'navraw' }))
      );

    try {
      const first = await Promise.race([evP, navP, closeP, guardP]);
      if (first === 'closed' || page.isClosed()) {
        return { kind: 'closed' };
      }
      if (first === 'timeout') {
        return { kind: 'timeout' };
      }
      if (first === 'nav' || (first as any).kind === 'navraw') {
        await page
          .waitForLoadState('domcontentloaded', { timeout: 10_000 })
          .catch(() => {});
        // A click that navigated may have been recorded just before unload.
        return { kind: 'nav', alive: await this.overlayAlive() };
      }
      if ((first as any).kind === 'events') {
        const events = (first as any).events as PresenterEvent[];
        this.seqSeen = Math.max(this.seqSeen, ...events.map((e) => e.seq));
        return { kind: 'events', events };
      }
      return { kind: 'timeout' };
    } finally {
      if (tick) {
        clearInterval(tick);
      }
      if (guard) {
        clearTimeout(guard);
      }
      if (onNav) {
        page.off('framenavigated', onNav);
      }
      if (onClose) {
        page.off('close', onClose);
      }
    }
  }
}

/** Plain CSS the overlay can re-query itself after a re-render. */
function cssOnly(selector?: string): string | null {
  if (!selector) {
    return null;
  }
  if (/^(xpath|text|css|id|data-testid|role)=/i.test(selector)) {
    return null;
  }
  if (selector.includes('>>')) {
    return null;
  }
  return selector;
}

/** Password, payment and one-time-code fields are never typed into. */
async function isSensitive(handle: ElementHandle<Element>): Promise<boolean> {
  return handle
    .evaluate((e: any) => {
      const t = String(e.type ?? '').toLowerCase();
      const ac = String(e.autocomplete ?? '').toLowerCase();
      return (
        t === 'password' ||
        ac.includes('password') ||
        ac.startsWith('cc-') ||
        ac === 'one-time-code'
      );
    })
    .catch(() => false);
}

function defaultAdvance(step: PresentStep): Advance {
  if (step.advance) {
    return step.advance;
  }
  switch (step.action) {
    case 'click':
      return 'click';
    case 'fill':
    case 'type':
    case 'select':
      return 'input';
    default:
      return 'next';
  }
}
