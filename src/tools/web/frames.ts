/**
 * Tool to list a page's frames (iframes), including cross-origin ones.
 *
 * Cross-origin frames are opaque to page JavaScript, so this is the only way
 * to discover them. Use the returned index (or a URL substring) as the
 * `frame` argument of playwright_evaluate.
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

/** Registers playwright_frames. */
export default function frames(server: FastMCP): void {
  const schema = z.object({
    tab: z
      .string()
      .optional()
      .describe('Stable tab id (defaults to the AI-active tab)'),
  });

  server.addTool({
    name: 'playwright_frames',
    description:
      'List the frames (iframes) of a page, including cross-origin ones that page JavaScript cannot see through the same-origin policy. Gives each frame an index and URL; pass the index or a URL substring as the `frame` argument of playwright_evaluate to run code inside it. Captcha widgets (reCAPTCHA, hCaptcha, Turnstile) live in such frames.',
    parameters: schema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (args: z.infer<typeof schema>): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }
      const page = args.tab ? driver.resolvePage(args.tab) : driver.page;
      if (!page) {
        throw new Error(`No tab with id "${args.tab}".`);
      }

      assertNotProtected(page.url(), 'list frames of');
      await assertNotUserFocused(page, 'list frames of');

      const list = driver.listFrames(page);
      logActivity({
        tool: 'playwright_frames',
        tab: page.url(),
        status: 'ok',
        detail: `${list.length} frame(s)`,
      });

      const lines = list.map(
        (f) =>
          `[${f.index}]${f.main ? ' (main)' : ''} ${f.name ? `${f.name} ` : ''}${f.url || 'about:blank'}`
      );
      return {
        content: [
          {
            type: 'text',
            text:
              `${list.length} frame(s) on ${page.url()}:\n${lines.join('\n')}\n\n` +
              'Run code inside one by passing its index or a URL substring (e.g. "recaptcha") to playwright_evaluate.',
          },
        ],
      };
    },
  });
}
