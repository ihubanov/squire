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
import { refusedError } from './cdp-proxy.js';

/** Profile directories Chrome/Chromium write DevToolsActivePort into. */
export function profileDirs(): string[] {
  const override = process.env.APPIUM_MCP_CHROME_PROFILE_DIR;
  if (override) {
    return [override];
  }
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

export async function resolveCdpEndpoint(
  endpoint: string,
  dirs: string[] = profileDirs()
): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  if (await hasDiscovery(endpoint)) {
    return endpoint;
  }

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

/** The browser's WebSocket URL for an endpoint from resolveCdpEndpoint. */
export async function toBrowserWebSocketUrl(endpoint: string): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const res = await fetch(new URL('/json/version', endpoint), {
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401 || res.status === 403 || res.status === 423) {
    throw refusedError(res.status, await res.text().catch(() => ''));
  }
  const { webSocketDebuggerUrl } = (await res.json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (!webSocketDebuggerUrl) {
    throw new Error(`${endpoint} gave no webSocketDebuggerUrl`);
  }
  // Chrome reports its own idea of the host; keep the one we were given.
  const ws = new URL(webSocketDebuggerUrl);
  ws.host = new URL(endpoint).host;
  return ws.toString();
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

/** `host:port` without a scheme (as herdr hands it out) means http. */
export function normalizeCdpEndpoint(endpoint: string): string {
  const e = endpoint.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

/**
 * A cdpEndpoint passed to create_session comes from the caller, and on a
 * shared backend anyone who can reach it is a caller, so only loopback
 * hosts are accepted unless APPIUM_MCP_CDP_ALLOWED_HOSTS (comma-separated
 * host or host:port, or `*`) allows more. The env endpoint is trusted.
 */
export function assertAllowedCdpHost(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `cdpEndpoint "${endpoint}" is not a valid URL or host:port`
    );
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) {
    throw new Error(
      `cdpEndpoint "${endpoint}" must be http(s):// or ws(s)://, or host:port`
    );
  }
  const host = url.hostname;
  if (LOOPBACK.test(host)) {
    return;
  }
  const allowed = (process.env.APPIUM_MCP_CDP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const hostPort = `${host}:${url.port}`.toLowerCase();
  if (
    allowed.includes('*') ||
    allowed.includes(host.toLowerCase()) ||
    allowed.includes(hostPort)
  ) {
    return;
  }
  throw new Error(
    `cdpEndpoint host "${host}" is not allowed: only loopback hosts are, unless APPIUM_MCP_CDP_ALLOWED_HOSTS lists it`
  );
}

/**
 * Start of the error when the endpoint refuses with 403, as a herdr pane's
 * input-lock gate does once the user takes control. Squire never retries
 * it: retrying would fight the user for the screen.
 */
export const CONTROL_REVOKED_PREFIX = 'Control revoked:';

/**
 * 401/403, or 423 (herdr's pane gate: "Locked") unless its reason says the
 * gate itself is misconfigured or cut off. An unknown 423 counts as
 * revoked: better to stop and ask than to fight the user for the screen.
 */
export function isControlRevoked(err: Error): boolean {
  const m = err.message;
  if (m.startsWith(CONTROL_REVOKED_PREFIX)) {
    return true;
  }
  if (/Unexpected server response: 40[13]\b/.test(m)) {
    return true;
  }
  return /Unexpected server response: 423\b/.test(m) && !gateFault(m);
}

/** herdr's gate refusing for its own reasons, not because the user took over. */
function gateFault(msg: string): string | undefined {
  return /Unexpected server response: 423 \((unauthorized|unreachable)\)/.exec(
    msg
  )?.[1];
}

/** Prefix for an attach that got past Allow but failed afterwards. */
export const ACCEPTED_PREFIX = 'Chrome accepted the connection, but';

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
  const fault = gateFault(msg);
  if (fault) {
    const hint = /: (.*)$/.exec(msg.split('\n')[0]!)?.[1];
    return fault === 'unauthorized'
      ? `the browser gate at ${endpoint} rejected Squire's credentials (423 unauthorized). This is a configuration problem, not the user taking control${hint ? `: ${hint}` : ''}.`
      : `the browser gate at ${endpoint} cannot reach herdr-web (423 unreachable), so it refuses all connections. This is an infrastructure problem, not the user taking control${hint ? `: ${hint}` : ''}.`;
  }
  if (isControlRevoked(err)) {
    const status = /Unexpected server response: (\d+)/.exec(msg)?.[1];
    return `${CONTROL_REVOKED_PREFIX} ${endpoint} refused the connection${status ? ` (${status})` : ''}, so the user has taken control of this browser. Stop and ask the user in chat before trying again; do not retry on your own.`;
  }
  if (msg.startsWith(ACCEPTED_PREFIX)) {
    return msg.split('\n')[0];
  }
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
      if (text.trim().split('\n')[0]?.trim() === port) {
        return dir;
      }
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
