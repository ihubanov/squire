/**
 * Tool to evaluate JavaScript in a Playwright web session
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

export default function evaluate(server: FastMCP): void {
  const evaluateSchema = z.object({
    script: z
      .string()
      .describe(
        'JavaScript code to evaluate in the browser page context. The result will be serialized and returned.'
      ),
  });

  server.addTool({
    name: 'playwright_evaluate',
    description:
      "Run a JavaScript expression in the AI's active tab and get the result back. Use this to scrape structured data from a page (`document.querySelectorAll(...).map(e => e.textContent)`), call a page's own JS API, fetch a JSON endpoint via `fetch(...)` from the page's origin (useful for SearXNG's /search?format=json), or check page state. The page is real and live — DOM, cookies, network are all what a human would see.",
    parameters: evaluateSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof evaluateSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'evaluate JS in');
      await assertNotUserFocused(driver.page, 'evaluate JS in');

      try {
        const result = await driver.page.evaluate(args.script);
        const resultStr =
          typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        logActivity({
          tool: 'playwright_evaluate',
          tab: driver.page.url(),
          status: 'ok',
          detail: args.script.slice(0, 80),
        });

        return {
          content: [
            {
              type: 'text',
              text: `Script executed successfully.\nResult: ${resultStr ?? 'undefined'}`,
            },
          ],
        };
      } catch (err: any) {
        // A script that submits a form / follows a link tears down its own
        // execution context mid-run ("Execution context was destroyed …").
        // That isn't a failure — the script did navigate. Settle the new
        // page and report it plainly instead of surfacing a scary error, so
        // the model knows the side effect happened and just can't read a
        // return value. (For multi-step flows across a navigation, prefer
        // playwright_run_script, which resumes on the far side.)
        const msg = err?.message ?? String(err);
        if (
          typeof msg === 'string' &&
          msg.includes('Execution context was destroyed')
        ) {
          try {
            await driver.page.waitForLoadState('load', { timeout: 15000 });
          } catch {
            /* best-effort settle */
          }
          const url = (() => {
            try {
              return driver.page.url();
            } catch {
              return '';
            }
          })();
          logActivity({
            tool: 'playwright_evaluate',
            tab: url,
            status: 'ok',
            detail: 'navigated (context destroyed)',
          });
          return {
            content: [
              {
                type: 'text',
                text:
                  `Script triggered a navigation, which destroyed its execution context before a value could be returned. ` +
                  `The navigation completed; the page is now at ${url}. ` +
                  `To run steps on the far side of a navigation as one unit, use playwright_run_script.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `Failed to evaluate script. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
