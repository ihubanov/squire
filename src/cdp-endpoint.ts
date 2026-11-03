/**
 * Turn APPIUM_MCP_CDP_ENDPOINT into something connectOverCDP can attach to.
 *
 * Chrome's newer "Allow remote debugging for this browser instance" toggle
 * (chrome://inspect/#remote-debugging) serves the DevTools WebSocket but
 * not the /json discovery endpoints, so an http:// endpoint 404s there.
 * Chrome still writes the browser's WebSocket path to DevToolsActivePort
 * in its profile directory, which is where we find it.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Profile directories Chrome/Chromium write DevToolsActivePort into. */
export function profileDirs(): string[] {
  const override = process.env.APPIUM_MCP_CHROME_PROFILE_DIR;
  if (override) return [override];
  const home = homedir();
  const linux = [
    'google-chrome',
    'google-chrome-beta',
    'google-chrome-unstable',
    'chromium',
  ].map((d) => join(home, '.config', d));
  const mac = ['Google/Chrome', 'Google/Chrome Beta', 'Chromium'].map((d) =>
    join(home, 'Library', 'Application Support', d)
  );
  return [...linux, ...mac];
}

async function hasDiscovery(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/json/version', endpoint), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveCdpEndpoint(
  endpoint: string,
  dirs: string[] = profileDirs()
): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  if (await hasDiscovery(endpoint)) return endpoint;

  const url = new URL(endpoint);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const dir of dirs) {
    let text: string;
    try {
      text = await readFile(join(dir, 'DevToolsActivePort'), 'utf8');
    } catch {
      continue;
    }
    const [filePort, path] = text.trim().split('\n');
    if (filePort?.trim() === port && path?.startsWith('/devtools/browser/')) {
      return `ws://${url.hostname}:${port}${path.trim()}`;
    }
  }
  return endpoint;
}

/**
 * A one-line reason for a failed attach that tells the user what to do.
 * `resolved` is what resolveCdpEndpoint returned for `endpoint`.
 */
export function explainAttachError(
  err: Error,
  endpoint: string,
  resolved: string,
  timeoutMs: number
): string {
  const msg = err.message;
  if (/ECONNREFUSED/.test(msg)) {
    if (resolved !== endpoint) {
      return `Chrome's remote debugging is off (DevToolsActivePort is left over from when it was on). Turn on "Allow remote debugging" at chrome://inspect/#remote-debugging.`;
    }
    return `nothing is listening at ${endpoint}. Chrome is not running with remote debugging: turn it on at chrome://inspect/#remote-debugging, or start Chrome with --remote-debugging-port.`;
  }
  if (/timeout|timed out/i.test(msg)) {
    return `timed out after ${Math.round(timeoutMs / 1000)}s. If Chrome showed an "Allow remote debugging" prompt, it was not accepted in time; it may be in a Chrome window you are not looking at.`;
  }
  return msg.split('\n')[0];
}

/** The profile directory whose DevToolsActivePort names this port. */
export async function profileDirForPort(
  port: string,
  dirs: string[] = profileDirs()
): Promise<string | undefined> {
  for (const dir of dirs) {
    try {
      const text = await readFile(join(dir, 'DevToolsActivePort'), 'utf8');
      if (text.trim().split('\n')[0]?.trim() === port) return dir;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/**
 * Display names of the Chrome profiles open in `dir`, from its Local State.
 * CDP has no profile names, so this is the only place to get them.
 */
export async function openProfileNames(dir: string): Promise<string[]> {
  try {
    const state = JSON.parse(await readFile(join(dir, 'Local State'), 'utf8'));
    const cache = state?.profile?.info_cache ?? {};
    const active: string[] = state?.profile?.last_active_profiles ?? [];
    return active.map((d) => cache[d]?.name ?? d);
  } catch {
    return [];
  }
}
