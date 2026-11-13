/**
 * Tool to create a new session (Android, iOS, or Web via Playwright)
 */
import { z } from 'zod';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { URL } from 'node:url';
import type { BrowserContext } from 'playwright';
import type { AndroidUiautomator2Driver } from 'appium-uiautomator2-driver';
import type { XCUITestDriver } from 'appium-xcuitest-driver';
import {
  setSession,
  listSessions,
  dropDisconnectedSession,
} from '../../session-store.js';
import {
  getSelectedDevice,
  getSelectedDeviceType,
  getSelectedDeviceInfo,
  clearSelectedDevice,
} from './select-device.js';
import { IOSManager } from '../../devicemanager/ios-manager.js';
import { PlaywrightDriver } from '../../playwright-adapter.js';
import { markSharedWithUser } from '../../focus-guard.js';
import { findFreePort } from '../../free-port.js';
import { ownedBrowserEnv } from '../../browser-cleanup.js';
import { detectDatadome, findHardBlock } from '../../datadome-detect.js';
import {
  resolveCdpEndpoint,
  normalizeCdpEndpoint,
  assertAllowedCdpHost,
  CONTROL_REVOKED_PREFIX,
  CHROME_REFUSED_PREFIX,
  explainAttachError,
  profileDirForPort,
  openProfileNames,
  toBrowserWebSocketUrl,
  ACCEPTED_PREFIX,
} from '../../cdp-endpoint.js';
import {
  getRelay,
  getUserBrowser,
  acquireUserBrowser,
  releaseUserBrowser,
} from '../../cdp-connection.js';
import { countProfiles } from '../../user-profiles.js';
import { watchUserActivity } from '../../user-activity.js';
import log from '../../logger.js';
import {
  createUIResource,
  createSessionDashboardUI,
  addUIResourceToResponse,
} from '../../ui/mcp-ui-utils.js';
import WebDriver from 'webdriver';

/**
 * Registers a tool for creating a new mobile session with Android or iOS devices.
 *
 * This function adds a 'create_session' tool to the provided server that handles
 * mobile session creation with support for both local and remote Appium servers.
 *
 * @param server - The server instance to which the create_session tool will be added
 *
 * @tool create_session
 * @description Creates a new mobile session with Android or iOS device. Requires prior
 * platform selection via the select_platform tool. Supports both local and remote
 * Appium server connections.
 *
 * @param {Object} args - Tool execution arguments
 * @param {'ios' | 'android'} args.platform - REQUIRED. The target platform, must match
 * the platform explicitly selected via select_platform tool
 * @param {Object} [args.capabilities] - Optional custom W3C format capabilities
 * @param {string} [args.remoteServerUrl] - Optional remote Appium server URL
 * (e.g., http://localhost:4723). If not provided, uses local Appium server
 *
 * @returns {Promise<Object>} Response object containing:
 * - text: Success message with session ID and device details
 * - ui: Interactive session dashboard UI component
 *
 * @throws {Error} If session creation fails or platform capabilities cannot be loaded
 *
 * @example
 * // Register the tool
 * createSession(server);
 */
export interface WebSessionOptions {
  browser?: string;
  /** Default true. */
  headless?: boolean;
  url?: string;
  viewport?: { width: number; height: number };
  /** Cookies and localStorage for a launched browser (not used when attached to the user's). */
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>;
  /**
   * A persistent browser profile directory for a launched browser. Cookies,
   * history and cache live here and survive delete_session, so search
   * engines and other sites build trust over time. Chromium-family only in
   * practice (launchPersistentContext is supported by all three engines).
   */
  userDataDir?: string;
  /** Called if attaching to the user's Chrome is slow, most likely waiting on its Allow prompt. */
  onWaiting?: (message: string) => void;
  /**
   * Chrome to attach to for this session, overriding APPIUM_MCP_CDP_ENDPOINT.
   * When given, a failed attach always throws.
   */
  cdpEndpoint?: string;
  /**
   * Playwright channel for the browser binary, e.g. "chrome" for the
   * installed Google Chrome stable or "msedge" for Edge. Chromium only.
   * When set, that exact binary must exist — there is no fallback.
   */
  channel?: string;
  /**
   * Explicit browser executable path. Chromium only. Wins over `channel`.
   * When set, that exact binary must exist — there is no fallback.
   */
  executablePath?: string;
  /**
   * Internal: this launch is the one-shot DataDome hard-block retry, so do
   * not retry again.
   */
  datadomeRetried?: boolean;
  /**
   * Internal: an engine retry must launch a fresh owned browser, never
   * re-attempt a CDP attach to the browser that was just refused.
   */
  skipCdpAttach?: boolean;
}

// Define capabilities type
interface Capabilities {
  platformName: string;
  'appium:automationName': string;
  'appium:deviceName'?: string;
  [key: string]: any;
}

// Define capabilities config type
interface CapabilitiesConfig {
  android: Record<string, any>;
  ios: Record<string, any>;
  general: Record<string, any>;
}

/**
 * Remove empty string values from capabilities object
 */
export function filterEmptyCapabilities(
  capabilities: Capabilities
): Capabilities {
  const filtered = { ...capabilities };
  Object.keys(filtered).forEach((key) => {
    if (filtered[key] === '') {
      delete filtered[key];
    }
  });
  return filtered;
}

/**
 * Build Android capabilities by merging defaults, config, device selection, and custom capabilities
 */
export function buildAndroidCapabilities(
  configCaps: Record<string, any>,
  customCaps: Record<string, any> | undefined,
  isRemoteServer: boolean
): Capabilities {
  const defaultCaps: Capabilities = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'Android Device',
  };

  const selectedDeviceUdid = isRemoteServer ? undefined : getSelectedDevice();

  const additionalCaps = {
    'appium:settings[actionAcknowledgmentTimeout]': 0,
    'appium:settings[waitForIdleTimeout]': 0,
    'appium:settings[waitForSelectorTimeout]': 0,
    'appium:autoGrantPermissions': true,
    'appium:newCommandTimeout': 300,
  };

  const capabilities = {
    ...defaultCaps,
    ...additionalCaps,
    ...configCaps,
    ...(selectedDeviceUdid && { 'appium:udid': selectedDeviceUdid }),
    ...customCaps,
  };

  if (selectedDeviceUdid) {
    clearSelectedDevice();
  }

  return filterEmptyCapabilities(capabilities);
}

