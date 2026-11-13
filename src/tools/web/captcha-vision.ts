/**
 * Vision half of the reCAPTCHA grid solver.
 *
 * The tool ships no model of its own: it speaks the OpenAI chat-completions
 * shape to any vision endpoint the operator already runs, so the same
 * gateway a local agent uses can classify tiles. Configuration, all optional:
 *
 *   APPIUM_MCP_CAPTCHA_VLM_URL     base URL, e.g. http://127.0.0.1:9510/v1
 *   APPIUM_MCP_CAPTCHA_VLM_MODEL   model id, e.g. nvidia/Nemotron-3.5-Super-VL-NVFP4
 *   APPIUM_MCP_CAPTCHA_VLM_KEY     bearer token, if the endpoint wants one
 *   APPIUM_MCP_CAPTCHA_VLM=0       disable the solver entirely
 *
 * When APPIUM_MCP_CAPTCHA_VLM_URL is unset the claude-local hunch config's
 * backend URL is used if it exists (`~/.local/share/claude-local/hunch.toml`),
 * so a machine already running a local gateway needs no extra setup. Only the
 * URL is taken from it: hunch's main model is the text judge, and a model that
 * cannot see images answers tiles confidently wrong. Set APPIUM_MCP_CAPTCHA_VLM_MODEL
 * to the backend's vision model when it is not the default.
 *
 * With neither a URL nor a hunch config, the caller may pass `sample` — an
 * MCP-sampling classifier answered by the client's own main model
 * (captcha-sampling.ts). The local endpoint always wins when configured.
 *
 * Hunch judge (grid only, opt-in):
 *   APPIUM_MCP_CAPTCHA_HUNCH=1        enable the hunch judge for tile grids
 *   APPIUM_MCP_CAPTCHA_HUNCH_URL      default http://127.0.0.1:8791
 *   APPIUM_MCP_CAPTCHA_HUNCH_MODEL    default "main" (the alias in hunch.toml)
 *
 * Unlike the whole-grid classifier, hunch answers one closed-set yes/no per
 * tile with a calibrated p_yes, which the caller gates at 0.9. It re-prefills
 * the image on every check, so ask one tile per request rather than batching
 * the grid; that shape costs ~1s per check against ~40s+ for the reasoning
 * main model under a whole-grid prompt.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TileSampler } from './captcha-sampling.js';

const HUNCH_TOML = join(homedir(), '.local/share/claude-local/hunch.toml');

export interface VisionConfig {
  /** Base URL ending in /v1. */
  url: string;
  model: string;
  key?: string;
}

/** Optional sink for why a vision attempt failed, for the caller's log. */
export type VisionNote = (message: string) => void;

interface HunchConfig {
  url?: string;
}

/**
 * Reads the backend URL out of claude-local's hunch config. Deliberately not
 * a TOML parser: the file is machine-written with one `url = "..."` under
 * [backend], and a missing or odd file simply means "no local vision".
 */
function readHunchConfig(): HunchConfig {
  let text: string;
  try {
    text = readFileSync(HUNCH_TOML, 'utf8');
  } catch {
    return {};
  }
  const backend = /\[backend\][\s\S]*?\nurl\s*=\s*"([^"]+)"/.exec(text)?.[1];
  return { url: backend };
}

/** The endpoint to classify tiles with, or null when none is configured. */
export function visionConfig(): VisionConfig | null {
  if (process.env.APPIUM_MCP_CAPTCHA_VLM === '0') {
    return null;
  }
  const explicit = process.env.APPIUM_MCP_CAPTCHA_VLM_URL;
  const hunch = explicit ? {} : readHunchConfig();
  const base = explicit ?? hunch.url;
  const model =
    process.env.APPIUM_MCP_CAPTCHA_VLM_MODEL ??
    'nvidia/Nemotron-3.5-Super-VL-NVFP4';
  if (!base) {
    return null;
  }
  const url = base.replace(/\/+$/, '').endsWith('/v1')
    ? base.replace(/\/+$/, '')
    : `${base.replace(/\/+$/, '')}/v1`;
  return {
    url,
    model,
    key: process.env.APPIUM_MCP_CAPTCHA_VLM_KEY ?? process.env.VLLM_API_KEY,
  };
}

