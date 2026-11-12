/**
 * Cloudflare Turnstile solver. Behind APPIUM_MCP_CAPTCHA.
 *
 * Two surfaces are discriminated before anything is pressed: an embedded
 * Turnstile widget (a host `.cf-turnstile` / `[data-sitekey]` element, or the
 * challenge iframe / `#challenge-stage`) versus a Cloudflare WAF interstitial
 * (`#challenge-form`, `/cdn-cgi/challenge-platform/…`, no widget host). On a
 * widget the solver waits briefly for a silent managed pass, then presses the
 * checkbox through the widget frame's shadow root when one is exposed. On an
 * interstitial it waits for the challenge iframe and reloads the challenge
 * traffic inside a wall-clock cap.
 *
 * A token is only a token: once the widget reports success, the token is
 * written into the response field *before* the page callback is invoked, so a
 * host submit that reads the field never sees null. A callback that already
 * fired with a value is never invoked a second time.
 *
 * Manual recipe (deterministic, no live-site risk): embed
 * `<div class="cf-turnstile" data-sitekey="3x00000000000000000000FF"></div>`
 * with `https://challenges.cloudflare.com/turnstile/v0/api.js`, open it, and
 * call this tool until the gate opens. Test sitekeys: `1x…AA` always passes
 * (visible), `2x…AB` always passes (invisible), `2x…BB` always fails (visible),
 * `3x…FF` forces interaction. A passing `3x` proves the press path; a live
 * site still needs a warmed profile because Cloudflare scores headless traffic
 * worse.
 */
import { createHash } from 'node:crypto';
import type { ContentResult, FastMCP } from 'fastmcp';
import type { Frame } from 'playwright';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';
import { cueText } from '../../watch.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cloudflare's documented test sitekeys, for the harness and manual runs. */
export const TURNSTILE_TEST_KEYS = {
  alwaysPassVisible: '1x00000000000000000000AA',
  alwaysPassInvisible: '2x00000000000000000000AB',
  alwaysFailsVisible: '2x00000000000000000000BB',
  forcesInteraction: '3x00000000000000000000FF',
} as const;

const FRAME_SELECTORS = [
  '.cf-turnstile iframe',
  'iframe.cf-challenge',
  '#challenge-stage iframe',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="cdn-cgi/challenge-platform"]',
  'iframe[src*="turnstile"]',
];

const CHECKBOX_CANDIDATES =
  'input[type="checkbox"], [role="checkbox"], .cb-c, #challenge-stage input, #challenge-stage button, button, label';

interface SurfaceProbe {
  host: boolean;
  iframe: boolean;
  waf: boolean;
  url: string;
  sitekey: string | null;
}

/**
 * Vendor text/aria error code → taxonomy + action. The numeric codes are
 * Cloudflare's client-side error codes; `timeout-or-duplicate` is the siteverify
 * replay answer and `chl-missing` means the challenge payload never loaded.
 */
const ERROR_PATTERNS: Array<[RegExp, string, 'abort' | 'retry' | 'reload']> = [
  [/\b110200\b/, 'domain_mismatch', 'abort'],
  [/\bchl-missing\b/, 'chl_missing', 'reload'],
  [/\btimeout-or-duplicate\b/, 'timeout_or_duplicate', 'retry'],
  [/\b110620\b/, 'interaction_timeout', 'retry'],
  [/\b110600\b/, 'challenge_timeout', 'retry'],
  [/\b200500\b/, 'iframe_blocked', 'retry'],
  [/\b600010\b/, 'challenge_failure', 'retry'],
  [/\b(300\d{3}|600\d{3})\b/, 'bot_detected', 'retry'],
  [/\binternal\b/i, 'provider_error', 'retry'],
];

function classifyError(
  text: string
): { code: string; action: string } | undefined {
  for (const [pattern, code, action] of ERROR_PATTERNS) {
    if (pattern.test(text)) {
      return { code, action };
    }
  }
  return undefined;
}

