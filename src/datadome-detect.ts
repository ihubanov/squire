/**
 * DataDome frame classifier.
 *
 * DataDome serves three distinct things in a geo.captcha-delivery.com frame,
 * and only one of them is a solvable CAPTCHA:
 *
 *   hard-block   -> body[data-dd-response-page="hard-block"]; no puzzle, no
 *                   token. Triggered by IP/ASN reputation (datacenter/VPN) or
 *                   a bad score. Changing the fingerprint cannot fix it.
 *   interstitial -> URL path /interstitial/; the page clears by itself once
 *                   the client JS passes. "Solving" == wait.
 *   captcha      -> an interactive challenge (slider/puzzle) is rendered.
 *
 * Treating hard-block or interstitial as a slider wastes the attempt budget
 * and hides the real cause. classify() separates them.
 *
 * Ported from tools/security/captcha/ddetect.py. Keep it a single synchronous
 * classification pass: the ordering and the exact, case-sensitive,
 * double-quoted marker are intentional until a real hard-block page is
 * captured and can back a richer check.
 */

export const DATADOME_PROVIDER = 'datadome';
export const DATADOME_FRAME_HOST = 'geo.captcha-delivery.com';
export const DATADOME_HARD_BLOCK_MARKER = 'data-dd-response-page="hard-block"';

export type DatadomeKind =
  'hard-block' | 'interstitial' | 'captcha' | 'unknown';

export interface DatadomeVerdict {
  provider: typeof DATADOME_PROVIDER;
  present: true;
  kind: DatadomeKind;
  solvable: boolean;
  url: string;
  detail: string;
}

/** Minimal Frame surface this module needs (Playwright's Frame fits). */
export interface FrameLike {
  url(): string;
  content(): Promise<string>;
}

/** Minimal Page surface (Playwright's Page fits). */
export interface PageLike {
  frames(): FrameLike[];
}

/**
 * Classify one captcha-delivery frame. Order matters: a hard-block body wins
 * over an interstitial URL, and a captcha body is only checked after both.
 */
export function classifyDatadomeFrame(
  frameUrl: string,
  html: string | null
): DatadomeVerdict {
  const v: DatadomeVerdict = {
    provider: DATADOME_PROVIDER,
    present: true,
    kind: 'unknown',
    solvable: false,
    url: frameUrl.slice(0, 300),
    detail: '',
  };
  if (html && html.includes(DATADOME_HARD_BLOCK_MARKER)) {
    v.kind = 'hard-block';
    v.detail = 'IP/fingerprint reputation block; no challenge is offered';
    return v;
  }
  if (frameUrl.includes('/interstitial/')) {
    v.kind = 'interstitial';
    v.detail = 'auto-clears if the browser passes the client check; just wait';
    return v;
  }
  if (html && html.includes('captcha__')) {
    v.kind = 'captcha';
    v.solvable = true;
    v.detail = 'interactive challenge rendered';
    return v;
  }
  v.detail = 'captcha-delivery frame with unrecognised body';
  return v;
}

/**
 * Scan a page's frames for DataDome and classify each. Returns [] when no
 * captcha-delivery frame is present: "no geo frame seen" is not a pass, and
 * callers must not treat an empty result as "clean".
 */
export async function detectDatadome(
  page: PageLike
): Promise<DatadomeVerdict[]> {
  const out: DatadomeVerdict[] = [];
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url.includes(DATADOME_FRAME_HOST)) {
      continue;
    }
    let html: string | null;
    try {
      html = await frame.content();
    } catch {
      html = null;
    }
    out.push(classifyDatadomeFrame(url, html));
  }
  return out;
}

/** The hard-block verdict, if the page has one. */
export function findHardBlock(
  verdicts: DatadomeVerdict[]
): DatadomeVerdict | undefined {
  return verdicts.find((v) => v.kind === 'hard-block');
}
