/**
 * playwright_run_script — drive a page like a human in one call.
 *
 * Runs an ordered list of steps with two properties a raw evaluate lacks:
 * it survives navigations (a form submit no longer aborts the rest of the
 * script), and it falls back to a humanised, hidden-element-revealing path
 * only when the normal fast path hits a wall. It stops on the first failing
 * step and returns per-step results plus a continuation id, so the caller
 * can inspect the damage and resume, adjust, or abandon.
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';
import { runScript, type Step } from '../../human-driver.js';

/** Remaining-steps parked for a later `resume`, keyed by continuation id. */
const pending = new Map<string, Step[]>();
// Bound the parked set so a caller that never resumes can't leak memory.
const MAX_PENDING = 50;

const stepSchema = z.object({
  action: z.enum([
    'fill',
    'click',
    'type',
    'press',
    'hover',
    'select',
    'scrollTo',
    'reveal',
    'wait',
    'eval',
    'upload',
  ]),
  selector: z
    .string()
    .optional()
    .describe(
      'CSS selector; also accepts Playwright `xpath=…` / `text=…` prefixes.'
    ),
  text: z.string().optional().describe('Text for fill/type.'),
  key: z.string().optional().describe('Key for press, e.g. "Enter", "Tab".'),
  value: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Value(s) for select.'),
  ms: z.number().optional().describe('Milliseconds for wait.'),
  waitFor: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'navigation'])
    .optional()
    .describe('Page state / navigation to await for a wait step.'),
  script: z.string().optional().describe('JavaScript body for an eval step.'),
  files: z
    .array(z.string())
    .optional()
    .describe(
      'Absolute paths of local files for an upload step. Its selector may be the ' +
        '<input type=file> (hidden is fine) or the button that opens the file picker; ' +
        'scope it to the open dialog, since some sites leave stale file inputs elsewhere.'
    ),
  visual: z
    .string()
    .optional()
    .describe(
      'What the control LOOKS like, for when DOM selectors fail (canvas, WebGL, embedded viewers, images). ' +
        'Two forms: a visible text label ("Sign in") — grounded via OCR, and refined to the detected control region ' +
        'when an icon detector is configured; or, for icon-only controls with no readable text, a position hint ' +
        '("hamburger menu icon top left", "close X top right", "play button center") — grounded via the icon detector ' +
        'within that screen zone. Works for click/fill/type steps only.'
    ),
});

export default function runScriptTool(server: FastMCP): void {
  const schema = z.object({
    steps: z
      .array(stepSchema)
      .optional()
      .describe(
        'Ordered steps to run in one go. Each is attempted the normal fast way first; ' +
          'if it hits a wall (hidden/not-actionable/intercepted) and humanize allows, it ' +
          'escalates to a human path that reveals the element (unhides ancestors, pierces ' +
          'shadow DOM, scrolls into view), paces input, and can dispatch the event in-page. ' +
          'Navigations mid-script are absorbed automatically — a form submit no longer aborts ' +
          'the remaining steps. Omit when using `resume`.'
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Continuation id from a prior run that stopped early — resumes its remaining steps.'
      ),
    humanize: z
      .enum(['auto', 'always', 'never'])
      .optional()
      .describe(
        'auto (default): normal first, human fallback only on a wall. always: human path every step. never: normal only, fail instead of falling back.'
      ),
    stopOnError: z
      .boolean()
      .optional()
      .describe(
        'Stop on the first failing step and return a continuation (default true).'
      ),
    pauseAfter: z
      .number()
      .optional()
      .describe(
        'Hand control back after this many successful steps, returning a continuation for the rest.'
      ),
    stepTimeout: z
      .number()
      .optional()
      .describe('Per-step normal-attempt timeout in ms (default 5000).'),
    tab: z
      .string()
      .optional()
      .describe(
        'Stable tab id (from playwright_list_tabs) to run this script against. ' +
          'Omit to use the AI-active tab. Targeting a tab id drives that tab DIRECTLY ' +
          'without changing the active-tab pointer or foregrounding it — so several ' +
          'tabs can be driven independently/concurrently without interfering.'
      ),
  });

  server.addTool({
    name: 'playwright_run_script',
    description:
      "Drive the AI's active tab through a sequence of steps in one call, like a human would. " +
      'Survives page navigations (form submits no longer abort the rest of the script) and falls ' +
      'back to a humanised, hidden-element-revealing path only when the normal fast path fails — ' +
      'useful for modals/menus that a plain click cannot reach. Returns per-step results; on a ' +
      'failing step it stops and hands back a `continuationId` you can pass as `resume` to pick up ' +
      'where it left off after you adjust. Prefer this over chaining many single-action tools when ' +
      'a flow (login, multi-field form, open-menu-then-click) should run as one human-like unit. ' +
      'An upload step puts local files into a file input or the file picker a button opens.',
    parameters: schema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (
      args: z.infer<typeof schema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      // Resolve the step list: either resumed or freshly supplied.
      let steps: Step[];
      if (args.resume) {
        const parked = pending.get(args.resume);
        if (!parked) {
          throw new Error(
            `Unknown continuation id "${args.resume}" (already resumed, expired, or never existed).`
          );
        }
        pending.delete(args.resume);
        steps = parked;
      } else if (args.steps && args.steps.length > 0) {
        steps = args.steps as Step[];
      } else {
        throw new Error(
          'Provide `steps` to run, or a `resume` continuation id.'
        );
      }

      // Resolve the target tab: an explicit stable id, or the active page.
      // Targeting a tab id drives that (possibly background) tab directly,
      // leaving the active-tab pointer untouched so concurrent per-tab runs
      // don't clobber each other.
      let targetPage = driver.page;
      if (args.tab) {
        const p = driver.resolvePage(args.tab);
        if (!p) {
          throw new Error(
            `Unknown tab id "${args.tab}" (it may have been closed). Call playwright_list_tabs for current tab ids.`
          );
        }
        targetPage = p;
      }
      const targetTabId = driver.getTabId(targetPage);

      // Fail fast against the target page before we start.
      assertNotProtected(targetPage.url(), 'run script on');
      await assertNotUserFocused(targetPage, 'run script on');

      const result = await runScript(targetPage, steps, {
        humanize: args.humanize,
        stopOnError: args.stopOnError,
        pauseAfter: args.pauseAfter,
        stepTimeout: args.stepTimeout,
      });

      let continuationId: string | undefined;
      if (!result.finished && result.remaining && result.remaining.length > 0) {
        // Evict oldest parked run if we're at the cap.
        if (pending.size >= MAX_PENDING) {
          const oldest = pending.keys().next().value;
          if (oldest) {
            pending.delete(oldest);
          }
        }
        continuationId = randomUUID();
        pending.set(continuationId, result.remaining);
      }

      const failed = result.results.find((r) => r.status === 'failed');
      logActivity({
        tool: 'playwright_run_script',
        tab: result.finalUrl,
        status: result.finished ? 'ok' : failed ? 'error' : 'ok',
        detail: `${result.completed}/${result.total} steps${failed ? ` — failed at #${failed.index} (${failed.action})` : ''}`,
      });

      const summary = {
        finished: result.finished,
        completed: result.completed,
        total: result.total,
        tab: targetTabId,
        finalUrl: result.finalUrl,
        ...(continuationId ? { continuationId } : {}),
        ...(result.remaining ? { remaining: result.remaining.length } : {}),
        steps: result.results,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  });
}