export interface HunchGridConfig {
  /** Base URL, no trailing slash, without /v1. */
  url: string;
  /** hunch model alias, e.g. "main". Must be vision-capable. */
  model: string;
  /** p_yes at or above this counts as a selected tile. */
  gate: number;
}

/**
 * The hunch judge for tile grids, or null unless asked for. Off by default:
 * the per-tile scaffold is new and only earns a place in the shipped path
 * once it beats the whole-grid classifier in a live A/B.
 */
export function hunchGridConfig(): HunchGridConfig | null {
  if (process.env.APPIUM_MCP_CAPTCHA_HUNCH !== '1') {
    return null;
  }
  const base =
    process.env.APPIUM_MCP_CAPTCHA_HUNCH_URL ?? 'http://127.0.0.1:8791';
  return {
    url: base.replace(/\/+$/, ''),
    model: process.env.APPIUM_MCP_CAPTCHA_HUNCH_MODEL ?? 'main',
    gate: 0.9,
  };
}

const HUNCH_TILE_QUESTION = [
  'This is ONE tile cropped from a reCAPTCHA image-challenge grid.',
  'The whole-grid instruction is quoted at the end.',
  'Does this single tile clearly contain any part of the requested object,',
  'including a cut-off fragment at its edge — that is how reCAPTCHA expects',
  'fragments to be treated? Answer yes only for a real object or a piece of',
  'one, not for a reflection, shadow, or background glimpse.',
].join('\n');

interface HunchJudgeReply {
  results?: Record<string, { p_yes?: number; answer?: string }>;
  error?: { code?: string; message?: string };
}

