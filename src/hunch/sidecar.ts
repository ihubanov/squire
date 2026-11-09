/**
 * Bundled hunch — Squire's calibrated P(yes) judge.
 *
 * hunch (github.com/ihubanov/hunch) reads the probability of a constrained
 * answer token off a vLLM's logprobs, giving a *calibrated* yes/no / pick /
 * scale. Squire bundles it so verification and vision-grounding get a real
 * confidence number instead of the driving LLM's self-assessment.
 *
 * Design decisions (per the product requirements):
 *  - LIBRARY MODE, NO SERVER: driven as `python -m hunch judge -` — one JSON
 *    request on stdin, one JSON result on stdout. No HTTP, so nothing has to
 *    pick, reserve or poll a TCP port.
 *  - LATEST, auto-updating: installed from git@main into a dedicated venv, and
 *    upgraded on a daily cadence so it tracks the hunch repo without reinstalling
 *    every session. Installs under an exclusive lock so concurrent Squire
 *    sessions don't corrupt the venv.
 *  - Fail-closed and optional: dormant unless a backend vLLM is configured
 *    (SQUIRE_HUNCH_BACKEND_URL / HUNCH_BACKEND_URL); errors never fabricate a
 *    probability — callers treat them as "unknown", never "no".
 *
 * hunch needs an OpenAI-compatible vLLM endpoint serving a VISION model with
 * logprobs + structured outputs. Squire's *driving* LLM (Claude) cannot back it
 * (no enforced-choice logprobs) — this is a separate, self-hosted model.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import log from '../logger.js';

const execFileP = promisify(execFile);

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
/** Dedicated venv so hunch's deps never collide with the vision sidecar's. */
const VENV_DIR =
  process.env.SQUIRE_HUNCH_VENV ?? path.join(REPO_ROOT, '.venv-hunch');
const VENV_PY = path.join(VENV_DIR, 'bin', 'python');
/** Track LATEST: git main, upgraded on a cadence. */
const GIT_SPEC = 'hunch @ git+https://github.com/ihubanov/hunch@main';
const INSTALL_LOCK = path.join(os.tmpdir(), 'squire-hunch-install.lock');
const UPGRADE_MARKER = path.join(VENV_DIR, '.last-upgrade');
const UPGRADE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Live judge child, so shutdown can kill an in-flight call. */
let current: ChildProcess | null = null;

/** hunch is usable only when explicitly enabled AND a backend vLLM is configured. */
export function hunchEnabled(): boolean {
  if (process.env.SQUIRE_HUNCH === '0') {
    return false;
  }
  return Boolean(backendUrl());
}
function backendUrl(): string | undefined {
  return process.env.SQUIRE_HUNCH_BACKEND_URL ?? process.env.HUNCH_BACKEND_URL;
}
function backendModel(): string {
  return (
    process.env.SQUIRE_HUNCH_BACKEND_MODEL ??
    process.env.HUNCH_BACKEND_MODEL ??
    'default'
  );
}

