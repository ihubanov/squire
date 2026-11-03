import {
  describe,
  test,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

// Mock heavy/native deps so the real screenshot module can be imported.
await jest.unstable_mockModule('appium-uiautomator2-driver', () => ({
  AndroidUiautomator2Driver: class {
    async deleteSession() {}
  },
}));
await jest.unstable_mockModule('appium-xcuitest-driver', () => ({
  XCUITestDriver: class {
    async deleteSession() {}
  },
}));
await jest.unstable_mockModule('@appium/support', () => ({
  imageUtil: { requireSharp: () => null },
}));
await jest.unstable_mockModule('../logger', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const MOCK_BASE64 = 'dGVzdA=='; // "test"
await jest.unstable_mockModule('../command', () => ({
  getScreenshot: async () => MOCK_BASE64,
}));

// UI helpers only exercised in the opt-in path; make them trivially inspectable.
await jest.unstable_mockModule('../ui/mcp-ui-utils', () => ({
  createUIResource: (uri: string, html: string) => ({
    type: 'resource',
    resource: { uri, mimeType: 'text/html', text: html },
  }),
  createScreenshotViewerUI: () => '<html>viewer</html>',
  addUIResourceToResponse: (resp: any, ui: any) => ({
    ...resp,
    content: [...resp.content, ui],
  }),
}));

const { executeScreenshot } =
  await import('../tools/interactions/screenshot.js');

function makeDeps() {
  return {
    getDriver: () => ({ getScreenshot: async () => MOCK_BASE64 }) as any,
    writeFile: jest.fn(async () => {}) as any,
    mkdir: jest.fn(async () => {}) as any,
    resolveScreenshotDir: () => '/mock/screens',
    dateNow: () => 111,
  };
}

describe('executeScreenshot returns a real MCP image block', () => {
  const prev = process.env.APPIUM_MCP_UI;
  beforeEach(() => {
    delete process.env.APPIUM_MCP_UI;
  });
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.APPIUM_MCP_UI;
    } else {
      process.env.APPIUM_MCP_UI = prev;
    }
  });

  test('default: text path + full-res image block, no UI resource', async () => {
    const result: any = await executeScreenshot({ deps: makeDeps() as any });

    const text = result.content.find((c: any) => c.type === 'text');
    expect(text.text).toContain('Screenshot saved successfully to:');

    const image = result.content.find((c: any) => c.type === 'image');
    expect(image).toEqual({
      type: 'image',
      data: MOCK_BASE64, // unmodified — host does the resizing
      mimeType: 'image/png',
    });

    // The base64-in-HTML viewer (the token bomb) must NOT be present by default.
    expect(result.content.some((c: any) => c.type === 'resource')).toBe(false);
  });

  test('APPIUM_MCP_UI=1: still an image block, plus the opt-in UI resource', async () => {
    process.env.APPIUM_MCP_UI = '1';
    const result: any = await executeScreenshot({ deps: makeDeps() as any });

    expect(result.content.some((c: any) => c.type === 'image')).toBe(true);
    expect(result.content.some((c: any) => c.type === 'resource')).toBe(true);
  });
});
