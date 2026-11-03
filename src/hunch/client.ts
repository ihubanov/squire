/**
 * Client for the bundled hunch sidecar.
 *
 * Wraps POST /v1/judge. Everything is fail-closed: any transport/HTTP error
 * returns { ok: false } with a reason, and callers MUST treat that as "unknown"
 * — never as "no". A hunch verdict is a signal, not a gate on destructive
 * actions (screenshots can carry adversarial text).
 */
import { ensureHunch, hunchEnabled } from './sidecar.js';
import log from '../logger.js';

export type Check =
  | { kind: 'yesno'; question: string; yes_if?: string; no_if?: string }
  | { kind: 'pick'; question: string; options: string[]; yes_if?: string }
  | { kind: 'scale'; question: string; levels?: number };

export interface JudgeOk {
  ok: true;
  results: Record<
    string,
    {
      kind: string;
      p_yes?: number;
      pick?: string;
      probs?: unknown;
      confidence?: number;
      value?: number;
    }
  >;
  usage?: unknown;
}
export interface JudgeErr {
  ok: false;
  reason: string;
}
export type JudgeResult = JudgeOk | JudgeErr;

/**
 * Run one or more calibrated checks over a screenshot (or text-only). Batch all
 * checks for one image into a single call — they share the prefix cache and run
 * in parallel on the backend.
 */
export async function judge(opts: {
  checks: Record<string, Check>;
  images?: string[]; // data:image/...;base64 URLs (downscale to ~1024px wide before calling)
  context?: Record<string, unknown>;
  model?: string;
  effort?: 'low' | 'high';
  timeoutMs?: number;
}): Promise<JudgeResult> {
  if (!hunchEnabled()) {
    return {
      ok: false,
      reason:
        'hunch disabled or no backend configured (set SQUIRE_HUNCH_BACKEND_URL)',
    };
  }
  const h = await ensureHunch();
  if (!h) {
    return { ok: false, reason: 'hunch sidecar unavailable' };
  }

  const body: Record<string, unknown> = { checks: opts.checks };
  if (opts.images?.length) {
    body.images = opts.images;
  }
  if (opts.context) {
    body.context = opts.context;
  }
  if (opts.model) {
    body.model = opts.model;
  }
  if (opts.effort) {
    body.effort = opts.effort;
  }

  try {
    const r = await fetch(`${h.baseUrl}/v1/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!r.ok) {
      // 502/503 = backend down: fail closed, this is "unknown".
      return { ok: false, reason: `hunch ${r.status}` };
    }
    const data = (await r.json()) as {
      results?: JudgeOk['results'];
      usage?: unknown;
    };
    return { ok: true, results: data.results ?? {}, usage: data.usage };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * Convenience: a single calibrated yes/no over an image. Returns the P(yes) or
 * null when hunch couldn't answer (unknown). Name the look-alike in `noIf` — it
 * measurably improves accuracy.
 */
export async function pYes(
  question: string,
  opts: {
    image?: string;
    yesIf?: string;
    noIf?: string;
    context?: Record<string, unknown>;
  } = {}
): Promise<number | null> {
  const res = await judge({
    checks: {
      q: { kind: 'yesno', question, yes_if: opts.yesIf, no_if: opts.noIf },
    },
    images: opts.image ? [opts.image] : undefined,
    context: opts.context,
  });
  if (!res.ok) {
    log.info(`[hunch] pYes unknown: ${res.reason}`);
    return null;
  }
  return res.results.q?.p_yes ?? null;
}

/** Threshold verdict helper: act >= hi, fail < lo, else abstain. null → unknown. */
export function verdict(
  p: number | null,
  hi = 0.9,
  lo = 0.5
): 'yes' | 'no' | 'abstain' | 'unknown' {
  if (p == null) {
    return 'unknown';
  }
  if (p >= hi) {
    return 'yes';
  }
  if (p < lo) {
    return 'no';
  }
  return 'abstain';
}
