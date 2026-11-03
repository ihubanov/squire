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