function backendKey(): string | undefined {
  return process.env.SQUIRE_HUNCH_BACKEND_KEY ?? process.env.HUNCH_BACKEND_KEY;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface JudgeReply {
  results?: Record<string, unknown>;
  usage?: unknown;
  error?: { code?: string; message?: string };
}

/**
 * Run one hunch judge request. Resolves with the parsed reply (which may carry
 * `error`) or null when hunch is disabled / the child could not run at all.
 */
export async function runJudge(
  body: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<JudgeReply | null> {
  if (!hunchEnabled()) {
    return null;
  }
  if (!(await ensureInstalled())) {
    return null;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUNCH_BACKEND_URL: backendUrl()!,
    HUNCH_BACKEND_MODEL: backendModel(),
    // Skip the per-spawn mode probe: we always drive the same judge path.
    HUNCH_MODE: 'one_token',
    ...(backendKey() ? { HUNCH_BACKEND_KEY: backendKey()! } : {}),
  };

  return new Promise((resolve) => {
    const proc = spawn(VENV_PY, ['-m', 'hunch', 'judge', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    current = proc;
    let out = '';
    let err = '';
    let done = false;

    const finish = (reply: JudgeReply | null) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      current = null;
      resolve(reply);
    };

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ error: { code: 'timeout', message: `judge timed out` } });
    }, timeoutMs);

    proc.stdout!.setEncoding('utf8');
    proc.stderr!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => (out += d));
    proc.stderr!.on('data', (d: string) => (err += d));
    proc.on('error', (e) => {
      log.error(`[hunch] spawn failed: ${e.message}`);
      finish(null);
    });
    proc.on('close', () => {
      const text = out.trim();
      if (!text) {
        log.error(`[hunch] empty reply${err ? `: ${err.trim()}` : ''}`);
        finish({ error: { message: err.trim() || 'empty reply' } });
        return;
      }
      try {
        finish(JSON.parse(text.split('\n').pop()!) as JudgeReply);
      } catch {
        log.error(`[hunch] unparseable reply: ${text.slice(0, 200)}`);
        finish({ error: { message: 'unparseable reply' } });
      }
    });

    proc.stdin!.on('error', () => {
      /* EPIPE if the child exits early; reported via close */
    });
    proc.stdin!.end(JSON.stringify(body));
  });
}

/** Kill an in-flight judge (called on server shutdown). */
export function stopHunch(): void {
  if (current && !current.killed) {
    try {
      current.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  current = null;
}

/** Acquire a crude cross-process lock so two Squire sessions don't pip-install at once. */
async function withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 120; i++) {
    try {
      const fd = fs.openSync(INSTALL_LOCK, 'wx'); // O_CREAT|O_EXCL
      try {
        return await fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(INSTALL_LOCK);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
      // Stale lock (older than 5 min) → steal it.
      try {
        const age = Date.now() - fs.statSync(INSTALL_LOCK).mtimeMs;
        if (age > 5 * 60 * 1000) {
          fs.unlinkSync(INSTALL_LOCK);
        }
      } catch {
        /* ignore */
      }
      await sleep(1000);
    }
  }
  throw new Error('Timed out waiting for the hunch install lock');
}

/** Ensure the venv exists with an up-to-date (latest) hunch. */
async function ensureInstalled(): Promise<boolean> {
  const py = process.env.SQUIRE_HUNCH_PYTHON ?? 'python3';
  const haveVenv = fs.existsSync(VENV_PY);
  const dueForUpgrade = (() => {
    try {
      return (
        Date.now() - fs.statSync(UPGRADE_MARKER).mtimeMs > UPGRADE_INTERVAL_MS
      );
    } catch {
      return true; // no marker yet
    }
  })();
  if (haveVenv && !dueForUpgrade) {
    return true;
  }

  try {
    await withInstallLock(async () => {
      // Re-check inside the lock — another session may have just done it.
      if (fs.existsSync(VENV_PY)) {
        try {
          if (
            Date.now() - fs.statSync(UPGRADE_MARKER).mtimeMs <=
            UPGRADE_INTERVAL_MS
          ) {
            return;
          }
        } catch {
          /* fall through to upgrade */
        }
      } else {
        log.info(`Creating hunch venv at ${VENV_DIR}`);
        await execFileP(py, ['-m', 'venv', VENV_DIR]);
      }
      log.info('Installing/upgrading bundled hunch to latest (git@main)…');
      await execFileP(
        VENV_PY,
        ['-m', 'pip', 'install', '--quiet', '--upgrade', GIT_SPEC],
        {
          timeout: 240_000,
        }
      );
      try {
        fs.writeFileSync(UPGRADE_MARKER, new Date().toISOString());
      } catch {
        /* ignore */
      }
    });
    return true;
  } catch (e) {
    log.error(`[hunch] install failed: ${(e as Error).message}`);
    return false;
  }
}

// Never leave the python child behind.
for (const sig of ['exit', 'SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => stopHunch());
}