/**
 * Validate iOS device selection when multiple devices are available
 */
export async function validateIOSDeviceSelection(
  deviceType: 'simulator' | 'real' | null
): Promise<void> {
  if (!deviceType) {
    return;
  }

  const iosManager = IOSManager.getInstance();
  const devices = await iosManager.getDevicesByType(deviceType);

  if (devices.length > 1) {
    const selectedDevice = getSelectedDevice();
    if (!selectedDevice) {
      throw new Error(
        `Multiple iOS ${deviceType === 'simulator' ? 'simulators' : 'devices'} found (${devices.length}). Please use the select_device tool to choose which device to use before creating a session.`
      );
    }
  }
}

/**
 * Build iOS capabilities by merging defaults, config, device selection, and custom capabilities
 */
export async function buildIOSCapabilities(
  configCaps: Record<string, any>,
  customCaps: Record<string, any> | undefined,
  isRemoteServer: boolean
): Promise<Capabilities> {
  const deviceType = isRemoteServer ? null : getSelectedDeviceType();
  await validateIOSDeviceSelection(deviceType);

  // Get selected device info BEFORE constructing defaultCaps so we can use the actual device name
  const selectedDeviceUdid = isRemoteServer ? undefined : getSelectedDevice();
  const selectedDeviceInfo = isRemoteServer
    ? undefined
    : getSelectedDeviceInfo();

  log.debug('Selected device info:', selectedDeviceInfo);

  const defaultCaps: Capabilities = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:deviceName': selectedDeviceInfo?.name || 'iPhone Simulator',
  };

  const platformVersion =
    selectedDeviceInfo?.platform && selectedDeviceInfo.platform.trim() !== ''
      ? selectedDeviceInfo.platform
      : undefined;

  const additionalCaps =
    deviceType === 'simulator'
      ? {
          'appium:usePrebuiltWDA': true,
          'appium:wdaStartupRetries': 4,
          'appium:wdaStartupRetryInterval': 20000,
        }
      : {};
  additionalCaps['appium:newCommandTimeout'] = 300;
  additionalCaps['appium:settings[animationCoolOffTimeout]'] = 0.5;
  additionalCaps['appium:settings[maxTypingFrequency]'] = 45;
  additionalCaps['appium:settings[pageSourceExcludedAttributes]'] = 'visible';

  log.debug('Platform version:', platformVersion);

  const capabilities = {
    ...defaultCaps,
    ...additionalCaps,
    // Auto-detected platform version as fallback (before config)
    ...(platformVersion && { 'appium:platformVersion': platformVersion }),
    ...configCaps,
    ...(selectedDeviceUdid && { 'appium:udid': selectedDeviceUdid }),
    // customCaps should override additionalCaps.
    ...customCaps,
  };

  if (selectedDeviceUdid) {
    clearSelectedDevice();
  }

  return filterEmptyCapabilities(capabilities);
}

/**
 * Extract port number from a URL object, using protocol defaults (https/http) when not specified.
 */
export function getPortFromUrl(url: URL): number {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

/**
 * Load capabilities configuration from file if specified in environment
 */
async function loadCapabilitiesConfig(): Promise<CapabilitiesConfig> {
  const configPath = process.env.CAPABILITIES_CONFIG;
  if (!configPath) {
    return { android: {}, ios: {}, general: {} };
  }

  try {
    await access(configPath, constants.F_OK);
    const configContent = await readFile(configPath, 'utf8');
    return JSON.parse(configContent);
  } catch (error) {
    log.warn(`Failed to parse capabilities config: ${error}`);
    return { android: {}, ios: {}, general: {} };
  }
}

/**
 * Create the appropriate driver instance for the given platform
 */
async function createDriverForPlatform(
  platform: 'android' | 'ios'
): Promise<any> {
  // Lazy-import the heavy Appium mobile drivers only when a mobile session is
  // actually created — importing them eagerly cost ~2-3s at every server start
  // (they pull the whole Appium stack), pointless for the browser-first path.
  if (platform === 'android') {
    const { AndroidUiautomator2Driver } =
      await import('appium-uiautomator2-driver');
    const driver = new AndroidUiautomator2Driver({} as any);
    driver.relaxedSecurityEnabled = true;
    return driver;
  }
  if (platform === 'ios') {
    const { XCUITestDriver } = await import('appium-xcuitest-driver');
    const driver = new XCUITestDriver({} as any);
    driver.relaxedSecurityEnabled = true;
    return driver;
  }
  throw new Error(
    `Unsupported platform: ${platform}. Please choose 'android' or 'ios'.`
  );
}

/**
 * Create a new session with the given driver and capabilities
 */
async function createDriverSession(
  driver: any,
  capabilities: Capabilities
): Promise<string> {
  // @ts-ignore
  const result = await driver.createSession(null, {
    alwaysMatch: capabilities,
    firstMatch: [{}],
  });
  // Appium drivers return [sessionId, caps], extract just the session ID
  return Array.isArray(result) ? result[0] : result;
}

/**
 * Load patchright (a Playwright fork whose patchright-core avoids the
 * automation-detectable CDP calls stock Playwright makes; the binary it drives
 * is an ordinary Chrome for Testing build) as an optional engine. The import
 * is deliberately not a literal so the build does not require the optional
 * package; a missing install becomes an actionable error, not a boot failure.
 */
async function loadPatchright(): Promise<{
  chromium: typeof import('playwright').chromium;
}> {
  const spec = 'patchright';
  try {
    return (await import(spec)) as {
      chromium: typeof import('playwright').chromium;
    };
  } catch (e) {
    throw new Error(
      `patchright_unavailable: the patchright engine is not installed (${(e as Error).message}). Install it once: npm install patchright && npx patchright install chromium.`
    );
  }
}

/**
 * patchright downloads its own Chromium build per machine (not via npm).
 * A launch failure for that missing binary must say exactly how to fix it.
 */
function mapPatchrightLaunchError(e: unknown): never {
  const msg = (e as Error)?.message ?? String(e);
  if (
    /ms-playwright|Executable doesn't exist|executable doesn't exist|please run the following command|not installed/i.test(
      msg
    )
  ) {
    throw new Error(
      `patchright_browser_missing: patchright's Chromium build is not installed (${msg}). Run once: npx patchright install chromium.`
    );
  }
  throw e instanceof Error ? e : new Error(String(e));
}

/**
 * Installed distro/snap Chromium binaries, in preference order. This is not
 * Google Chrome (`channel: 'chrome'` covers that); it is the fallback when
 * Chrome is missing but the distro build is present. Unlike Playwright's
 * bundled build — "Chrome for Testing", which announces in the window that
 * it is only for automated testing — a distro Chromium does not.
 */
const SYSTEM_CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/lib/chromium/chromium',
];

