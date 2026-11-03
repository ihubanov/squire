/**
 * Chrome profiles in an attached browser.
 *
 * With several profiles open in one Chrome, connectOverCDP puts every tab
 * in one Playwright context, but each tab belongs to a profile (a CDP
 * browserContextId) and has that profile's logins. A tab opened with
 * Target.createTarget or context.newPage() lands in whichever profile Chrome
 * picks, often not the one the user meant. These helpers tell the profiles
 * apart and open a tab inside a chosen one.
 */
import type { Browser, BrowserContext, Page } from 'playwright';

/** The CDP browserContextId (profile) a tab belongs to. */
export async function pageProfileId(
  context: BrowserContext,
  page: Page
): Promise<string | undefined> {
  try {
    const s = await context.newCDPSession(page);
    try {
      const { targetInfo } = (await s.send('Target.getTargetInfo')) as {
        targetInfo?: { browserContextId?: string };
      };
      return targetInfo?.browserContextId;
    } finally {
      await s.detach().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

/** Number of distinct profiles that have page tabs open. */
export async function countProfiles(browser: Browser): Promise<number> {
  try {
    const s = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = (await s.send('Target.getTargets')) as {
        targetInfos: { type: string; browserContextId?: string }[];
      };
      return new Set(
        targetInfos
          .filter((t) => t.type === 'page' && t.browserContextId)
          .map((t) => t.browserContextId)
      ).size;
    } finally {
      await s.detach().catch(() => {});
    }
  } catch {
    return 0;
  }
}

/** "profile A", "profile B", … in order of first appearance. */
export function profileLabels(ids: (string | undefined)[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const id of ids) {
    if (id && !labels.has(id)) {
      labels.set(id, `profile ${String.fromCharCode(65 + labels.size)}`);
    }
  }
  return labels;
}

/**
 * Open a tab in the same profile as `opener` by having the opener call
 * window.open: a tab a page opens stays in that page's profile, with its
 * logins. Resolves to the new tab, cut loose from its opener.
 */
export async function openTabInProfileOf(
  context: BrowserContext,
  opener: Page,
  timeoutMs = 15_000
): Promise<Page> {
  const popup = opener.waitForEvent('popup', { timeout: timeoutMs });
  popup.catch(() => { /* surfaced through the await below */ });
  const s = await context.newCDPSession(opener);
  try {
    const res = (await s.send('Runtime.evaluate', {
      expression: "window.open('about:blank', '_blank') ? 'ok' : 'blocked'",
      userGesture: true,
      returnByValue: true,
    })) as { result?: { value?: string } };
    if (res.result?.value !== 'ok') {
      throw new Error('the tab could not open a new window (popup blocked)');
    }
  } finally {
    await s.detach().catch(() => {});
  }
  const page = await popup;
  await page.evaluate(() => { window.opener = null; }).catch(() => {});
  return page;
}
