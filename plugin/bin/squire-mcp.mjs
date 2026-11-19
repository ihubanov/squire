#!/usr/bin/env node
/**
 * Squire MCP launcher.
 *
 * The plugin used to launch the server with `npx -y @sniffski/squire@<pin>`
 * directly. When an interrupted npm run leaves a half-installed
 * `~/.npm/_npx/<hash>/` (a `node_modules/` tree with no root `package.json`),
 * npx treats that directory as finished and every launch dies with
 *   ENOENT .../_npx/<hash>/package.json
 * before any Squire code runs — a cryptic dead MCP with no recovery path.
 *
 * This wrapper sits in front of npx and makes the launch self-healing:
 *   1. remove structurally-broken Squire installs from the npx cache (only
 *      directories that hold our package but no usable root manifest), then
 *   2. run npx normally, and
 *   3. if npx still dies early with a package.json/cache error while
 *      producing no stdout, repair again and retry exactly once.
 *
 * Everything is best-effort and platform-safe: no /proc, no shell on POSIX,
 * no assumptions outside the npm cache layout. Node >= 18 required.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAMES = ['@sniffski/squire', 'appium-mcp'];
const SPEC_RE = /^@sniffski\/squire@\d+\.\d+\.\d+$/;
const DEFAULT_MIN_AGE_MS = 10_000;
const EARLY_EXIT_MS = 30_000;

/** npm's cache root; mirrors npm's own default when npm did not set the env. */
export function npmCacheRoot(env = process.env) {
  if (env.npm_config_cache) {
    return env.npm_config_cache;
  }
  if (process.platform === 'win32') {
    const localAppData =
      env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'npm-cache');
  }
  return join(env.HOME || env.USERPROFILE || homedir(), '.npm');
}

/** A `cache=` line in the user's .npmrc takes precedence over the default. */
function npmrcCacheRoot(env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const npmrc = readFileSync(join(home, '.npmrc'), 'utf8');
    const match = npmrc.match(/^\s*cache\s*=\s*(.+?)\s*$/m);
    return match ? match[1].replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

/** Every cache root worth scanning, most specific first. */
export function npmCacheRoots(env = process.env) {
  const roots = [];
  if (env.npm_config_cache) {
    roots.push(env.npm_config_cache);
  }
  const configured = npmrcCacheRoot(env);
  if (configured) {
    roots.push(configured);
  }
  roots.push(npmCacheRoot(env));
  return [...new Set(roots)];
}

function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function installedVersion(dir) {
  for (const name of PACKAGE_NAMES) {
    const pkg = readJsonObject(join(dir, 'node_modules', name, 'package.json'));
    if (pkg && typeof pkg.version === 'string') {
      return pkg.version;
    }
  }
  return null;
}

function describeEntry(dir) {
  const hasPackage = PACKAGE_NAMES.some((name) =>
    existsSync(join(dir, 'node_modules', name, 'package.json'))
  );
  return {
    dir,
    hasPackage,
    complete: readJsonObject(join(dir, 'package.json')) !== null,
    version: installedVersion(dir),
  };
}

/** Every Squire-family install in the npx cache (healthy or broken). */
export function scanNpxCache(options = {}) {
  const roots = options.cacheRoot ? [options.cacheRoot] : npmCacheRoots();
  const found = [];
  const seen = new Set();
  for (const cacheRoot of roots) {
    const root = join(cacheRoot, '_npx');
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      if (seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      const described = describeEntry(dir);
      if (described.hasPackage) {
        found.push(described);
      }
    }
  }
  return found;
}

/** Broken Squire installs, ignoring directories touched just now. */
export function findBrokenCaches({
  cacheRoot,
  minAgeMs = DEFAULT_MIN_AGE_MS,
} = {}) {
  return scanNpxCache({ cacheRoot })
    .filter((entry) => !entry.complete)
    .filter((entry) => {
      try {
        return Date.now() - statSync(entry.dir).mtimeMs >= minAgeMs;
      } catch {
        return false;
      }
    })
    .map((entry) => entry.dir);
}

/** Remove broken Squire installs. Returns the directories actually deleted. */
export function repairNpxCache(options = {}) {
  const removed = [];
  for (const dir of findBrokenCaches(options)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Leave it; npx will report the real permission problem.
    }
  }
  return removed;
}