/** Registers playwright_captcha_turnstile. */
export default function captchaTurnstile(server: FastMCP): void {
  const schema = z.object({
    frame: z
      .union([z.string(), z.number().int().min(0)])
      .optional()
      .describe(
        'Frame holding the Turnstile widget, from playwright_frames. Default: auto-resolve the challenge iframe from the host element, frame URL, or documented iframe classes.'
      ),
    sitekey: z
      .string()
      .optional()
      .describe(
        'Expected data-sitekey, checked when one is present so a wrong widget is reported instead of pressed. The documented test keys are 1x00000000000000000000AA (always passes, visible), 2x00000000000000000000AB (always passes, invisible), 2x00000000000000000000BB (always fails, visible) and 3x00000000000000000000FF (forces interaction).'
      ),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe(
        'Press/reset rounds before giving up (default and cap: 5). A token timeout, an interaction timeout, a challenge failure or an internal error retries; a domain mismatch aborts immediately.'
      ),
    tokenTtlMs: z
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .optional()
      .describe(
        'How long a press may take to produce a non-empty cf-turnstile-response token (default 15000). Expiry is a retry, not a pass.'
      ),
    maxMs: z
      .number()
      .int()
      .min(5_000)
      .optional()
      .describe('Wall-clock cap for the whole call (default 90000).'),
    submit: z
      .string()
      .optional()
      .describe(
        'CSS selector of the host submit control, clicked after a token is captured. Off by default so the caller keeps control of submission.'
      ),
    revealToken: z
      .boolean()
      .optional()
      .describe(
        'Return the full token instead of a redacted head/tail. The page keeps the full value either way.'
      ),
  });

  server.addTool({
    name: 'playwright_captcha_turnstile',
    description:
      'Solve a Cloudflare Turnstile widget or a Cloudflare WAF interstitial. Discriminates the embedded widget (.cf-turnstile/[data-sitekey], challenge iframe, #challenge-stage) from an interstitial (#challenge-form, /cdn-cgi/challenge-platform/, no widget); widget mode presses the checkbox inside the widget frame\'s shadow root after a short silent managed-pass wait, interstitial mode waits for the challenge iframe and reloads the challenge traffic within a wall-clock cap. Writes the token into cf-turnstile-response (or data-response-field-name) before invoking the page callback, never double-invokes a callback that already fired, maps 110200/600010/timeout-or-duplicate/chl-missing/internal and 300x/600x to abort, retry or reload, caps retries at 5 and the call at 90s by default. Manual, deterministic gate: embed <div class="cf-turnstile" data-sitekey="3x00000000000000000000FF"></div> with https://challenges.cloudflare.com/turnstile/v0/api.js and call until the gate opens (1x00000000000000000000AA always passes; 3x00000000000000000000FF forces the click path).',
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

      const maxAttempts = args.maxAttempts ?? 5;
      const tokenTtl = args.tokenTtlMs ?? 15_000;
      const maxMs = args.maxMs ?? 90_000;
      const page = driver.page;
      const main = page.mainFrame();
      const log: string[] = [];
      const started = Date.now();
      const deadline = started + maxMs;
      let attempts = 0;
      let surface: 'widget' | 'interstitial' | undefined;
      let frame: Frame | undefined;

      const blocked = (code: string, note: string): ContentResult => {
        log.push(`${code}: ${note}`);
        logActivity({
          tool: 'playwright_captcha_turnstile',
          tab: page.url(),
          status: 'error',
          detail: `${code}: ${note}`.slice(0, 200),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Captcha turnstile: not solved (${attempts} attempt${attempts === 1 ? '' : 's'}) — ${code}\n${log.join('\n')}`,
            },
          ],
        };
      };

      const readSurface = async (): Promise<SurfaceProbe | undefined> => {
        try {
          return await main.evaluate(() => {
            const visible = (el: Element | null) => {
              if (!el) {
                return false;
              }
              const b = el.getBoundingClientRect();
              return b.width > 0 && b.height > 0;
            };
            const host = document.querySelector(
              '.cf-turnstile[data-sitekey], .cf-turnstile, [data-sitekey]'
            );
            const iframe = document.querySelector(
              '.cf-turnstile iframe, iframe.cf-challenge, #challenge-stage iframe, iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"]'
            );
            return {
              host: visible(host),
              iframe: visible(iframe),
              waf: !!document.querySelector('#challenge-form'),
              url: location.href,
              sitekey: host?.getAttribute('data-sitekey') ?? null,
            };
          });
        } catch {
          return undefined;
        }
      };

      const resolveFrame = async (): Promise<Frame> => {
        if (args.frame !== undefined) {
          return driver.resolveFrame(page, args.frame);
        }
        for (const f of page.frames()) {
          const url = f.url();
          if (
            url.includes('challenges.cloudflare.com') ||
            url.includes('/cdn-cgi/challenge-platform/')
          ) {
            return f;
          }
        }
        for (const selector of FRAME_SELECTORS) {
          // count() is immediate; elementHandle() alone waits 30 s for a
          // selector that matches nothing.
          const locator = main.locator(selector).first();
          if (!(await locator.count())) {
            continue;
          }
          const handle = await locator.elementHandle();
          if (handle) {
            const child = await handle.contentFrame();
            if (child) {
              return child;
            }
          }
        }
        throw new Error('turnstile_widget_frame_missing');
      };

      /**
       * Finds and presses the checkbox, piercing open shadow roots breadth
       * first. Coordinates are frame-relative, so the frame element's viewport
       * offset is added for the real mouse. A widget whose checkbox is not
       * exposed is a typed failure, not a hang.
       */
      const pressCheckbox = async (widgetFrame: Frame): Promise<void> => {
        const hit = (await widgetFrame.evaluate((candidates) => {
          const roots: Array<Document | ShadowRoot> = [document];
          const seen = new Set<Document | ShadowRoot>();
          const find = (
            root: Document | ShadowRoot
          ): { x: number; y: number; label: string } | null => {
            const el = root.querySelector(candidates) as HTMLElement | null;
            if (!el) {
              return null;
            }
            const b = el.getBoundingClientRect();
            if (b.width <= 0 || b.height <= 0) {
              return null;
            }
            return {
              x: b.x + b.width / 2,
              y: b.y + b.height / 2,
              label: (el.getAttribute('aria-label') || el.textContent || '')
                .trim()
                .slice(0, 40),
            };
          };
          for (let i = 0; i < roots.length; i++) {
            const root = roots[i];
            if (seen.has(root)) {
              continue;
            }
            seen.add(root);
            const found = find(root);
            if (found) {
              return found;
            }
            for (const el of Array.from(root.querySelectorAll('*'))) {
              const shadow = (el as HTMLElement).shadowRoot;
              if (shadow) {
                roots.push(shadow);
              }
            }
          }
          return null;
        }, CHECKBOX_CANDIDATES)) as {
          x: number;
          y: number;
          label: string;
        } | null;
        if (!hit) {
          throw new Error('turnstile_widget_detected_but_checkbox_not_exposed');
        }
        let offsetX = 0;
        let offsetY = 0;
        const element = await widgetFrame.frameElement().catch(() => null);
        const box = element
          ? await element.boundingBox().catch(() => null)
          : null;
        if (box) {
          offsetX = box.x;
          offsetY = box.y;
        }
        const x = offsetX + hit.x;
        const y = offsetY + hit.y;
        log.push(
          `attempt ${attempts}: pressing checkbox${hit.label ? ` "${hit.label}"` : ''} at ${Math.round(x)},${Math.round(y)}`
        );
        await cueText(page, 'press the Turnstile checkbox', 'click', {
          x,
          y,
          w: 24,
          h: 24,
        });
        await page.mouse.move(x, y, { steps: 8 });
        await sleep(80 + Math.random() * 120);
        await page.mouse.down();
        await sleep(50 + Math.random() * 70);
        await page.mouse.up();
      };

      /** Installs the callback shim without clobbering a previous attempt's state. */
      const installShim = async () => {
        try {
          await main.evaluate(() => {
            const win = window as unknown as Record<string, any>;
            const el = document.querySelector(
              '.cf-turnstile[data-sitekey], [data-sitekey]'
            );
            const name = el?.getAttribute('data-callback') ?? null;
            const previous = win.__squireTurnstile;
            win.__squireTurnstile =
              previous && previous.name === name
                ? previous
                : { name, fired: false, token: null };
            if (!name) {
              return;
            }
            const original = win[name];
            if (typeof original !== 'function' || original.__squire) {
              return;
            }
            const wrapped = (token: unknown) => {
              win.__squireTurnstile.fired = true;
              if (typeof token === 'string' && token) {
                win.__squireTurnstile.token = token;
              }
              return original(token);
            };
            wrapped.__squire = true;
            win[name] = wrapped;
          });
        } catch {
          // A page with no callback is fine; the field is then the only signal.
        }
      };

      const readState = async (widgetFrame: Frame | undefined) => {
        const state = await main.evaluate(() => {
          const win = window as unknown as Record<string, any>;
          const shim = win.__squireTurnstile ?? {};
          const el = document.querySelector(
            '.cf-turnstile[data-sitekey], [data-sitekey]'
          );
          const fieldName =
            el?.getAttribute('data-response-field-name') ??
            'cf-turnstile-response';
          const field = document.querySelector(
            `input[name="${fieldName}"], textarea[name="${fieldName}"]`
          ) as HTMLInputElement | null;
          return {
            shimToken: typeof shim.token === 'string' ? shim.token : '',
            fired: !!shim.fired,
            fieldToken: field?.value ?? '',
            fieldFound: !!field,
            fieldName,
            body: document.body?.innerText ?? '',
          };
        });
        let vendorText = '';
        if (widgetFrame) {
          try {
            vendorText = await widgetFrame.evaluate(() => {
              // Error text can live behind the widget's shadow root, which is
              // absent from innerText, so walk it explicitly.
              const parts: string[] = [];
              const walk = (root: Document | ShadowRoot) => {
                parts.push(root.textContent ?? '');
                for (const el of Array.from(root.querySelectorAll('*'))) {
                  const shadow = (el as HTMLElement).shadowRoot;
                  if (shadow) {
                    walk(shadow);
                  }
                }
              };
              walk(document);
              return parts.join('\n');
            });
          } catch {
            // The frame may be mid-navigation.
          }
        }
        return {
          ...state,
          token: state.shimToken || state.fieldToken,
          text: `${vendorText}\n${state.body}`,
        };
      };

      /**
       * Writes the token into the response field first, then invokes the
       * callback once. A callback that already fired with a value is left
       * alone (only the field is repaired).
       */
      const finalize = async (token: string) =>
        main.evaluate((value) => {
          const win = window as unknown as Record<string, any>;
          const shim = win.__squireTurnstile ?? {};
          const el = document.querySelector(
            '.cf-turnstile[data-sitekey], [data-sitekey]'
          );
          const fieldName =
            el?.getAttribute('data-response-field-name') ??
            'cf-turnstile-response';
          const field = document.querySelector(
            `input[name="${fieldName}"], textarea[name="${fieldName}"]`
          ) as HTMLInputElement | null;
          let wrote = false;
          if (field && !field.value) {
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            wrote = true;
          }
          const preFired =
            shim.fired &&
            typeof shim.token === 'string' &&
            shim.token.length > 0;
          if (preFired) {
            return { callback: 'pre-fired', wrote };
          }
          if (shim.name && typeof win[shim.name] === 'function') {
            win[shim.name](value);
            return { callback: 'invoked', wrote };
          }
          return { callback: shim.name ? 'callback-missing' : 'none', wrote };
        }, token);

      /** Best-effort provider reset: turnstile.reset(), then a Try again control. */
      const reset = async () => {
        let reset = false;
        try {
          reset = await main.evaluate(() => {
            const win = window as unknown as Record<string, any>;
            const api = win.turnstile;
            if (api && typeof api.reset === 'function') {
              try {
                api.reset();
                return true;
              } catch {
                return false;
              }
            }
            return false;
          });
        } catch {
          // Detached during navigation.
        }
        if (!reset) {
          const control = main
            .locator(
              "#challenge-stage button, button[value='Try again'], text=Try again"
            )
            .first();
          if (await control.count().catch(() => 0)) {
            await control.click({ timeout: 2_000 }).catch(() => {});
            reset = true;
          }
        }
        return reset;
      };

      try {
        // ── Detection (read-only) ──────────────────────────────────
        let probe = await readSurface();
        if (!probe) {
          return blocked(
            'widget_missing',
            'the main frame could not be inspected (navigation?)'
          );
        }
        if (probe.sitekey && args.sitekey && probe.sitekey !== args.sitekey) {
          return blocked(
            'sitekey_mismatch',
            `expected ${args.sitekey}, found ${probe.sitekey}`
          );
        }
        // A host container means a widget. Without one, #challenge-form or a
        // challenge-platform URL is an interstitial even once its (hostless)
        // challenge iframe is on screen — that iframe is not a widget.
        if (probe.host) {
          surface = 'widget';
        } else if (
          probe.waf ||
          probe.url.includes('/cdn-cgi/challenge-platform/')
        ) {
          surface = 'interstitial';
        } else if (probe.iframe) {
          surface = 'widget';
        }
        if (!surface) {
          return blocked(
            'widget_missing',
            `no Turnstile widget, challenge iframe, or #challenge-form on ${probe.url}`
          );
        }
        log.push(`surface: ${surface}`);

        // An interstitial may still be mounting its iframe: wait, and reload
        // the challenge traffic inside a short cap instead of pressing air.
        if (surface === 'interstitial') {
          const cap = Math.min(10_000, deadline - Date.now());
          const until = Date.now() + cap;
          while (Date.now() < until && !(probe.iframe || probe.host)) {
            await sleep(300);
            probe = await readSurface();
            if (!probe) {
              break;
            }
          }
          if (!probe || !(probe.iframe || probe.host)) {
            let reloaded = 0;
            while (reloaded < 2 && Date.now() < deadline) {
              reloaded++;
              log.push(
                `interstitial iframe missing — reloading (${reloaded}/2)`
              );
              await page
                .reload({
                  waitUntil: 'domcontentloaded',
                  timeout: Math.min(15_000, deadline - Date.now()),
                })
                .catch(() => {});
              await sleep(700);
              probe = await readSurface();
              if (probe && (probe.iframe || probe.host)) {
                break;
              }
            }
            if (!probe || !(probe.iframe || probe.host)) {
              return blocked(
                'waf_interstitial',
                'challenge page replaced the site and its iframe never appeared'
              );
            }
          }
        }

        await installShim();

        // ── Press / token loop ─────────────────────────────────────
        let failure: string | undefined;
        let token = '';
        let callback = 'none';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (Date.now() > deadline) {
            failure = 'timeout';
            log.push('wall-clock cap hit');
            break;
          }
          attempts = attempt;
          await installShim();
          frame = await resolveFrame().catch(() => undefined);
          if (!frame) {
            failure = 'turnstile_widget_frame_missing';
            log.push(`attempt ${attempt}: widget frame vanished`);
            break;
          }

          try {
            await pressCheckbox(frame);
          } catch (err: any) {
            failure = String(err?.message ?? err).replace(/^Error: /, '');
            log.push(`attempt ${attempt}: ${failure}`);
            if (failure.includes('checkbox_not_exposed')) {
              break;
            }
            await sleep(400 + Math.random() * 400);
            continue;
          }

          // Poll for a token, watching the callback shim too. A Success!
          // state without a readable token yet gets extra patience: the host
          // callback is allowed to arrive before the field is written.
          const until = Math.min(Date.now() + tokenTtl, deadline);
          let error: { code: string; action: string } | undefined;
          while (Date.now() < until) {
            const state = await readState(frame);
            if (state.token) {
              token = state.token;
              break;
            }
            error = classifyError(state.text);
            if (error) {
              break;
            }
            if (/Success!/i.test(state.text)) {
              await sleep(400);
            } else {
              await sleep(200);
            }
          }
          if (token) {
            const result = await finalize(token);
            callback = result.callback;
            log.push(
              `attempt ${attempt}: token ${token.length} chars — callback ${callback}${result.wrote ? ', field written' : ''}`
            );
            break;
          }
          if (!error) {
            const state = await readState(frame).catch(() => undefined);
            error = state ? classifyError(state.text) : undefined;
          }
          if (!error) {
            error = { code: 'token_absent', action: 'retry' };
          }
          log.push(
            `attempt ${attempt}: ${error.code}${error.action === 'abort' ? ' — aborting' : ''}`
          );
          if (error.action === 'abort') {
            failure = error.code;
            break;
          }
          if (error.action === 'reload') {
            await page
              .reload({
                waitUntil: 'domcontentloaded',
                timeout: Math.min(15_000, deadline - Date.now()),
              })
              .catch(() => {});
            await sleep(700);
            await installShim();
            continue;
          }
          failure = error.code;
          if (attempt < maxAttempts) {
            await reset();
            await sleep(400 + Math.random() * 800);
          }
        }

        if (!token) {
          logActivity({
            tool: 'playwright_captcha_turnstile',
            tab: page.url(),
            status: 'error',
            detail: `${failure ?? 'not_solved'}: ${log.join(' | ')}`.slice(
              0,
              200
            ),
          });
          return {
            content: [
              {
                type: 'text',
                text: `Captcha turnstile: not solved (${attempts} attempt${attempts === 1 ? '' : 's'}) — ${failure ?? 'not_solved'}\n${log.join('\n')}\nRetry the call (the token is single-use); if a domain mismatch is reported, the sitekey does not belong to this host.`,
              },
            ],
          };
        }

        // Optional host submit, only after the callback/field are in place.
        let submitted = false;
        if (args.submit) {
          const control = main.locator(args.submit).first();
          if (await control.count().catch(() => 0)) {
            await cueText(page, 'submit the token', 'click', null);
            await control.click({ timeout: 3_000 }).catch(() => {});
            await page
              .waitForLoadState('domcontentloaded', { timeout: 3_000 })
              .catch(() => {});
            submitted = true;
            log.push('submit clicked');
          } else {
            log.push(`no submit element (${args.submit})`);
          }
        }

        const sha = createHash('sha256')
          .update(token)
          .digest('hex')
          .slice(0, 12);
        const shown = args.revealToken
          ? token
          : `${token.slice(0, 6)}…${token.slice(-4)}`;
        logActivity({
          tool: 'playwright_captcha_turnstile',
          tab: page.url(),
          status: 'ok',
          detail: `${attempts} attempt(s), callback ${callback}, token ${token.length}`,
        });
        const evidence = {
          provider: 'turnstile',
          status: 'solved',
          surface,
          attempts,
          callback,
          submitted,
          token: {
            sha,
            len: token.length,
            value: shown,
            field: undefined,
          },
          failure: null,
        };
        return {
          content: [
            {
              type: 'text',
              text: `Captcha turnstile: solved (${attempts} attempt${attempts === 1 ? '' : 's'}, ${Date.now() - started}ms) — ${surface}, token + ${callback} callback\n${log.join('\n')}\n${JSON.stringify(evidence)}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Captcha turnstile stopped. Error: ${err.toString()}\n${log.join('\n')}`,
            },
          ],
        };
      }
    },
  });
}
