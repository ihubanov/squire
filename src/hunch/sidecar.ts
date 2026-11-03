/**
 * Bundled hunch sidecar — Squire's calibrated P(yes) judge.
 *
 * hunch (github.com/ihubanov/hunch) is a thin Python/FastAPI service that reads
 * the probability of a constrained answer token off a vLLM's logprobs, giving a
 * *calibrated* yes/no / pick / scale. Squire bundles it as a managed sidecar so
 * verification and vision-grounding get a real confidence number instead of the
 * driving LLM's self-assessment.
 *
 * Design decisions (per the product requirements):
 *  - LATEST, auto-updating: installed from git@main into a dedicated venv, and
 *    upgraded on a daily cadence so it tracks the hunch repo without reinstalling
 *    every session.
 *  - Never fights another hunch on the host: it listens on a FREE port picked at
 *    spawn (the stock hunch default is 8791; we never assume it), and installs
 *    under an exclusive lock so concurrent Squire sessions don't corrupt the venv.
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
import { findFreePort } from '../free-port.js';
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

export interface HunchHandle {
  baseUrl: string;
  proc: ChildProcess;
}

let handle: HunchHandle | null = null;
let starting: Promise<HunchHandle | null> | null = null;

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

/**
 * Start (or reuse) the bundled hunch sidecar and return its base URL, or null
 * when hunch is disabled/unconfigured. Idempotent and concurrency-safe.
 */
export async function ensureHunch(): Promise<HunchHandle | null> {
  if (!hunchEnabled()) {
    return null;
  }
  if (handle && !handle.proc.killed) {
    return handle;
  }
  if (starting) {
    return starting;
  }

  starting = (async () => {
    try {
      await ensureInstalled();
      const port = await findFreePort(0); // 0 → any free port; never assume 8791
      const baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        ...process.env,
        HUNCH_HOST: '127.0.0.1',
        HUNCH_PORT: String(port),
        HUNCH_BACKEND_URL: backendUrl()!,
        HUNCH_BACKEND_MODEL: backendModel(),
        HUNCH_DEFAULT_MODEL: backendModel(),
        HUNCH_ALLOW_NOAUTH: '1', // localhost-only
        ...(backendKey() ? { HUNCH_BACKEND_KEY: backendKey()! } : {}),
      };
      const proc = spawn(VENV_PY, ['-m', 'hunch'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      proc.unref?.();
      proc.on('error', (e) => log.error(`[hunch] spawn failed: ${e.message}`));

      // Wait for the HTTP server to accept connections (models load / backend
      // probe can make /health 503 briefly; a reachable socket is enough to use).
      for (let i = 0; i < 30; i++) {
        try {
          await fetch(`${baseUrl}/v1/models`, {
            signal: AbortSignal.timeout(1500),
          });
          break;
        } catch {
          if (proc.killed || proc.exitCode != null) {
            throw new Error('hunch exited during startup');
          }
          await sleep(500);
        }
      }
      handle = { baseUrl, proc };
      log.info(
        `[hunch] sidecar up at ${baseUrl} (backend ${backendUrl()}, healthy=${await healthy(baseUrl)})`
      );
      return handle;
    } catch (e) {
      log.error(`[hunch] could not start sidecar: ${(e as Error).message}`);
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Stop the sidecar (called on server shutdown). */
export function stopHunch(): void {
  if (handle?.proc && !handle.proc.killed) {
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  handle = null;
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
async function ensureInstalled(): Promise<void> {
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
    return;
  }

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
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok; // 200 once the backend vLLM is reachable; 503 while it isn't
  } catch {
    return false;
  }
}

// Never leave the python child behind.
for (const sig of ['exit', 'SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => stopHunch());
}
