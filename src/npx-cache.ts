/**
 * npx cache integrity.
 *
 * `npx -y @sniffski/squire@<version>` installs into `_npx/<hash>/` and then
 * treats that directory as a finished install. If npm is interrupted
 * mid-install, the directory can contain `node_modules/` but no root
 * `package.json`; every later launch of that spec then dies with
 *   ENOENT .../_npx/<hash>/package.json
 * before any of our code runs. npx itself does not validate the cache, so
 * nothing recovers on its own.
 *
 * This module recognises exactly that shape and removes the unusable
 * directory so the next npx run reinstalls. It only deletes a directory that
 * (a) holds this package under `node_modules` and (b) has no usable root
 * manifest. Anything else — other packages, healthy installs, an install that
 * is still being written — is left alone.
 *
 * Runs on Linux, macOS and Windows; only the default cache location differs.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Package directories that identify a Squire-family npx install. */
export const SQUIRE_PACKAGE_NAMES = ['@sniffski/squire', 'appium-mcp'];

export interface NpxCacheEntry {
  /** `_npx/<hash>` directory. */
  dir: string;
  /** An install of a Squire-family package lives under `node_modules`. */
  hasPackage: boolean;
  /** The root package.json exists and parses as an object. */
  complete: boolean;
  /** Installed @sniffski/squire (or appium-mcp) version, when readable. */
  version: string | null;
}

/**
 * npm's cache root. `npm_config_cache` is set whenever npm/npx launches a
 * child; otherwise fall back to the platform default, matching npm's own
 * `@npmcli/config` (Windows uses %LocalAppData%\npm-cache).
 */
export function npmCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.npm_config_cache) {
    return env.npm_config_cache;
  }
  if (platform === 'win32') {
    const localAppData =
      env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'npm-cache');
  }
  return join(env.HOME || env.USERPROFILE || homedir(), '.npm');
}

/** A `cache=` line in the user's .npmrc, which takes precedence over the default. */
function npmrcCacheRoot(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const npmrc = readFileSync(join(home, '.npmrc'), 'utf8');
    const match = npmrc.match(/^\s*cache\s*=\s*(.+?)\s*$/m);
    return match ? match[1].replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

/**
 * Every cache root worth scanning, most specific first. The env var is what
 * npm/npx passes to its children; `.npmrc` covers a direct `squire doctor`
 * run with a custom cache; the platform default is the common case.
 */
export function npmCacheRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const roots: string[] = [];
  if (env.npm_config_cache) {
    roots.push(env.npm_config_cache);
  }
  const configured = npmrcCacheRoot(env);
  if (configured) {
    roots.push(configured);
  }
  roots.push(npmCacheRoot(env, platform));
  return [...new Set(roots)];
}

function npxRoot(cacheRoot: string): string {
  return join(cacheRoot, '_npx');
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function installedVersion(dir: string): string | null {
  for (const name of SQUIRE_PACKAGE_NAMES) {
    const pkg = readJsonObject(join(dir, 'node_modules', name, 'package.json'));
    if (pkg && typeof pkg.version === 'string') {
      return pkg.version;
    }
  }
  return null;
}

function describeEntry(dir: string): NpxCacheEntry {
  const hasPackage = SQUIRE_PACKAGE_NAMES.some((name) =>
    existsSync(join(dir, 'node_modules', name, 'package.json'))
  );
  return {
    dir,
    hasPackage,
    complete: readJsonObject(join(dir, 'package.json')) !== null,
    version: installedVersion(dir),
  };
}

export interface ScanOptions {
  /** One npm cache root to inspect; defaults to every likely root. */
  cacheRoot?: string;
}

/** Every Squire-family install in the npx cache (healthy or broken). */
export function scanNpxCache(options: ScanOptions = {}): NpxCacheEntry[] {
  const roots = options.cacheRoot ? [options.cacheRoot] : npmCacheRoots();
  const found: NpxCacheEntry[] = [];
  const seen = new Set<string>();
  for (const cacheRoot of roots) {
    const root = npxRoot(cacheRoot);
    let entries: string[];
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

/** A Squire install with no usable root manifest is unusable by npx. */
export function isBrokenSquireEntry(dir: string): boolean {
  const entry = describeEntry(dir);
  return entry.hasPackage && !entry.complete;
}

function directoryAgeMs(dir: string): number {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

export interface RepairOptions extends ScanOptions {
  /**
   * Skip directories touched more recently than this. An in-flight npx
   * install also has `node_modules` before its root manifest is written;
   * the age guard keeps a startup repair from deleting it underneath the
   * process that is writing it. Default 10s.
   */
  minAgeMs?: number;
}

/** Broken Squire cache directories, optionally ignoring very fresh ones. */
export function findBrokenSquireCaches(options: RepairOptions = {}): string[] {
  const minAgeMs = options.minAgeMs ?? 10_000;
  return scanNpxCache(options)
    .filter((entry) => !entry.complete)
    .filter((entry) => directoryAgeMs(entry.dir) >= minAgeMs)
    .map((entry) => entry.dir);
}

/**
 * Remove broken Squire installs from the npx cache. Returns the directories
 * that were actually deleted. Never throws: a repair is best-effort and a
 * launch must not die because a cache directory was undeletable.
 */
export function repairNpxCache(options: RepairOptions = {}): string[] {
  const removed: string[] = [];
  for (const dir of findBrokenSquireCaches(options)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Leave it: the caller still reports it as broken and the next npx
      // run will produce its own error with the real permission problem.
    }
  }
  return removed;
}
