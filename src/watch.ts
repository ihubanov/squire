/**
 * Watch mode — ambient "what is Squire doing" cues while it drives a page.
 *
 * When `APPIUM_MCP_WATCH` is on, every click / fill / hover / navigation
 * gets a brief animated cue drawn over the live page: a cursor gliding to
 * the target, a highlight box where the action lands and a ripple on click.
 * No captions, no dimming, no interaction — just enough for the person
 * watching the visible browser to follow along.
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
  text?: string
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
    // the tool call.
    4000
  );
}

/** Cue on a DOM target (element or locator). */
export async function cueAt(
  page: Page,
  target: Locator | ElementHandle,
  kind: CueKind
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
    // box and leaves the click unboxed, so give it room.
    2000
  );
  await cue(page, rect, kind);
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
