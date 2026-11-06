/**
 * Tests for APPIUM_MCP_CDP_REQUIRED hard-fail mode (shared-display
 * deployments, e.g. herdr-share):
 *  - with the flag set, a failed CDP attach THROWS instead of silently
 *    falling back to a detached launch (a fallback browser is invisible
 *    to whoever is watching the shared display)
 *  - with the flag set but no endpoint configured, throw (config error)
 *  - without the flag, the historical fallback behavior is preserved
 *    (attach failure → detached launch attempt)
 *
 * Playwright is mocked and the endpoint is dead (nothing listens); launch is
 * a sentinel that throws — proving the fallback path was ENTERED without
 * spawning a real browser.
 */
import {
  describe,
  test,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

const connectOverCDP = jest.fn(async () => {
  throw new Error('ECONNREFUSED (simulated dead gate)');
});
const launch = jest.fn(async () => {
  throw new Error('launch sentinel — must not spawn a real browser in tests');
});

await jest.unstable_mockModule('playwright', () => ({
  chromium: { connectOverCDP, launch },
  firefox: { launch },
  webkit: { launch },
}));

await jest.unstable_mockModule('../session-store', () => ({
  setSession: jest.fn(),
  listSessions: () => [],
  getDriver: () => null,
  dropDisconnectedSession: jest.fn(),
}));

await jest.unstable_mockModule('../playwright-adapter', () => ({
  PlaywrightDriver: class {
    constructor(
      public browser: any,
      public context: any,
      public page: any,
      public shared: any
    ) {}
  },
}));

await jest.unstable_mockModule('../logger', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

await jest.unstable_mockModule('../ui/mcp-ui-utils', () => ({
  createUIResource: (uri: string, html: string) => ({
    type: 'resource',
    resource: { uri, mimeType: 'text/html', text: html },
  }),
  createSessionDashboardUI: () => '<html></html>',
  addUIResourceToResponse: (resp: any) => resp,
}));

await jest.unstable_mockModule('../tools/session/select-device', () => ({
  getSelectedDevice: () => null,
  getSelectedDeviceType: () => null,
  getSelectedDeviceInfo: () => null,
  clearSelectedDevice: jest.fn(),
}));

await jest.unstable_mockModule('../devicemanager/ios-manager', () => ({
  IOSManager: class {},
}));

await jest.unstable_mockModule('appium-uiautomator2-driver', () => ({
  AndroidUiautomator2Driver: class {},
}));
await jest.unstable_mockModule('appium-xcuitest-driver', () => ({
  XCUITestDriver: class {},
}));
await jest.unstable_mockModule('webdriver', () => ({ default: {} }));

const registerCreateSession = (
  await import('../tools/session/create-session.js')
).default;

function capture(register: (server: any) => void) {
  let cfg: any;
  register({
    addTool: (c: any) => {
      cfg = c;
    },
  } as any);
  return cfg;
}

const cfg = capture(registerCreateSession);

describe('APPIUM_MCP_CDP_REQUIRED hard-fail mode', () => {
  beforeEach(() => {
    connectOverCDP.mockClear();
    launch.mockClear();
    process.env.APPIUM_MCP_CDP_ENDPOINT = 'http://127.0.0.1:9401';
    process.env.APPIUM_MCP_CDP_REQUIRED = '1';
  });
  afterEach(() => {
    delete process.env.APPIUM_MCP_CDP_ENDPOINT;
    delete process.env.APPIUM_MCP_CDP_REQUIRED;
  });

  test('failed attach THROWS (no detached fallback) when required', async () => {
    await expect(
      cfg.execute({ platform: 'web', browser: 'chromium', headless: true }, {})
    ).rejects.toThrow(/NOT falling back to a detached launch/);
    // The dead endpoint is refused when Squire opens its own connection,
    // before Playwright is involved.
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  test('required flag without an endpoint is a loud config error', async () => {
    delete process.env.APPIUM_MCP_CDP_ENDPOINT;
    await expect(
      cfg.execute({ platform: 'web', browser: 'chromium', headless: true }, {})
    ).rejects.toThrow(/APPIUM_MCP_CDP_ENDPOINT is not/);
    expect(launch).not.toHaveBeenCalled();
  });

  test('non-chromium browser throws when required', async () => {
    await expect(
      cfg.execute({ platform: 'web', browser: 'firefox', headless: true }, {})
    ).rejects.toThrow(/CDP attach only supports chromium/);
    expect(launch).not.toHaveBeenCalled();
  });

  test('without the flag, attach failure still falls back to a launch attempt', async () => {
    delete process.env.APPIUM_MCP_CDP_REQUIRED;
    // The detached-launch path is ENTERED: launch is attempted (and hit
    // by our sentinel) rather than the CDP error surfacing.
    await expect(
      cfg.execute({ platform: 'web', browser: 'chromium', headless: true }, {})
    ).rejects.toThrow(/launch sentinel/);
    // The dead endpoint is refused when Squire opens its own connection,
    // before Playwright is involved.
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalled();
  });

  test('flag is off for explicit falsy values', async () => {
    process.env.APPIUM_MCP_CDP_REQUIRED = 'false';
    await expect(
      cfg.execute({ platform: 'web', browser: 'chromium', headless: true }, {})
    ).rejects.toThrow(/launch sentinel/);
    expect(launch).toHaveBeenCalled();
  });
});

describe('per-session cdpEndpoint', () => {
  beforeEach(() => {
    connectOverCDP.mockClear();
    launch.mockClear();
    delete process.env.APPIUM_MCP_CDP_ENDPOINT;
    delete process.env.APPIUM_MCP_CDP_REQUIRED;
    delete process.env.APPIUM_MCP_CDP_ALLOWED_HOSTS;
  });
  afterEach(() => {
    delete process.env.APPIUM_MCP_CDP_ENDPOINT;
    delete process.env.APPIUM_MCP_CDP_ALLOWED_HOSTS;
  });

  const web = (extra: Record<string, unknown>) =>
    cfg.execute(
      { platform: 'web', browser: 'chromium', headless: true, ...extra },
      {}
    );

  test('a dead explicit endpoint throws and never launches a browser', async () => {
    await expect(web({ cdpEndpoint: 'http://127.0.0.1:9402' })).rejects.toThrow(
      /cdpEndpoint was given — NOT falling back/
    );
    expect(launch).not.toHaveBeenCalled();
  });

  test('host:port without a scheme means http, and the arg beats the env', async () => {
    process.env.APPIUM_MCP_CDP_ENDPOINT = 'http://127.0.0.1:9401';
    await expect(web({ cdpEndpoint: '127.0.0.1:9403' })).rejects.toThrow(
      /CDP attach to http:\/\/127\.0\.0\.1:9403 failed/
    );
    expect(launch).not.toHaveBeenCalled();
  });

  test('non-loopback hosts are refused unless allowed', async () => {
    await expect(web({ cdpEndpoint: 'http://10.1.2.3:9222' })).rejects.toThrow(
      /not allowed/
    );
    process.env.APPIUM_MCP_CDP_ALLOWED_HOSTS = '*';
    await expect(
      web({ cdpEndpoint: 'http://squire-test.invalid:9222' })
    ).rejects.toThrow(/cdpEndpoint was given/);
    expect(launch).not.toHaveBeenCalled();
  });

  test('a non-chromium browser with an explicit endpoint throws', async () => {
    await expect(
      cfg.execute(
        {
          platform: 'web',
          browser: 'firefox',
          headless: true,
          cdpEndpoint: '127.0.0.1:9402',
        },
        {}
      )
    ).rejects.toThrow(/cdpEndpoint was given but browserType=firefox/);
    expect(launch).not.toHaveBeenCalled();
  });

  test('a 403 from the endpoint is "control revoked", even without REQUIRED', async () => {
    const http = await import('node:http');
    let hits = 0;
    const gate = http.createServer((_req, res) => {
      hits++;
      res.writeHead(403).end();
    });
    gate.on('upgrade', (_req, socket) => {
      hits++;
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
    const port = (gate.address() as import('node:net').AddressInfo).port;
    try {
      process.env.APPIUM_MCP_CDP_ENDPOINT = `http://127.0.0.1:${port}`;
      await expect(web({})).rejects.toThrow(/Control revoked:.*do not retry/);
      const before = hits;
      await expect(web({ cdpEndpoint: `127.0.0.1:${port}` })).rejects.toThrow(
        /Control revoked:/
      );
      // One attempt per call: discovery, then the version lookup. No retry loop.
      expect(hits - before).toBeLessThanOrEqual(2);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => gate.close(() => r()));
    }
  });
});
