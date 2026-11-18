/**
 * Refuses to start a second Squire MCP server inside one client session.
 *
 * A client can be given Squire twice — e.g. the plugin plus a hand-written
 * `.mcp.json` entry — and then every tool exists under two server prefixes,
 * often at two different versions. The client does not deduplicate that for
 * us. One session is one process group (Claude Code spawns its stdio servers
 * in its own group, and `npx` does not detach them), so two Squire servers in
 * the same group are the same session: keep the oldest and let the newcomer
 * exit.
 *
 * Linux-only, like the browser cleanup: it reads /proc. Elsewhere it is a
 * no-op. Set SQUIRE_ALLOW_MULTIPLE_SERVERS=1 to bypass it deliberately.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SquireProcess {
  pid: number;
  ppid: number;
  pgid: number;
  /** Clock ticks since boot; older processes have a smaller value. */
  startTime: number;
  argv: string[];
}

const SERVER_PATTERNS = [
  /node_modules[\\/]\.bin[\\/]squire(?:$|\s)/,
  /@sniffski[\\/]squire[\\/]dist[\\/]index\.js/,
  /appium-mcp[\\/]dist[\\/]index\.js/,
];

/** True for a Squire server process, false for the `squire doctor` CLI. */
export function isSquireServerArgv(argv: string[]): boolean {
  if (argv.includes('doctor')) {
    return false;
  }
  const cmd = argv.join(' ');
  return SERVER_PATTERNS.some((pattern) => pattern.test(cmd));
}

interface ProcStat {
  ppid: number;
  pgid: number;
  startTime: number;
}

/** Parse the fields of /proc/<pid>/stat that this module needs. */
export function readProcStat(pid: number, procRoot = '/proc'): ProcStat | null {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  // comm (field 2) may contain spaces and parentheses; everything after the
  // last ')' starts at field 3 (state).
  const fields = raw
    .slice(raw.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = Number(fields[19]);
  if (![ppid, pgid, startTime].every(Number.isFinite)) {
    return null;
  }
  return { ppid, pgid, startTime };
}

/** Every live Squire server process visible in procRoot. */
export function listSquireServers(procRoot = '/proc'): SquireProcess[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const servers: SquireProcess[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    let raw: string;
    try {
      raw = readFileSync(join(procRoot, name, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    const argv = raw.split('\0').filter(Boolean);
    if (!isSquireServerArgv(argv)) {
      continue;
    }
    const stat = readProcStat(pid, procRoot);
    if (!stat) {
      continue;
    }
    servers.push({ pid, ...stat, argv });
  }
  return servers;
}

export interface DuplicateServer {
  /** The newer server, which must exit. */
  self: SquireProcess;
  /** The older server in the same process group, which keeps running. */
  older: SquireProcess;
}

export interface DuplicateGroup {
  /** Client session (process group) that owns the servers. */
  pgid: number;
  /** Same group, oldest first; `servers[0]` is the survivor. */
  servers: SquireProcess[];
  /** Every server except the oldest; these are the duplicates. */
  surplus: SquireProcess[];
}

/** Group servers by client session, oldest first, keeping only duplicates. */
export function duplicateGroups(servers: SquireProcess[]): DuplicateGroup[] {
  const byGroup = new Map<number, SquireProcess[]>();
  for (const server of servers) {
    byGroup.set(server.pgid, [...(byGroup.get(server.pgid) ?? []), server]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [pgid, groupServers] of byGroup) {
    if (groupServers.length < 2) {
      continue;
    }
    groupServers.sort((a, b) =>
      a.startTime !== b.startTime ? a.startTime - b.startTime : a.pid - b.pid
    );
    groups.push({
      pgid,
      servers: groupServers,
      surplus: groupServers.slice(1),
    });
  }
  return groups;
}

/**
 * `squire doctor --fix`: stop the duplicate servers in each group, keeping
 * the oldest. Single servers are never touched, even when they are stale —
 * they may be a live session that would lose its browser.
 */
export function terminateDuplicateServers(
  servers: SquireProcess[] = listSquireServers()
): number[] {
  const pids: number[] = [];
  for (const group of duplicateGroups(servers)) {
    for (const server of group.surplus) {
      try {
        process.kill(server.pid, 'SIGTERM');
        pids.push(server.pid);
      } catch {
        // Already gone or not ours to signal; the report shows it either way.
      }
    }
  }
  return pids;
}

/** True if `self` should lose the race for its process group. */
function losesTo(self: SquireProcess, other: SquireProcess): boolean {
  if (other.startTime !== self.startTime) {
    return other.startTime < self.startTime;
  }
  return other.pid < self.pid;
}

/**
 * Find a Squire server that was started before this one in the same process
 * group. Returns null when this server is the only one (or the oldest).
 */
export function findDuplicateSquireServer(
  opts: {
    procRoot?: string;
    pid?: number;
  } = {}
): DuplicateServer | null {
  const procRoot = opts.procRoot ?? '/proc';
  const selfPid = opts.pid ?? process.pid;
  const servers = listSquireServers(procRoot);
  const self = servers.find((server) => server.pid === selfPid);
  if (!self) {
    return null;
  }
  const older = servers.find(
    (server) =>
      server.pid !== self.pid &&
      server.pgid === self.pgid &&
      losesTo(self, server)
  );
  return older ? { self, older } : null;
}

/**
 * Exit when another Squire server already serves this client session.
 * A duplicate produces two copies of every tool and mixes versions; one
 * loud failure at startup is better than that.
 */
export function refuseIfDuplicateSquireServer(): void {
  const override = process.env.SQUIRE_ALLOW_MULTIPLE_SERVERS;
  if (override && !['0', 'false', 'no'].includes(override.toLowerCase())) {
    return;
  }
  if (process.platform !== 'linux') {
    return;
  }
  let duplicate: DuplicateServer | null;
  try {
    duplicate = findDuplicateSquireServer();
  } catch {
    return;
  }
  if (!duplicate) {
    return;
  }
  // stderr, not the appium logger: this runs before the server exists and
  // must be visible even when the client swallows normal logging.
  console.error(
    `Another Squire MCP server (pid ${duplicate.older.pid}) is already ` +
      `running in this client session. Refusing to start a second one: two ` +
      `servers expose every tool twice and can serve different versions. ` +
      `Remove one Squire entry (keep the plugin, or keep a single ` +
      `.mcp.json entry) and restart. Set SQUIRE_ALLOW_MULTIPLE_SERVERS=1 to ` +
      `override.`
  );
  process.exit(1);
}
