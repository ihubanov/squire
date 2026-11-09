/**
 * Captcha solve loop for one captcha type: the rotation dial (a.k.a.
 * rotate-the-disc / radial slider). Behind APPIUM_MCP_CAPTCHA.
 *
 * Written against the captcha *type*, not one site: everything is selector-
 * and script-driven, so the same tool serves any widget of this kind.
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
import { cueText } from '../../watch.js';
import { judge as hunchJudge } from '../../hunch/client.js';
import { hunchEnabled } from '../../hunch/sidecar.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registers playwright_captcha_solve. */
export default function captcha(server: FastMCP): void {
  const schema = z.object({
    dial: z
      .string()
      .describe(
        'CSS selector of the dial body of a rotate-the-disc captcha (rotation dial / radial slider — the only captcha type this tool solves): the disc or its rotation track, e.g. "#dial" or ".rotation-disc".'
      ),
    handle: z
      .string()
      .optional()
      .describe(
        'CSS selector of the knob riding the disc rim, e.g. "#handle". Its current bearing gives the start angle and its box centre the press point. Omit it when the knob is not an element (a range-input thumb, a canvas sprite) and let angleScript return startAngle/radius/grab instead. Its box alone is wrong for a range thumb: that box spans the whole track. Also drop it when a cursor-hotspot knob on screen has no computable cursor — a `<input type=range>` thumb with `cursor: auto` reports nothing, so derive the grab from the control value instead.'
      ),
    angleScript: z
      .string()
      .describe(
        'JS run in the widget frame before each attempt; returns the next end angle in degrees, or { angle, direction } ("cw" | "ccw" | "shortest"). It may also return { startAngle, radius, grab } to override the dial geometry: startAngle and radius in the same convention as playwright_drag_arc, grab as {x, y} px from the dial box top-left. Use those when the knob is not an element, and derive the grab from live state every call (a range input value mapped along its track) — the script is re-run when a drag has to be repeated, so a stale constant grab would press the wrong place. Keep any search-window state in a window variable so it shrinks as attempts go on. Land the final precision in `angle`: a drag is absolute (startAngle from live state to `angle` in one press), so deltas do not have to accumulate across presses, and on widgets that re-fit or redraw themselves nothing set by an earlier press survives — a sequence of small corrections is a sequence of absolute drags, never wheel ticks that add up. Return `confidence` (0–1) when the fit is scored from evidence (spread and peak of candidate answers): the tool logs it, and with minAngleConfidence a low value asks for a new picture instead of spending a hopeless drag.'
      ),
    successScript: z
      .string()
      .optional()
      .describe(
        'JS run in the main frame after each attempt; truthy when the captcha passed. Prefer the token field ("the hidden response field now has a value") over the picture. Optional when judgeScript is given, but keep it when one exists — it is the reliable half of the verdict. Test a value that only exists after success (a now-revealed number or token), not a wrapper\'s innerText: dialogs keep their static strings ("the code expired") in that text at all times, so it never distinguishes a pass.'
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
        'Challenges that expire (a signed image URL, roughly a minute) get replaced when the current one is older than this: the refresh control is clicked and the clock resets. Default 55000. Cards that hand out a stable per-session token are safe to keep much longer (20 s is comfortable); a per-image URL is the case that needs a short value.'
      ),
    settleScript: z
      .string()
      .optional()
      .describe(
        'JS run in the widget frame, polled until truthy: the widget has finished moving and has accepted the drag. Use it wherever a load animation can overwrite a value set mid-flight, or the widget records a "user moved it" flag that submit refuses without. Polled after a refresh and after every drag; a drag that never settles is repeated (twice) before the attempt is judged, and counts as a miss unless successScript passes. Keep the check on live state (control value equals the target AND the widget\'s own touched flag), with the target stashed by angleScript in a window variable.'
      ),
    settleTimeoutMs: z
      .number()
      .int()
      .min(200)
      .max(10_000)
      .optional()
      .describe(
        'How long settleScript may stay falsy before a drag counts as unrecorded (default 2500).'
      ),
    minAngleConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Gate on the confidence angleScript reports. Below it, the challenge is refreshed rather than dragged: an adversarial puzzle whose fit is a coin toss is a burnt attempt, and a fresh picture is cheaper. Agreement between candidate answers should drive that number, not peak — on a live widget a genuine fit peaks lower than a hopeless one can, so a peak-only floor vetoes good drags. Around 0.35 is a sensible gate. Costs one attempt per refresh, and does nothing without `refresh` (the drag proceeds; only the log records the low value).'
      ),
    identityScript: z
      .string()
      .optional()
      .describe(
        "JS run in the main frame; returns a stable string that names the current challenge (a session token in a hidden field, an image src). Read before the drag and again before judging: a picture replaced mid-attempt makes the screenshot meaningless, so the score is skipped and the attempt counts as a miss. Use a value that outlives image fetches — a per-image URL is replaced by the widget's own refresh, not by this."
      ),
    hunchGate: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Opt in to the local vision judge (hunch) on top of judgeScript — omitted by default, so the shipped path stays score-based. judgeScript reports where things are; hunch reads a calibrated probability that they are actually aligned, and a crop scoring P below this is a miss however generous the pixel score was. Only ever turns a pass into a miss — never the reverse. A live hunch call costs ~40s while the puzzle can expire in ~60s, so it is a gate for careful runs, not the default. Needs SQUIRE_HUNCH_BACKEND_URL (a vLLM serving a vision model with logprobs); without it the gate is inert and the log records "vision unavailable", and SQUIRE_HUNCH=0 disables it outright. A-B the gate against plain judgeScript before trusting a threshold.'
      ),
    hunchQuestion: z
      .string()
      .optional()
      .describe(
        'Yes/no question hunch is asked about the crop. Default: "Is the dark seam line in the middle of the dial perfectly aligned with the notch at the top?" Rephrase it for other widgets.'
      ),
  });

  server.addTool({
    name: 'playwright_captcha_solve',
    description:
      'Solve a rotation-dial (rotate-the-disc / radial slider) captcha by dragging it round. Repeats: read the next angle from angleScript, drag the knob there with real pointer moves, screenshot the widget and score it with judgeScript (and/or check successScript), re-show and refresh, then stop when it passes. Each press is absolute (live start angle to target in one drag), so nothing has to accumulate between presses; a fit the script rates low can buy a new picture with minAngleConfidence instead of a hopeless drag. Selector- and script-driven, so it is not tied to any site. Use playwright_frames first to find the widget frame, and playwright_evaluate for one-off probes.',
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
      const settleTimeout = args.settleTimeoutMs ?? 2500;
      const minConfidence = args.minAngleConfidence;
      const frame =
        args.frame === undefined
          ? driver.page.mainFrame()
          : driver.resolveFrame(driver.page, args.frame);
      const log: string[] = [];
      const started = Date.now();
      let challengeAt = started;
      let lastOk = false;
      // Drags the widget threw back. Each repeat starts from a fresh solve, so
      // the widget's own state has been reset in between: a score read after a
      // repeat is a new baseline, not an improvement on the previous one.
      let repeats = 0;
      const scores: number[] = [];

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
       * The current challenge's identity, when the page offers one. Some
       * widgets swap the picture mid-flow; a score taken after that is of a
       * puzzle that no longer exists.
       */
      const identity = async (): Promise<string | undefined> => {
        if (!args.identityScript) {
          return undefined;
        }
        try {
          const v = await driver.page.mainFrame().evaluate(args.identityScript);
          return v === undefined || v === null ? undefined : String(v);
        } catch {
          return undefined;
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
        handleBox:
          { x: number; y: number; width: number; height: number } | undefined,
        angle: number,
        attempt: number
      ): Promise<{
        ok: boolean;
        note: string;
        score?: number;
        strip?: string;
      }> => {
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
            score: verdict,
            strip: image,
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
            score: typeof v.score === 'number' ? v.score : undefined,
            strip: image,
          };
        }
        return {
          ok: Boolean(verdict),
          note: `judge ${JSON.stringify(verdict)}`,
          strip: image,
        };
      };

      /**
       * Polls settleScript until the widget is quiet. Without a
       * settleScript there is nothing to wait for, so this is true at once.
       */
      const waitSettled = async (capMs = settleTimeout): Promise<boolean> => {
        if (!args.settleScript) {
          return true;
        }
        const deadline = Date.now() + capMs;
        while (Date.now() < deadline) {
          try {
            if (await frame.evaluate(args.settleScript)) {
              return true;
            }
          } catch {
            // The widget is mid-swap and its nodes are gone for a moment.
          }
          await sleep(120);
        }
        return false;
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
        const b = await locator.boundingBox().catch(() => null);
        await cueText(
          driver.page,
          why,
          'click',
          b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
          700
        );
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

          if (await tokenPassed()) {
            log.push('passed before the next drag');
            break;
          }

          // Which picture this attempt is scoring, so a mid-drag swap is
          // noticed before the screenshot is spent on a stale puzzle.
          const challengeId = await identity();

          const cx = dialBox.x + dialBox.width / 2;
          const cy = dialBox.y + dialBox.height / 2;
          const bearing = (p: { x: number; y: number }) =>
            (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
          let handleBox:
            { x: number; y: number; width: number; height: number } | undefined;

          /**
           * Asks for the next angle, works out the knob geometry and drags.
           * Run again when a drag did not settle: the knob has moved by then,
           * so the grab has to come from fresh state rather than the first
           * calculation.
           */
          type AngleAnswer = {
            angle?: number;
            direction?: string;
            startAngle?: number;
            radius?: number;
            grab?: { x?: number; y?: number };
            confidence?: number;
            confidenceNote?: string;
          };

          const aimAndDrag = async (seed?: AngleAnswer) => {
            const out =
              seed ?? ((await frame.evaluate(args.angleScript)) as unknown);
            const next = (
              typeof out === 'number' ? { angle: out } : (out ?? {})
            ) as AngleAnswer;
            if (!next || typeof next.angle !== 'number') {
              log.push(
                `angleScript returned ${JSON.stringify(out)} — no angle to try`
              );
              return undefined;
            }

            // The angleScript may describe the knob itself, because a knob is
            // not always an element (a range-input thumb has no box of its own —
            // the input's box spans the whole track). Anything it gives wins;
            // a handle element only fills in what is left.
            let startAngle =
              typeof next.startAngle === 'number' ? next.startAngle : undefined;
            let radius =
              typeof next.radius === 'number' ? next.radius : undefined;
            let grab: { x: number; y: number } | undefined =
              next.grab &&
              typeof next.grab.x === 'number' &&
              typeof next.grab.y === 'number'
                ? // Offsets are relative to the dial box, so the frame's own
                  // offset and the page scroll both stay out of the caller's
                  // way.
                  { x: dialBox.x + next.grab.x, y: dialBox.y + next.grab.y }
                : undefined;
            if (grab && startAngle === undefined) {
              startAngle = bearing(grab);
            }
            if (!grab && args.handle) {
              handleBox = await box(args.handle);
              grab = {
                x: handleBox.x + handleBox.width / 2,
                y: handleBox.y + handleBox.height / 2,
              };
              radius ??= Math.hypot(grab.x - cx, grab.y - cy) || 40;
              startAngle ??= bearing(grab);
            }
            startAngle ??= 0;
            // No knob geometry at all: grab the rim, which is right for a dial
            // whose rim is the control.
            radius ??= Math.min(dialBox.width, dialBox.height) * 0.375;

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
            const steps = Math.max(
              40,
              Math.min(180, Math.ceil(Math.abs(delta)))
            );

            // A widget that was just reloaded or re-shown animates into
            // place, and setting a value before it finishes is how the drag
            // gets silently discarded. Held after the angleScript so a state
            // check can compare against the target it just stashed, and
            // capped short: a "has the user moved it" flag is false until
            // the drag lands, so waiting the full timeout here is wasted.
            if (!(await waitSettled(Math.min(settleTimeout, 800)))) {
              log.push(
                `attempt ${attempt}: dial never settled before the press — dragging anyway`
              );
            }

            await cueText(
              driver.page,
              `set rotation to ${Math.round(next.angle)}°`,
              'input',
              {
                x: dialBox.x,
                y: dialBox.y,
                w: dialBox.width,
                h: dialBox.height,
              },
              700
            );

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
            return { angle: next.angle, startAngle, steps };
          };

          // One solve up front, so a fit that is not worth dragging can be
          // gated before the press. The press itself is absolute: from the
          // live start angle to this answer in one drag.
          const first = (await frame.evaluate(args.angleScript)) as unknown;
          const seed = (
            typeof first === 'number' ? { angle: first } : (first ?? {})
          ) as AngleAnswer;
          const confidence =
            typeof seed.confidence === 'number' ? seed.confidence : undefined;
          if (confidence !== undefined) {
            log.push(
              `attempt ${attempt}: angle fit confidence ${confidence.toFixed(2)}` +
                (typeof seed.confidenceNote === 'string'
                  ? ` (${seed.confidenceNote})`
                  : '')
            );
          }
          if (
            minConfidence !== undefined &&
            confidence !== undefined &&
            confidence < minConfidence
          ) {
            // An adversarial puzzle with a coin-toss fit burns the attempt
            // either way; a fresh picture is the cheaper try. The attempt
            // counter still moves, so refreshes cannot loop forever.
            if (
              args.refresh &&
              (await clickIfPresent(args.refresh, 'refresh'))
            ) {
              log.push(
                `attempt ${attempt}: fit ${confidence.toFixed(2)} < ${minConfidence} — refreshed instead of dragging`
              );
              challengeAt = Date.now();
              continue;
            }
            log.push(
              `attempt ${attempt}: weak fit and ${
                args.refresh
                  ? 'the refresh control did not take'
                  : 'no refresh control'
              } — dragging anyway`
            );
          }

          let moved = await aimAndDrag(seed);
          if (!moved) {
            break;
          }
          // The widget may still be animating, or refuse to record a value set
          // mid-flight. Repeat the drag until it takes (twice at most); the
          // second call re-reads the knob position from live state.
          let settled = await waitSettled();
          for (let retry = 0; retry < 2 && !settled; retry++) {
            log.push(
              `attempt ${attempt}: drag not recorded yet — repeating (${retry + 1}/2)`
            );
            repeats++;
            // Fresh solve, never the angle that just failed: the widget has
            // reset its own base in between, so the old start angle is stale
            // and reusing it lands in the same place again.
            const again = await aimAndDrag();
            if (!again) {
              break;
            }
            moved = again;
            settled = await waitSettled();
          }
          if (!settled) {
            log.push(
              'dial never settled — the widget may have discarded the drag'
            );
          }

          // The widget replaced the picture while being dragged: the crop
          // below is a puzzle the angle was never aimed at, so skip the
          // vision pass — the token still decides if it turned up anyway.
          const replaced =
            challengeId !== undefined && (await identity()) !== challengeId;
          if (replaced) {
            log.push(
              `attempt ${attempt}: the picture was replaced mid-attempt — score skipped`
            );
          }

          const captureBox = args.capture ? await box(args.capture) : dialBox;
          await sleep(hold);
          const verdict: {
            ok: boolean;
            note: string;
            score?: number;
            strip?: string;
          } = replaced
            ? { ok: false, note: 'picture replaced mid-attempt' }
            : await judged(
                captureBox,
                dialBox,
                handleBox,
                moved.angle,
                attempt
              );
          if (typeof verdict.score === 'number') {
            scores.push(verdict.score);
          }
          // Second, independent opinion on the same crop. judgeScript says
          // where the parts are; hunch says whether they line up, with a
          // number that means the same thing on every picture. It may only
          // veto a pass, never manufacture one, and a hunch failure is
          // "unknown" — the judgeScript verdict stands.
          if (args.hunchGate !== undefined && verdict.strip && verdict.ok) {
            if (!hunchEnabled()) {
              verdict.note = [verdict.note, 'vision unavailable']
                .filter(Boolean)
                .join(' — ');
            } else {
              const v = await hunchJudge({
                images: [verdict.strip],
                checks: {
                  seam: {
                    kind: 'yesno',
                    question:
                      args.hunchQuestion ??
                      'Is the dark seam line in the middle of the dial perfectly aligned with the notch at the top?',
                  },
                },
              });
              const p = v.ok ? v.results.seam?.p_yes : undefined;
              if (p === undefined) {
                verdict.note = [verdict.note, 'vision unavailable']
                  .filter(Boolean)
                  .join(' — ');
              } else {
                const gate = args.hunchGate;
                const vetoed = verdict.ok && p < gate;
                verdict.note = [
                  verdict.note,
                  `vision ${p.toFixed(2)} (gate ${gate})${vetoed ? ' — vetoed' : ''}`,
                ]
                  .filter(Boolean)
                  .join(' — ');
                if (vetoed) {
                  verdict.ok = false;
                }
              }
            }
          }
          const token = await tokenPassed();
          // The token is authoritative when it exists; a picture score that
          // disagrees is worth reporting, not obeying. An unsettled dial
          // cannot count as a pass on the picture alone: the crop can look
          // right while the widget never accepted the value.
          const ok = token === undefined ? verdict.ok && settled : token;
          lastOk = ok;
          log.push(
            `attempt ${attempt}: ${moved.startAngle.toFixed(0)}° → ${moved.angle.toFixed(0)}° (${moved.steps} moves) — ` +
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
          // A miss burns this picture: the next attempt should solve a new
          // puzzle, not re-guess one the widget already rejected. An expired
          // picture is replaced by its own age check anyway, so only ask for a
          // refresh when the picture is still current.
          if (args.refresh && (await clickIfPresent(args.refresh, 'refresh'))) {
            log.push(
              `attempt ${attempt}: miss — fresh puzzle for the next try`
            );
            challengeAt = Date.now();
            await sleep(settle);
          }
        }

        // The same score on every attempt is a geometry signal, not an angle
        // one: the press keeps landing on the same wrong pixels.
        if (scores.length >= 2 && new Set(scores).size === 1) {
          log.push(
            `every attempt scored ${scores[0].toFixed(3)} — suspect the grab (the press may be missing the control), not the angle` +
              (repeats > 0
                ? '; a repeated drag resets the widget to its own base, so the score after one is a new baseline and its being unchanged is expected'
                : '')
          );
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
