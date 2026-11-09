/**
 * Tool to navigate to a URL in a Playwright web session
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';
import { cueNav } from '../../watch.js';

export default function navigate(server: FastMCP): void {
  const navigateSchema = z.object({
    url: z.string().describe('The URL to navigate to'),
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
      .optional()
      .describe(
        "When to consider navigation complete. Default is 'load'. Use 'networkidle' to wait until no network requests for 500ms."
      ),
  });

  server.addTool({
    name: 'playwright_navigate',
    description:
      "Navigate the AI's currently active tab to a URL in the real Chromium browser the user is sitting in front of. The page loads, JavaScript runs, cookies/redirects/captchas behave exactly as they would for a human. Use this to follow a link from a previous result, change the URL of a tab you already opened, or move through a multi-page flow. Prefer playwright_new_tab when starting a fresh task so you don't clobber an existing tab. Refused if the target tab is the qwen-web TUI or the user is currently focused on it.",
    parameters: navigateSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (
      args: z.infer<typeof navigateSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      // Hard guard: never navigate the host's protected tab(s) (e.g. the
      // qwen-web TUI). Force the AI to open a new tab instead.
      assertNotProtected(driver.page.url(), 'navigate');
      // Soft guard: don't navigate a tab the user is currently focused on.
      await assertNotUserFocused(driver.page, 'navigate');

      try {
        const response = await driver.page.goto(args.url, {
          waitUntil: args.waitUntil || 'load',
        });
        await cueNav(driver.page, args.url);

        const status = response?.status() ?? 'unknown';
        const title = await driver.page.title();
        logActivity({
          tool: 'playwright_navigate',
          tab: args.url,
          status: 'ok',
          detail: title,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Navigated to ${args.url}\nStatus: ${status}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to navigate to ${args.url}. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
