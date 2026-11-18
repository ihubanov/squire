/**
 * A half-installed npx cache entry (node_modules present, root package.json
 * missing) kills every launch of that spec with ENOENT before any Squire code
 * runs. Detection must see exactly that shape, and repair must delete exactly
 * that shape — never a healthy install, another package, or an install that
 * is being written right now.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import {
  findBrokenSquireCaches,
  npmCacheRoot,
  npmCacheRoots,
  repairNpxCache,
  scanNpxCache,
} from '../npx-cache.js';

const roots: string[] = [];

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'squire-npx-'));
  roots.push(root);
  mkdirSync(join(root, '_npx'), { recursive: true });
  return root;
}

interface InstallOptions {
  packageName?: string;
  version?: string;
  /** false: simulate the interrupted install (no root package.json). */
  rootManifest?: boolean | string;
}

function install(
  root: string,
  hash: string,
  options: InstallOptions = {}
): string {
  const name = options.packageName ?? '@sniffski/squire';
  const dir = join(root, '_npx', hash);
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name,
      version: options.version ?? '1.34.14',
    })
  );
  if (options.rootManifest !== false) {
    const raw =
      typeof options.rootManifest === 'string'
        ? options.rootManifest
        : JSON.stringify({
            dependencies: { [name]: `^${options.version ?? '1.34.14'}` },
            _npx: { packages: [`${name}@${options.version ?? '1.34.14'}`] },
          });
    writeFileSync(join(dir, 'package.json'), raw);
  }
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('npmCacheRoot', () => {
  test('honours npm_config_cache', () => {
    expect(
      npmCacheRoot({ npm_config_cache: '/tmp/custom-cache' }, 'linux')
    ).toBe('/tmp/custom-cache');
  });

  test('uses npm platform defaults off Windows', () => {
    expect(npmCacheRoot({}, 'linux').endsWith('.npm')).toBe(true);
    expect(npmCacheRoot({}, 'darwin').endsWith('.npm')).toBe(true);
  });

  test('uses %LocalAppData%\\npm-cache on Windows', () => {
    expect(npmCacheRoot({ LOCALAPPDATA: '/win/appdata' }, 'win32')).toBe(
      join('/win/appdata', 'npm-cache')
    );
  });

  test('also scans a cache configured in the user .npmrc', () => {
    const home = mkdtempSync(join(tmpdir(), 'squire-home-'));
    roots.push(home);
    writeFileSync(join(home, '.npmrc'), 'cache = /custom/npm-cache\n');
    const found = npmCacheRoots({ HOME: home }, 'linux');
    expect(found[0]).toBe('/custom/npm-cache');
    expect(found).toContain(join(home, '.npm'));
  });
});

describe('scanNpxCache', () => {
  test('reports healthy and broken Squire installs with their versions', () => {
    const root = cacheRoot();
    install(root, 'healthy', { version: '1.34.14' });
    install(root, 'broken', { version: '1.34.14', rootManifest: false });

    const entries = scanNpxCache({ cacheRoot: root }).sort((a, b) =>
      a.dir < b.dir ? -1 : 1
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.complete)).toEqual([false, true]);
    expect(entries.every((entry) => entry.version === '1.34.14')).toBe(true);
  });

  test('a zero-byte root manifest counts as broken', () => {
    const root = cacheRoot();
    const dir = install(root, 'truncated', { rootManifest: '' });
    expect(scanNpxCache({ cacheRoot: root })[0].complete).toBe(false);
    expect(findBrokenSquireCaches({ cacheRoot: root, minAgeMs: 0 })).toEqual([
      dir,
    ]);
  });

  test('ignores unrelated npx packages', () => {
    const root = cacheRoot();
    install(root, 'other', { packageName: 'left-pad', rootManifest: false });
    expect(scanNpxCache({ cacheRoot: root })).toEqual([]);
  });

  test('returns nothing when there is no npx cache at all', () => {
    expect(
      scanNpxCache({ cacheRoot: join(tmpdir(), 'missing-squire') })
    ).toEqual([]);
  });
});

describe('repairNpxCache', () => {
  test('removes only the broken Squire install', () => {
    const root = cacheRoot();
    const healthy = install(root, 'healthy');
    const broken = install(root, 'broken', { rootManifest: false });
    const unrelated = install(root, 'other', {
      packageName: 'left-pad',
      rootManifest: false,
    });

    const removed = repairNpxCache({ cacheRoot: root, minAgeMs: 0 });

    expect(removed).toEqual([broken]);
    expect(existsSync(broken)).toBe(false);
    expect(existsSync(healthy)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('leaves a freshly touched entry alone (concurrent install)', () => {
    const root = cacheRoot();
    const broken = install(root, 'in-flight', { rootManifest: false });

    expect(repairNpxCache({ cacheRoot: root, minAgeMs: 60_000 })).toEqual([]);
    expect(existsSync(broken)).toBe(true);
  });

  test('is idempotent', () => {
    const root = cacheRoot();
    install(root, 'broken', { rootManifest: false });
    expect(repairNpxCache({ cacheRoot: root, minAgeMs: 0 })).toHaveLength(1);
    expect(repairNpxCache({ cacheRoot: root, minAgeMs: 0 })).toEqual([]);
  });

  test('also recognises the appium-mcp package name', () => {
    const root = cacheRoot();
    const broken = install(root, 'legacy', {
      packageName: 'appium-mcp',
      rootManifest: false,
    });
    expect(repairNpxCache({ cacheRoot: root, minAgeMs: 0 })).toEqual([broken]);
  });
});