/** One closed-set yes/no about one tile crop. Returns p_yes, or null. */
async function askHunchTile(
  config: HunchGridConfig,
  prompt: string,
  image: string,
  timeoutMs: number
): Promise<number | null> {
  const body = {
    model: config.model,
    images: [image],
    context: 'One reCAPTCHA grid tile',
    checks: {
      tile: {
        kind: 'yesno',
        question: `${HUNCH_TILE_QUESTION}\n\nWhole-grid instruction: ${JSON.stringify(prompt)}`,
      },
    },
    reasoning: 'off',
  };
  let res: Response;
  try {
    res = await fetch(`${config.url}/v1/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  let data: HunchJudgeReply;
  try {
    data = (await res.json()) as HunchJudgeReply;
  } catch {
    return null;
  }
  const p = data.results?.tile?.p_yes;
  return typeof p === 'number' ? p : null;
}

/**
 * Judges every tile with hunch, one image per request. Returns the indices
 * whose p_yes clears the gate, or null when the judge is unusable — callers
 * treat null as "no answer", never as "nothing selected".
 */
export async function pickTilesHunch(opts: {
  config: HunchGridConfig;
  prompt: string;
  tiles: Array<{ index: number; image: string }>;
  timeoutMs?: number;
  concurrency?: number;
  note?: VisionNote;
}): Promise<number[] | null> {
  if (!opts.tiles.length) {
    return null;
  }
  const scores: Array<number | null> = new Array(opts.tiles.length).fill(null);
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? 4, opts.tiles.length)
  );
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (let i = next++; i < opts.tiles.length; i = next++) {
      scores[i] = await askHunchTile(
        opts.config,
        opts.prompt,
        opts.tiles[i].image,
        opts.timeoutMs ?? 15_000
      );
    }
  });
  await Promise.all(workers);

  const failed = scores.filter((s) => s === null).length;
  if (failed) {
    opts.note?.(`hunch: ${failed}/${scores.length} tiles unanswered`);
  }
  if (failed === scores.length) {
    return null;
  }
  const picked = scores
    .map((s, i) =>
      s !== null && s >= opts.config.gate ? opts.tiles[i].index : -1
    )
    .filter((i) => i >= 0);
  if (!picked.length && failed) {
    // Some tiles failed and none cleared the gate: "nothing" would be a guess.
    return null;
  }
  return picked;
}

const INSTRUCTION = [
  'You are choosing tiles in a reCAPTCHA image challenge.',
  'The image is the whole challenge grid; the challenge instruction is',
  'quoted at the end.',
  'The grid has ROWS rows and COLS columns. Tiles are numbered 0-based in',
  'row-major order (left to right, then top to bottom): the tile at row r,',
  'column c is index r*COLS+c.',
  '',
  'Select a tile when the requested object is clearly present in it, even',
  'if only part of the object is inside that tile — that is how reCAPTCHA',
  'expects fragments of an object to be treated. Do not select a tile for a',
  'background glimpse, a reflection, or a label with no object. When the',
  'requested object is not in any tile, select nothing.',
  '',
  'Answer with JSON only, no prose: {"select":[indices]}',
].join('\n');

/** Pulls the first JSON object or array out of a model reply. */
export function parseSelection(text: string): number[] | null {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) {
    return null;
  }
  let body = text.slice(Math.min(...starts));
  // Trim trailing prose after the value by scanning to its matching close.
  const first = body[0];
  const close = first === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === first) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  body = body.slice(0, end);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const raw = Array.isArray(value)
    ? value
    : ((value as Record<string, unknown>).select ??
      (value as Record<string, unknown>).yes ??
      (value as Record<string, unknown>).indices ??
      (value as Record<string, unknown>).tiles);
  if (!Array.isArray(raw)) {
    return null;
  }
  const out = raw
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v >= 0);
  return Array.from(new Set(out));
}

/** Where one classification request goes: a local endpoint or MCP sampling. */
type ClassifierSource = {
  config?: VisionConfig | null;
  /** Used when no local endpoint is configured. */
  sample?: TileSampler;
};

/**
 * Asks for one reply, over the local endpoint when configured and through
 * MCP sampling otherwise. Null means "no answer", never "nothing selected".
 */
async function askModel(
  source: ClassifierSource,
  instruction: string,
  image: string,
  maxTokens: number,
  timeoutMs: number,
  note?: VisionNote
): Promise<string | null> {
  if (source.sample) {
    return source.sample({ instruction, image, maxTokens });
  }
  if (!source.config) {
    return null;
  }
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: instruction },
    { type: 'image_url', image_url: { url: image } },
  ];
  const body = {
    model: source.config.model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    // A reasoning VL model thinks its way around every tile before it
    // answers. A 4x4 grid has measured 1.5k-4k reasoning tokens, and at
    // 4096 a long grid was seen to finish right at the cap with the reply
    // cut off mid-JSON ("no usable answer" live). 8192 leaves room to
    // finish; the per-tile fallback covers an endpoint that still runs out.
    max_tokens: maxTokens,
  };
  let res: Response;
  try {
    res = await fetch(`${source.config.url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(source.config.key
          ? { Authorization: `Bearer ${source.config.key}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    note?.(`vision request failed: ${err?.message ?? err}`);
    return null;
  }
  if (!res.ok) {
    note?.(`vision endpoint returned HTTP ${res.status}`);
    return null;
  }
  let data: {
    choices?: Array<{
      message?: { content?: string | null; reasoning?: string | null };
      finish_reason?: string;
    }>;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    note?.('vision endpoint returned non-JSON');
    return null;
  }
  const choice = data.choices?.[0];
  const message = choice?.message;
  // A reasoning VL model can spend the whole budget thinking and leave
  // `content` null with the analysis in `reasoning`; its final JSON is
  // still there, so read it rather than blame the endpoint.
  const reply = message?.content || message?.reasoning;
  if (typeof reply !== 'string' || !reply.trim()) {
    note?.('vision endpoint returned an empty reply');
    return null;
  }
  if (!parseSelection(reply)) {
    note?.(
      `vision reply had no JSON selection (finish ${choice?.finish_reason ?? '?'})`
    );
  }
  return reply;
}

/**
 * Classifies every tile in one request. Returns the selected indices, or
 * null when the endpoint is unusable — callers treat null as "no answer",
 * never as "nothing selected".
 */
export async function pickTiles(opts: {
  config?: VisionConfig | null;
  sample?: TileSampler;
  prompt: string;
  /** The tile grid alone (no instruction header). */
  image: string;
  rows: number;
  cols: number;
  timeoutMs?: number;
  note?: VisionNote;
}): Promise<number[] | null> {
  const instruction =
    INSTRUCTION.replaceAll('ROWS', String(opts.rows)).replaceAll(
      'COLS',
      String(opts.cols)
    ) + `\n\nChallenge instruction: ${JSON.stringify(opts.prompt)}`;
  const reply = await askModel(
    { config: opts.config, sample: opts.sample },
    instruction,
    opts.image,
    8192,
    opts.timeoutMs ?? 45_000,
    opts.note
  );
  return reply ? parseSelection(reply) : null;
}

const PER_TILE_INSTRUCTION = [
  'This is ONE tile cropped from a reCAPTCHA image challenge grid.',
  'The whole-grid instruction is quoted at the end.',
  'Decide whether this single tile clearly contains any part of the',
  'requested object, including a cut-off fragment at its edge — that is how',
  'reCAPTCHA expects fragments to be treated. Say true only for a real',
  'object or a piece of one, not for a reflection, shadow, or background',
  'glimpse.',
  '',
  'Answer with JSON only, no prose: {"yes":true} or {"yes":false}',
].join('\n');

/** Pulls a strict yes/no verdict out of a model reply. */
export function parseYes(text: string): boolean | null {
  const m = /"yes"\s*:\s*(true|false)/i.exec(text);
  if (m) {
    return m[1].toLowerCase() === 'true';
  }
  const trimmed = text.trim();
  const bare = /^(true|false|yes|no)\b/i.exec(trimmed);
  if (bare) {
    const v = bare[1].toLowerCase();
    return v === 'true' || v === 'yes';
  }
  return null;
}

/**
 * Fallback for a grid the whole-image classifier could not read: asks about
 * each tile crop on its own, in parallel, and returns the indices that got a
 * clear "yes". Null when no request produced a usable verdict at all.
 */
export async function pickTilesPerTile(opts: {
  config?: VisionConfig | null;
  sample?: TileSampler;
  prompt: string;
  /** Tile crops, each tagged with the caller's tile index. */
  tiles: Array<{ index: number; image: string }>;
  timeoutMs?: number;
  concurrency?: number;
  note?: VisionNote;
}): Promise<number[] | null> {
  if (!opts.tiles.length) {
    return null;
  }
  const instruction = `${PER_TILE_INSTRUCTION}\n\nWhole-grid instruction: ${JSON.stringify(opts.prompt)}`;
  const source = { config: opts.config, sample: opts.sample };
  const askOne = async (image: string): Promise<boolean | null> => {
    const reply = await askModel(
      source,
      instruction,
      image,
      1024,
      opts.timeoutMs ?? 20_000
    );
    return reply ? parseYes(reply) : null;
  };
  // MCP sampling is one request per call and some clients gate it behind a
  // human approval; asking all tiles at once is still right, but keep the
  // fan-out modest so a queued client is not flooded.
  const concurrency = opts.sample ? 1 : (opts.concurrency ?? 4);

  const verdicts: Array<boolean | null> = new Array(opts.tiles.length).fill(
    null
  );
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, opts.tiles.length) },
    async () => {
      for (let i = next++; i < opts.tiles.length; i = next++) {
        verdicts[i] = await askOne(opts.tiles[i].image);
      }
    }
  );
  await Promise.all(workers);

  const failed = verdicts.filter((v) => v === null).length;
  if (failed) {
    opts.note?.(`per-tile: ${failed}/${verdicts.length} tiles unanswered`);
  }
  if (failed === verdicts.length && verdicts.length > 0) {
    return null;
  }
  const picked = verdicts
    .map((v, i) => (v === true ? opts.tiles[i].index : -1))
    .filter((i) => i >= 0);
  if (!picked.length && failed) {
    // Some tiles failed and none were positive: "nothing" would be a guess.
    return null;
  }
  return picked;
}
