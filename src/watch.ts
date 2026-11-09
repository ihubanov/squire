/**
 * Watch mode — ambient "what is Squire doing" cues while it drives a page.
 *
 * When `APPIUM_MCP_WATCH` is on, every click / fill / hover / navigation
 * gets a brief animated cue drawn over the live page: a cursor gliding to
 * the target, a highlight box where the action lands, a ripple on click and
 * a one-line caption naming the action. No dimming and no interaction — just
 * enough for the person watching the visible browser to follow along. The
 * overlay is passive, so cues also run during real automation (a captcha
 * drag per attempt), not only during a presenter tour.
 *
 * The overlay is presenter-overlay.ts in ambient mode, so the two never
 * fight: a real tour takes over the same overlay and a later cue only
 * re-enables the ambient styling.
 *
 * All cues are best-effort. They are time-boxed and swallow errors, so a
 * page that is mid-navigation or has CSP quirks can never fail a tool call.
 */
import type { ElementHandle, Locator, Page } from 'playwright';
import { installPresenter } from './presenter-overlay.js';

export type CueKind = 'click' | 'input' | 'hover' | 'nav';

/** Enabled with APPIUM_MCP_WATCH=1 (also true/yes/on). */
export function watchEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.APPIUM_MCP_WATCH ?? '');
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CUE_MS: Record<CueKind, number> = {
  click: 1300,
  input: 1100,
  hover: 900,
  nav: 1600,
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), ms)),
  ]);

async function cue(
  page: Page,
  rect: Rect | null,
  kind: CueKind,
  text?: string,
  budgetMs = 4000
): Promise<void> {
  if (!watchEnabled() || page.isClosed()) {
    return;
  }
  await withTimeout(
    (async () => {
      await page.evaluate(installPresenter, { ambient: true });
      await page.evaluate((o) => (window as any).__squirePresenter?.cue(o), {
        rect,
        click: kind === 'click',
        ms: CUE_MS[kind],
        text,
      });
    })(),
    // Generous enough that a loaded CI box still finishes the two evaluates
    // before the cue is dropped, but still bounded so a wedged page can't hang
    // the tool call. Live automation passes a shorter budget.
    budgetMs
  );
}

/**
 * Cue on a DOM target (element or locator), optionally captioned.
 *
 * `budgetMs` bounds the whole cue. The default suits a one-shot tool call;
 * tight loops (a drag per attempt) should pass something small so the overlay
 * can never become the slowest part of the work.
 */
export async function cueAt(
  page: Page,
  target: Locator | ElementHandle,
  kind: CueKind,
  text?: string,
  budgetMs = 6000
): Promise<void> {
  if (!watchEnabled()) {
    return;
  }
  let rect: Rect | null = null;
  await withTimeout(
    (async () => {
      await (target as any).scrollIntoViewIfNeeded?.({ timeout: 1500 });
      const b = await (target as any).boundingBox?.({ timeout: 1500 });
      if (b) {
        rect = { x: b.x, y: b.y, w: b.width, h: b.height };
      }
    })(),
    // A crowded box is slow to answer; a short budget here silently drops the
    // box and leaves the click unboxed, so give it room — but stay inside the
    // caller's budget.
    Math.min(2000, budgetMs)
  );
  await cue(page, rect, kind, text, Math.min(4000, budgetMs));
}

/**
 * Cue without a DOM target: a caption, optionally near a known box. Used
 * where the thing being acted on has no element of its own (a canvas, a range
 * thumb) or where the action is a description rather than a click.
 */
export async function cueText(
  page: Page,
  text: string,
  kind: CueKind = 'nav',
  rect?: Rect | null,
  budgetMs = 1500
): Promise<void> {
  await cue(page, rect ?? null, kind, text, budgetMs);
}

/** Cue a navigation (no DOM target): a short toast naming the destination. */
export async function cueNav(page: Page, url: string): Promise<void> {
  let label = url;
  try {
    label = new URL(url).host;
  } catch {
    /* keep the raw string */
  }
  await cue(page, null, 'nav', `→ ${label}`);
}
