/**
 * The plugin launches the MCP through plugin/bin/squire-mcp.mjs precisely so
 * a corrupt npx cache cannot leave a dead server. This drives the real shim
 * with a fake `npx` on PATH: the first run fails like npm does on a missing
 * root package.json, the shim repairs the cache, and the retry succeeds.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from '@jest/globals';

const shim = fileURLToPath(
  new URL('../../plugin/bin/squire-mcp.mjs', import.meta.url)
);
const spec = '@sniffski/squire@1.34.14';
const onWindows = process.platform === 'win32';

const roots: string[] = [];

interface Fixture {
  root: string;
  home: string;
  cache: string;
  brokenDir: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'squire-launcher-'));
  roots.push(root);
  const home = join(root, 'home');
  const cache = join(home, '.npm');
  const bin = join(root, 'bin');
  const brokenDir = join(cache, '_npx', 'deadbeef');
  mkdirSync(join(brokenDir, 'node_modules', '@sniffski', 'squire'), {
    recursive: true,
  });
  writeFileSync(
    join(brokenDir, 'node_modules', '@sniffski', 'squire', 'package.json'),
    JSON.stringify({ name: '@sniffski/squire', version: '1.34.14' })
  );
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'npx.log');
  const fakeNpx = join(bin, 'npx');
  writeFileSync(
    fakeNpx,
    [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'case "$FAKE_NPX_MODE" in',
      '  corrupt)',
      `    if [ -d "${brokenDir}" ]; then`,
      `      echo "npm error ENOENT: no such file or directory, open '${brokenDir}/package.json'" >&2`,
      '      exit 1',
      '    fi',
      '    echo 1.34.14',
      '    exit 0 ;;',
      '  network)',
      '    echo "npm error network request to https://registry.npmjs.org failed" >&2',
      '    exit 1 ;;',
      '  *)',
      '    echo 1.34.14',
      '    exit 0 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(fakeNpx, 0o755);

  return {
    root,
    home,
    cache,
    brokenDir,
    log,
    env: {
      ...process.env,
      HOME: home,
      npm_config_cache: cache,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_NPX_MODE: 'corrupt',
    },
  };
}

function runShim(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shim, spec], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function npxCalls(log: string): string[] {
  try {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const posixTest = onWindows ? test.skip : test;

describe('squire-mcp launcher', () => {
  posixTest(
    'repairs a corrupt npx cache and retries once',
    async () => {
      const f = fixture();
      const result = await runShim(f.env);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('1.34.14');
      expect(result.stderr).toContain('removed corrupt npx install');
      expect(result.stderr).toContain('retrying once');
      expect(existsSync(f.brokenDir)).toBe(false);
      expect(npxCalls(f.log)).toHaveLength(2);
    },
    15_000
  );

  posixTest(
    'does not retry an unrelated npx failure',
    async () => {
      const f = fixture();
      f.env.FAKE_NPX_MODE = 'network';
      const result = await runShim(f.env);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('network request');
      // One launch: the fresh broken dir is skipped by the startup age guard
      // (a concurrent install could look the same), and a network error is
      // not the cache-corruption signature that triggers the retry.
      expect(npxCalls(f.log)).toHaveLength(1);
    },
    15_000
  );

  posixTest(
    'a healthy cache is a single launch with no repair',
    async () => {
      const f = fixture();
      rmSync(f.brokenDir, { recursive: true, force: true });
      f.env.FAKE_NPX_MODE = 'ok';
      const result = await runShim(f.env);

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('removed corrupt');
      expect(npxCalls(f.log)).toHaveLength(1);
    },
    15_000
  );
});
