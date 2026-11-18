/**
 * `squire doctor` — report Squire servers and npx installs on this machine,
 * and flag the ones that are not this version.
 *
 * Read-only by default: it never kills a process and never deletes a cache
 * directory, because a server may belong to a live session that is still
 * working. `squire doctor --fix` is the explicit opt-in: it removes corrupt
 * npx cache entries (so the next launch can reinstall) and stops duplicate
 * servers, keeping the oldest in each client session. It still never touches
 * a single stale server — that session's browser would vanish mid-task; it
 * reports it so the client can be restarted instead.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  listSquireServers,
  duplicateGroups,
  terminateDuplicateServers,
  type SquireProcess,
} from './duplicate-guard.js';
import {
  findBrokenSquireCaches,
  repairNpxCache,
  scanNpxCache as scanCacheEntries,
} from './npx-cache.js';

// FastMCP types its version as a semver template literal, so keep that shape.
export const CURRENT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version as `${number}.${number}.${number}`;

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
  return scanCacheEntries()
    .filter(
      (entry): entry is typeof entry & { version: string } =>
        entry.version !== null
    )
    .map((entry) => ({ version: entry.version, dir: entry.dir }));
}

function serverVersion(server: SquireProcess): string | null {
  const script = serverScript(server.argv);
  return script ? versionForScript(script) : null;
}

/**
 * Print the report and return the process exit code (1 if anything still
 * needs an operator after any requested fix).
 */
export async function runDoctor(
  options: { fix?: boolean } = {}
): Promise<number> {
  const current = CURRENT_VERSION;
  const fix = options.fix === true;
  const servers = listSquireServers();
  const brokenCaches = findBrokenSquireCaches({ minAgeMs: 0 });
  const duplicate = duplicateGroups(servers);

  console.log(`Squire doctor${fix ? ' --fix' : ''}`);
  console.log(`  this CLI: v${current} (${process.platform})`);
  console.log('');

  if (servers.length === 0) {
    console.log('Running Squire servers: none');
  } else {
    console.log(`Running Squire servers: ${servers.length}`);
    for (const server of servers) {
      const version = serverVersion(server);
      const label = version ? `v${version}` : 'unknown';
      const stale = version !== current;
      console.log(
        `  pid ${server.pid}  ${label.padEnd(12)} ${stale ? 'STALE' : 'ok'}`
      );
    }
    for (const group of duplicate) {
      console.log(
        `  DUPLICATE: ${group.servers.length} servers in client session ` +
          `${group.pgid} (pids ${group.servers.map((s) => s.pid).join(', ')})`
      );
    }
  }

  console.log('');
  const cached = scanNpxCache();
  if (cached.length === 0) {
    console.log('npx cache installs: none');
  } else {
    console.log(
      'npx cache installs (old entries are harmless; npx reuses ' +
        'the pin it was given):'
    );
    const broken = new Set(brokenCaches);
    for (const install of cached) {
      const corrupt = broken.has(install.dir)
        ? '  BROKEN (no package.json)'
        : '';
      const stale = install.version !== current ? '  (old)' : '';
      console.log(
        `  v${install.version.padEnd(12)} ${install.dir}${corrupt}${stale}`
      );
    }
  }

  let killed: number[] = [];
  if (fix) {
    console.log('');
    // Keep the default age guard: a directory written seconds ago may be a
    // concurrent npx install, and deleting it would break that launch.
    for (const dir of repairNpxCache()) {
      console.log(`  FIXED: removed corrupt npx install ${dir}`);
    }
    killed = terminateDuplicateServers(servers);
    for (const pid of killed) {
      console.log(`  FIXED: stopped duplicate server pid ${pid}`);
    }
  }

  // What still needs a human: a stale surviving server can only change
  // version by restarting its client; a corrupt cache that repair could not
  // delete is a permission problem; real duplicates remain only without --fix.
  const killedSet = new Set(killed);
  const survivors = servers.filter((server) => !killedSet.has(server.pid));
  const staleSurvivors = survivors.filter(
    (server) => serverVersion(server) !== current
  );
  const brokenAfter = findBrokenSquireCaches({ minAgeMs: 0 });
  const duplicatesAfter = duplicateGroups(survivors).length;
  const problems = staleSurvivors.length + brokenAfter.length + duplicatesAfter;

  console.log('');
  if (problems === 0) {
    console.log(`Result: all running servers are on v${current}.`);
  } else {
    if (staleSurvivors.length > 0) {
      console.log(
        `Result: ${staleSurvivors.length} running server(s) are not ` +
          `v${current}. Restart the Claude sessions that own them so they ` +
          `relaunch on the installed pin; the plugin's autoUpdate moves that ` +
          `pin with the plugin.`
      );
    }
    if (brokenAfter.length > 0) {
      console.log(
        `Result: ${brokenAfter.length} corrupt npx install(s) could not be ` +
          `removed. Delete them by hand (they will be reinstalled): ` +
          brokenAfter.join(', ')
      );
    }
    if (duplicatesAfter > 0) {
      console.log(
        `Result: ${duplicatesAfter} client session(s) still run two Squire ` +
          `servers. Rerun with \`squire doctor --fix\` (or remove one Squire ` +
          `entry) and restart.`
      );
    }
  }
  return problems === 0 ? 0 : 1;
}
