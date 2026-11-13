/**
 * Google reCAPTCHA solver: v2 checkbox + image/audio challenge, and v3 token
 * capture. Registered by default (APPIUM_MCP_CAPTCHA=0 removes it); also
 * reachable through playwright_captcha_solve with provider="recaptcha".
 *
 * On an image grid the tool classes the tiles with the configured vision
 * endpoint (see captcha-vision.ts), presses the matching ones, verifies, and
 * re-solves each fresh round until a token appears. Without a vision endpoint
 * it falls back to returning the PNG and every tile's geometry as
 * `needs_answer`, exactly as before; a caller-supplied `tiles` or
 * `tilesScript` always wins. Audio clips are downloaded and handed to an
 * external audioScript for transcription; no local ASR dependency is shipped.
 *
 * v3 is passive: a token is captured and returned, but the score is only
 * evaluated server-side, so the result is always "unverified — no score
 * assertion", never a claimed pass.
 *
 * Manual run recipe (APPlUM_MCP_CAPTCHA=1, a web session on the demo page):
 *   v2 on https://recaptcha-demo.appspot.com/recaptcha-v2-checkbox.php — the
 *   real Google demo, a fresh session gets an image grid. Call and it solves.
 *   v2 always-challenge key (sitekey
 *   6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe) on a fixture page.
 *   v3 on https://recaptcha-demo.appspot.com/recaptcha-v3-verify.php with
 *   sitekey 6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI (test key: always a
 *   token, score is returned by the demo backend, not by this tool).
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import type { Frame, Page } from 'playwright';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';
import { cueText } from '../../watch.js';
import { pickTiles, pickTilesPerTile, visionConfig } from './captcha-vision.js';
import type { TileSampler } from './captcha-sampling.js';
import { makeSamplingSampler } from './captcha-sampling.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Google's documented test keys, for the manual harness only. */
export const RECAPTCHA_TEST_KEYS = {
  v2AlwaysPasses: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
  v2AlwaysChallenges: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
  v3: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
} as const;

export type RecaptchaFailureCode =
  | 'no_session'
  | 'widget_missing'
  | 'anchor_unchecked'
  | 'challenge_timeout'
  | 'challenge_expired'
  | 'tiles_rejected'
  | 'anchor_alert'
  | 'bot_suspected'
  | 'retry_cap'
  | 'token_absent'
  | 'needs_answer'
  | 'script_error'
  | 'audio_unavailable'
  | 'audio_failed'
  | 'timeout';

