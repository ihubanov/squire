/**
 * Tools for managing browser tabs in Playwright sessions
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { writeAiActiveTab } from '../../ai-state.js';
import { logActivity } from '../../activity-log.js';
import type { PlaywrightDriver } from '../../playwright-adapter.js';
import {
  takeUserEvents,
  waitForUserEvent,
  formatUserEvents,
} from '../../user-activity.js';
import {
  countProfiles,
  openTabInProfileOf,
  pageProfileId,
  profileLabels,
} from '../../user-profiles.js';

export function newTab(server: FastMCP): void {
  const newTabSchema = z.object({
    url: z
      .string()
      .optional()
      .describe('Optional URL to navigate to in the new tab'),
    bringToFront: z
      .boolean()
      .optional()
      .describe(
        "Whether to bring the new tab to the foreground in the user's window. Default false — new tabs open in the background so the AI doesn't steal focus from the user. Set true only if the user explicitly asked you to show them the new tab."
      ),
    sameProfileAs: z
      .union([z.number().int().min(0), z.string()])
      .optional()
      .describe(
        "Attached to the user's Chrome only: open the tab in the same Chrome profile, with the same logins, as this tab (index or tab id from playwright_list_tabs). When Chrome has several profiles open the default is the profile of the AI-active tab."
      ),
    evenIfOpen: z
      .boolean()
      .optional()
      .describe(
        "Attached to the user's Chrome only: open a new tab even when one of the user's tabs already has this site open. By default no tab is opened and you are pointed at the existing one, because users prefer you work in the tab they already have (logged in, right profile)."
      ),
  });

  server.addTool({
    name: 'playwright_new_tab',
    description:
      'Open a new tab in the real Chromium window the user is in, optionally navigated to a URL. This is your primary tool for "go look at a website" — it does literally what a person does when they Cmd+T and type a URL. The page loads with full JavaScript, cookies, redirects, and captchas just like for a human. New tabs open in the background by default so the user\'s view doesn\'t get yanked; the AI\'s "active tab" follows the new one. Use this for: web search (always via http://localhost:8484/search?q=…, never google.com directly), opening a specific site the user mentioned, opening a result link from a previous search.',
    parameters: newTabSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (
      args: z.infer<typeof newTabSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const wantBackground = args.bringToFront !== true;

        // The user already has this site open: use that tab, it is in the
        // right profile and logged in. Point there instead of opening one.
        if (
          driver.attachedToUserBrowser &&
          args.url &&
          !args.evenIfOpen &&
          args.sameProfileAs === undefined
        ) {
          let host = '';
          try {
            host = new URL(args.url).hostname.replace(/^www\./, '');
          } catch {
            /* not a URL */
          }
          const pages = driver.context.pages();
          const at = host
            ? pages.findIndex((p) => {
                try {
                  return (
                    new URL(p.url()).hostname.replace(/^www\./, '') === host
                  );
                } catch {
                  return false;
                }
              })
            : -1;
          if (at >= 0) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `No tab opened: the user's tab ${at} [${driver.getTabId(pages[at])}] already has ${host} open (${pages[at].url()}). ` +
                    `Work in it: playwright_switch_tab ${at}, then navigate within it, if the task is in that site and the user is fine with you using their tab. ` +
                    `If you need a separate tab, call playwright_new_tab again with evenIfOpen: true (add sameProfileAs: ${at} to keep that tab's logins).`,
                },
              ],
            };
          }
        }

        const inProfile = await openInProfile(driver, args.sameProfileAs);
        let page: import('playwright').Page;

        if (inProfile.page) {
          page = inProfile.page;
          if (args.url) {
            await page.goto(args.url);
          }
          if (!wantBackground) {
            await page.bringToFront();
          }
        } else if (wantBackground) {
          // True background creation via CDP — Chromium never foregrounds
          // the new tab, so the user's focused tab doesn't even flicker.
          // We can't use context.newPage() which always steals focus.
          const cdp = await driver.context.newCDPSession(driver.page);
          const newPagePromise = driver.context.waitForEvent('page', {
            timeout: 15000,
          });
          // If cdp.send() below throws, control jumps to the catch and this
          // promise is never awaited — 15s later it rejects with no handler,
          // which under Node's default --unhandled-rejections=throw crashes
          // the whole MCP server. Register a no-op handler so a stranded
          // waiter can never take the process down.
          newPagePromise.catch(() => {
            /* superseded by the catch below */
          });
          // Open it in this session's browser context: a detached browser's
          // context is not Chrome's default one, and a target made there
          // never shows up in driver.context (the wait above timed out).
          const { targetInfo } = await cdp.send('Target.getTargetInfo');
          await cdp.send('Target.createTarget', {
            url: args.url ?? 'about:blank',
            background: true,
            ...(targetInfo.browserContextId
              ? { browserContextId: targetInfo.browserContextId }
              : {}),
          });
          page = await newPagePromise;
          // Wait for initial load (best-effort) so the AI can act on it
          // immediately after this call returns.
          if (args.url) {
            try {
              await page.waitForLoadState('load', { timeout: 15000 });
            } catch {
              /* ignore */
            }
          }
          try {
            await cdp.detach();
          } catch {
            /* ignore */
          }
        } else {
          page = await driver.context.newPage();
          if (args.url) {
            await page.goto(args.url);
          }
        }

        // The AI's "active page" follows the new tab regardless of who
        // has window focus — it's a separate concept.
        driver.setPage(page);
        writeAiActiveTab(driver.context.pages().indexOf(page), page.url());
        logActivity({
          tool: 'playwright_new_tab',
          tab: page.url(),
          status: 'ok',
          detail: wantBackground ? 'background' : 'foreground',
        });

        const title = await page.title();
        const url = page.url();
        const pages = driver.context.pages();
        const newIndex = pages.indexOf(page);

        return {
          content: [
            {
              type: 'text',
              text: `New tab opened at index ${newIndex} (${
                wantBackground
                  ? 'in background — user focus preserved'
                  : 'foregrounded'
              }).\nURL: ${url}\nTitle: ${title}\nTotal tabs: ${pages.length}${inProfile.note ? `\n${inProfile.note}` : ''}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to open new tab. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function switchTab(server: FastMCP): void {
  const switchTabSchema = z.object({
    index: z
      .number()
      .int()
      .min(0)
      .describe('Zero-based index of the tab to switch to'),
    bringToFront: z
      .boolean()
      .optional()
      .describe(
        "Whether to also foreground the tab in the user's window. Default false — switches the AI's internal active tab without stealing focus from the user. Set true only if the user explicitly asked to be shown that tab."
      ),
  });

  server.addTool({
    name: 'playwright_switch_tab',
    description:
      "Change which existing open tab the AI is acting on. By default this does NOT change what the user sees — the user's foreground tab stays put — it only retargets subsequent playwright_* calls. Pass bringToFront=true to also surface the tab in the user's window (only do this if the user explicitly asked to be shown that tab).",
    parameters: switchTabSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof switchTabSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const pages = driver.context.pages();
        if (args.index >= pages.length) {
          throw new Error(
            `Tab index ${args.index} is out of range. There are ${pages.length} tab(s) (0-${pages.length - 1}).`
          );
        }

        const page = pages[args.index];
        driver.setPage(page);
        writeAiActiveTab(args.index, page.url());

        if (args.bringToFront === true) {
          await page.bringToFront();
        }

        const title = await page.title();
        const url = page.url();
        const visible =
          args.bringToFront === true
            ? 'foregrounded'
            : 'AI-active only (user focus untouched)';

        return {
          content: [
            {
              type: 'text',
              text: `Switched AI active tab to ${args.index} (${visible}).\nURL: ${url}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to switch tab. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function listTabs(server: FastMCP): void {
  server.addTool({
    name: 'playwright_list_tabs',
    description:
      "List every tab currently open in the real browser window with index, URL, title, and which is the AI-active tab. Use mcp__tabs__tabs_state instead when you can — it also reports user-focus and content previews, and doesn't require a session bootstrap.",
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    execute: async (): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const pages = driver.context.pages();
        const currentPage = driver.page;

        const tabInfo = await Promise.all(
          pages.map(async (page, index) => {
            // A tab Chrome has frozen never answers; don't let it hang the list.
            const title = await within<string | null>(page.title(), 2000, null);
            const url = page.url();
            const id = driver.getTabId(page);
            const isActive = page === currentPage ? ' (active)' : '';
            const shown =
              title === null ? '(not responding)' : title || '(no title)';
            return `  ${index}. [${id}] ${shown} - ${url}${isActive}`;
          })
        );

        // Attached to the user's Chrome with several profiles open: group
        // the tabs by profile, since each profile has its own logins.
        let listing = tabInfo.join('\n');
        if (driver.attachedToUserBrowser && pages.length > 1) {
          const ids = await Promise.all(
            pages.map((p) =>
              within(pageProfileId(driver.context, p), 2000, undefined)
            )
          );
          const labels = profileLabels(ids);
          if (labels.size > 1) {
            const groups = [...labels.entries()].map(([pid, label]) =>
              [`${label}:`, ...tabInfo.filter((_, i) => ids[i] === pid)].join(
                '\n'
              )
            );
            const unknown = tabInfo.filter(
              (_, i) => !ids[i] || !labels.has(ids[i]!)
            );
            if (unknown.length) {
              groups.push(['profile unknown:', ...unknown].join('\n'));
            }
            listing =
              groups.join('\n') +
              '\n\nEach Chrome profile has its own logins. CDP does not give profile names; tell them apart by the tabs. ' +
              'To open a tab in a given profile, pass one of its tabs as sameProfileAs to playwright_new_tab.';
          }
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `Open tabs (${pages.length}):\n${listing}\n\n` +
                `Pass a tab id (e.g. "${driver.getTabId(currentPage)}") as the \`tab\` ` +
                `argument to playwright_run_script to drive that tab directly, even in the background.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list tabs. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function closeTab(server: FastMCP): void {
  const closeTabSchema = z.object({
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based index of the tab to close. Defaults to the current active tab.'
      ),
  });

  server.addTool({
    name: 'playwright_close_tab',
    description:
      "Close a tab in the user's browser window by index, or the AI-active tab if no index is given. Use this to clean up after you're done with a research tab and don't need it anymore. Refused on the qwen-web TUI tab and on a tab the user is currently looking at.",
    parameters: closeTabSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof closeTabSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const pages = driver.context.pages();
        const targetIndex = args.index ?? pages.indexOf(driver.page);

        if (targetIndex < 0 || targetIndex >= pages.length) {
          throw new Error(
            `Tab index ${targetIndex} is out of range. There are ${pages.length} tab(s).`
          );
        }

        const pageToClose = pages[targetIndex];
        assertNotProtected(pageToClose.url(), 'close tab');
        await assertNotUserFocused(pageToClose, 'close tab');
        const closedUrl = pageToClose.url();
        await pageToClose.close();
        logActivity({
          tool: 'playwright_close_tab',
          tab: closedUrl,
          status: 'ok',
        });

        // Switch to the last remaining tab if we closed the active one
        const remaining = driver.context.pages();
        if (remaining.length > 0 && pageToClose === driver.page) {
          driver.setPage(remaining[remaining.length - 1]);
        }

        return {
          content: [
            {
              type: 'text',
              text: `Tab ${targetIndex} closed. ${remaining.length} tab(s) remaining.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to close tab. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function userActivity(server: FastMCP): void {
  const schema = z.object({
    waitSeconds: z
      .number()
      .min(0)
      .max(600)
      .optional()
      .describe(
        'Wait up to this long for the user to do something (returns as soon as they do). Default 0: just report.'
      ),
  });
  server.addTool({
    name: 'playwright_user_activity',
    description:
      "What the user did in their own browser (clicks, field changes, Enter, form submits, page loads, new tabs) since you last looked. Attached to the user's Chrome only. Use it to work together in one tab: ask the user to do a step (log in, pick something, approve a 2FA prompt), then call this with waitSeconds to see when and what they did. Every other tool result also starts with this report when there is something new. Password and card fields never show values.",
    parameters: schema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (args: z.infer<typeof schema>): Promise<ContentResult> => {
      const driver = getDriver();
      if (
        !driver ||
        !isPlaywrightDriverSession(driver) ||
        !driver.attachedToUserBrowser
      ) {
        throw new Error(
          "Only available when attached to the user's Chrome (APPIUM_MCP_CDP_ENDPOINT)."
        );
      }
      if (args.waitSeconds) {
        await waitForUserEvent(args.waitSeconds * 1000);
      }
      // Let a burst of events (click, then page load) arrive together.
      await new Promise((r) => setTimeout(r, 300));
      const seen = takeUserEvents();
      return {
        content: [
          {
            type: 'text',
            text:
              formatUserEvents(seen) ||
              'The user has not done anything in their browser since your last action.',
          },
        ],
      };
    },
  });
}

/** `p`, or `fallback` if it fails or takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref()),
  ]);
}

/** A tab given as an index or a stable tab id. */
function findTab(
  driver: PlaywrightDriver,
  ref: number | string
): import('playwright').Page | undefined {
  if (typeof ref === 'number') {
    return driver.context.pages()[ref];
  }
  return /^\d+$/.test(ref)
    ? driver.context.pages()[Number(ref)]
    : driver.resolvePage(ref);
}

/**
 * Attached to the user's Chrome: open the tab in the opener's profile, so it
 * has that profile's logins. Returns undefined when this is not needed (one
 * profile, nothing asked), so the caller opens the tab the usual way.
 */
async function openInProfile(
  driver: PlaywrightDriver,
  sameProfileAs: number | string | undefined
): Promise<{ page?: import('playwright').Page; note: string }> {
  if (!driver.attachedToUserBrowser) {
    if (sameProfileAs !== undefined) {
      return {
        note: "sameProfileAs ignored: this browser is not the user's Chrome.",
      };
    }
    return { note: '' };
  }
  const explicit = sameProfileAs !== undefined;
  if (!explicit && (await countProfiles(driver.browser)) < 2) {
    return { note: '' };
  }
  const opener = explicit ? findTab(driver, sameProfileAs) : driver.page;
  if (!opener) {
    throw new Error(
      `No tab ${sameProfileAs}. Use playwright_list_tabs for indexes and ids.`
    );
  }
  const at = driver.context.pages().indexOf(opener);
  try {
    assertNotProtected(opener.url(), 'open a tab from');
    const page = await openTabInProfileOf(driver.context, opener);
    const [want, got] = await Promise.all([
      pageProfileId(driver.context, opener),
      pageProfileId(driver.context, page),
    ]);
    if (want && got && want !== got) {
      await page.close().catch(() => {});
      throw new Error('the new tab landed in a different profile');
    }
    return {
      page,
      note: `Opened from tab ${at}, so it is in that tab's Chrome profile with its logins. Chrome may have brought it to the front.`,
    };
  } catch (e) {
    const why = (e as Error).message.split('\n')[0];
    if (explicit) {
      throw new Error(
        `Could not open a tab in the profile of tab ${sameProfileAs} (${why}). Pick a regular web page tab in that profile.`
      );
    }
    return {
      note: `WARNING: Chrome has several profiles open and the tab could not be opened from the AI-active tab ${at} (${why}), so it may be in a different profile than you want. Check playwright_list_tabs, and pass sameProfileAs with a web page tab from the right profile.`,
    };
  }
}
