/**
 * Attaching to the user's Chrome: one shared connection (each new one is an
 * Allow prompt), errors that say what to do, and profile names.
 */
import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { getUserBrowser, resetUserBrowser } from '../cdp-connection.js';
import {
  explainAttachError,
  openProfileNames,
  profileDirForPort,
} from '../cdp-endpoint.js';
import { profileLabels } from '../user-profiles.js';

function fakeBrowser() {
  const b = new EventEmitter() as EventEmitter & { connected: boolean };
  b.connected = true;
  return Object.assign(b, {
    isConnected: () => b.connected,
  }) as unknown as Browser & EventEmitter & { connected: boolean };
}

describe('getUserBrowser', () => {
  beforeEach(() => resetUserBrowser());

  test('reuses one connection across sessions', async () => {
    let calls = 0;
    const b = fakeBrowser();
    const connect = async () => {
      calls++;
      return b;
    };
    const first = await getUserBrowser('ws://x', connect);
    const second = await getUserBrowser('ws://x', connect);
    expect(calls).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.browser).toBe(b);
  });

  test('concurrent callers share one connect', async () => {
    let calls = 0;
    const connect = async () => {
      calls++;
      return fakeBrowser();
    };
    const [a, b] = await Promise.all([
      getUserBrowser('ws://x', connect),
      getUserBrowser('ws://x', connect),
    ]);
    expect(calls).toBe(1);
    expect(a.browser).toBe(b.browser);
  });

  test('reconnects after the connection drops', async () => {
    let calls = 0;
    const connect = async () => {
      calls++;
      return fakeBrowser();
    };
    const { browser } = await getUserBrowser('ws://x', connect);
    (browser as unknown as { connected: boolean }).connected = false;
    (browser as unknown as EventEmitter).emit('disconnected');
    const again = await getUserBrowser('ws://x', connect);
    expect(calls).toBe(2);
    expect(again.reused).toBe(false);
  });

  test('a failed connect is not cached', async () => {
    let calls = 0;
    const connect = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('nope');
      }
      return fakeBrowser();
    };
    await expect(getUserBrowser('ws://x', connect)).rejects.toThrow('nope');
    await expect(getUserBrowser('ws://x', connect)).resolves.toBeDefined();
    expect(calls).toBe(2);
  });
});

describe('explainAttachError', () => {
  const refused = new Error('connect ECONNREFUSED 127.0.0.1:9222');

  test('a stale DevToolsActivePort means the toggle is off', () => {
    const msg = explainAttachError(
      refused,
      'http://localhost:9222',
      'ws://localhost:9222/devtools/browser/abc',
      90_000
    );
    expect(msg).toMatch(/remote debugging is off/);
    expect(msg).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
  });

  test('nothing listening and no port file', () => {
    const msg = explainAttachError(
      refused,
      'http://localhost:9222',
      'http://localhost:9222',
      90_000
    );
    expect(msg).toMatch(/nothing is listening/);
  });

  test('a timeout points at the Allow prompt', () => {
    const msg = explainAttachError(
      new Error('browserType.connectOverCDP: Timeout 90000ms exceeded.'),
      'http://localhost:9222',
      'ws://localhost:9222/devtools/browser/abc',
      90_000
    );
    expect(msg).toMatch(/90s/);
    expect(msg).toMatch(/Allow/);
  });
});

describe('profile names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-'));
  writeFileSync(
    join(dir, 'DevToolsActivePort'),
    '9222\n/devtools/browser/abc\n'
  );
  writeFileSync(
    join(dir, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'IFS-Gmail' },
          'Profile 1': { name: 'Alpha (bart)' },
        },
        last_active_profiles: ['Profile 1', 'Default'],
      },
    })
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('finds the profile dir by port', async () => {
    expect(await profileDirForPort('9222', [join(dir, 'missing'), dir])).toBe(
      dir
    );
    expect(await profileDirForPort('9333', [dir])).toBeUndefined();
  });

  test('reads the open profiles from Local State', async () => {
    expect(await openProfileNames(dir)).toEqual(['Alpha (bart)', 'IFS-Gmail']);
    expect(await openProfileNames(join(dir, 'missing'))).toEqual([]);
  });

  test('labels profiles in order of first appearance', () => {
    const labels = profileLabels(['b', undefined, 'a', 'b']);
    expect([...labels.entries()]).toEqual([
      ['b', 'profile A'],
      ['a', 'profile B'],
    ]);
  });
});
