/**
 * `squire doctor` — report Squire servers and npx installs on this machine,
 * and flag the ones that are not this version.
 *
 * Read-only. It never kills a process and never deletes a cache directory:
 * a server may belong to a live session that is still working, and npx
 * reuses cached versions without cost. The report exists so the stale
 * leftovers are visible instead of silently answering tool calls.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listSquireServers, type SquireProcess } from './duplicate-guard.js';

// FastMCP types its version as a semver template literal, so keep that shape.
export const CURRENT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version as `${number}.${number}.${number}`;

const PACKAGE_DIRS = ['@sniffski/squire', 'appium-mcp'];

/** The JS file a server process is running, if it can be identified. */
export function serverScript(argv: string[]): string | undefined {
  return argv.find(
    (arg) =>
      /dist[\\/]index\.js$/.test(arg) ||
      /node_modules[\\/]\.bin[\\/](squire|appium-mcp)$/.test(arg)
  );
}

/** The package version behind a server's script path, if readable. */
export function versionForScript(script: string): string | null {
  let resolved = script;
  try {
    resolved = realpathSync(script);
  } catch {
    // Keep the path as given; the package.json read may still work.
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(resolved)), 'package.json'), 'utf8')
    );
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export interface CachedInstall {
  version: string;
  dir: string;
}

/** Squire copies in the npx cache (`~/.npm/_npx/<hash>/node_modules/...`). */
export function scanNpxCache(): CachedInstall[] {
  const cache = process.env.npm_config_cache || join(homedir(), '.npm');
  const npxRoot = join(cache, '_npx');
  let entries: string[];
  try {
    entries = readdirSync(npxRoot);
  } catch {
    return [];
  }
  const installs: CachedInstall[] = [];
  for (const entry of entries) {
    const dir = join(npxRoot, entry);
    for (const name of PACKAGE_DIRS) {
      try {
        const pkg = JSON.parse(
          readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')
        );
        if (typeof pkg.version === 'string') {
          installs.push({ version: pkg.version, dir });
        }
      } catch {
        // Not an install of this package.
      }
    }
  }
  return installs;
}

function describeServer(
  server: SquireProcess,
  current: string
): { line: string; stale: boolean } {
  const script = serverScript(server.argv);
  const version = script ? versionForScript(script) : null;
  const label = version ? `v${version}` : 'unknown';
  const stale = version !== current;
  return {
    line: `  pid ${server.pid}  ${label.padEnd(12)} ${stale ? 'STALE' : 'ok'}`,
    stale,
  };
}

/** Print the report and return the process exit code (1 if anything stale). */
export async function runDoctor(): Promise<number> {
  const current = CURRENT_VERSION;
  const servers = listSquireServers();

  console.log(`Squire doctor`);
  console.log(`  this CLI: v${current} (${process.platform})`);
  console.log('');

  let problems = 0;
  if (servers.length === 0) {
    console.log('Running Squire servers: none');
  } else {
    console.log(`Running Squire servers: ${servers.length}`);
    for (const server of servers) {
      const { line, stale } = describeServer(server, current);
      console.log(line);
      if (stale) {
        problems++;
      }
    }
    const byGroup = new Map<number, number[]>();
    for (const server of servers) {
      byGroup.set(server.pgid, [
        ...(byGroup.get(server.pgid) ?? []),
        server.pid,
      ]);
    }
    for (const [pgid, pids] of byGroup) {
      if (pids.length > 1) {
        problems++;
        console.log(
          `  DUPLICATE: ${pids.length} servers in client session ${pgid} ` +
            `(pids ${pids.join(', ')})`
        );
      }
    }
  }

  const cached = scanNpxCache();
  console.log('');
  if (cached.length === 0) {
    console.log('npx cache installs: none');
  } else {
    console.log(
      'npx cache installs (old entries are harmless; npx reuses ' +
        'the pin it was given):'
    );
    for (const install of cached) {
      const stale = install.version !== current ? '  (old)' : '';
      console.log(`  v${install.version.padEnd(12)} ${install.dir}${stale}`);
    }
  }

  console.log('');
  if (problems === 0) {
    console.log('Result: all running servers are on v' + current + '.');
  } else {
    console.log(
      `Result: ${problems} problem(s). Restart the Claude sessions that own ` +
        `the stale or duplicate servers so they relaunch on the installed ` +
        `pin; the plugin's autoUpdate moves that pin with the plugin.`
    );
  }
  return problems === 0 ? 0 : 1;
}
