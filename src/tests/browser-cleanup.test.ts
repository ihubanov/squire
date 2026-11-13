/**
 * Ownership marker and orphan sweep. Linux-only (/proc); elsewhere the
 * module is a deliberate no-op and Playwright's own close path applies.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, test, expect, afterEach } from '@jest/globals';
import {
  findOwnedBrowsers,
  isPidAlive,
  killOwnedBrowsers,
  ownedBrowserEnv,
  OWNED_BROWSER_ENV,
  OWNER_PID_ENV,
} from '../browser-cleanup.js';

const linux = process.platform === 'linux';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const children: ChildProcess[] = [];

function markedSleep(ownerPid: number): ChildProcess {
  const child = spawn('sleep', ['30'], {
    env: ownedBrowserEnv(ownerPid),
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 40 && isPidAlive(pid); i++) {
    await sleep(50);
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
});

const describeLinux = linux ? describe : describe.skip;

describeLinux('browser cleanup', () => {
  test('the marker env keeps the parent env and adds ownership', () => {
    const env = ownedBrowserEnv(4242);
    expect(env[OWNED_BROWSER_ENV]).toBe('1');
    expect(env[OWNER_PID_ENV]).toBe('4242');
    // Playwright replaces the child env, so inherited values must be present.
    if (process.env.PATH) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });

  test('finds a marked process', () => {
    const child = markedSleep(process.pid);
    expect(findOwnedBrowsers().map((b) => b.pid)).toContain(child.pid);
    expect(findOwnedBrowsers().find((b) => b.pid === child.pid)?.ownerPid).toBe(
      process.pid
    );
  });

  test('kills a browser whose owner is gone', async () => {
    const deadPid = 2_147_000_000;
    const child = markedSleep(deadPid);
    await sleep(100);

    const killed = await killOwnedBrowsers({
      orphansOnly: true,
      graceMs: 50,
    });

    expect(killed).toContain(child.pid);
    await waitGone(child.pid!);
    expect(isPidAlive(child.pid!)).toBe(false);
  });

  test('leaves a browser with a live owner alone, then closes it on shutdown', async () => {
    const child = markedSleep(process.pid);
    await sleep(100);

    expect(
      await killOwnedBrowsers({ orphansOnly: true, graceMs: 50 })
    ).not.toContain(child.pid);
    expect(isPidAlive(child.pid!)).toBe(true);

    const killed = await killOwnedBrowsers({
      ownerPid: process.pid,
      graceMs: 50,
    });
    expect(killed).toContain(child.pid);
    await waitGone(child.pid!);
    expect(isPidAlive(child.pid!)).toBe(false);
  });
});