async function findSystemChromium(): Promise<string | undefined> {
  for (const p of SYSTEM_CHROMIUM_PATHS) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // Not there or not executable; try the next.
    }
  }
  return undefined;
}

/** Long enough for a person to find Chrome's Allow prompt and click it. */
const CDP_CONNECT_TIMEOUT_MS = 90_000;
/** Playwright's setup over the already-open connection. */
const CDP_SETUP_TIMEOUT_MS = 60_000;

/** Open a Playwright browser and make it the active session. */
export async function openWebSession(opts: WebSessionOptions) {
  const requestedBrowser = opts.browser || 'chromium';
  // patchright is a Playwright-compatible engine that avoids the
  // automation-detectable CDP calls stock Playwright makes. Always chromium.
  const engineName: 'playwright' | 'patchright' =
    requestedBrowser === 'patchright' ? 'patchright' : 'playwright';
  const browserType =
    requestedBrowser === 'patchright' ? 'chromium' : requestedBrowser;
  const headless = opts.headless !== false; // default true
  const initialUrl = opts.url;
  const viewport = opts.viewport || { width: 1920, height: 1080 };

  log.info(
    `Creating new WEB session with ${engineName} (${browserType}, headless=${headless})`
  );

  const engines: Record<string, import('playwright').BrowserType> =
    engineName === 'patchright'
      ? { chromium: (await loadPatchright()).chromium }
      : ((await import('playwright')) as unknown as Record<
          string,
          import('playwright').BrowserType
        >);
  const engine = engines[browserType];
  if (!engine) {
    throw new Error(
      `Unsupported browser: ${requestedBrowser}. Use chromium, firefox, webkit, or patchright.`
    );
  }

  // CDP attach mode: when APPIUM_MCP_CDP_ENDPOINT is set, attach to
  // an externally-managed Chromium instance (e.g. one launched by
  // ai-colleague with --remote-debugging-port) instead of spawning
  // a fresh browser. New tabs/pages opened by the AI then appear
  // in the user's already-open Chromium window.
  // A per-session cdpEndpoint (one shared backend serving several panes,
  // each with its own browser) wins over the env default.
  const explicitEndpoint = opts.cdpEndpoint?.trim()
    ? normalizeCdpEndpoint(opts.cdpEndpoint)
    : undefined;
  if (explicitEndpoint) {
    assertAllowedCdpHost(explicitEndpoint);
  }
  const cdpEndpoint = explicitEndpoint ?? process.env.APPIUM_MCP_CDP_ENDPOINT;
  // Hard-fail mode (shared-display deployments, e.g. herdr-share):
  // when APPIUM_MCP_CDP_REQUIRED is set, a failed attach MUST throw
  // instead of silently falling back to a detached launch — a
  // fallback browser is invisible to whoever is watching the
  // shared display, which is exactly the failure this prevents.
  // A caller that named its browser never wants a detached one instead.
  const cdpRequired =
    !!explicitEndpoint ||
    /^(1|true|yes)$/i.test((process.env.APPIUM_MCP_CDP_REQUIRED ?? '').trim());
  if (!opts.skipCdpAttach && cdpRequired && !cdpEndpoint) {
    throw new Error(
      'APPIUM_MCP_CDP_REQUIRED is set but APPIUM_MCP_CDP_ENDPOINT is not — refusing to launch a detached browser.'
    );
  }
  let browser!: import('playwright').Browser;
  let context!: import('playwright').BrowserContext;
  let page!: import('playwright').Page;
  // The persistent profile actually opened, if any (for the session reply).
  let persistentProfile: string | undefined;
  // Which browser binary actually launched, for the session reply — e.g.
  // "Google Chrome (channel chrome)" or "bundled Chromium (fallback)".
  let launchedBinary: string | undefined;
  // CDP debug port of a browser we launch ourselves (undefined in
  // CDP-attach mode or when disabled via APPIUM_MCP_CDP_PORT=0).
  let cdpPort: number | undefined;
  // True only if we actually attached to the user's own browser.
  // Attach is attempted when APPIUM_MCP_CDP_ENDPOINT is set, but a
  // dead endpoint (the user's Chromium isn't running right now)
  // falls back to a detached launch instead of failing the session.
  let attachedToUserBrowser = false;
  // Why the attach failed, so the caller hears that this is not the user's browser.
  let attachError: string | undefined;
  // What we attached to, for the session response.
  let attachedInfo: string | undefined;
  // The attached Chrome's WebSocket URL: its key in cdp-connection.ts.
  let upstreamUrl: string | undefined;

  if (!opts.skipCdpAttach && cdpEndpoint && browserType === 'chromium') {
    log.info(`Attaching to existing Chromium via CDP at ${cdpEndpoint}`);
    let wsOrHttp = cdpEndpoint;
    try {
      wsOrHttp = await resolveCdpEndpoint(cdpEndpoint);
      // Chrome's remote-debugging toggle asks the user to approve each new
      // connection, so Squire holds one and all sessions share it
      // (cdp-connection.ts, cdp-proxy.ts).
      const upstream = await toBrowserWebSocketUrl(wsOrHttp);
      const { relay, fresh } = await getRelay(
        upstream,
        CDP_CONNECT_TIMEOUT_MS,
        () =>
          opts.onWaiting?.(
            'Waiting for you to click Allow in Chrome (the remote-debugging prompt may be in another Chrome window).'
          )
      );
      let b: import('playwright').Browser;
      try {
        ({ browser: b } = await getUserBrowser(relay.url, (ep) =>
          engine.connectOverCDP(ep, { timeout: CDP_SETUP_TIMEOUT_MS })
        ));
      } catch (e) {
        throw new Error(
          `${ACCEPTED_PREFIX} setting up its tabs failed (${(e as Error).message.split('\n')[0]}).` +
            (relay.stuckTargets.size
              ? ` ${relay.stuckTargets.size} tab(s) did not respond and were skipped.`
              : '') +
            ' Set APPIUM_MCP_CDP_TRACE=<file> to log the CDP traffic.'
        );
      }
      const reused = !fresh;
      acquireUserBrowser(upstream);
      upstreamUrl = upstream;
      const contexts = b.contexts();
      // viewport:null and no userAgent override — the user's real
      // Chrome already sends a correct, self-consistent UA + client
      // hints; a hardcoded string drifts from the real version and
      // flags as automation. viewport:null lets pages fill the window.
      const ctx = contexts[0] ?? (await b.newContext({ viewport: null }));
      // CDP-attach: do NOT create a new page on session creation.
      // The user already sees their open tabs in the host Chromium;
      // opening a blank tab here would pollute the tab list before
      // the AI has done anything. We adopt the first existing page
      // as the driver's "active" handle so tools have something to
      // operate on, but the AI is expected to call playwright_new_tab
      // before any navigation/interaction so it never accidentally
      // mutates a page the user owns (e.g. the qwen-web TUI tab).
      // This browser is the user's own window — enable the
      // focus/protected-tab guards for it.
      markSharedWithUser(ctx);
      // Report what the user does in their tabs, so the AI and the user
      // can work in the same tab.
      await watchUserActivity(ctx);
      const existing = ctx.pages();
      // Edge case when no pages exist: a Chromium with zero pages.
      // Open one so the driver isn't broken; this is the only time
      // CDP-attach create_session adds a tab.
      const pg = existing[0] ?? (await ctx.newPage());
      browser = b;
      context = ctx;
      page = pg;
      attachedToUserBrowser = true;
      // Make the page fill the real browser window. Playwright over
      // CDP otherwise leaves a fixed viewport emulation (~1280x720),
      // so the page renders into a small box with dead space around it
      // (the "page doesn't cover the window" symptom). Clearing the
      // device-metrics override lets the page track the actual window.
      try {
        const vp = await ctx.newCDPSession(pg);
        await vp.send('Emulation.clearDeviceMetricsOverride');
        await vp.detach().catch(() => {});
      } catch {
        /* best-effort */
      }
      try {
        const port = new URL(cdpEndpoint).port;
        const dir = port ? await profileDirForPort(port) : undefined;
        const names = dir ? await openProfileNames(dir) : [];
        const profiles = await countProfiles(b);
        attachedInfo =
          [
            `Chrome ${b.version()}` +
              (names.length ? `, profiles open: ${names.join(', ')}` : ''),
            profiles > 1
              ? `Tabs are in ${profiles} profiles: playwright_list_tabs groups them, and playwright_new_tab opens in the profile of the AI-active tab (or pass sameProfileAs)`
              : '',
            relay.stuckTargets.size
              ? `${relay.stuckTargets.size} tab(s) or frame(s) did not respond during setup (often tabs Chrome has frozen); playwright_list_tabs marks them "(not responding)"`
              : '',
            reused ? 'Reused the existing connection, no Allow prompt' : '',
          ]
            .filter(Boolean)
            .join('. ') + '.';
      } catch {
        /* description only */
      }
    } catch (e) {
      const reason = explainAttachError(
        e as Error,
        cdpEndpoint,
        wsOrHttp,
        CDP_CONNECT_TIMEOUT_MS
      );
      if (
        reason.startsWith(CONTROL_REVOKED_PREFIX) ||
        reason.startsWith(CHROME_REFUSED_PREFIX)
      ) {
        // The user took the browser back, or has not accepted Chrome's
        // Allow prompt yet. A detached browser would be just as wrong as a
        // retry: the caller needs to relay the reason to the user.
        throw new Error(reason);
      }
      if (cdpRequired) {
        throw new Error(
          `CDP attach to ${cdpEndpoint} failed (${reason}) and ${explicitEndpoint ? 'cdpEndpoint was given' : 'APPIUM_MCP_CDP_REQUIRED is set'} — NOT falling back to a detached launch.`
        );
      }
      attachError = reason;
      log.warn(
        `Could not attach to CDP endpoint ${cdpEndpoint} (${attachError}); the user's browser is probably not running. Falling back to a detached launch.`
      );
    }
  }

  if (!attachedToUserBrowser) {
    if (cdpEndpoint && browserType !== 'chromium') {
      if (cdpRequired) {
        throw new Error(
          `${explicitEndpoint ? 'cdpEndpoint was given' : 'APPIUM_MCP_CDP_REQUIRED is set'} but browserType=${browserType}; CDP attach only supports chromium.`
        );
      }
      log.warn(
        `APPIUM_MCP_CDP_ENDPOINT is set but browserType=${browserType}; CDP attach only supports chromium. Falling back to launch().`
      );
    }

    // Fully detach the launched browser from any Chrome/Chromium
    // the user already has open. Playwright's launch() always
    // creates a fresh temp user-data-dir, so we get our own
    // process (Chrome's singleton lock is per-profile) — the
    // args below make the separation visible and safe:
    //  - --class gives the window its own WM_CLASS so the window
    //    manager doesn't group it with the user's Chrome (Linux).
    //  - --remote-debugging-port exposes CDP for this browser on
    //    a port that is verified free first. If a pre-existing
    //    Chrome already holds the preferred port we walk to the
    //    next free one, so a later connectOverCDP can never land
    //    in the user's browser by accident.
    // APPIUM_MCP_CDP_PORT sets the preferred port (default 9222);
    // set it to 0 or "none" to not expose CDP at all.
    const isChromium = browserType === 'chromium';
    const isPatchright = engineName === 'patchright';
    const cdpPortEnv = (process.env.APPIUM_MCP_CDP_PORT ?? '').trim();
    if (
      isChromium &&
      cdpPortEnv !== '0' &&
      cdpPortEnv.toLowerCase() !== 'none'
    ) {
      const preferredPort = parseInt(cdpPortEnv, 10) || 9222;
      cdpPort = await findFreePort(preferredPort);
      if (cdpPort !== preferredPort) {
        log.info(
          `CDP port ${preferredPort} is already in use (another Chrome/Chromium?); using free port ${cdpPort} instead.`
        );
      }
    }
    const detachArgs = [
      '--class=appium-mcp',
      ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
    ];

    // Human-like ("stealth") defaults for chromium so sites with
    // bot detection (Google sign-in, Booking, etc.) treat the
    // browser like a real user instead of automation. We prefer the
    // installed Google Chrome binary over bundled Chromium, strip
    // the automation switches that set navigator.webdriver and the
    // "controlled by automated software" banner, and mask the
    // remaining automation fingerprints via an init script.
    // Set APPIUM_MCP_STEALTH=0 to opt back into plain launch.
    const stealth = isChromium && process.env.APPIUM_MCP_STEALTH !== '0';
    // Explicit binary selection. `channel: "chrome"` pins installed Google
    // Chrome stable; `executablePath` pins an exact file. Either one means
    // "use this binary" — a missing binary is an error, never a silent
    // fallback to Playwright's bundled Chromium (Chrome for Testing, which
    // announces "only for automated testing" and hurts site trust).
    const channel = opts.channel?.trim() || undefined;
    const executablePath = opts.executablePath?.trim() || undefined;
    const explicitBinary = !!(channel || executablePath);
    if (explicitBinary && !isChromium) {
      throw new Error(
        `channel/executablePath select a Chromium-family binary; not supported for ${browserType}. Use browser: 'chromium'.`
      );
    }
    if (isPatchright && explicitBinary) {
      throw new Error(
        'patchright uses its own Chromium build; channel/executablePath are not supported with it. Drop them or use browser: "chromium".'
      );
    }
    const binaryLaunchOpts = executablePath
      ? { executablePath }
      : channel
        ? { channel }
        : {};
    const userDataDir = opts.userDataDir?.trim()
      ? opts.userDataDir.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~')
      : undefined;
    persistentProfile = userDataDir;

    if (userDataDir) {
      // One long-lived profile: cookies, history and cache persist across
      // sessions (this is what lets a search engine trust the browser over
      // time). Playwright's launchPersistentContext owns the browser process,
      // so `browser` comes from the context rather than launch(). Only one
      // process may hold a profile's singleton lock at a time.
      if (opts.storageState) {
        log.warn(
          'userDataDir ignores storageState: a persistent profile already holds its own cookies.'
        );
      }
      const contextOpts = {
        headless,
        viewport,
        // No userAgent override — see newContext below.
        locale: 'en-US',
        timezoneId: 'Europe/Sofia',
        // Ownership marker for the SessionEnd / shutdown sweep. Playwright
        // replaces the child environment when `env` is set, so this is the
        // full parent env plus SQUIRE_OWNED_BROWSER=1 / SQUIRE_OWNER_PID.
        env: ownedBrowserEnv(),
        ...(isChromium ? { args: detachArgs } : {}),
      };
      const persistentOpts = stealth
        ? {
            ...contextOpts,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-first-run',
              '--no-default-browser-check',
              '--disable-infobars',
              ...detachArgs,
            ],
            ignoreDefaultArgs: ['--enable-automation'],
          }
        : contextOpts;
      try {
        context = await engine.launchPersistentContext(userDataDir, {
          ...persistentOpts,
          // patchright must use its own Chromium build: no installed-Chrome
          // channel and no distro fallback.
          ...(explicitBinary
            ? binaryLaunchOpts
            : stealth && !isPatchright
              ? { channel: 'chrome' }
              : {}),
        });
        browser = context.browser() as import('playwright').Browser;
        launchedBinary = isPatchright
          ? 'patchright (own Chromium build)'
          : explicitBinary
            ? executablePath
              ? `custom executable ${executablePath}`
              : `channel ${channel}`
            : stealth
              ? 'Google Chrome stable (channel chrome)'
              : undefined;
      } catch (e) {
        if (isPatchright) {
          mapPatchrightLaunchError(e);
        }
        if (explicitBinary) {
          throw new Error(
            `Could not launch the requested browser (${executablePath ?? `channel ${channel}`}): ${(e as Error).message}`
          );
        }
        if (!stealth) {
          throw e;
        }
        const systemChromium = await findSystemChromium();
        let launched = false;
        if (systemChromium) {
          try {
            context = await engine.launchPersistentContext(userDataDir, {
              ...persistentOpts,
              executablePath: systemChromium,
            });
            browser = context.browser() as import('playwright').Browser;
            launchedBinary = `system Chromium ${systemChromium}`;
            launched = !!browser;
            log.warn(
              `Could not launch installed Google Chrome (channel chrome) (${(e as Error).message}); using system Chromium at ${systemChromium} instead — not Chrome for Testing.`
            );
          } catch (systemError) {
            log.warn(
              `System Chromium at ${systemChromium} also failed (${(systemError as Error).message}); falling back to bundled Chromium.`
            );
          }
        }
        if (!launched) {
          log.warn(
            "Falling back to bundled Chromium — sites will see Chrome for Testing and may treat it as automation. Install Google Chrome or a distro Chromium, or pass channel: 'chrome' to make a missing Chrome an error instead."
          );
          context = await engine.launchPersistentContext(
            userDataDir,
            persistentOpts
          );
          browser = context.browser() as import('playwright').Browser;
          launchedBinary = 'bundled Chromium (Chrome for Testing) — fallback';
        }
      }
      if (!browser) {
        throw new Error(
          `Persistent profile ${userDataDir} opened without a browser handle — close any other browser using it and retry.`
        );
      }
    } else if (stealth || explicitBinary || isPatchright) {
      const launchOpts = {
        headless,
        env: ownedBrowserEnv(),
        ...(stealth
          ? {
              args: [
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-infobars',
                ...detachArgs,
              ],
              ignoreDefaultArgs: ['--enable-automation'],
            }
          : { args: detachArgs }),
      };
      try {
        // Explicit selection wins; otherwise the installed Google Chrome
        // binary — least detectable. patchright always uses its own patched
        // Chromium, so launch through the selected engine, not Playwright's.
        browser = await engine.launch({
          ...launchOpts,
          ...(explicitBinary
            ? binaryLaunchOpts
            : isPatchright
              ? {}
              : { channel: 'chrome' }),
        });
        launchedBinary = isPatchright
          ? 'patchright (own Chromium build)'
          : explicitBinary
            ? executablePath
              ? `custom executable ${executablePath}`
              : `channel ${channel}`
            : 'Google Chrome stable (channel chrome)';
      } catch (e) {
        if (isPatchright) {
          mapPatchrightLaunchError(e);
        }
        if (explicitBinary) {
          throw new Error(
            `Could not launch the requested browser (${executablePath ?? `channel ${channel}`}): ${(e as Error).message}`
          );
        }
        if (!stealth) {
          throw e;
        }
        const systemChromium = await findSystemChromium();
        let launched = false;
        if (systemChromium) {
          try {
            browser = await engine.launch({
              ...launchOpts,
              executablePath: systemChromium,
            });
            launchedBinary = `system Chromium ${systemChromium}`;
            launched = true;
            log.warn(
              `Could not launch installed Google Chrome (channel chrome) (${(e as Error).message}); using system Chromium at ${systemChromium} instead — not Chrome for Testing.`
            );
          } catch (systemError) {
            log.warn(
              `System Chromium at ${systemChromium} also failed (${(systemError as Error).message}); falling back to bundled Chromium.`
            );
          }
        }
        if (!launched) {
          log.warn(
            "Falling back to bundled Chromium — sites will see Chrome for Testing and may treat it as automation. Install Google Chrome or a distro Chromium, or pass channel: 'chrome' to make a missing Chrome an error instead."
          );
          browser = await engine.launch(launchOpts);
          launchedBinary = 'bundled Chromium (Chrome for Testing) — fallback';
        }
      }
    } else {
      browser = await engine.launch({
        headless,
        env: ownedBrowserEnv(),
        ...(isChromium ? { args: detachArgs } : {}),
      });
    }

    if (!userDataDir) {
      context = await browser.newContext({
        viewport,
        // No userAgent override: a hardcoded string drifts from the real
        // Chrome version and desyncs from navigator.userAgentData /
        // client hints, which is itself a bot signal. The real Chrome
        // channel already sends a correct, consistent UA.
        locale: 'en-US',
        timezoneId: 'Europe/Sofia',
        ...(opts.storageState ? { storageState: opts.storageState } : {}),
      });
    }

    if (stealth) {
      await context.addInitScript(() => {
        // navigator.webdriver === true is the #1 automation tell.
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        // Some detectors check for the presence of window.chrome.
        (window as unknown as { chrome: unknown }).chrome = (
          window as unknown as { chrome?: unknown }
        ).chrome || { runtime: {} };
      });
    }

    // A persistent context already opens with a blank tab; adopt it rather
    // than leaving an extra one behind each session.
    page = userDataDir
      ? (context.pages()[0] ?? (await context.newPage()))
      : await context.newPage();
  }

  if (initialUrl) {
    if (attachedToUserBrowser) {
      // Attached to the user's own browser: `page` is one of the
      // user's real tabs (adopted above). Navigating it would yank
      // the user away from whatever they were looking at — and does
      // so bypassing the protected-url / focus guards that every
      // other mutating web tool honours. Open a fresh tab for the
      // AI instead and navigate THAT, leaving the user's tabs alone.
      page = await context.newPage();
    }
    try {
      await page.goto(initialUrl);
    } catch (e) {
      // Not a session yet, so nothing else would ever close this.
      await (attachedToUserBrowser ? page.close() : browser.close()).catch(
        () => {}
      );
      if (upstreamUrl) {
        releaseUserBrowser(upstreamUrl);
      }
      throw e;
    }

    // DataDome hard-block: the page is refused on IP/ASN reputation before
    // any challenge exists, so no selector will ever appear. Fingerprint
    // changes cannot fix the IP, but one engine switch is the only remedy
    // available in-process. Try patchright once, on the same profile, then
    // say plainly what the block is instead of letting the caller wait.
    if (browserType === 'chromium') {
      const block = findHardBlock(await detectDatadome(page).catch(() => []));
      if (block) {
        await (attachedToUserBrowser ? page.close() : browser.close()).catch(
          () => {}
        );
        if (upstreamUrl) {
          releaseUserBrowser(upstreamUrl);
        }
        const retryAllowed =
          engineName === 'playwright' &&
          !opts.datadomeRetried &&
          !attachedToUserBrowser &&
          process.env.APPIUM_MCP_DATADOME_FALLBACK !== '0';
        if (retryAllowed) {
          log.warn(
            `DataDome hard-block on ${block.url} (${block.detail}); relaunching once with the patchright engine.`
          );
          return openWebSession({
            ...opts,
            browser: 'patchright',
            datadomeRetried: true,
            // A blocked browser is not a browser to attach to again.
            skipCdpAttach: true,
          });
        }
        const why = attachedToUserBrowser
          ? 'This session is attached to the user’s browser, so Squire cannot switch engines.'
          : engineName === 'patchright'
            ? 'It is still blocked with the patchright engine — the retry did not clear it.'
            : 'The patchright retry is disabled.';
        throw new Error(
          `datadome_hard_block: DataDome refused ${block.url} (${block.detail}). ${why} This is IP/ASN reputation, not fingerprint; use a different egress or a warmed persistent profile.`
        );
      }
    }
  }

  const pwDriver = new PlaywrightDriver(
    browser,
    context,
    page,
    attachedToUserBrowser
  );
  const sessionId = `pw-${Date.now()}`;
  const webCapabilities = {
    platformName: 'Web',
    browserName: browserType,
    engine: engineName,
    headless,
    viewport,
    ...(cdpPort ? { cdpPort } : {}),
    attachedToUserBrowser,
  };
  setSession(pwDriver, sessionId, webCapabilities);

  // Auto-cleanup on browser close. If this browser goes away
  // unexpectedly — the user closes the CDP-attached Chrome, it
  // crashes, or is killed — Playwright emits 'disconnected'. Drop the
  // session so the next tool call reports a clean "no web session"
  // instead of a pile of "Target closed" errors, and leave a trace in
  // the activity log so agents can see the browser vanished.
  // Intentional teardown (delete_session) sets isDeletingSession
  // first, so dropDisconnectedSession no-ops there.
  // On an attached browser a cut connection is most often the user taking
  // control (a herdr shared pane's force-take), so the session's next calls
  // say "Control revoked:" and the AI stops and asks.
  const onDisconnected = () => {
    dropDisconnectedSession(
      sessionId,
      'attached browser closed or its connection was cut (on a shared pane the user may have taken control: ask before reconnecting)',
      attachedToUserBrowser
        ? `${CONTROL_REVOKED_PREFIX} the connection to the attached browser${cdpEndpoint ? ` at ${cdpEndpoint}` : ''} was cut, so the user has most likely taken control of it (or closed it). Stop and ask the user in chat before trying again; do not create a new session on your own.`
        : undefined
    );
  };
  browser.on('disconnected', onDisconnected);
  // The attached browser outlives the session, so don't leave the listener behind.
  // Other sessions may share an attached browser's connection, and a new
  // one makes Chrome ask for Allow again, so release it rather than close
  // it; cdp-connection.ts closes it once nobody has used it for a while.
  pwDriver.onDelete = () => {
    browser.off('disconnected', onDisconnected);
    if (upstreamUrl) {
      releaseUserBrowser(upstreamUrl);
    }
  };

  log.info(`WEB session created successfully with ID: ${sessionId}`);

  return {
    sessionId,
    driver: pwDriver,
    browserType,
    headless,
    viewport,
    initialUrl,
    cdpPort,
    browserBinary: launchedBinary,
    userDataDir: persistentProfile,
    attachedToUserBrowser,
    attachError,
    attachedInfo,
  };
}

