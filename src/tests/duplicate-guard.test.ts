/**
 * One Squire server per client session. Two servers in the same process
 * group are the same client (the plugin plus a hand-written .mcp.json
 * entry); the older one survives so the newcomer exits deterministically.
 * Fake /proc keeps the test independent of real processes.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect, afterEach } from '@jest/globals';
import {
  duplicateGroups,
  findDuplicateSquireServer,
  isSquireServerArgv,
  type SquireProcess,
} from '../duplicate-guard.js';

const roots: string[] = [];

function procRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'squire-proc-'));
  roots.push(root);
  return root;
}

function writeProc(
  root: string,
  pid: number,
  opts: {
    ppid?: number;
    pgid: number;
    startTime: number;
    argv: string[];
  }
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir);
  const fields = new Array(20).fill('0');
  fields[0] = 'S';
  fields[1] = String(opts.ppid ?? 1);
  fields[2] = String(opts.pgid);
  fields[19] = String(opts.startTime);
  writeFileSync(join(dir, 'stat'), `${pid} (node) ${fields.join(' ')}\n`);
  writeFileSync(join(dir, 'cmdline'), opts.argv.join('\0') + '\0');
}

const serverArgv = (version: string) => [
  'node',
  `/home/u/.npm/_npx/hash/node_modules/.bin/squire`,
  `@${version}`,
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('isSquireServerArgv', () => {
  test('matches the npx bin and dist paths', () => {
    expect(
      isSquireServerArgv(['node', '/x/node_modules/.bin/squire', 'doctor2'])
    ).toBe(true);
    expect(
      isSquireServerArgv(['node', '/x/@sniffski/squire/dist/index.js'])
    ).toBe(true);
    expect(isSquireServerArgv(['node', '/x/appium-mcp/dist/index.js'])).toBe(
      true
    );
  });

  test('ignores the doctor CLI, wrappers and unrelated processes', () => {
    expect(
      isSquireServerArgv(['node', '/x/node_modules/.bin/squire', 'doctor'])
    ).toBe(false);
    expect(
      isSquireServerArgv(['npm', 'exec', '@sniffski/squire@1.34.13'])
    ).toBe(false);
    expect(isSquireServerArgv(['node', '/x/other/dist/index.js'])).toBe(false);
  });
});

describe('duplicateGroups', () => {
  const server = (
    pid: number,
    pgid: number,
    startTime: number
  ): SquireProcess => ({
    pid,
    ppid: 1,
    pgid,
    startTime,
    argv: serverArgv('1.34.14'),
  });

  test('keeps the oldest of each group and lists the rest as surplus', () => {
    const groups = duplicateGroups([
      server(300, 100, 200),
      server(301, 100, 100),
      server(302, 100, 300),
      server(400, 101, 100),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].pgid).toBe(100);
    expect(groups[0].servers.map((s) => s.pid)).toEqual([301, 300, 302]);
    expect(groups[0].surplus.map((s) => s.pid)).toEqual([300, 302]);
  });

  test('a start-time tie is broken by pid', () => {
    const groups = duplicateGroups([
      server(300, 100, 100),
      server(299, 100, 100),
    ]);
    expect(groups[0].surplus.map((s) => s.pid)).toEqual([300]);
  });

  test('no group for a single server', () => {
    expect(duplicateGroups([server(300, 100, 100)])).toEqual([]);
  });
});

describe('findDuplicateSquireServer', () => {
  test('a newer server loses to the older one in the same group', () => {
    const root = procRoot();
    writeProc(root, 300, {
      pgid: 100,
      startTime: 200,
      argv: serverArgv('1.34.13'),
    });
    writeProc(root, 301, {
      pgid: 100,
      startTime: 100,
      argv: serverArgv('1.34.9'),
    });

    const duplicate = findDuplicateSquireServer({ procRoot: root, pid: 300 });
    expect(duplicate?.self.pid).toBe(300);
    expect(duplicate?.older.pid).toBe(301);
  });

  test('the older server keeps running', () => {
    const root = procRoot();
    writeProc(root, 300, {
      pgid: 100,
      startTime: 100,
      argv: serverArgv('1.34.13'),
    });
    writeProc(root, 301, {
      pgid: 100,
      startTime: 200,
      argv: serverArgv('1.34.9'),
    });

    expect(findDuplicateSquireServer({ procRoot: root, pid: 300 })).toBeNull();
  });

  test('servers in different client sessions do not collide', () => {
    const root = procRoot();
    writeProc(root, 300, {
      pgid: 100,
      startTime: 200,
      argv: serverArgv('1.34.13'),
    });
    writeProc(root, 301, {
      pgid: 101,
      startTime: 100,
      argv: serverArgv('1.34.9'),
    });

    expect(findDuplicateSquireServer({ procRoot: root, pid: 300 })).toBeNull();
  });

  test('a start-time tie is broken by pid so exactly one survives', () => {
    const root = procRoot();
    writeProc(root, 300, {
      pgid: 100,
      startTime: 100,
      argv: serverArgv('1.34.13'),
    });
    writeProc(root, 299, {
      pgid: 100,
      startTime: 100,
      argv: serverArgv('1.34.9'),
    });

    const duplicate = findDuplicateSquireServer({ procRoot: root, pid: 300 });
    expect(duplicate?.older.pid).toBe(299);
  });
});
