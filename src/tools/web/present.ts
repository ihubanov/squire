/**
 * playwright_present — walk a person through a website on screen.
 *
 * Draws an animated spotlight, pointing arrow and caption over the live
 * page, one step at a time. Guided mode (default) waits for the person to
 * do each step; demo mode does the steps itself at human pace with a
 * visible cursor. See src/presenter.ts for the state machine.
 *
 * Unlike the other mutating web tools this deliberately does NOT apply the
 * user-focus guard: presenting to the person on the tab they are looking at
 * is the whole point. Guided mode never acts on the page; demo mode acts
 * only because it was explicitly asked for. Protected tabs stay off-limits.
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { logActivity } from '../../activity-log.js';
import { Tour, type PresentStep } from '../../presenter.js';
import { ensureVisibleBrowser } from '../../visible-browser.js';

/** Tours still on screen, keyed by tour id. */
const tours = new Map<string, Tour>();
const MAX_TOURS = 20;

const stepSchema = z.object({
  selector: z
    .string()
    .optional()
    .describe(
      'CSS selector of the element to spotlight (`xpath=…` / `text=…` prefixes also work). Omit for a caption-only step.'
    ),
  visual: z
    .string()
    .optional()
    .describe(
      'Visible label or position hint ("Sign in", "close X top right") to ground the spotlight via OCR/vision when the DOM has nothing (canvas, PDF viewers).'
    ),
  title: z.string().optional().describe('Short heading for the caption.'),
  text: z
    .string()
    .describe('What to tell the person at this step — one idea, plain words.'),
  action: z
    .enum(['none', 'click', 'fill', 'type', 'hover', 'select', 'press'])
    .optional()
    .describe(
      'What this step does. Demo mode performs it; guided mode leaves it to the person and uses it to pick a default `advance`.'
    ),
  value: z
    .string()
    .optional()
    .describe('Text for fill/type, option value for select (demo mode).'),
  key: z.string().optional().describe('Key for press, e.g. "Enter".'),
  advance: z
    .enum(['next', 'click', 'input', 'navigation'])
    .optional()
    .describe(
      'Guided: what moves on to the next step — the Next button (default), the person clicking the highlighted element, filling it in, or the page navigating. Defaults from `action`: click→click, fill/type/select→input.'
    ),
  readMs: z
    .number()
    .optional()
    .describe(
      'Demo: ms to hold the step on screen before Squire performs it (default 5000).'
    ),
});

