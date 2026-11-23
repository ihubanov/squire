/**
 * Stale Squire server reaper.
 *
 * Every client session launches its own stdio server. When a session ends
 * uncleanly (a killed terminal, a crashed client) its server can outlive it;
 * across a few upgrades that leaves several old versions running at once.
 * Those orphans hold browser connections and answer with stale tools.
 *
 * This module stops only servers it can *prove* are abandoned:
 *
 *   - an older version (`versionForScript` says it is not CURRENT_VERSION);
 *   - no ancestor process named `claude` — a live session owns it, so leave it;
 *   - the parent chain is readable and reaches init / systemd --user, i.e. it
 *     was reparented rather than still attached to a client;
 *   - not in our own process group (duplicate-guard owns that case);
 *   - not managed by a systemd unit — a unit will just restart it, so report
 *     the disable command instead of fighting it.
 *
 * A same-version orphan is deliberately left alone: transport-guard owns the
 * "client is gone" shutdown for those, and killing one could race that path.
 *
 * Linux-only (it reads /proc); elsewhere every entry point is a no-op. Never
 * throws: housekeeping must not be able to block a server from starting.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import log from './logger.js';
import {
  listSquireServers,
  readProcStat,
  type SquireProcess,
} from './duplicate-guard.js';
import { CURRENT_VERSION, serverScript, versionForScript } from './doctor.js';

/** The exact command that retires the legacy shared backend. */
export const SYSTEMD_DISABLE_COMMAND =
  'systemctl --user disable --now appium-mcp-backend.service appium-mcp.socket appium-mcp.service';

/** A cgroup path that names one of the legacy appium/squire units. */
const SYSTEMD_CGROUP = /(?:appium-mcp|squire)[^/]*\.service/;

export interface SystemdServer {
  pid: number;
  version: string | null;
  /** Unit name from the cgroup path (e.g. appium-mcp-backend.service). */
  unit: string;
}

export interface SkippedServer {
  pid: number;
  version: string | null;
  reason: string;
}

export interface ReapCandidate {
  pid: number;
  version: string;
  proc: SquireProcess;
}

export interface ReapPlan {
  /** Abandoned servers that may be signalled. */
  candidates: ReapCandidate[];
  /** Systemd-owned servers that must never be signalled by us. */
  systemd: SystemdServer[];
  /** Everything else, with the reason it was left alone. */
  skipped: SkippedServer[];
}

export interface ReaperOptions {
  /** Fake /proc root for tests. */
  procRoot?: string;
  /** Override this process's pid (tests). */
  selfPid?: number;
  /** Override this process's group id (tests). */
  selfPgid?: number;
}

export interface ReapOptions extends ReaperOptions {
  env?: NodeJS.ProcessEnv;
  /** Signal sender; tests replace it so no real pid is ever signalled. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  /** Suppress the module's own logging (doctor prints its own report). */
  quiet?: boolean;
}

export interface ReapedServer {
  pid: number;
  version: string;
  signal: 'SIGTERM' | 'SIGKILL' | 'gone';
}

export interface ReapReport {
  reaped: ReapedServer[];
  systemd: SystemdServer[];
  skipped: SkippedServer[];
}

function truthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !['0', 'false', 'no'].includes(value.toLowerCase());
}

