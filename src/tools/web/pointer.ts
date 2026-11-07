/**
 * Raw pointer tools: report where an element is, move the cursor there, and
 * drag it along an arc.
 *
 * Playwright's normal click/hover land on an element's centre, which is
 * useless for circular controls: a rotation dial (custom captchas, knob
 * sliders, radial pickers) has to be pressed on its rim and dragged round.
 * These drive the real mouse by viewport coordinate, so they work on any
 * widget regardless of its site, framework or element structure.
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { elementUUIDScheme } from '../../schema.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registers playwright_element_box, playwright_move and playwright_drag_arc. */
export default function pointer(server: FastMCP): void {
  // ── Where is it? ────────────────────────────────────────────────
  const boxSchema = z.object({ elementUUID: elementUUIDScheme });

  server.addTool({
    name: 'playwright_element_box',
    description:
      'Report an element’s position and size on screen (viewport pixels): {x, y, width, height}. Use the centre for circular controls and with playwright_drag_arc. Fails if the element is off-screen or hidden.',
    parameters: boxSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (
      args: z.infer<typeof boxSchema>
    ): Promise<ContentResult> => {
      const driver = requireDriver();
      assertNotProtected(driver.page.url(), 'measure');
      await assertNotUserFocused(driver.page, 'measure');
      try {
        const el = driver.requireElement(args.elementUUID);
        const box = await el.boundingBox();
        if (!box) {
          return {
            content: [
              {
                type: 'text',
                text: `Element ${args.elementUUID} has no box — it is hidden, detached, or scrolled out of view.`,
              },
            ],
          };
        }
        const centre = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...box, centre }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to measure ${args.elementUUID}. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });

  // ── Move the cursor ─────────────────────────────────────────────
  const moveSchema = z.object({
    x: z.number().describe('Viewport x in CSS pixels'),
    y: z.number().describe('Viewport y in CSS pixels'),
    steps: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe('Intermediate hops (default 8)'),
    stepDelayMs: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('Pause between hops (default 12)'),
  });

  server.addTool({
    name: 'playwright_pointer_move',
    description:
      'Move the real mouse cursor to a viewport coordinate in several small hops, without pressing. Use it to hover a control before pressing, or to park the cursor away before a drag.',
    parameters: moveSchema,
    annotations: { readOnlyHint: false, openWorldHint: false },
    execute: async (
      args: z.infer<typeof moveSchema>
    ): Promise<ContentResult> => {
      const driver = requireDriver();
      assertNotProtected(driver.page.url(), 'move the pointer on');
      await assertNotUserFocused(driver.page, 'move the pointer on');
      const steps = args.steps ?? 8;
      const delay = args.stepDelayMs ?? 12;
      // Playwright does not expose the current cursor position, so start from
      // the last point we moved to in this session, or assume the origin.
      const from = lastPoint ?? { x: 0, y: 0 };
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await driver.page.mouse.move(
          from.x + (args.x - from.x) * t,
          from.y + (args.y - from.y) * t
        );
        if (delay) {
          await sleep(delay);
        }
      }
      lastPoint = { x: args.x, y: args.y };
      logActivity({
        tool: 'playwright_pointer_move',
        tab: driver.page.url(),
        status: 'ok',
      });
      return {
        content: [
          { type: 'text', text: `Pointer moved to ${args.x}, ${args.y}.` },
        ],
      };
    },
  });

  // ── Drag along an arc ───────────────────────────────────────────
  const arcSchema = z.object({
    elementUUID: elementUUIDScheme
      .optional()
      .describe('Circular control to use as the centre (its box centre)'),
    handleUUID: elementUUIDScheme
      .optional()
      .describe(
        'Grab knob/handle element. The press starts at its box centre and its current angle from the centre becomes the start angle, so only endAngle is needed. Overrides radius for the grab point.'
      ),
    centerX: z
      .number()
      .optional()
      .describe('Centre x (used when elementUUID is omitted)'),
    centerY: z
      .number()
      .optional()
      .describe('Centre y (used when elementUUID is omitted)'),
    radius: z
      .number()
      .min(1)
      .optional()
      .describe(
        'Distance from the centre to grab at, in px. Default: 75% of the control’s half-size, so the grab lands on the rim.'
      ),
    startAngle: z
      .number()
      .optional()
      .describe(
        'Angle to press at, degrees. 0 = 3 o’clock, 90 = 6 o’clock, 180 = 9 o’clock (clockwise). Default: the handle’s current angle, or 0 without a handleUUID.'
      ),
    endAngle: z
      .number()
      .describe('Angle to release at, degrees, same convention.'),
    direction: z
      .enum(['shortest', 'cw', 'ccw'])
      .optional()
      .describe(
        'Which way round to travel: shortest (default), or forced clockwise / counter-clockwise.'
      ),
    steps: z
      .number()
      .int()
      .min(2)
      .max(720)
      .optional()
      .describe(
        'Intermediate moves (default ≈ one per 2° of travel, min 24, max 180)'
      ),
    stepDelayMs: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('Pause between moves, ms (default 16 ≈ one frame)'),
    holdAtEndMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe(
        'Pause with the button still down at the end angle before releasing (default 60)'
      ),
  });

  server.addTool({
    name: 'playwright_drag_arc',
    description:
      'Press the mouse on a circle and drag it round to another angle, releasing there. For rotation dials and radial controls that respond to absolute angle from their centre, not to a click. Drives the real pointer in small continuous moves, so the widget sees every intermediate angle (when the control re-checks on movement, the end angle alone is not enough). Angles: 0° = 3 o’clock, 90° = 6 o’clock, 180° = 9 o’clock, positive = clockwise.',
    parameters: arcSchema,
    annotations: { readOnlyHint: false, openWorldHint: false },
    execute: async (
      args: z.infer<typeof arcSchema>
    ): Promise<ContentResult> => {
      const driver = requireDriver();
      assertNotProtected(driver.page.url(), 'drag on');
      await assertNotUserFocused(driver.page, 'drag on');

      try {
        let cx = args.centerX;
        let cy = args.centerY;
        let radius = args.radius;
        if (args.elementUUID) {
          const box = await driver
            .requireElement(args.elementUUID)
            .boundingBox();
          if (!box) {
            throw new Error(
              'control has no box — hidden, detached, or off-screen'
            );
          }
          cx = box.x + box.width / 2;
          cy = box.y + box.height / 2;
          radius ??= Math.min(box.width, box.height) * 0.375;
        }
        if (cx === undefined || cy === undefined) {
          throw new Error('pass elementUUID, or both centerX and centerY');
        }

        // A handle element gives both the grab point and the true start angle
        // — no need for the caller to guess a radius or read the current
        // rotation. Press exactly on the knob first, then ease onto its arc.
        let grab: { x: number; y: number } | undefined;
        let startAngle = args.startAngle;
        if (args.handleUUID) {
          const hb = await driver.requireElement(args.handleUUID).boundingBox();
          if (!hb) {
            throw new Error(
              'handle has no box — hidden, detached, or off-screen'
            );
          }
          grab = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
          const dx = grab.x - cx;
          const dy = grab.y - cy;
          radius = Math.hypot(dx, dy) || (radius ?? 40);
          startAngle ??= (Math.atan2(dy, dx) * 180) / Math.PI;
        }
        startAngle ??= 0;
        radius ??= 40;

        // Travel the requested way round, allowing more than one turn.
        let delta = args.endAngle - startAngle;
        if (args.direction === 'cw') {
          while (delta <= 0) {
            delta += 360;
          }
        } else if (args.direction === 'ccw') {
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

        const steps =
          args.steps ??
          Math.max(24, Math.min(180, Math.ceil(Math.abs(delta) / 2)));
        const delay = args.stepDelayMs ?? 16;
        const hold = args.holdAtEndMs ?? 60;

        const end = await arcDrag(driver.page, {
          cx,
          cy,
          radius,
          startAngle,
          delta,
          steps,
          delay,
          hold,
          grab,
        });

        logActivity({
          tool: 'playwright_drag_arc',
          tab: driver.page.url(),
          status: 'ok',
          detail: `${startAngle.toFixed(0)}° → ${(startAngle + delta).toFixed(0)}° (${steps} steps)`,
        });
        return {
          content: [
            {
              type: 'text',
              text:
                `Dragged from ${startAngleLabel(startAngle)} to ${startAngleLabel(startAngle + delta)} ` +
                `(${Math.abs(delta).toFixed(0)}° ${delta >= 0 ? 'clockwise' : 'counter-clockwise'}, ` +
                `${steps} moves, centre ${cx.toFixed(0)},${cy.toFixed(0)} r=${radius.toFixed(0)}). ` +
                `Released at ${end.x.toFixed(0)},${end.y.toFixed(0)}.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to drag arc. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export interface ArcDrag {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  delta: number;
  steps: number;
  delay: number;
  hold: number;
  grab?: { x: number; y: number };
}

/**
 * Press, ease onto the circle, travel the arc in `steps` real moves, hold,
 * release. Shared by playwright_drag_arc and the captcha loop. Returns the
 * release point.
 */
export async function arcDrag(
  page: import('playwright').Page,
  o: ArcDrag
): Promise<{ x: number; y: number }> {
  const start = pointOnArc(o.cx, o.cy, o.radius, o.startAngle);
  const pressAt = o.grab ?? start;
  await page.mouse.move(pressAt.x, pressAt.y);
  lastPoint = pressAt;
  await sleep(Math.max(o.delay, 20));
  await page.mouse.down();

  // Ease from the knob centre onto the circle before turning.
  if (o.grab) {
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      await page.mouse.move(
        o.grab.x + (start.x - o.grab.x) * t,
        o.grab.y + (start.y - o.grab.y) * t
      );
      if (o.delay) {
        await sleep(o.delay);
      }
    }
  }

  for (let i = 1; i <= o.steps; i++) {
    const p = pointOnArc(
      o.cx,
      o.cy,
      o.radius,
      o.startAngle + (o.delta * i) / o.steps
    );
    await page.mouse.move(p.x, p.y);
    lastPoint = p;
    if (o.delay) {
      await sleep(o.delay);
    }
  }
  if (o.hold) {
    await sleep(o.hold);
  }

  const end = pointOnArc(o.cx, o.cy, o.radius, o.startAngle + o.delta);
  await page.mouse.up();
  lastPoint = end;
  return end;
}

/** One point on the circle. Angle in degrees, 0 = 3 o'clock, positive = clockwise (y grows down). */
function pointOnArc(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function requireDriver() {
  const driver = getDriver();
  if (!driver || !isPlaywrightDriverSession(driver)) {
    throw new Error(
      'No Playwright web session found. Create a session with platform="web" first.'
    );
  }
  return driver;
}

/** Last cursor position, so a move can interpolate from somewhere sensible. */
let lastPoint: { x: number; y: number } | null = null;

function startAngleLabel(angle: number): string {
  const a = ((angle % 360) + 360) % 360;
  return `${a.toFixed(0)}°`;
}