/** A package-manifest error is the cache-corruption signature. */
export function looksLikeCorruptCache(stderr) {
  return (
    /package\.json/i.test(stderr) &&
    /(ENOENT|ENOTDIR|EJSONPARSE|Unexpected end of JSON|Cannot find module|ERR_MODULE_NOT_FOUND)/i.test(
      stderr
    )
  );
}

/**
 * The pinned version does not exist on the registry. This is what a plugin
 * that advertises a pin before its release publishes looks like to a user;
 * npx must not leave them with a dead server over it.
 */
export function looksLikeUnavailableVersion(stderr) {
  return (
    /(ETARGET|E404|ENOVERSIONS)/i.test(stderr) ||
    /No matching version/i.test(stderr) ||
    /404 (?:Not Found|no such package)/i.test(stderr)
  );
}

function runNpx(spec, extraArgs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdoutBytes = 0;
    let stderrTail = '';
    let settled = false;
    const isWin = process.platform === 'win32';

    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve({
          ...result,
          stdoutBytes,
          stderrTail,
          elapsedMs: Date.now() - started,
        });
      }
    };

    let child;
    try {
      child = spawn('npx', ['-y', spec, ...extraArgs], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
        // Run npm exec outside the client's project. When the session cwd (or
        // any ancestor) is a Squire checkout whose package.json name AND
        // version match the pin, npm exec resolves that local project instead
        // of fetching from the registry and then dies trying to run a bin it
        // never linked (`sh: 1: squire: not found`). A temp dir has no such
        // manifest, so the pinned package is always installed and run.
        cwd: tmpdir(),
        // Windows resolves npx.cmd through cmd.exe; POSIX needs no shell.
        shell: isWin,
      });
    } catch (error) {
      console.error(`squire-mcp: could not start npx: ${error.message}`);
      finish({ code: 127, signal: null });
      return;
    }

    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Child already gone.
      }
    };
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    for (const signal of signals) {
      process.on(signal, forward);
    }
    const detach = () => {
      for (const signal of signals) {
        process.removeListener(signal, forward);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-8192);
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      console.error(`squire-mcp: could not run npx: ${error.message}`);
      console.error(
        'squire-mcp: install Node.js (>= 18) and make sure npx is on PATH.'
      );
      detach();
      finish({ code: 127, signal: null });
    });
    child.on('close', (code, signal) => {
      detach();
      finish({ code, signal });
    });
  });
}

function reportUnrepaired() {
  console.error(
    'squire-mcp: npx exited with a package/cache error, but no broken ' +
      'Squire install was found to repair.'
  );
  console.error(
    `squire-mcp: inspect ${join(npmCacheRoot(), '_npx')} and delete the entry ` +
      'that has node_modules/ but no package.json; npx will reinstall it.'
  );
}

async function main() {
  const [spec, ...extraArgs] = process.argv.slice(2);
  if (!spec || !SPEC_RE.test(spec)) {
    console.error(
      'squire-mcp: usage: squire-mcp.mjs @sniffski/squire@<x.y.z> [server args]'
    );
    process.exit(2);
  }

  for (const dir of repairNpxCache()) {
    console.error(`squire-mcp: removed corrupt npx install ${dir}`);
  }

  let result = await runNpx(spec, extraArgs);
  const failedEarly =
    result.code !== 0 &&
    result.stdoutBytes === 0 &&
    result.elapsedMs < EARLY_EXIT_MS;

  if (failedEarly && looksLikeCorruptCache(result.stderrTail)) {
    // The failure itself proves this entry is not an in-flight install, so
    // the age guard does not apply on the retry.
    const repaired = repairNpxCache({ minAgeMs: 0 });
    if (repaired.length === 0) {
      reportUnrepaired();
    } else {
      for (const dir of repaired) {
        console.error(`squire-mcp: removed corrupt npx install ${dir}`);
      }
      console.error('squire-mcp: repaired the npx cache; retrying once...');
      result = await runNpx(spec, extraArgs);
    }
  } else if (failedEarly && looksLikeUnavailableVersion(result.stderrTail)) {
    // A pin can reach this launcher before its release is on npm (a tag-first
    // release, or a client that updated mid-publish). Never leave the user
    // with a dead server: fall back to the moving latest tag once.
    console.error(
      `squire-mcp: ${spec} is not available on npm; ` +
        'falling back to @sniffski/squire@latest'
    );
    result = await runNpx('@sniffski/squire@latest', extraArgs);
  }

  if (result.signal) {
    process.exit(1);
  }
  process.exit(result.code ?? 1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