function readCmdline(pid: number, procRoot: string): string[] | null {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function commandName(argv: string[]): string {
  return basename(argv[0] ?? '');
}

function readCgroup(pid: number, procRoot: string): string | null {
  try {
    return readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8');
  } catch {
    return null;
  }
}

function systemdUnit(cgroup: string): string | null {
  for (const line of cgroup.split('\n')) {
    const match = line.match(SYSTEMD_CGROUP);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function installedVersion(proc: SquireProcess): string | null {
  const script = serverScript(proc.argv);
  return script ? versionForScript(script) : null;
}

interface Abandonment {
  abandoned: boolean;
  reason: string;
}

/**
 * Walk the parent chain. A `claude` ancestor means a live session still owns
 * the server; an unreadable hop means we cannot prove anything, so we leave
 * it. Reaching init (pid <= 1) proves it was reparented.
 */
function abandonment(proc: SquireProcess, procRoot: string): Abandonment {
  let pid = proc.ppid;
  if (pid === proc.pid) {
    return { abandoned: false, reason: 'self-parent' };
  }
  while (pid > 1) {
    const argv = readCmdline(pid, procRoot);
    if (!argv) {
      return { abandoned: false, reason: 'ancestry unreadable' };
    }
    if (commandName(argv) === 'claude') {
      return { abandoned: false, reason: 'live claude ancestor' };
    }
    const stat = readProcStat(pid, procRoot);
    if (!stat) {
      return { abandoned: false, reason: 'ancestry unreadable' };
    }
    pid = stat.ppid;
  }
  return { abandoned: true, reason: 'orphaned' };
}

/**
 * Decide which servers may be reaped. Pure read of the process table: no
 * signals, no deletion. Exported for tests and for `squire doctor`.
 */
export function listReapableServers(options: ReaperOptions = {}): ReapPlan {
  const plan: ReapPlan = { candidates: [], systemd: [], skipped: [] };
  if (process.platform !== 'linux') {
    return plan;
  }

  const procRoot = options.procRoot ?? '/proc';
  const selfPid = options.selfPid ?? process.pid;
  const selfPgid = options.selfPgid ?? readProcStat(selfPid, procRoot)?.pgid;

  let servers: SquireProcess[];
  try {
    servers = listSquireServers(procRoot);
  } catch {
    return plan;
  }

  for (const server of servers) {
    const version = installedVersion(server);

    // A systemd unit restarts whatever we stop, so it is reported, never
    // signalled. An unreadable cgroup is treated the same way.
    const cgroup = readCgroup(server.pid, procRoot);
    if (cgroup === null) {
      plan.skipped.push({
        pid: server.pid,
        version,
        reason: 'cgroup unreadable',
      });
      continue;
    }
    const unit = systemdUnit(cgroup);
    if (unit) {
      plan.systemd.push({ pid: server.pid, version, unit });
      continue;
    }

    if (server.pid === selfPid) {
      plan.skipped.push({ pid: server.pid, version, reason: 'self' });
      continue;
    }
    if (selfPgid !== undefined && server.pgid === selfPgid) {
      plan.skipped.push({
        pid: server.pid,
        version,
        reason: 'same client session',
      });
      continue;
    }
    if (version === null) {
      plan.skipped.push({
        pid: server.pid,
        version,
        reason: 'version unknown',
      });
      continue;
    }
    if (version === CURRENT_VERSION) {
      plan.skipped.push({
        pid: server.pid,
        version,
        reason: 'current version',
      });
      continue;
    }

    const verdict = abandonment(server, procRoot);
    if (!verdict.abandoned) {
      plan.skipped.push({ pid: server.pid, version, reason: verdict.reason });
      continue;
    }
    plan.candidates.push({ pid: server.pid, version, proc: server });
  }

  return plan;
}

/** One human-readable line per systemd-owned server. */
export function reportSystemdBackends(systemd: SystemdServer[]): string[] {
  return systemd.map((server) => {
    const version = server.version ? ` v${server.version}` : '';
    return [
      `pid ${server.pid}${version} is systemd-owned (${server.unit});`,
      `not signalling it. Retire it with: ${SYSTEMD_DISABLE_COMMAND}`,
    ].join(' ');
  });
}

function pidAlive(pid: number, procRoot: string): boolean {
  return existsSync(join(procRoot, String(pid)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

async function terminate(
  pid: number,
  options: ReapOptions
): Promise<'SIGTERM' | 'SIGKILL' | 'gone' | null> {
  const procRoot = options.procRoot ?? '/proc';
  if (!pidAlive(pid, procRoot)) {
    return 'gone';
  }

  const signal = options.signal ?? defaultSignal;
  try {
    signal(pid, 'SIGTERM');
  } catch {
    return pidAlive(pid, procRoot) ? null : 'gone';
  }

  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!pidAlive(pid, procRoot)) {
      return 'SIGTERM';
    }
    await sleep(pollMs);
  }

  if (!pidAlive(pid, procRoot)) {
    return 'SIGTERM';
  }
  try {
    signal(pid, 'SIGKILL');
  } catch {
    // The report still names it; the permission problem is the operator's.
  }
  return 'SIGKILL';
}

/**
 * Stop every provably abandoned stale server. Never throws and never waits
 * more than `timeoutMs` per candidate. Returns what happened, including the
 * systemd-owned servers that were reported but left alone.
 */
export async function reapAbandonedServers(
  options: ReapOptions = {}
): Promise<ReapReport> {
  const empty: ReapReport = { reaped: [], systemd: [], skipped: [] };
  const env = options.env ?? process.env;
  // `SQUIRE_ALLOW_MULTIPLE_SERVERS` already means "I want more than one
  // server"; honour that as a full bypass.
  if (
    truthy(env.SQUIRE_NO_REAP) ||
    truthy(env.SQUIRE_ALLOW_MULTIPLE_SERVERS)
  ) {
    return empty;
  }

  try {
    const plan = listReapableServers(options);
    const report: ReapReport = {
      reaped: [],
      systemd: plan.systemd,
      skipped: plan.skipped,
    };

    if (!options.quiet) {
      for (const line of reportSystemdBackends(plan.systemd)) {
        log.warn(line);
      }
    }

    for (const candidate of plan.candidates) {
      const outcome = await terminate(candidate.pid, options);
      if (!outcome) {
        continue;
      }
      report.reaped.push({
        pid: candidate.pid,
        version: candidate.version,
        signal: outcome,
      });
      if (!options.quiet) {
        log.warn(
          `reaped pid ${candidate.pid} v${candidate.version} (orphaned)`
        );
      }
    }

    return report;
  } catch (error) {
    if (!options.quiet) {
      try {
        log.warn('stale-server reaper failed (continuing):', error);
      } catch {
        // Logging itself must never break the server.
      }
    }
    return empty;
  }
}
