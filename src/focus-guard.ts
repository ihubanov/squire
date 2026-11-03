/**
 * Refuse mutating tools on a tab the user is currently focused on.
 *
 * The signal is `document.hidden` — Chromium flips visibility per-tab as
 * the user switches tabs. We make a single evaluate() call per guard check.
 * It costs ~50-100ms but only fires on mutations, which are infrequent
 * compared to the read-only `tabs_state` / `playwright_list_tabs` queries.
 *
 * The guard only applies to browser contexts the user actually shares with
 * the AI (CDP-attach mode) — create_session marks those via
 * markSharedWithUser(). In a browser the MCP launched itself there is no
 * user to protect, and the active tab of a headed browser is always
 * "visible", so guarding it would just lock the AI out of its own browser.
 *
 * Off by default: a user working alongside the AI wants it in the tab they
 * are looking at (and a tab Squire opens comes to the front anyway).
 * Shared-screen setups where the AI must keep out of the watched tab turn
 * it on with APPIUM_MCP_RESPECT_USER_FOCUS=true.
 */
import type { BrowserContext, Page } from 'playwright';

/** Contexts attached to a browser the user is also using (CDP-attach). */
const sharedContexts = new WeakSet<BrowserContext>();

/** Mark a context as living in the user's own browser window. */
export function markSharedWithUser(context: BrowserContext): void {
  sharedContexts.add(context);
}

/**
 * Returns true if `document.hidden === false` — the page is the foreground
 * tab in its window. Returns false on any error (page closed, eval blocked,
 * etc.) so the guard fails open: better to allow an action than to lock
 * the AI out due to a flaky probe.
 */
export async function isPageUserFocused(page: Page): Promise<boolean> {
  if (page.isClosed()) {
    return false;
  }
  try {
    return await page.evaluate(() => !document.hidden);
  } catch {
    return false;
  }
}

export async function assertNotUserFocused(
  page: Page,
  action: string
): Promise<void> {
  if (!isEnabled()) {
    return;
  }
  if (!isSharedWithUser(page)) {
    return;
  }
  if (await isPageUserFocused(page)) {
    let url = '';
    try {
      url = page.url();
    } catch {
      /* ignore */
    }
    const msg =
      `Refusing to ${action} on tab "${url}" — the user is currently focused on it. ` +
      `Work on a different tab (open one with playwright_new_tab if needed), or ` +
      `wait until the user switches away. Use mcp__tabs__tabs_state to see which ` +
      `tab is user-focused before retrying.`;
    import('./activity-log.js')
      .then(({ logActivity }) =>
        logActivity({
          tool: action,
          tab: url,
          status: 'blocked',
          detail: 'user-focused tab',
        })
      )
      .catch(() => {
        /* ignore */
      });
    throw new Error(msg);
  }
}

function isSharedWithUser(page: Page): boolean {
  try {
    return sharedContexts.has(page.context());
  } catch {
    return false;
  }
}

function isEnabled(): boolean {
  const v = (process.env.APPIUM_MCP_RESPECT_USER_FOCUS ?? '')
    .trim()
    .toLowerCase();
  return v === 'true' || v === '1';
}