/** A failure the caller can branch on. */
export class RecaptchaError extends Error {
  constructor(
    readonly code: RecaptchaFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'RecaptchaError';
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Tile extends Box {
  index: number;
  /** Position inside the returned challenge image, for vision mapping. */
  imageX: number;
  imageY: number;
}

interface GridCapture {
  type: 'grid';
  frame: Frame;
  prompt: string;
  image: string;
  imageBox: Box;
  tiles: Tile[];
  /** Page scroll when the capture was taken, for follow-up tile crops. */
  scroll: { x: number; y: number };
}

interface AudioCapture {
  type: 'audio';
  frame: Frame;
  prompt: string;
  url: string;
}

type Challenge = GridCapture | AudioCapture;

const ANCHOR_SELECTOR = 'iframe[title="reCAPTCHA"]';
const ANCHOR_ANY_SELECTOR = 'iframe[title*="reCAPTCHA"]';
const CHALLENGE_SELECTOR = 'iframe[title*="challenge" i]';
/** The grid panel. Google's live DOM uses this; `.rc-imageselect` is only
 *  the jest fixture's shorthand and does not exist in the real widget. */
const GRID_PANEL =
  '.rc-imageselect-payload, #rc-imageselect-target, .rc-imageselect';
const ANCHOR_CHECKBOX = '#recaptcha-anchor, .recaptcha-checkbox-border';
const VERIFY_BUTTON = '#recaptcha-verify-button';
const RELOAD_BUTTON = '#recaptcha-reload-button';
const AUDIO_BUTTON = '.rc-button-audio';
const AUDIO_DOWNLOAD = '.rc-audiochallenge-tdownload-link, a[href*=".mp3"]';
const AUDIO_INPUT = '#audio-response';
const TOKEN_SELECTOR =
  'textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"], ' +
  '#g-recaptcha-response, [name="g-recaptcha-response"]';

const READ_TOKEN = `(() => {
  const el = document.querySelector(${JSON.stringify(TOKEN_SELECTOR)});
  return el && 'value' in el ? String(el.value || '').trim() : '';
})()`;

/** Smallest box containing all of them. */
function unionBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Centre of a box, nudged off dead-centre the way a human lands. */
function pressPoint(box: Box): { x: number; y: number } {
  return {
    x: box.x + box.width * (0.42 + Math.random() * 0.16),
    y: box.y + box.height * (0.42 + Math.random() * 0.16),
  };
}

/** Real pointer moves, hover, press, short hold, release. */
async function humanClick(page: Page, box: Box): Promise<void> {
  const p = pressPoint(box);
  await page.mouse.move(p.x, p.y, { steps: 10 });
  await sleep(80 + Math.random() * 120);
  await page.mouse.down();
  await sleep(40 + Math.random() * 60);
  await page.mouse.up();
}

async function boxOf(frame: Frame, selector: string): Promise<Box> {
  const locator = frame.locator(selector).first();
  try {
    await locator.waitFor({ state: 'attached', timeout: 3000 });
  } catch {
    throw new RecaptchaError(
      'widget_missing',
      `no element for selector ${selector} in the challenge frame`
    );
  }
  const handle = await locator.elementHandle();
  const box = await handle?.boundingBox();
  if (!box) {
    throw new RecaptchaError(
      'widget_missing',
      `element ${selector} has no box (hidden or off-screen)`
    );
  }
  return box;
}

async function countOf(frame: Frame, selector: string): Promise<number> {
  return frame.locator(selector).count();
}

/** Waits for a selector in a frame, returning false on timeout. */
async function present(
  frame: Frame,
  selector: string,
  timeout: number
): Promise<boolean> {
  try {
    await frame
      .locator(selector)
      .first()
      .waitFor({ state: 'attached', timeout });
    return true;
  } catch {
    return false;
  }
}

const gridTileCount = (frame: Frame) =>
  frame.evaluate(
    () =>
      document.querySelectorAll('.rc-imageselect-tile').length ||
      document.querySelectorAll('.rc-imageselect-table td').length
  );

async function chooseSelector(frame: Frame): Promise<string> {
  return (await gridTileCount(frame)) > 0
    ? '.rc-imageselect-tile'
    : '.rc-imageselect-table td';
}

async function anchorChecked(frame: Frame): Promise<boolean> {
  try {
    return await frame.evaluate(() => {
      const a = document.querySelector('#recaptcha-anchor');
      return a?.getAttribute('aria-checked') === 'true';
    });
  } catch {
    return false;
  }
}

async function readPrompt(frame: Frame): Promise<string> {
  try {
    return (await frame.evaluate(
      () =>
        document
          .querySelector(
            '.rc-imageselect-desc-no-canonical, ' +
              '.rc-imageselect-desc, .rc-audiochallenge-instructions'
          )
          ?.textContent?.trim() ?? ''
    )) as string;
  } catch {
    return '';
  }
}

/**
 * The instruction sentence alone. Google appends a hint ("If there are none,
 * click skip" / "Click verify once there are none left") inside the same
 * element, and a vision prompt reads better without it.
 */
export function cleanPrompt(text: string): string {
  return text
    .replace(
      /\s*(?:If there are none,?\s*click skip|Click verify once there are none left)\s*$/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

async function errorText(anchor: Frame | null, frame: Frame | null) {
  const parts: string[] = [];
  if (anchor) {
    try {
      const t = await anchor.evaluate(
        () => document.querySelector('.rc-anchor-alert')?.textContent ?? ''
      );
      if (t) {
        parts.push(String(t));
      }
    } catch {
      // frame detached mid-swap
    }
  }
  if (frame) {
    try {
      parts.push(
        (await frame.evaluate(() => document.body?.innerText ?? '')) as string
      );
    } catch {
      // frame detached mid-swap
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Registers playwright_captcha_recaptcha. */
export const recaptchaSchema = z.object({
  mode: z
    .enum(['auto', 'v2', 'v3'])
    .optional()
    .describe(
      'Challenge kind. "auto" (default) uses v2 when an anchor iframe exists and v3 when only grecaptcha is exposed. "v2" covers checkbox, image grid and the audio fallback. "v3" is passive: it executes and returns a token, never a pass.'
    ),
  sitekey: z
    .string()
    .optional()
    .describe(
      'reCAPTCHA sitekey, needed only for v3/invisible where it cannot be read from the page. Google test keys: v2 always passes 6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI; v2 always challenges 6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe; v3 uses the first.'
    ),
  action: z.string().optional().describe('v3 action name (default "submit").'),
  enterprise: z
    .boolean()
    .optional()
    .describe('Use grecaptcha.enterprise instead of grecaptcha (v3).'),
  frame: z
    .union([z.string(), z.number().int().min(0)])
    .optional()
    .describe(
      'Frame override for the anchor when auto-discovery is ambiguous (index or URL substring, from playwright_frames).'
    ),
  tiles: z
    .array(z.number().int().min(0))
    .optional()
    .describe(
      'Tile indices (0-based, row-major) to press for the current grid image. Usually taken from a previous call that returned the challenge and `needs_answer`.'
    ),
  tilesScript: z
    .string()
    .optional()
    .describe(
      'JS run inside the challenge frame with { image, width, height, tiles, prompt, attempt }. Understands the returned capture and presses the chosen tiles, and may return an array of tile indices instead (the tool then presses them). It should press #recaptcha-verify-button when it is done pressing; returning an array makes the tool press tiles and verify. The loop captures again after a rejected selection, up to 5 retries.'
    ),
  audio: z
    .boolean()
    .optional()
    .describe(
      'Prefer the audio challenge instead of the image grid. Without audioScript the clip URL is returned for the caller.'
    ),
  audioScript: z
    .string()
    .optional()
    .describe(
      'JS run inside the challenge frame with { url, attempt }; downloads/transcribes the audio clip and returns the text. The tool fills #audio-response and presses verify.'
    ),
  maxAttempts: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Challenge retry cap (default 5, as asked).'),
  maxMs: z
    .number()
    .int()
    .min(5_000)
    .optional()
    .describe('Wall-clock cap for the whole call (default 90000).'),
  verifyMs: z
    .number()
    .int()
    .min(1_000)
    .optional()
    .describe('How long to wait for a token after a press (default 8000).'),
  vision: z
    .boolean()
    .optional()
    .describe(
      'Solve image grids with the configured vision endpoint (or MCP sampling when no endpoint is configured) instead of returning them as `needs_answer`. Default: on when APPIUM_MCP_CAPTCHA_VLM_URL, a claude-local hunch config, or a sampling-capable MCP client is present; this option set to false disables both. A caller-supplied `tiles`/`tilesScript` still wins.'
    ),
  visionMs: z
    .number()
    .int()
    .min(5_000)
    .optional()
    .describe('Timeout for one vision classification call (default 45000).'),
});

/**
 * Skips the checkbox, solves the challenge, and returns a token when the page
 * accepts it. Shared by playwright_captcha_recaptcha and the provider dispatch
 * in playwright_captcha_solve.
 */
export async function solveRecaptcha(
  args: z.infer<typeof recaptchaSchema>,
  /** Answers tile grids through the client's model when no local endpoint is set. */
  sampler?: TileSampler,
  /**
   * Receives the run log. The caller passes the same array it gave the
   * sampler's failure note, so a rejected sampling reply shows up in the
   * tool output instead of only "no usable answer".
   */
  log: string[] = []
): Promise<ContentResult> {
  const driver = getDriver();
  if (!driver || !isPlaywrightDriverSession(driver)) {
    throw new RecaptchaError(
      'no_session',
      'No Playwright web session found. Create a session with platform="web" first.'
    );
  }
  const page = driver.page;
  assertNotProtected(page.url(), 'drive a captcha in');
  await assertNotUserFocused(page, 'drive a captcha in');

  const mode = args.mode ?? 'auto';
  const maxAttempts = args.maxAttempts ?? 5;
  const maxMs = args.maxMs ?? 90_000;
  const verifyMs = args.verifyMs ?? 8000;
  const vision = args.vision === false ? null : visionConfig();
  // The local endpoint wins; sampling is the zero-config fallback.
  const sample = args.vision === false || vision ? undefined : sampler;
  const hasVision = Boolean(vision || sample);
  const started = Date.now();
  let lastFailure: RecaptchaError | undefined;
  let anchor: Frame | null = null;

  const mainEval = <T>(fn: string | ((a: never) => T), arg?: unknown) =>
    arg === undefined
      ? page.mainFrame().evaluate(fn as never)
      : page.mainFrame().evaluate(fn as never, arg as never);

  const resolveAnchor = async (): Promise<Frame> => {
    if (args.frame !== undefined) {
      return driver.resolveFrame(page, args.frame);
    }
    const locator = page.mainFrame().locator(ANCHOR_SELECTOR).first();
    let handle = (await locator.count()) ? await locator.elementHandle() : null;
    if (!handle) {
      handle = await page
        .mainFrame()
        .locator(ANCHOR_ANY_SELECTOR)
        .first()
        .elementHandle();
    }
    if (!handle) {
      throw new RecaptchaError(
        'widget_missing',
        'no reCAPTCHA anchor iframe — is the widget rendered, or is this a v3 page?'
      );
    }
    const frame = await handle.contentFrame();
    if (!frame) {
      throw new RecaptchaError(
        'widget_missing',
        'anchor iframe has no content frame yet'
      );
    }
    return frame;
  };

  const resolveChallenge = async (): Promise<Frame | null> => {
    const locator = page.mainFrame().locator(CHALLENGE_SELECTOR).first();
    // count() is immediate; elementHandle() alone waits 30 s, which would
    // make every "no challenge yet" poll block for the whole test budget.
    if (!(await locator.count())) {
      return null;
    }
    const handle = await locator.elementHandle();
    if (!handle) {
      return null;
    }
    return handle.contentFrame();
  };

  const finish = (
    status: 'pass' | 'unverified' | 'needs_answer' | 'not_solved',
    tokenValue: string,
    mode: string,
    _log: string[],
    _started: number,
    failure: RecaptchaError | undefined,
    extra: Record<string, unknown> = {}
  ): ContentResult => {
    logActivity({
      tool: 'playwright_captcha_recaptcha',
      tab: page.url(),
      status: status === 'pass' || status === 'unverified' ? 'ok' : 'error',
      detail: `${status}${failure ? ` — ${failure.code}` : ''}`,
    });
    return result(status, tokenValue, mode, log, started, failure, extra);
  };

  const token = async (): Promise<string> =>
    String((await mainEval(READ_TOKEN)) ?? '');

  const waitToken = async (ms: number): Promise<string> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const t = await token().catch(() => '');
      if (t) {
        return t;
      }
      await sleep(150);
    }
    return '';
  };

  const clickIn = async (frame: Frame, selector: string, why: string) => {
    const box = await boxOf(frame, selector);
    await cueText(
      page,
      why,
      'click',
      { x: box.x, y: box.y, w: box.width, h: box.height },
      700
    );
    await humanClick(page, box);
  };

  const capture = async (frame: Frame): Promise<Challenge | null> => {
    if (await present(frame, GRID_PANEL, 4000)) {
      const tileSelector = await chooseSelector(frame);
      const panelBox = await boxOf(frame, GRID_PANEL);
      const prompt = cleanPrompt(await readPrompt(frame));
      const scroll = (await mainEval(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }))) as { x: number; y: number };
      const boxes: Array<Box & { index: number }> = [];
      const handles = frame.locator(tileSelector);
      const n = await handles.count();
      for (let i = 0; i < n; i++) {
        const handle = await handles.nth(i).elementHandle();
        const b = await handle?.boundingBox();
        if (!b) {
          continue;
        }
        boxes.push({ index: i, ...b });
      }
      // Crop to the tiles, not the whole panel: the panel carries Google's
      // instruction header, which the prompt already states and which
      // misleads the model about where the grid starts. A tile union also
      // keeps a 4x4 image at the true row/column geometry.
      const imageBox = boxes.length ? unionBox(boxes) : panelBox;
      const clip = {
        x: Math.max(0, Math.floor(imageBox.x + scroll.x)),
        y: Math.max(0, Math.floor(imageBox.y + scroll.y)),
        width: Math.max(1, Math.ceil(imageBox.width)),
        height: Math.max(1, Math.ceil(imageBox.height)),
      };
      const png = await page.screenshot({ clip, type: 'png' });
      const tiles: Tile[] = boxes.map((b) => ({
        ...b,
        imageX: b.x - imageBox.x,
        imageY: b.y - imageBox.y,
      }));
      return {
        type: 'grid',
        frame,
        prompt,
        image: `data:image/png;base64,${png.toString('base64')}`,
        imageBox,
        tiles,
        scroll,
      };
    }
    if (await present(frame, '.rc-audiochallenge', 1000)) {
      const prompt = await readPrompt(frame);
      const link = frame.locator(AUDIO_DOWNLOAD).first();
      const url = (await link.count())
        ? await link.getAttribute('href')
        : (await present(frame, 'audio', 1000))
          ? await frame.locator('audio').first().getAttribute('src')
          : null;
      if (!url) {
        throw new RecaptchaError(
          'audio_unavailable',
          'audio challenge shown but no clip URL found'
        );
      }
      return { type: 'audio', frame, prompt, url };
    }
    return null;
  };

  const reload = async (frame: Frame) => {
    if (await present(frame, RELOAD_BUTTON, 1000)) {
      await clickIn(frame, RELOAD_BUTTON, 'reload challenge');
      await sleep(300);
    }
  };

  /** Maps challenge text to a typed failure and a retry decision. */
  const classify = async (
    frame: Frame
  ): Promise<{ retry: boolean; error?: RecaptchaError }> => {
    const text = await errorText(anchor, frame);
    if (/try again later/i.test(text)) {
      return {
        retry: false,
        error: new RecaptchaError(
          'bot_suspected',
          'reCAPTCHA says "Try again later" — the session is suspected'
        ),
      };
    }
    if (/verification challenge expired/i.test(text)) {
      return {
        retry: true,
        error: new RecaptchaError(
          'challenge_expired',
          'verification challenge expired'
        ),
      };
    }
    if (/please select all matching images|select all/i.test(text)) {
      return {
        retry: true,
        error: new RecaptchaError(
          'tiles_rejected',
          'selection rejected — the grid stays open'
        ),
      };
    }
    if (anchor && /there was an error|rc-anchor-alert/i.test(text)) {
      return {
        retry: true,
        error: new RecaptchaError('anchor_alert', 'anchor reported an error'),
      };
    }
    return { retry: true };
  };

  try {
    if (mode === 'v3') {
      return await runV3(page, args, log, started);
    }

    const hasAnchor = await page
      .mainFrame()
      .locator(ANCHOR_ANY_SELECTOR)
      .count();
    const hasGrecaptcha = Boolean(await mainEval(() => 'grecaptcha' in window));
    // A v3 badge is itself an iframe titled "reCAPTCHA", so v3 wins in
    // auto only when no real v2 widget container exists.
    const hasV2Widget = Boolean(
      await page.mainFrame().locator('.g-recaptcha, [data-sitekey]').count()
    );
    if (mode === 'auto' && !hasV2Widget && hasGrecaptcha) {
      return await runV3(page, args, log, started);
    }
    if (!hasAnchor) {
      throw new RecaptchaError(
        'widget_missing',
        'no reCAPTCHA widget on the page (no anchor iframe and no grecaptcha)'
      );
    }

    // v2 invisible: no checkbox to click, execute returns the token.
    if (
      mode !== 'v2' &&
      (await page
        .mainFrame()
        .locator('[data-size="invisible"], .g-recaptcha[data-size="invisible"]')
        .count())
    ) {
      const t = await executeInvisible(page, args);
      return finish('pass', t, 'v2-invisible', log, started, undefined);
    }

    let attempt = 1;
    for (; attempt <= maxAttempts; attempt++) {
      if (Date.now() - started > maxMs) {
        lastFailure = new RecaptchaError('timeout', 'wall-clock cap hit');
        break;
      }
      anchor = await resolveAnchor();

      // A round after the first leaves the challenge frame open while a
      // new grid loads; clicking the anchor again would only add noise.
      // On a freshly reloaded page the iframe can linger with no content
      // and an unchecked anchor, which is not an open challenge: the
      // checkbox still has to be pressed.
      let challengeFrame = await resolveChallenge();
      if (
        challengeFrame &&
        !(await anchorChecked(anchor)) &&
        !(await present(challengeFrame, GRID_PANEL, 800)) &&
        !(await countOf(challengeFrame, AUDIO_BUTTON))
      ) {
        log.push(
          `attempt ${attempt}: challenge frame present but empty — pressing the checkbox`
        );
        challengeFrame = null;
      }
      if (challengeFrame) {
        log.push(`attempt ${attempt}: challenge frame already open`);
      } else {
        // Click the checkbox unless a previous attempt already settled it.
        if (!(await anchorChecked(anchor))) {
          await clickIn(anchor, ANCHOR_CHECKBOX, 'reCAPTCHA checkbox');
          log.push(`attempt ${attempt}: clicked the anchor checkbox`);
        } else {
          log.push(`attempt ${attempt}: anchor already checked`);
        }

        // Either the checkbox settles or a challenge frame opens.
        const settleDeadline = Date.now() + Math.min(verifyMs, 6000);
        while (Date.now() < settleDeadline) {
          const t = await token().catch(() => '');
          if (t) {
            return finish('pass', t, 'v2', log, started, undefined);
          }
          challengeFrame = await resolveChallenge();
          if (challengeFrame) {
            break;
          }
          await sleep(150);
        }
      }

      if (!challengeFrame) {
        if (!(await anchorChecked(anchor))) {
          const cls = await classify(anchor);
          lastFailure =
            cls.error ??
            new RecaptchaError(
              'anchor_unchecked',
              'checkbox did not settle and no challenge opened'
            );
          log.push(`attempt ${attempt}: ${lastFailure.message}`);
          continue;
        }
        const t = await waitToken(Math.min(verifyMs, 3000));
        if (t) {
          return finish('pass', t, 'v2', log, started, undefined);
        }
        lastFailure = new RecaptchaError(
          'token_absent',
          'anchor is checked but no token was set'
        );
        log.push(`attempt ${attempt}: checked, no token`);
        continue;
      }

      // Audio is the fallback whenever the caller asks for it.
      if (args.audio && (await countOf(challengeFrame, AUDIO_BUTTON))) {
        await clickIn(challengeFrame, AUDIO_BUTTON, 'switch to audio');
        await sleep(300);
      }

      // A fresh round fades the old grid out and the new tiles in; a
      // capture taken mid-fade is blank tiles for the vision model.
      if (attempt > 1) {
        await sleep(600);
      }
      const challenge = await capture(challengeFrame);
      if (!challenge) {
        lastFailure = new RecaptchaError(
          'challenge_timeout',
          'challenge frame opened but no grid or audio appeared'
        );
        log.push(`attempt ${attempt}: ${lastFailure.message}`);
        continue;
      }

      if (challenge.type === 'audio') {
        if (!args.audioScript) {
          return finish('needs_answer', '', 'v2', log, started, undefined, {
            status: 'needs_answer',
            challenge: {
              type: 'audio',
              prompt: challenge.prompt,
              audioUrl: challenge.url,
            },
            failure: {
              code: 'audio_unavailable',
              message:
                'audio clip captured — pass audioScript to transcribe it',
            },
          });
        }
        let text: unknown;
        try {
          text = await challenge.frame.evaluate(
            ({ code, url, attempt }) => {
              const v = (0, eval)(`(${code})`);
              return typeof v === 'function' ? v({ url, attempt }) : v;
            },
            { code: args.audioScript, url: challenge.url, attempt }
          );
          if (typeof text !== 'string' || !text.trim()) {
            throw new Error(`audioScript returned ${JSON.stringify(text)}`);
          }
        } catch (err: any) {
          lastFailure = new RecaptchaError(
            'audio_failed',
            `audioScript failed: ${err}`
          );
          log.push(`attempt ${attempt}: ${lastFailure.message}`);
          await reload(challenge.frame);
          continue;
        }
        await challenge.frame.locator(AUDIO_INPUT).fill(text.trim());
        if (await present(challenge.frame, VERIFY_BUTTON, 2000)) {
          await clickIn(challenge.frame, VERIFY_BUTTON, 'verify audio');
        }
        const t = await waitToken(verifyMs);
        if (t) {
          return finish('pass', t, 'v2', log, started, undefined);
        }
        const cls = await classify(challenge.frame);
        lastFailure = cls.error;
        log.push(`attempt ${attempt}: audio answer rejected`);
        if (!cls.retry) {
          break;
        }
        await reload(challenge.frame);
        continue;
      }

      // Grid: the caller's answer wins; otherwise ask the vision
      // endpoint; otherwise hand the capture back.
      let answerTiles = args.tiles;
      if (!answerTiles && !args.tilesScript && hasVision) {
        const first = challenge.tiles[0];
        const cols = first
          ? new Set(
              challenge.tiles
                .filter((t) => t.imageY === first.imageY)
                .map((t) => t.imageX)
            ).size || 3
          : 3;
        const rows = Math.ceil(challenge.tiles.length / cols) || 3;
        log.push(
          `  asking vision (${vision?.model ?? 'MCP sampling'}) about a ${rows}x${cols} grid`
        );
        const note = (m: string) => log.push(`  ${m}`);
        const picked = await pickTiles({
          config: vision,
          sample,
          prompt: challenge.prompt,
          image: challenge.image,
          rows,
          cols,
          timeoutMs: args.visionMs,
          note,
        }).catch((err: any) => {
          log.push(`  vision call failed: ${err?.message ?? err}`);
          return null;
        });
        if (picked) {
          answerTiles = picked
            .map((k) => challenge.tiles[k]?.index)
            .filter((v): v is number => typeof v === 'number');
          log.push(
            `  vision selected ${answerTiles.length ? answerTiles.join(',') : 'none'}`
          );
        } else {
          // The whole-grid read failed (typically a 4x4 that ran the model
          // out of budget mid-reasoning). Ask about each tile crop instead;
          // small images get short, reliable answers.
          log.push('  vision gave no usable answer — asking tile by tile');
          const crops: Array<{ index: number; image: string }> = [];
          for (const tile of challenge.tiles) {
            const png = await page
              .screenshot({
                clip: {
                  x: Math.max(0, Math.floor(tile.x + challenge.scroll.x)),
                  y: Math.max(0, Math.floor(tile.y + challenge.scroll.y)),
                  width: Math.max(1, Math.ceil(tile.width)),
                  height: Math.max(1, Math.ceil(tile.height)),
                },
                type: 'png',
              })
              .catch(() => null);
            if (png) {
              crops.push({
                index: tile.index,
                image: `data:image/png;base64,${png.toString('base64')}`,
              });
            }
          }
          const perTile = await pickTilesPerTile({
            config: vision,
            sample,
            prompt: challenge.prompt,
            tiles: crops,
            timeoutMs: Math.min(args.visionMs ?? 15_000, 15_000),
            note,
          }).catch((err: any) => {
            log.push(`  per-tile vision call failed: ${err?.message ?? err}`);
            return null;
          });
          if (perTile) {
            answerTiles = perTile;
            log.push(
              `  per-tile vision selected ${perTile.length ? perTile.join(',') : 'none'}`
            );
          } else {
            log.push('  per-tile vision gave no usable answer');
          }
        }
      }
      if (!answerTiles && !args.tilesScript) {
        return finish('needs_answer', '', 'v2', log, started, undefined, {
          status: 'needs_answer',
          challenge: {
            type: 'grid',
            prompt: challenge.prompt,
            image: challenge.image,
            imageBox: challenge.imageBox,
            tiles: challenge.tiles,
          },
          failure: {
            code: 'needs_answer',
            message: hasVision
              ? 'vision returned no usable tile selection — pass `tiles` (or tilesScript), or retry'
              : 'grid captured — pass `tiles` (or tilesScript) with the matching indices, or configure a vision endpoint / enable MCP sampling in the client',
          },
        });
      }

      let pressVerify = true;
      try {
        pressVerify = await applyTiles(
          page,
          challenge,
          answerTiles,
          args.tilesScript,
          log
        );
      } catch (err: any) {
        lastFailure = new RecaptchaError(
          'script_error',
          `tilesScript failed: ${err}`
        );
        log.push(`attempt ${attempt}: ${lastFailure.code}`);
        continue;
      }
      if (
        pressVerify &&
        (await present(challenge.frame, VERIFY_BUTTON, 2000))
      ) {
        await clickIn(challenge.frame, VERIFY_BUTTON, 'verify selection');
      }
      const t = await waitToken(verifyMs);
      if (t) {
        return finish('pass', t, 'v2', log, started, undefined);
      }

      const cls = await classify(challenge.frame);
      lastFailure = cls.error;
      log.push(
        `attempt ${attempt}: selection rejected` +
          (cls.error ? ` (${cls.error.code})` : '')
      );
      if (!cls.retry) {
        break;
      }
      if (cls.error?.code === 'challenge_expired') {
        await reload(challenge.frame);
      }
      await sleep(250);
    }

    if (!lastFailure && Date.now() - started > maxMs) {
      lastFailure = new RecaptchaError('timeout', 'wall-clock cap hit');
    }
    // Exhausting the loop is the cap, whatever the last retryable reason
    // was. A break (bot suspected, wall clock) keeps its own code.
    if (attempt > maxAttempts) {
      lastFailure = new RecaptchaError(
        'retry_cap',
        `no pass after ${maxAttempts} attempts` +
          (lastFailure ? ` (last: ${lastFailure.code})` : '')
      );
    }
    lastFailure ??= new RecaptchaError('retry_cap', 'no pass');
    log.push(`stopped: ${lastFailure.code} — ${lastFailure.message}`);
    return finish('not_solved', '', 'v2', log, started, lastFailure);
  } catch (err: any) {
    const failure =
      err instanceof RecaptchaError
        ? err
        : new RecaptchaError('timeout', err?.toString?.() ?? String(err));
    if (failure.code === 'widget_missing') {
      logActivity({
        tool: 'playwright_captcha_recaptcha',
        tab: page.url(),
        status: 'error',
        detail: failure.message.slice(0, 200),
      });
      throw failure;
    }
    log.push(`stopped: ${failure.code} — ${failure.message}`);
    return finish('not_solved', '', 'v2', log, started, failure);
  }
}

/** Registers playwright_captcha_recaptcha. */
export default function captchaRecaptcha(server: FastMCP): void {
  server.addTool({
    name: 'playwright_captcha_recaptcha',
    description:
      'Solve a Google reCAPTCHA v2 (checkbox, then image grid or audio) and capture v3 tokens. Clicks the checkbox with real pointer moves; on an image grid it classifies the tiles with a configured vision endpoint (APPIUM_MCP_CAPTCHA_VLM_URL, or the claude-local hunch config), or — when no endpoint is configured — by asking the MCP client model through sampling, then presses the matching tiles, verifies, and re-solves each new round until a token appears. Without either source it returns a PNG plus every tile box as `needs_answer`; `tiles`/`tilesScript` override it. Retries a rejected grid up to 5 times in 90 s and maps "challenge expired", "Try again later" and anchor alerts to typed failures. Audio is captured and handed to an external transcription hook. v3 is always reported "unverified — no score assertion". Live demo: https://recaptcha-demo.appspot.com/recaptcha-v2-checkbox.php; v3 demo: https://recaptcha-demo.appspot.com/recaptcha-v3-verify.php.',
    parameters: recaptchaSchema,
    annotations: { readOnlyHint: false, openWorldHint: false },
    execute: (args, ctx) => {
      const log: string[] = [];
      return solveRecaptcha(
        args,
        makeSamplingSampler(server, ctx, (m) => log.push(`  ${m}`)),
        log
      );
    },
  });
}

/** Presses tiles with real pointer moves, in row-major order. */
async function applyTiles(
  page: Page,
  challenge: GridCapture,
  tiles: number[] | undefined,
  tilesScript: string | undefined,
  log: string[]
): Promise<boolean> {
  // Returns whether the tool still has to press the verify button.
  if (tilesScript) {
    const returned = await challenge.frame.evaluate(
      ({ code, arg }) => {
        const v = (0, eval)(`(${code})`);
        // Accept both a function expression and an already-invoked value.
        return typeof v === 'function' ? v(arg) : v;
      },
      {
        code: tilesScript,
        arg: {
          image: challenge.image,
          width: challenge.imageBox.width,
          height: challenge.imageBox.height,
          tiles: challenge.tiles,
          prompt: challenge.prompt,
        },
      }
    );
    if (Array.isArray(returned)) {
      await pressTileIndices(page, challenge, returned as number[], log);
      return true;
    }
    // The script pressed the tiles and the verify button itself.
    log.push('  tilesScript handled the presses');
    return false;
  }
  if (!tiles || !tiles.length) {
    log.push('  no tiles given — verifying the empty selection');
    return true;
  }
  await pressTileIndices(page, challenge, tiles, log);
  return true;
}

async function pressTileIndices(
  page: Page,
  challenge: GridCapture,
  indices: number[],
  log: string[]
): Promise<void> {
  for (const i of [...indices].sort((a, b) => a - b)) {
    const tile = challenge.tiles.find((t) => t.index === i);
    if (!tile) {
      log.push(`  tile ${i} does not exist (0–${challenge.tiles.length - 1})`);
      continue;
    }
    await cueText(
      page,
      `tile ${i}`,
      'click',
      { x: tile.x, y: tile.y, w: tile.width, h: tile.height },
      600
    );
    await humanClick(page, tile);
    await sleep(70 + Math.random() * 70);
  }
  log.push(`  pressed tiles ${instances(indices)}`);
}

const instances = (a: number[]) => (a.length ? a.join(',') : 'none');

/** v3 / invisible v2: execute and return the token, never a score claim. */
async function runV3(
  page: Page,
  args: { sitekey?: string; action?: string; enterprise?: boolean },
  log: string[],
  started: number
): Promise<ContentResult> {
  const main = page.mainFrame();
  const sitekey =
    args.sitekey ??
    ((await main.evaluate(
      () =>
        document
          .querySelector('.g-recaptcha[data-sitekey]')
          ?.getAttribute('data-sitekey') ??
        Array.from(document.querySelectorAll('script[src]'))
          .map((s) => /[?&]render=([^&]+)/.exec(s.getAttribute('src') ?? ''))
          .find(Boolean)?.[1] ??
        null
    )) as string | null);
  if (!sitekey) {
    throw new RecaptchaError(
      'widget_missing',
      'v3 needs a sitekey — pass it explicitly (test key: 6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI)'
    );
  }
  const action = args.action ?? 'submit';
  const token = (await main.evaluate(
    async ({ key, act, ent }) => {
      const g = ent
        ? (window as any).grecaptcha?.enterprise
        : (window as any).grecaptcha;
      if (!g) {
        throw new Error('grecaptcha is not defined');
      }
      const t = await g.execute(key, { action: act });
      const el = document.querySelector(
        'textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"], #g-recaptcha-response, [name="g-recaptcha-response"]'
      );
      if (el && 'value' in el) {
        (el as HTMLTextAreaElement).value = String(t || '');
      }
      return String(t || '');
    },
    { key: sitekey, act: action, ent: Boolean(args.enterprise) }
  )) as string;

  log.push(
    `v3 execute(action=${action}) on ${sitekey.slice(0, 8)}… — token ${token ? `${token.length} chars` : 'absent'}`
  );
  log.push(
    'v3 is unverified — the score is server-side only, so no pass is claimed'
  );
  logActivity({
    tool: 'playwright_captcha_recaptcha',
    tab: page.url(),
    status: token ? 'ok' : 'error',
    detail: `v3 token ${token.length} chars`,
  });
  const status = token ? 'unverified' : 'not_solved';
  const payload = {
    provider: 'recaptcha',
    mode: 'v3',
    status,
    verified: false,
    token: token || undefined,
    tokenLength: token.length || undefined,
    elapsedMs: Date.now() - started,
    failure: token
      ? null
      : { code: 'token_absent', message: 'execute returned no token' },
  };
  return {
    content: [
      {
        type: 'text',
        text:
          `Captcha recaptcha v3: ${status} in ${Math.round((Date.now() - started) / 1000)}s` +
          ' — no score assertion (server-side only)\n' +
          `${log.join('\n')}\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  };
}

/** Invisible v2: execute the widget and return the token. */
async function executeInvisible(
  page: Page,
  args: { sitekey?: string; action?: string; enterprise?: boolean }
): Promise<string> {
  const main = page.mainFrame();
  const sitekey =
    args.sitekey ??
    ((await main.evaluate(() =>
      document
        .querySelector('.g-recaptcha[data-sitekey]')
        ?.getAttribute('data-sitekey')
    )) as string | null);
  if (!sitekey) {
    throw new RecaptchaError(
      'widget_missing',
      'invisible widget has no data-sitekey'
    );
  }
  return (await main.evaluate(
    async ({ key, act, ent }) => {
      const g = ent
        ? (window as any).grecaptcha?.enterprise
        : (window as any).grecaptcha;
      const t = await g.execute(key, { action: act });
      const el = document.querySelector(
        'textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"], #g-recaptcha-response, [name="g-recaptcha-response"]'
      );
      if (el && 'value' in el) {
        (el as HTMLTextAreaElement).value = String(t || '');
      }
      return String(t || '');
    },
    {
      key: sitekey,
      act: args.action ?? 'submit',
      ent: Boolean(args.enterprise),
    }
  )) as string;
}

/** Builds the content result, first line stable, JSON when structured. */
function result(
  status: 'pass' | 'unverified' | 'needs_answer' | 'not_solved',
  tokenValue: string,
  mode: string,
  log: string[],
  started: number,
  failure: RecaptchaError | undefined,
  extra: Record<string, unknown> = {}
): ContentResult {
  const verb = status === 'pass' ? 'pass' : status;
  const first =
    `Captcha recaptcha ${mode}: ${verb} ` +
    `(${Math.round((Date.now() - started) / 1000)}s)` +
    (failure ? ` — ${failure.code}: ${failure.message}` : '');
  const payload = {
    provider: 'recaptcha',
    mode,
    status,
    verified: status === 'pass',
    token: tokenValue || undefined,
    tokenLength: tokenValue.length || undefined,
    elapsedMs: Date.now() - started,
    failure: failure ? { code: failure.code, message: failure.message } : null,
    ...extra,
  };
  return {
    content: [
      {
        type: 'text',
        text: `${first}\n${log.join('\n')}\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  };
}
