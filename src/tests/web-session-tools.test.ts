import {
  describe,
  test,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

// For web (Playwright) sessions:
//  - appium_get_page_source must return HTML (not "xml"), save the full source
//    to a file, cap the inline preview, and keep the heavy UI resource opt-in.
//  - generate_locators must NOT crash on HTML; it returns clear guidance.
// We stub session-store so the tools believe the active session is a web one.
await jest.unstable_mockModule('../session-store', () => ({
  getDriver: () => ({ __web: true }),
  isPlaywrightDriverSession: () => true,
  isAndroidUiautomator2DriverSession: () => false,
  isXCUITestDriverSession: () => false,
}));

let mockSource = '';
await jest.unstable_mockModule('../command', () => ({
  getPageSource: async () => mockSource,
}));

await jest.unstable_mockModule('../logger', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

let uiResourceAttached = false;
await jest.unstable_mockModule('../ui/mcp-ui-utils', () => ({
  createUIResource: (uri: string, html: string) => ({
    type: 'resource',
    resource: { uri, mimeType: 'text/html', text: html },
  }),
  createPageSourceInspectorUI: () => '<html>inspector</html>',
  createLocatorGeneratorUI: () => '<html>locators</html>',
  addUIResourceToResponse: (resp: any, ui: any) => {
    uiResourceAttached = true;
    return { ...resp, content: [...resp.content, ui] };
  },
}));

const getPageSourceRegister = (
  await import('../tools/interactions/get-page-source.js')
).default;
const generateLocatorsRegister = (
  await import('../tools/test-generation/locators.js')
).default;

// Capture the tool config a register function passes to server.addTool.
function capture(register: (server: any) => void) {
  let cfg: any;
  register({
    addTool: (c: any) => {
      cfg = c;
    },
  } as any);
  return cfg;
}

const log = { info: jest.fn(), error: jest.fn() };

describe('appium_get_page_source on a web session', () => {
  const prev = process.env.APPIUM_MCP_UI;
  const prevMax = process.env.APPIUM_MCP_PAGE_SOURCE_MAX;
  beforeEach(() => {
    delete process.env.APPIUM_MCP_UI;
    delete process.env.APPIUM_MCP_PAGE_SOURCE_MAX;
    uiResourceAttached = false;
  });
  afterEach(() => {
    if (prev === undefined) {
      delete process.env.APPIUM_MCP_UI;
    } else {
      process.env.APPIUM_MCP_UI = prev;
    }
    if (prevMax === undefined) {
      delete process.env.APPIUM_MCP_PAGE_SOURCE_MAX;
    } else {
      process.env.APPIUM_MCP_PAGE_SOURCE_MAX = prevMax;
    }
  });

  test('labels HTML, caps the preview, saves full source, no UI by default', async () => {
    process.env.APPIUM_MCP_PAGE_SOURCE_MAX = '100';
    mockSource =
      '<html><head><link href="a.css"></head><body>' +
      'x'.repeat(500) +
      '</body></html>';

    const cfg = capture(getPageSourceRegister);
    const result: any = await cfg.execute({}, undefined);
    const text = result.content[0].text;

    expect(text).toContain('```html'); // not xml
    expect(text).toContain('saved to:');
    expect(text).toContain('Preview truncated'); // 500+ chars capped at 100
    expect(text).toContain(String(mockSource.length));
    // Heavy inspector resource must be absent by default.
    expect(result.content.some((c: any) => c.type === 'resource')).toBe(false);
    expect(uiResourceAttached).toBe(false);
  });

  test('APPIUM_MCP_UI=1 attaches the inspector resource', async () => {
    process.env.APPIUM_MCP_UI = '1';
    mockSource = '<html><body>small</body></html>';

    const cfg = capture(getPageSourceRegister);
    const result: any = await cfg.execute({}, undefined);

    expect(result.content.some((c: any) => c.type === 'resource')).toBe(true);
  });
});

describe('generate_locators on a web session', () => {
  test('returns guidance instead of crashing on HTML', async () => {
    const cfg = capture(generateLocatorsRegister);

    // Must not throw (the old behavior threw "Failed to parse XML").
    const result: any = await cfg.execute({}, { log });
    const text = result.content[0].text;

    expect(text).toContain('not supported for web');
    expect(text.toLowerCase()).toContain('playwright');
    // It must NOT have attempted the native pipeline / produced a resource.
    expect(result.content.some((c: any) => c.type === 'resource')).toBe(false);
  });
});
