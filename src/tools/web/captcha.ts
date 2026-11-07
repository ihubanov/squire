/**
 * Captcha solve loop for rotation dials, behind APPIUM_MCP_CAPTCHA.
 *
 * Squire cannot see the picture, so the caller supplies the one thing that
 * needs judgement — a script that names the next angle to try — and this tool
 * supplies the rest: find the widget, press the knob, drag round it in real
 * moves, re-check, refresh, and stop when the page says it passed. Everything
 * is by selector and script, so nothing here is specific to a site.
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';
import { arcDrag } from './pointer.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registers playwright_captcha_solve. */
export default function captcha(server: FastMCP): void {
  const schema = z.object({
    dial: z
      .string()
      .describe('CSS selector of the dial body, e.g. ".roulette" or "#dial".'),
    handle: z
      .string()
      .describe(
        'CSS selector of the knob to grab, e.g. ".roulette-handle". Its current bearing gives the start angle.'
      ),
    angleScript: z
      .string()
      .describe(
        'JS run in the widget frame after each attempt; returns the next end angle in degrees, or { angle, direction } ("cw" | "ccw" | "shortest"). Keep any search-window state in a window variable so it shrinks as attempts go on.'
      ),
    successScript: z
      .string()
      .describe(
        'JS run in the main frame after each attempt; truthy when the captcha passed. Usually "the token field now has a value" — not a change in the picture.'
      ),
    refresh: z
      .string()
      .optional()
      .describe(
        'CSS selector of the widget’s reload control, clicked between attempts. Without it the same challenge is retried.'
      ),
    frame: z
      .union([z.string(), z.number().int().min(0)])
      .optional()
      .describe(
        'Frame holding the widget, from playwright_frames. Default "main". Captcha widgets are normally cross-origin iframes and must be named here.'
      ),
    maxAttempts: z.number().int().min(1).max(12).optional(),
    settleMs: z
      .number()
      .int()
      .min(50)
      .optional()
      .describe(
        'Wait after a drag (and after a refresh) before judging, default 900.'
      ),
  });

  server.addTool({
    name: 'playwright_captcha_solve',
    description:
      'Solve a rotation-dial captcha by dragging it round. Repeats: read the next angle from angleScript, drag the knob there with real pointer moves, judge with successScript, refresh and retry on a miss. Selector- and script-driven, so it is not tied to any site. Use playwright_frames first to find the widget frame, and playwright_evaluate for one-off probes.',
    parameters: schema,
    annotations: { readOnlyHint: false, openWorldHint: false },
    execute: async (args: z.infer<typeof schema>): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }
      assertNotProtected(driver.page.url(), 'drive a captcha in');
      await assertNotUserFocused(driver.page, 'drive a captcha in');

      const maxAttempts = args.maxAttempts ?? 4;
      const settle = args.settleMs ?? 900;
      const frame =
        args.frame === undefined
          ? driver.page.mainFrame()
          : driver.resolveFrame(driver.page, args.frame);
      const log: string[] = [];
      const started = Date.now();

      const box = async (selector: string) => {
        const locator = frame.locator(selector).first();
        // elementHandle() waits 30 s by default, which hides a wrong selector
        // behind the call's own timeout. Three seconds is enough for a widget
        // that is already on screen.
        try {
          await locator.waitFor({ state: 'attached', timeout: 3000 });
        } catch {
          throw new Error(
            `no element for selector ${selector} (3s) — is it in the frame you named?`
          );
        }
        const handle = await locator.elementHandle();
        if (!handle) {
          throw new Error(`no element for selector ${selector}`);
        }
        const b = await handle.boundingBox();
        if (!b) {
          throw new Error(
            `element ${selector} has no box (hidden or off-screen)`
          );
        }
        return b;
      };
      const passed = async () => {
        try {
          return Boolean(
            await driver.page.mainFrame().evaluate(args.successScript)
          );
        } catch {
          return false;
        }
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            if (args.refresh) {
              const reload = frame.locator(args.refresh).first();
              if (await frame.locator(args.refresh).count()) {
                await reload.click();
                await sleep(settle);
              } else {
                log.push(
                  `no refresh element (${args.refresh}); keeping the same challenge`
                );
              }
            }
            if (await passed()) {
              log.push('passed before the next drag');
              break;
            }
          }

          const out = await frame.evaluate(args.angleScript);
          const next = (
            typeof out === 'number' ? { angle: out } : (out ?? {})
          ) as { angle?: number; direction?: string };
          if (!next || typeof next.angle !== 'number') {
            log.push(
              `angleScript returned ${JSON.stringify(out)} — no angle to try`
            );
            break;
          }

          const dialBox = await box(args.dial);
          const handleBox = await box(args.handle);
          const cx = dialBox.x + dialBox.width / 2;
          const cy = dialBox.y + dialBox.height / 2;
          const grab = {
            x: handleBox.x + handleBox.width / 2,
            y: handleBox.y + handleBox.height / 2,
          };
          const startAngle =
            (Math.atan2(grab.y - cy, grab.x - cx) * 180) / Math.PI;
          const radius = Math.hypot(grab.x - cx, grab.y - cy) || 40;

          let delta = next.angle - startAngle;
          if (next.direction === 'cw') {
            while (delta <= 0) {
              delta += 360;
            }
          } else if (next.direction === 'ccw') {
            while (delta >= 0) {
              delta -= 360;
            }
          } else {
            while (delta > 180) {
              delta -= 360;
            }
            while (delta <= -180) {
              delta += 360;
            }
          }
          // A single jump registers on almost nothing: never fewer than 40
          // intermediate bearings, and more when the turn is wide.
          const steps = Math.max(40, Math.min(180, Math.ceil(Math.abs(delta))));

          await arcDrag(driver.page, {
            cx,
            cy,
            radius,
            startAngle,
            delta,
            steps,
            delay: 12,
            hold: 80,
            grab,
          });
          await sleep(settle);

          const ok = await passed();
          log.push(
            `attempt ${attempt}: ${startAngle.toFixed(0)}° → ${next.angle.toFixed(0)}° (${steps} moves) — ${ok ? 'PASSED' : 'miss'}`
          );
          if (ok) {
            break;
          }
          if (Date.now() - started > 90_000) {
            log.push('wall-clock cap hit');
            break;
          }
        }

        const solved = await passed();
        logActivity({
          tool: 'playwright_captcha_solve',
          tab: driver.page.url(),
          status: solved ? 'ok' : 'error',
          detail: log.join(' | ').slice(0, 200),
        });

        return {
          content: [
            {
              type: 'text',
              text: `${solved ? 'Solved' : 'Not solved'} in ${Math.round((Date.now() - started) / 1000)}s.\n${log.join('\n')}\n${solved ? '' : 'Screenshot the widget, adjust angleScript or replace the challenge (refresh), then call again. If two rounds miss, hand it to the user.'}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Captcha solve stopped. Error: ${err.toString()}\n${log.join('\n')}`,
            },
          ],
        };
      }
    },
  });
}
