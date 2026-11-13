/**
 * Finds and kills browsers that Squire launched itself.
 *
 * Every Playwright launch carries SQUIRE_OWNED_BROWSER=1 and the server pid in
 * SQUIRE_OWNER_PID. That marker is inherited by the whole browser process
 * tree, so cleanup does not depend on the owning server being reachable, on a
 * profile path, or on the npm install layout (a plugin run under `npx` has a
 * completely different argv from the systemd backend).
 *
 * Two uses:
 *   - a server at shutdown kills the browsers it owns if closing the sessions
 *     did not take them down (wedged browser, SIGKILLed renderer);
 *   - the plugin SessionEnd hook kills browsers whose owning server is gone
 *     (a crashed or SIGKILLed session), which is what leaves windows behind.
 *
 * Linux-only: it reads /proc/<pid>/environ. Elsewhere it is a no-op and the
 * normal Playwright close paths still apply.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const OWNED_BROWSER_ENV = 'SQUIRE_OWNED_BROWSER';
export const OWNER_PID_ENV = 'SQUIRE_OWNER_PID';

export interface OwnedBrowser {
  pid: number;
  ownerPid?: number;
}

/**
 * Environment for a browser launched by this server: the full parent
 * environment (Playwright replaces, not merges, when `env` is given) plus the
 * ownership marker.
 */
export function ownedBrowserEnv(
  ownerPid: number = process.pid
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env[OWNED_BROWSER_ENV] = '1';
  env[OWNER_PID_ENV] = String(ownerPid);
  return env;
}

function readEnviron(
  pid: number,
  procRoot: string
): Map<string, string> | null {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'environ'), 'utf8');
  } catch {
    return null;
  }
  const vars = new Map<string, string>();
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) {
      vars.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  }
  return vars;
}

/** Every live process carrying Squire's ownership marker. */
export function findOwnedBrowsers(procRoot = '/proc'): OwnedBrowser[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const found: OwnedBrowser[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (pid === process.pid) {
      continue;
    }
    const vars = readEnviron(pid, procRoot);
    if (vars?.get(OWNED_BROWSER_ENV) !== '1') {
      continue;
    }
    const owner = Number(vars.get(OWNER_PID_ENV));
    found.push({
      pid,
      ownerPid: Number.isInteger(owner) && owner > 0 ? owner : undefined,
    });
  }
  return found;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface CleanupOptions {
  /** Only browsers recorded as owned by this pid (server shutdown). */
  ownerPid?: number;
  /** Only browsers whose owning server is gone (session-end sweep). */
  orphansOnly?: boolean;
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number;
  procRoot?: string;
}

/** SIGTERM, then SIGKILL whatever survived the grace. Returns killed pids. */
export async function killOwnedBrowsers(
  opts: CleanupOptions = {}
): Promise<number[]> {
  const { ownerPid, orphansOnly = false, graceMs = 500 } = opts;
  const targets = findOwnedBrowsers(opts.procRoot)
    .filter((browser) => {
      if (ownerPid !== undefined && browser.ownerPid !== ownerPid) {
        return false;
      }
      if (
        orphansOnly &&
        browser.ownerPid !== undefined &&
        isPidAlive(browser.ownerPid)
      ) {
        return false;
      }
      return true;
    })
    .map((browser) => browser.pid);
  if (!targets.length) {
    return [];
  }
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const pid of targets) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  return targets;
}
