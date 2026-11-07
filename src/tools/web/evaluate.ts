/**
 * Tool to evaluate JavaScript in a Playwright web session
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

const DEFAULT_MAX = 20_000;

/**
 * Trims a long value to `max` characters, keeping both ends and saying how
 * much went missing. A silent cut is worse than a visible one: the caller
 * cannot tell a short answer from a mangled one.
 */
function cap(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  const half = Math.floor((max - 60) / 2);
  const cut = s.length - half * 2;
  return `${s.slice(0, half)}\n… [truncated ${cut} of ${s.length} chars; raise maxLength or narrow the script] …\n${s.slice(-half)}`;
}

/** Registers playwright_evaluate. */
export default function evaluate(server: FastMCP): void {
  const evaluateSchema = z.object({
    script: z
      .string()
      .describe(
        'JavaScript code to evaluate in the browser page context. The result will be serialized and returned.'
      ),
    frame: z
      .union([z.string(), z.number().int().min(0)])
      .optional()
      .describe(
        'Frame to run in. Default "main". Pass a frame index from playwright_frames, or a substring of the frame URL/name (e.g. "recaptcha", "cloudflare"). Needed to reach inside cross-origin captcha widgets, which page JS cannot see through the same-origin policy.'
      ),
    format: z
      .enum(['auto', 'raw', 'json', 'compact'])
      .optional()
      .describe(
        'How to render the result. "auto" (default) returns strings as-is and pretty-prints other values. "raw" always uses String(). "json" always pretty-prints. "compact" JSON-encodes with no whitespace — use it for large arrays of numbers, points or candidate boxes, where indentation is pure waste.'
      ),
    maxLength: z
      .number()
      .int()
      .min(200)
      .optional()
      .describe(
        'Character cap for the returned value (default 20000). Above the cap the middle is cut and both ends are kept, with an explicit marker giving the total size — so a long result is trimmed visibly, never silently.'
      ),
  });

  server.addTool({
    name: 'playwright_evaluate',
    description:
      "Run a JavaScript expression in the AI's active tab and get the result back. Use this to scrape structured data from a page (`document.querySelectorAll(...).map(e => e.textContent)`), call a page's own JS API, fetch a JSON endpoint via `fetch(...)` from the page's origin (useful for SearXNG's /search?format=json), or check page state. The page is real and live — DOM, cookies, network are all what a human would see. Strings come back verbatim (newlines and all); long values are trimmed in the middle with an explicit marker, so nothing is cut silently.",
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
        const frame =
          args.frame === undefined
            ? driver.page.mainFrame()
            : driver.resolveFrame(driver.page, args.frame);
        const result = await frame.evaluate(args.script);
        const json = () => JSON.stringify(result, null, 2) ?? 'undefined';
        const rendered =
          args.format === 'json'
            ? json()
            : args.format === 'compact'
              ? (JSON.stringify(result) ?? 'undefined')
              : args.format === 'raw'
                ? String(result)
                : typeof result === 'string'
                  ? result
                  : json();
        const resultStr = cap(rendered, args.maxLength ?? DEFAULT_MAX);
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
              text: `Script executed successfully${frame === driver.page.mainFrame() ? '' : ` in frame ${frame.url()}`}.\nResult: ${resultStr ?? 'undefined'}`,
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
