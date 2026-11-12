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
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HUNCH_TOML = join(homedir(), '.local/share/claude-local/hunch.toml');

export interface VisionConfig {
  /** Base URL ending in /v1. */
  url: string;
  model: string;
  key?: string;
}

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

/**
 * Classifies every tile in one request. Returns the selected indices, or
 * null when the endpoint is unusable — callers treat null as "no answer",
 * never as "nothing selected".
 */
export async function pickTiles(opts: {
  config: VisionConfig;
  prompt: string;
  /** The whole challenge grid, header included. */
  image: string;
  rows: number;
  cols: number;
  timeoutMs?: number;
}): Promise<number[] | null> {
  const instruction = INSTRUCTION.replaceAll(
    'ROWS',
    String(opts.rows)
  ).replaceAll('COLS', String(opts.cols));
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: `${instruction}\n\nChallenge instruction: ${JSON.stringify(opts.prompt)}`,
    },
    { type: 'image_url', image_url: { url: opts.image } },
  ];
  const body = {
    model: opts.config.model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    // A reasoning VL model spends 900-1300 tokens working through a 4x4 grid
    // before it answers; at 2048 a long grid is truncated mid-thought and the
    // reply carries no JSON. The headroom is what makes the answer reliable.
    max_tokens: 4096,
  };
  const res = await fetch(`${opts.config.url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.config.key
        ? { Authorization: `Bearer ${opts.config.key}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string | null; reasoning?: string | null };
    }>;
  };
  const message = data.choices?.[0]?.message;
  // A reasoning VL model can spend the whole budget thinking and leave
  // `content` null with the analysis in `reasoning`; its final JSON is
  // still there, so read it rather than blame the endpoint.
  const reply = message?.content || message?.reasoning;
  if (typeof reply !== 'string' || !reply.trim()) {
    return null;
  }
  return parseSelection(reply);
}
