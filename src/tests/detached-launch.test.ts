/**
 * Tests for the detached-browser guarantees:
 *  - findFreePort skips ports already held by another process (e.g. a
 *    pre-existing Chrome on 9222) so our --remote-debugging-port never
 *    collides with the user's browser.
 *  - the focus guard only protects browsers actually shared with the user
 *    (CDP-attach); a browser we launched ourselves is never guarded.
 */
import { describe, test, expect, jest, afterEach } from '@jest/globals';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));

const { findFreePort, isPortFree } = await import('../free-port.js');
const { assertNotUserFocused, markSharedWithUser } =
  await import('../focus-guard.js');

function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

function makeMockPage(opts: { visible: boolean; context?: object }) {
  const context = opts.context ?? {};
  return {
    isClosed: () => false,
    evaluate: async () => opts.visible,
    url: () => 'https://example.com/',
    context: () => context,
  } as any;
}

describe('free-port', () => {
  test('isPortFree reports an occupied port as not free', async () => {
    const { port, close } = await occupyPort();
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await close();
    }
  });

  test('findFreePort returns the preferred port when it is free', async () => {
    const { port, close } = await occupyPort();
    await close(); // port is now free again
    expect(await findFreePort(port)).toBe(port);
  });

  test('findFreePort walks past an occupied preferred port', async () => {
    const { port, close } = await occupyPort();
    try {
      const chosen = await findFreePort(port);
      expect(chosen).not.toBe(port);
      expect(chosen).toBeGreaterThan(port);
      expect(await isPortFree(chosen)).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('focus guard scoping', () => {
  afterEach(() => {
    delete process.env.APPIUM_MCP_RESPECT_USER_FOCUS;
  });

  test('does NOT guard a visible tab in a browser we launched ourselves', async () => {
    const page = makeMockPage({ visible: true });
    await expect(
      assertNotUserFocused(page, 'click on')
    ).resolves.toBeUndefined();
  });

  test('by default lets the AI work in the tab the user is looking at', async () => {
    const context = {};
    markSharedWithUser(context as any);
    const page = makeMockPage({ visible: true, context });
    await expect(
      assertNotUserFocused(page, 'click on')
    ).resolves.toBeUndefined();
  });

  test('with APPIUM_MCP_RESPECT_USER_FOCUS=true, guards a visible tab in a user-shared browser', async () => {
    process.env.APPIUM_MCP_RESPECT_USER_FOCUS = 'true';
    const context = {};
    markSharedWithUser(context as any);
    const page = makeMockPage({ visible: true, context });
    await expect(assertNotUserFocused(page, 'click on')).rejects.toThrow(
      /user is currently focused/
    );
  });

  test('allows a background tab in a user-shared browser', async () => {
    process.env.APPIUM_MCP_RESPECT_USER_FOCUS = 'true';
    const context = {};
    markSharedWithUser(context as any);
    const page = makeMockPage({ visible: false, context });
    await expect(
      assertNotUserFocused(page, 'click on')
    ).resolves.toBeUndefined();
  });

  test('APPIUM_MCP_RESPECT_USER_FOCUS=false disables the guard entirely', async () => {
    process.env.APPIUM_MCP_RESPECT_USER_FOCUS = 'false';
    const context = {};
    markSharedWithUser(context as any);
    const page = makeMockPage({ visible: true, context });
    await expect(
      assertNotUserFocused(page, 'click on')
    ).resolves.toBeUndefined();
  });
});
