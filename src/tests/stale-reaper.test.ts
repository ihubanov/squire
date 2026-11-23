/**
 * Startup reaper: only provably abandoned, older-version servers are
 * signalled. A fake /proc keeps the tests independent of real processes, and
 * the signal sender is injected so a test can never touch a real pid.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect, afterEach } from '@jest/globals';
import { CURRENT_VERSION } from '../doctor.js';
import {
  listReapableServers,
  reapAbandonedServers,
  reportSystemdBackends,
} from '../stale-reaper.js';

const STALE = '1.0.0';
const USER_CGROUP = '0::/user.slice/user-1000.slice/session-2.scope\n';
const SYSTEMD_CGROUP =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/appium-mcp-backend.service\n';

const roots: string[] = [];

function procRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'squire-reap-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A real on-disk install so versionForScript can read its package.json. */
function makeInstall(root: string, version: string): string {
  const pkg = join(
    root,
    'installs',
    version,
    'node_modules',
    '@sniffski',
    'squire'
  );
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@sniffski/squire', version })
  );
  const script = join(pkg, 'dist', 'index.js');
  writeFileSync(script, '// fake server\n');
  return script;
}

interface ProcSpec {
  ppid?: number;
  pgid: number;
  startTime?: number;
  argv: string[];
  cgroup?: string;
}

function writeProc(root: string, pid: number, spec: ProcSpec): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  const fields = new Array(20).fill('0');
  fields[0] = 'S';
  fields[1] = String(spec.ppid ?? 1);
  fields[2] = String(spec.pgid);
  fields[19] = String(spec.startTime ?? 1);
  writeFileSync(join(dir, 'stat'), `${pid} (node) ${fields.join(' ')}\n`);
  writeFileSync(join(dir, 'cmdline'), spec.argv.join('\0') + '\0');
  writeFileSync(join(dir, 'cgroup'), spec.cgroup ?? USER_CGROUP);
}

/** A live claude process: a server under it belongs to a live session. */
function writeClaude(root: string, pid: number): void {
  writeProc(root, pid, {
    ppid: 1,
    pgid: pid,
    argv: ['/home/u/.local/bin/claude'],
  });
}

interface SignalCall {
  pid: number;
  signal: NodeJS.Signals;
}

function recorder(root: string): {
  calls: SignalCall[];
  signal: (pid: number, signal: NodeJS.Signals) => void;
} {
  const calls: SignalCall[] = [];
  return {
    calls,
    signal: (pid, signal) => {
      calls.push({ pid, signal });
      // A reaped process disappears from the fake process table.
      rmSync(join(root, String(pid)), { recursive: true, force: true });
    },
  };
}

describe('listReapableServers', () => {
  test('an abandoned older-version server is reapable', () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, { ppid: 1, pgid: 300, argv: ['node', script] });

    const plan = listReapableServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
    });

    expect(plan.candidates.map((c) => [c.pid, c.version])).toEqual([
      [300, STALE],
    ]);
    expect(plan.systemd).toEqual([]);
  });

  test('a live claude ancestor protects the server', () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, { ppid: 400, pgid: 300, argv: ['node', script] });
    writeClaude(root, 400);

    const plan = listReapableServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.find((s) => s.pid === 300)?.reason).toBe(
      'live claude ancestor'
    );
  });

  test('a same-version orphan is left to the transport guard', () => {
    const root = procRoot();
    const script = makeInstall(root, CURRENT_VERSION);
    writeProc(root, 300, { ppid: 1, pgid: 300, argv: ['node', script] });

    const plan = listReapableServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.find((s) => s.pid === 300)?.reason).toBe(
      'current version'
    );
  });

  test('a systemd-owned server is reported, never signalled', () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, {
      ppid: 1,
      pgid: 300,
      argv: ['node', script],
      cgroup: SYSTEMD_CGROUP,
    });

    const plan = listReapableServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.systemd.map((s) => s.pid)).toEqual([300]);
    expect(reportSystemdBackends(plan.systemd)[0]).toContain(
      'systemctl --user disable --now appium-mcp-backend.service'
    );
  });

  test('a server in our own process group is left alone', () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, { ppid: 1, pgid: 555, argv: ['node', script] });

    const plan = listReapableServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 555,
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.find((s) => s.pid === 300)?.reason).toBe(
      'same client session'
    );
  });
});

describe('reapAbandonedServers', () => {
  test('signals an abandoned older-version server', async () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, { ppid: 1, pgid: 300, argv: ['node', script] });
    const { calls, signal } = recorder(root);

    const report = await reapAbandonedServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
      quiet: true,
      signal,
    });

    expect(report.reaped).toEqual([
      { pid: 300, version: STALE, signal: 'SIGTERM' },
    ]);
    expect(calls).toEqual([{ pid: 300, signal: 'SIGTERM' }]);
  });

  test('a live claude ancestor is never signalled', async () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, { ppid: 400, pgid: 300, argv: ['node', script] });
    writeClaude(root, 400);
    const { calls, signal } = recorder(root);

    const report = await reapAbandonedServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
      quiet: true,
      signal,
    });

    expect(report.reaped).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a systemd-owned server is not signalled', async () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, {
      ppid: 1,
      pgid: 300,
      argv: ['node', script],
      cgroup: SYSTEMD_CGROUP,
    });
    const { calls, signal } = recorder(root);

    const report = await reapAbandonedServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
      quiet: true,
      signal,
    });

    expect(report.reaped).toEqual([]);
    expect(report.systemd.map((s) => s.pid)).toEqual([300]);
    expect(calls).toEqual([]);
  });

  test('SQUIRE_NO_REAP=1 disables the reaper', async () => {
    const root = procRoot();
    const script = makeInstall(root, STALE);
    writeProc(root, 300, { ppid: 1, pgid: 300, argv: ['node', script] });
    const { calls, signal } = recorder(root);

    const report = await reapAbandonedServers({
      procRoot: root,
      selfPid: 999,
      selfPgid: 999,
      quiet: true,
      signal,
      env: { SQUIRE_NO_REAP: '1' },
    });

    expect(report.reaped).toEqual([]);
    expect(calls).toEqual([]);
  });
});
