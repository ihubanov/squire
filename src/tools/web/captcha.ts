/**
 * Captcha solve loop for rotation dials, behind APPIUM_MCP_CAPTCHA.
 *
 * Squire cannot see the picture, so the caller supplies the judgement — a
 * script that names the next angle, and (better) a script that scores the
 * widget picture after each attempt. This tool supplies the rest: find the
 * widget, press the knob, drag round it in real moves, screenshot the result,
 * re-show or refresh the widget, and stop when the page says it passed.
 * Everything is by selector and script, so nothing here is specific to a site.
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
        'JS run in the widget frame before each attempt; returns the next end angle in degrees, or { angle, direction } ("cw" | "ccw" | "shortest"). Keep any search-window state in a window variable so it shrinks as attempts go on.'
      ),
    successScript: z
      .string()
      .optional()
      .describe(
        'JS run in the main frame after each attempt; truthy when the captcha passed. Prefer the token field ("the hidden response field now has a value") over the picture. Optional when judgeScript is given, but keep it when one exists — it is the reliable half of the verdict.'
      ),
    judgeScript: z
      .string()
      .optional()
      .describe(
        'JS run in the main frame after each attempt with one argument: { image, width, height, dial, handle, angle, attempt }. `image` is a data URL PNG of the capture region, so the script can draw it to a canvas and score it. Return truthy / a score / { ok, score, note }. Use it when the picture must be judged by code (a seam line, an alignment offset) rather than assumed passed.'
      ),
    capture: z
      .string()
      .optional()
      .describe(
        'CSS selector of the region to screenshot for judgeScript. Default: the dial box. Widen it with pad when the judgement needs the surround.'
      ),
    pad: z
      .number()
      .int()
      .min(0)
      .max(400)
      .optional()
      .describe('Padding around the capture box, px (default 32).'),
    passScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'When judgeScript returns a bare number, score at or above this counts as passed (default 0.9).'
      ),
    holdMs: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe(
        'Pause between releasing the drag and taking the screenshot (default 600). Drop it once settled; raise it for a slow widget.'
      ),
    beforeNext: z
      .string()
      .optional()
      .describe(
        'CSS selector clicked before every attempt after the first — a control the widget hides itself behind (re-show links, "try again" buttons).'
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
    maxMs: z
      .number()
      .int()
      .min(5_000)
      .optional()
      .describe('Wall-clock cap for the whole call (default 90000).'),

    maxAgeMs: z
      .number()
      .int()
      .min(5_000)
      .optional()
      .describe(
        'Challenges that expire (a signed image URL, roughly a minute) get replaced when the current one is older than this: the refresh control is clicked and the clock resets. Default 55000.'
      ),
  });

  server.addTool({
    name: 'playwright_captcha_solve',
    description:
      'Solve a rotation-dial captcha by dragging it round. Repeats: read the next angle from angleScript, drag the knob there with real pointer moves, screenshot the widget and score it with judgeScript (and/or check successScript), re-show and refresh, then stop when it passes. Selector- and script-driven, so it is not tied to any site. Use playwright_frames first to find the widget frame, and playwright_evaluate for one-off probes.',
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

      if (!args.successScript && !args.judgeScript) {
        throw new Error(
          'Pass successScript (token check), judgeScript (picture score), or both — otherwise there is no verdict.'
        );
      }

      const maxAttempts = args.maxAttempts ?? 4;
      const settle = args.settleMs ?? 900;
      const hold = args.holdMs ?? 600;
      const pad = args.pad ?? 32;
      const passScore = args.passScore ?? 0.9;
      const maxMs = args.maxMs ?? 90_000;
      const maxAge = args.maxAgeMs ?? 55_000;
      const frame =
        args.frame === undefined
          ? driver.page.mainFrame()
          : driver.resolveFrame(driver.page, args.frame);
      const log: string[] = [];
      const started = Date.now();
      let challengeAt = started;
      let lastOk = false;

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
      const tokenPassed = async () => {
        if (!args.successScript) {
          return undefined;
        }
        try {
          return Boolean(
            await driver.page.mainFrame().evaluate(args.successScript)
          );
        } catch {
          return false;
        }
      };

      /**
       * Screenshots the capture region and lets judgeScript score it. The
       * clip is in page coordinates (box + scroll) so an iframe's own offset
       * and a scrolled page both land on the right pixels.
       */
      const judged = async (
        target: { x: number; y: number; width: number; height: number },
        dialBox: { x: number; y: number; width: number; height: number },
        handleBox: { x: number; y: number; width: number; height: number },
        angle: number,
        attempt: number
      ): Promise<{ ok: boolean; note: string }> => {
        if (!args.judgeScript) {
          return { ok: true, note: '' };
        }
        const scroll = await driver.page
          .mainFrame()
          .evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        const clip = {
          x: Math.max(0, Math.floor(target.x + scroll.x - pad)),
          y: Math.max(0, Math.floor(target.y + scroll.y - pad)),
          width: Math.max(1, Math.ceil(target.width + pad * 2)),
          height: Math.max(1, Math.ceil(target.height + pad * 2)),
        };
        const png = await driver.page.screenshot({ clip, type: 'png' });
        const image = `data:image/png;base64,${png.toString('base64')}`;
        const verdict = await driver.page.mainFrame().evaluate(
          ({ code, arg }) =>
            // eslint-disable-next-line no-new-func
            (0, eval)(`(${code})`)(arg),
          {
            code: args.judgeScript,
            arg: {
              image,
              width: clip.width,
              height: clip.height,
              dial: dialBox,
              handle: handleBox,
              angle,
              attempt,
            },
          }
        );
        if (typeof verdict === 'number') {
          return {
            ok: verdict >= passScore,
            note: `score ${verdict.toFixed(3)} (pass ≥ ${passScore})`,
          };
        }
        if (verdict && typeof verdict === 'object') {
          const v = verdict as {
            ok?: unknown;
            score?: unknown;
            note?: unknown;
          };
          const ok =
            typeof v.ok === 'boolean'
              ? v.ok
              : typeof v.score === 'number' && v.score >= passScore;
          return {
            ok,
            note: [
              typeof v.score === 'number' ? `score ${v.score}` : '',
              v.note,
            ]
              .filter(Boolean)
              .join(' — '),
          };
        }
        return {
          ok: Boolean(verdict),
          note: `judge ${JSON.stringify(verdict)}`,
        };
      };

      const clickIfPresent = async (
        selector: string | undefined,
        why: string
      ) => {
        if (!selector) {
          return false;
        }
        const locator = frame.locator(selector).first();
        if (!(await locator.count())) {
          log.push(`no ${why} element (${selector})`);
          return false;
        }
        await locator.click();
        await sleep(settle);
        return true;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            await clickIfPresent(args.beforeNext, 'beforeNext');
          }
          // A challenge that expires has to be replaced, not retried.
          if (Date.now() - challengeAt > maxAge) {
            if (await clickIfPresent(args.refresh, 'refresh')) {
              log.push(`challenge older than ${maxAge}ms — refreshed`);
              challengeAt = Date.now();
            } else {
              log.push(
                'challenge may have expired and there is no refresh control'
              );
              break;
            }
          }

          // Measure first so a wrong selector is reported even when the
          // token check would short-circuit the attempt.
          const dialBox = await box(args.dial);
          const handleBox = await box(args.handle);

          if (await tokenPassed()) {
            log.push('passed before the next drag');
            break;
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

          const captureBox = args.capture ? await box(args.capture) : dialBox;
          await sleep(hold);
          const verdict = await judged(
            captureBox,
            dialBox,
            handleBox,
            next.angle,
            attempt
          );
          const token = await tokenPassed();
          // The token is authoritative when it exists; a picture score that
          // disagrees is worth reporting, not obeying.
          const ok = token === undefined ? verdict.ok : token;
          lastOk = ok;
          log.push(
            `attempt ${attempt}: ${startAngle.toFixed(0)}° → ${next.angle.toFixed(0)}° (${steps} moves) — ` +
              (verdict.note ? `${verdict.note}, ` : '') +
              (token === undefined
                ? ok
                  ? 'PASSED'
                  : 'miss'
                : token
                  ? 'PASSED (token set)'
                  : 'miss (token unset)')
          );
          if (ok) {
            break;
          }
          if (Date.now() - started > maxMs) {
            log.push('wall-clock cap hit');
            break;
          }
        }

        const tokenNow = await tokenPassed();
        const solved = tokenNow ?? lastOk;
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
              text: `${solved ? 'Solved' : 'Not solved'} in ${Math.round((Date.now() - started) / 1000)}s.\n${log.join('\n')}\n${solved ? '' : 'Adjust angleScript or judgeScript (a screenshot of the widget is worth taking), or replace the challenge, then call again. If two rounds miss, hand it to the user.'}`,
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