export default function present(server: FastMCP): void {
  const schema = z.object({
    steps: z
      .array(stepSchema)
      .optional()
      .describe('The tour, in order. Omit when using `resume` or `stop`.'),
    mode: z
      .enum(['guided', 'demo'])
      .optional()
      .describe(
        'guided (default): point and explain, the person does each step. demo: Squire does the steps itself, slowly, with a visible cursor. Demo never types into password/payment fields — those steps wait for the person.'
      ),
    tab: z
      .string()
      .optional()
      .describe(
        'Stable tab id (from playwright_list_tabs) to present on. Omit for the active tab. The tab is brought to the front.'
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Tour id from a previous call that returned waiting:true — keep waiting for the person.'
      ),
    stop: z
      .string()
      .optional()
      .describe('Tour id to end now; removes the overlay.'),
    waitSeconds: z
      .number()
      .min(5)
      .max(600)
      .optional()
      .describe(
        'Guided: how long this call waits for the person before returning waiting:true (default 120). The overlay stays up meanwhile.'
      ),
    accent: z
      .string()
      .optional()
      .describe(
        'CSS colour for the spotlight, arrow and buttons (default violet).'
      ),
  });

  server.addTool({
    name: 'playwright_present',
    description:
      'Show a person how to do something on a website: an animated spotlight, a pointing arrow and a caption ' +
      'walk them through it step by step on the real page. Use when the user says "show me how…", "where do I…", ' +
      '"walk me through…", "guide me". Default mode "guided" points and explains — the person clicks/types ' +
      'themselves, and the tour advances on their click, their input, or navigation; pressing Next does the ' +
      "step's action for them (never into password/payment/one-time-code fields), and Back undoes a step that " +
      'navigated. Mode "demo" ' +
      'performs the steps itself, slowly, with a visible cursor. Guided calls return waiting:true with a tourId ' +
      'when the person is still busy; call again with `resume` to keep waiting, or `stop` to end it. ' +
      'Tours always run where the person can see them: a headless session is reopened in a visible browser ' +
      'first (same page, cookies and localStorage), and the call fails if no visible browser can open.',
    parameters: schema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (
      args: z.infer<typeof schema>,
      context: any
    ): Promise<ContentResult> => {
      if (args.stop) {
        const tour = tours.get(args.stop);
        if (!tour) {
          throw new Error(`Unknown tour id "${args.stop}" (already ended?).`);
        }
        await tour.stop();
        tours.delete(args.stop);
        logActivity({
          tool: 'playwright_present',
          status: 'ok',
          detail: 'stopped',
        });
        return {
          content: [{ type: 'text', text: `Tour ${args.stop} stopped.` }],
        };
      }

      let tourId: string;
      let tour: Tour;
      let reopened = false;
      if (args.resume) {
        const t = tours.get(args.resume);
        if (!t) {
          throw new Error(
            `Unknown tour id "${args.resume}" (finished, stopped, or never existed).`
          );
        }
        tourId = args.resume;
        tour = t;
      } else {
        if (!args.steps || args.steps.length === 0) {
          throw new Error('Provide `steps`, or a `resume` / `stop` tour id.');
        }
        const driver = getDriver();
        if (!driver || !isPlaywrightDriverSession(driver)) {
          throw new Error(
            'No Playwright web session found. Create a session with platform="web" and headless=false first.'
          );
        }
        let page = driver.page;
        if (args.tab) {
          const p = driver.resolvePage(args.tab);
          if (!p) {
            throw new Error(
              `Unknown tab id "${args.tab}" (it may have been closed). Call playwright_list_tabs for current tab ids.`
            );
          }
          page = p;
        }
        assertNotProtected(page.url(), 'present on');
        ({ page, reopened } = await ensureVisibleBrowser(driver, page));

        // One tour per page: a new one replaces whatever is on screen there.
        for (const [id, t] of tours) {
          if (t.page === page) {
            await t.stop();
            tours.delete(id);
          }
        }
        if (tours.size >= MAX_TOURS) {
          const oldest = tours.keys().next().value;
          if (oldest) {
            await tours.get(oldest)?.stop();
            tours.delete(oldest);
          }
        }
        tour = new Tour(
          page,
          args.steps as PresentStep[],
          args.mode ?? 'guided',
          args.accent
        );
        tourId = randomUUID();
        tours.set(tourId, tour);
      }

      assertNotProtected(tour.page.url(), 'present on');
      let ticks = 0;
      const status = await tour.run((args.waitSeconds ?? 120) * 1000, () => {
        // Keep the client's request alive while the person takes their time.
        ticks++;
        Promise.resolve(context?.reportProgress?.({ progress: ticks })).catch(
          () => {}
        );
      });

      if (tour.done) {
        tours.delete(tourId);
      }

      logActivity({
        tool: 'playwright_present',
        tab: status.finalUrl,
        status: status.failed ? 'error' : 'ok',
        detail: `${status.completed}/${status.total} steps${
          status.stoppedByUser
            ? ' — stopped by user'
            : status.waiting
              ? ' — waiting'
              : ''
        }`,
      });

      let note: string;
      if (status.finished) {
        note = 'Tour finished — the person went through every step.';
      } else if (status.stoppedByUser) {
        note = `The person ended the tour at step ${status.at + 1}.`;
      } else if (status.waiting) {
        note =
          `The person is still on step ${status.at + 1} of ${status.total}; the overlay is still showing. ` +
          `Call playwright_present again with resume:"${tourId}" to keep waiting, or stop:"${tourId}" to end it.`;
      } else if (status.failed) {
        note =
          `Step ${status.at + 1} failed (see steps). The overlay is still showing; fix the cause and ` +
          `resume:"${tourId}", or stop:"${tourId}".`;
      } else {
        note = '';
      }

      if (reopened) {
        note =
          `${note} The session was headless, so the page was reopened in a visible browser first. ` +
          'Earlier tab ids no longer work.';
      }

      const summary = {
        ...(tour.done ? {} : { tourId }),
        ...status,
        note: note.trim(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  });
}