export default function createSession(server: any): void {
  server.addTool({
    name: 'create_session',
    description: `Create a new session with Android, iOS, Web (Playwright), or any device/driver Appium supports.
      WORKFLOW FOR LOCAL SERVERS (no remoteServerUrl):
      - Use select_platform tool FIRST to ask the user which platform they want
      - Then optionally use select_device tool if multiple devices are available
      - Finally call create_session with the selected platform and device
      - DO NOT assume or default to any platform
      WORKFLOW FOR WEB (Playwright):
      - Use select_platform with platform='web' first
      - Then call create_session with platform='web'
      - Optionally specify browser (chromium, firefox, webkit), channel ('chrome' for installed Google Chrome stable), executablePath, and headless mode. Chromium defaults to installed Google Chrome and falls back to bundled Chromium (Chrome for Testing); pass channel: 'chrome' to require real Chrome instead of falling back.
      - When AI_COLLEAGUE_CDP_ENDPOINT / APPIUM_MCP_CDP_ENDPOINT is set, this attaches to the user's already-running Chromium window (the one they can see); focus/protected-tab guards apply there. Otherwise Playwright launches a fresh browser fully detached from any Chrome/Chromium the user already has open (own process/profile/window class, own CDP debug port chosen to be free — APPIUM_MCP_CDP_PORT sets the preferred port, 0/none disables); no focus guards apply to a detached browser. Either way it's a real browser — full JavaScript, cookies, redirects, captchas all behave like for a human user.
      WORKFLOW FOR REMOTE SERVERS (remoteServerUrl provided):
      - SKIP select_platform tool entirely
      - Infer the platform from the user's request (e.g., 'ios', 'android', or 'general')
      - If platform is 'general', treat the provided capabilities as a pass-through W3C/Appium capability set (useful for non-Android/iOS drivers like Windows, macOS, or custom drivers)
      - Infer device type from context when possible (e.g., 'simulator', 'real device')
      - Call create_session directly with platform, remoteServerUrl, and any other capabilities from the user's request
      - Example: User says 'start session with http://localhost:4723 for ios with iphone 17' → infer platform='ios' and call create_session with remoteServerUrl and platform parameters
      `,
    parameters: z.object({
      platform: z.enum(['ios', 'android', 'general', 'web']).describe(
        `REQUIRED: Platform to use.
          - For local servers, this must match the platform the user explicitly selected via the select_platform tool ('ios', 'android', or 'web').
          - Use 'web' for browser automation using Playwright (supports chromium, firefox, webkit).
          - Use 'general' when you want the tool to treat capabilities as a pass-through Appium/W3C capability set (recommended for non-Android/iOS drivers such as Windows, macOS, or other custom Appium servers). 'general' will not apply any platform-specific defaults.
          - If remoteServerUrl is provided, the assistant should confirm or infer the platform from the conversation; do not assume a default.`
      ),
      capabilities: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'Optional custom W3C format capabilities for the session. These are applied on top of defaults for ios/android or used as-is for platform="general". For web sessions, use browser, headless, and url parameters instead. Custom capabilities override default and config file settings.'
        ),
      remoteServerUrl: z
        .string()
        .optional()
        .describe(
          'Remote Appium server URL (e.g., http://localhost:4723 or http://192.168.1.100:4723). If not provided, uses local Appium server. Not used for web/Playwright sessions.'
        ),
      browser: z
        .enum(['chromium', 'firefox', 'webkit', 'patchright'])
        .optional()
        .describe(
          "For web platform only: Browser engine to use. Default is 'chromium'. Options: 'chromium', 'firefox', 'webkit' (Safari engine), 'patchright' (chromium family driven by the optional patchright engine, which avoids the automation-detectable CDP calls stock Playwright makes and never sets navigator.webdriver; requires npm install patchright and npx patchright install chromium). A DataDome hard-block on the initial url automatically retries once with patchright; set APPIUM_MCP_DATADOME_FALLBACK=0 to disable that."
        ),
      channel: z
        .string()
        .optional()
        .describe(
          "For web platform with chromium only: the installed browser channel to launch, e.g. 'chrome' (Google Chrome stable) or 'msedge'. Default when chromium: try installed Google Chrome and fall back to Playwright's bundled Chromium (Chrome for Testing). Pass 'chrome' to require real Chrome — if it is not installed the call fails instead of falling back. The session reply says which binary actually launched."
        ),
      executablePath: z
        .string()
        .optional()
        .describe(
          "For web platform with chromium only: absolute path to the browser executable. Wins over 'channel'. A missing file is an error, never a fallback to bundled Chromium."
        ),
      headless: z
        .preprocess((val) => {
          if (typeof val === 'string') {
            return val.toLowerCase() !== 'false';
          }
          return val;
        }, z.boolean())
        .optional()
        .describe(
          'For web platform only: Whether to run the browser in headless mode. Default is true. Pass false when a person should watch, as for playwright_present.'
        ),
      url: z
        .string()
        .optional()
        .describe(
          'For web platform only: Initial URL to navigate to after launching the browser.'
        ),
      cdpEndpoint: z
        .string()
        .optional()
        .describe(
          "For web platform only: the Chrome to attach to for this session, as http://host:port, host:port or a ws://…/devtools/browser/… URL. Overrides APPIUM_MCP_CDP_ENDPOINT. If the attach fails the call fails; it never opens a separate browser instead. Loopback hosts only unless the server's APPIUM_MCP_CDP_ALLOWED_HOSTS allows more."
        ),
      viewport: z
        .object({
          width: z.number().int().min(1).describe('Viewport width in pixels'),
          height: z.number().int().min(1).describe('Viewport height in pixels'),
        })
        .optional()
        .describe(
          'For web platform only: Browser viewport size. Default is 1280x720.'
        ),
      userDataDir: z
        .string()
        .optional()
        .describe(
          'For web platform only: a persistent browser profile directory (e.g. ~/.local/share/squire/profile). Cookies, history and cache persist across sessions, which lets search engines and other sites build trust over time. The profile is flushed on delete_session; only one session can use a directory at a time. Ignored when attaching via cdpEndpoint, and storageState is ignored when this is set.'
        ),
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (args: any, _context: any): Promise<any> => {
      try {
        const {
          platform,
          capabilities: customCapabilities,
          remoteServerUrl,
        } = args;

        // Handle Playwright web sessions
        if (platform === 'web') {
          const {
            sessionId,
            browserType,
            headless,
            viewport,
            initialUrl,
            cdpPort,
            userDataDir,
            browserBinary,
            attachedToUserBrowser,
            attachError,
            attachedInfo,
          } = await openWebSession({
            browser: args.browser,
            headless: args.headless,
            url: args.url,
            viewport: args.viewport,
            cdpEndpoint: args.cdpEndpoint,
            userDataDir: args.userDataDir,
            channel: args.channel,
            executablePath: args.executablePath,
            onWaiting: (m) => _context?.log?.info?.(m),
          });

          const totalSessions = listSessions().length;

          const textResponse = {
            content: [
              {
                type: 'text',
                text: `WEB session created successfully with ID: ${sessionId}\nPlatform: Web (Playwright)\nBrowser: ${browserType}${browserBinary ? ` — ${browserBinary}` : ''}\nHeadless: ${headless}\nViewport: ${viewport.width}x${viewport.height}${initialUrl ? `\nURL: ${initialUrl}` : ''}${attachedToUserBrowser ? `\nMode: attached to user browser (CDP)${attachedInfo ? `: ${attachedInfo}` : ''}` : `\nMode: detached browser (own process/profile)${cdpPort ? `, CDP on 127.0.0.1:${cdpPort}` : ''}`}${userDataDir ? `\nPersistent profile: ${userDataDir} (cookies and history survive delete_session)` : ''}\nActive sessions: ${totalSessions}${attachError ? `\nWARNING: could not attach to the user's browser at ${process.env.APPIUM_MCP_CDP_ENDPOINT} (${attachError}). This is a separate browser the user is not looking at. Fix that, then delete this session and create it again.` : ''}`,
              },
            ],
          };

          // Hosts that render MCP responses as plain text (e.g. qwen-code's
          // TUI) end up dumping the entire HTML dashboard inline, which is
          // very noisy for the user. Suppress the UI resource when
          // APPIUM_MCP_NO_UI is set, or implicitly when CDP-attach mode is
          // active (ai-colleague case).
          if (
            process.env.APPIUM_MCP_NO_UI ||
            process.env.APPIUM_MCP_CDP_ENDPOINT ||
            args.cdpEndpoint
          ) {
            return textResponse;
          }

          const uiResource = createUIResource(
            `ui://appium-mcp/session-dashboard/${sessionId}`,
            createSessionDashboardUI({
              sessionId,
              platform: 'Web',
              automationName: 'Playwright',
              deviceName: `${browserType}${headless ? ' (headless)' : ''}`,
            })
          );

          return addUIResourceToResponse(textResponse, uiResource);
        }

        const configCapabilities = await loadCapabilitiesConfig();
        let finalCapabilities;
        if (platform === 'android') {
          finalCapabilities = buildAndroidCapabilities(
            configCapabilities.android,
            customCapabilities,
            !!remoteServerUrl
          );
        } else if (platform === 'ios') {
          finalCapabilities = await buildIOSCapabilities(
            configCapabilities.ios,
            customCapabilities,
            !!remoteServerUrl
          );
        } else {
          finalCapabilities = {
            ...configCapabilities.general,
            ...customCapabilities,
          };
        }

        log.info(
          `Creating new ${platform.toUpperCase()} session with capabilities:`,
          JSON.stringify(finalCapabilities, null, 2)
        );

        let sessionId;
        if (remoteServerUrl) {
          const remoteUrl = new URL(remoteServerUrl);
          const protocol = remoteUrl.protocol.replace(':', '');
          const port = getPortFromUrl(remoteUrl);
          const user = remoteUrl.username
            ? decodeURIComponent(remoteUrl.username)
            : undefined;
          const key = remoteUrl.password
            ? decodeURIComponent(remoteUrl.password)
            : undefined;
          log.info(
            `Sending capabilities to remote server: ${protocol}://${remoteUrl.hostname}:${port}${remoteUrl.pathname}`
          );
          const client = await WebDriver.newSession({
            protocol,
            hostname: remoteUrl.hostname,
            port,
            path: remoteUrl.pathname,
            ...(user && key ? { user, key } : {}),
            capabilities: finalCapabilities,
          });
          sessionId = client.sessionId;
          setSession(client, client.sessionId, finalCapabilities);
        } else {
          const driver = await createDriverForPlatform(platform);
          log.info(`Sending session with ${driver.constructor.name}`);
          sessionId = await createDriverSession(driver, finalCapabilities);
          setSession(driver, sessionId, finalCapabilities);
        }

        // Safely convert sessionId to string for display
        const sessionIdStr =
          typeof sessionId === 'string'
            ? sessionId
            : String(sessionId || 'Unknown');

        log.info(
          `${platform.toUpperCase()} session created successfully with ID: ${sessionIdStr}`
        );

        const totalSessions = listSessions().length;

        const textResponse = {
          content: [
            {
              type: 'text',
              text: `${platform.toUpperCase()} session created successfully with ID: ${sessionIdStr}\nPlatform: ${finalCapabilities.platformName}\nAutomation: ${finalCapabilities['appium:automationName']}\nDevice: ${finalCapabilities['appium:deviceName']}\nActive sessions: ${totalSessions}`,
            },
          ],
        };

        // Add interactive session dashboard UI
        const uiResource = createUIResource(
          `ui://appium-mcp/session-dashboard/${sessionIdStr}`,
          createSessionDashboardUI({
            sessionId: sessionIdStr,
            platform: finalCapabilities.platformName,
            automationName: finalCapabilities['appium:automationName'],
            deviceName: finalCapabilities['appium:deviceName'],
            platformVersion: finalCapabilities['appium:platformVersion'],
            udid: finalCapabilities['appium:udid'],
          })
        );

        return addUIResourceToResponse(textResponse, uiResource);
      } catch (error: any) {
        log.error('Error creating session:', error);
        throw new Error(`Failed to create session: ${error.message}`);
      }
    },
  });
}
