/**
 * Tools Registration Module
 *
 * This file registers all available MCP tools with the server.
 *
 * ADDING A NEW TOOL:
 * 1. Create your tool file in src/tools/
 * 2. Import it at the top of this file
 * 3. Call it in the registerTools function below
 *
 * See docs/CONTRIBUTING.md for detailed instructions.
 * See src/tools/README.md for tool organization.
 * See src/tools/metadata/README.md for YAML metadata approach.
 */
import { FastMCP } from 'fastmcp';
import log from '../logger.js';
import { touchActiveSession } from '../session-store.js';
import {
  beginAction,
  endAction,
  takeUserEvents,
  formatUserEvents,
} from '../user-activity.js';
import answerAppium from './documentation/answer-appium.js';
import createSession from './session/create-session.js';
import deleteSession from './session/delete-session.js';
import listSessions from './session/list-sessions.js';
import selectSession from './session/select-session.js';
import generateLocators from './test-generation/locators.js';
import selectPlatform from './session/select-platform.js';
import selectDevice from './session/select-device.js';
import openNotifications from './session/open-notifications.js';
import { lockDevice, unlockDevice } from './session/lock.js';
import {
  setGeolocation,
  getGeolocation,
  resetGeolocation,
} from './session/geolocation.js';
import bootSimulator from './ios/boot-simulator.js';
import setupWDA from './ios/setup-wda.js';
import installWDA from './ios/install-wda.js';
import generateTest from './test-generation/generate-tests.js';
import scroll from './navigations/scroll.js';
import scrollToElement from './navigations/scroll-to-element.js';
import swipe from './navigations/swipe.js';
import findElement from './interactions/find.js';
import clickElement from './interactions/click.js';
import doubleTap from './interactions/double-tap.js';
import longPress from './interactions/long-press.js';
import dragAndDrop from './interactions/drag-and-drop.js';
import pinch from './interactions/pinch.js';
import pressKey from './interactions/press-key.js';
import setValue from './interactions/set-value.js';
import getText from './interactions/get-text.js';
import getActiveElement from './interactions/active-element.js';
import getPageSource from './interactions/get-page-source.js';
import { getOrientation, setOrientation } from './interactions/orientation.js';
import handleAlert from './interactions/handle-alert.js';
import { screenshot, elementScreenshot } from './interactions/screenshot.js';
import activateApp from './app-management/activate-app.js';
import installApp from './app-management/install-app.js';
import uninstallApp from './app-management/uninstall-app.js';
import terminateApp from './app-management/terminate-app.js';
import listApps from './app-management/list-apps.js';
import isAppInstalled from './app-management/is-app-installed.js';
import deepLink from './app-management/deep-link.js';
import getContexts from './context/get-contexts.js';
import switchContext from './context/switch-context.js';
import navigate from './web/navigate.js';
import { goBack, goForward, reload } from './web/browser-navigation.js';
import evaluate from './web/evaluate.js';
import runScriptTool from './web/run-script.js';
import present from './web/present.js';
import selectOption from './web/select-option.js';
import hover from './web/hover.js';
import { newTab, switchTab, listTabs, closeTab, userActivity } from './web/tabs.js';
import { type as playwrightType, pressKey as playwrightPressKey } from './web/keyboard.js';
import getUrl from './web/get-url.js';

/**
 * Web-only mode.
 *
 * Set --web-only on the command line, or APPIUM_MCP_WEB_ONLY=1, to register
 * just the browser tools plus the session/element tools they share with the
 * mobile side. Everything unambiguously mobile — device setup, app management,
 * touch gestures, contexts, test generation — is left unregistered.
 *
 * The point is tool-surface economy: every registered tool's description is
 * loaded into the model's context on every session, so a client that will only
 * ever drive a browser should not pay for the mobile half.
 */
function isWebOnly(): boolean {
  if (process.argv.includes('--web-only')) {
    return true;
  }
  const env = process.env.APPIUM_MCP_WEB_ONLY;
  return env === '1' || env === 'true';
}

export default function registerTools(server: FastMCP): void {
  const webOnly = isWebOnly();

  // Wrap addTool to inject logging around tool execution
  const originalAddTool = (server as any).addTool.bind(server);
  (server as any).addTool = (toolDef: any) => {
    const toolName = toolDef?.name ?? 'unknown_tool';
    const originalExecute = toolDef?.execute;
    if (typeof originalExecute !== 'function') {
      return originalAddTool(toolDef);
    }
    const SENSITIVE_KEYS = [
      'password',
      'token',
      'accessToken',
      'authorization',
      'apiKey',
      'apikey',
      'secret',
      'clientSecret',
    ];
    const redactArgs = (obj: any) => {
      try {
        return JSON.parse(
          JSON.stringify(obj, (key, value) => {
            if (
              key &&
              SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k))
            ) {
              return '[REDACTED]';
            }
            // Avoid logging extremely large buffers/strings
            if (value && typeof value === 'string' && value.length > 2000) {
              return `[string:${value.length}]`;
            }
            if (
              value &&
              typeof Buffer !== 'undefined' &&
              Buffer.isBuffer(value)
            ) {
              return `[buffer:${(value as Buffer).length}]`;
            }
            return value;
          })
        );
      } catch {
        return '[Unserializable args]';
      }
    };
    return originalAddTool({
      ...toolDef,
      execute: async (args: any, context: any) => {
        const start = Date.now();
        log.info(`[TOOL START] ${toolName}`, redactArgs(args));
        // Keep the active session's idle clock fresh so the reaper only
        // closes browsers/drivers that are genuinely unused.
        try { touchActiveSession(); } catch { /* no active session yet */ }
        // What this tool does in the user's browser is not the user's activity.
        const bracket = toolName !== 'playwright_user_activity';
        try {
          if (bracket) beginAction();
          let result;
          try {
            result = await originalExecute(args, context);
          } finally {
            if (bracket) endAction();
          }
          const duration = Date.now() - start;
          log.info(`[TOOL END] ${toolName} (${duration}ms)`);
          // Tell the AI what the user did in their browser meanwhile.
          if (bracket && Array.isArray(result?.content)) {
            const seen = takeUserEvents();
            if (seen.length) {
              result = {
                ...result,
                content: [{ type: 'text', text: formatUserEvents(seen) }, ...result.content],
              };
            }
          }
          return result;
        } catch (err: any) {
          const duration = Date.now() - start;
          const msg = err?.stack || err?.message || String(err);
          log.error(`[TOOL ERROR] ${toolName} (${duration}ms): ${msg}`);
          throw err;
        }
      },
    });
  };

  // Session Management
  selectPlatform(server);
  if (!webOnly) {
    selectDevice(server);
  }
  createSession(server);
  listSessions(server);
  selectSession(server);
  deleteSession(server);
  if (!webOnly) {
    openNotifications(server);
    lockDevice(server);
    unlockDevice(server);
    setGeolocation(server);
    getGeolocation(server);
    resetGeolocation(server);

    // iOS Setup
    bootSimulator(server);
    setupWDA(server);
    installWDA(server);
  }

  // Navigation
  scroll(server);
  scrollToElement(server);
  if (!webOnly) {
    swipe(server);
  }

  // Element Interactions
  // PRIORITY ORDER FOR ELEMENT SEARCH:
  // 1. getActiveElement    - Get currently focused element (efficient, instant)
  // 2. findElement         - Find specific element by strategy/selector
  // 3. generateLocators    - Generate all locators (heavyweight, for debugging only)
  findElement(server);
  clickElement(server);
  if (!webOnly) {
    doubleTap(server);
    longPress(server);
    dragAndDrop(server);
    pinch(server);
    pressKey(server);
  }
  setValue(server);
  getText(server);
  getActiveElement(server);
  getPageSource(server);
  if (!webOnly) {
    getOrientation(server);
    setOrientation(server);
  }
  handleAlert(server);
  screenshot(server);
  elementScreenshot(server);

  if (!webOnly) {
    // App Management
    activateApp(server);
    installApp(server);
    uninstallApp(server);
    terminateApp(server);
    listApps(server);
    isAppInstalled(server);
    deepLink(server);

    // Context Management
    getContexts(server);
    switchContext(server);

    // Test Generation
    generateLocators(server);
    generateTest(server);
  }

  // Web (Playwright) Tools
  navigate(server);
  goBack(server);
  goForward(server);
  reload(server);
  evaluate(server);
  runScriptTool(server);
  present(server);
  selectOption(server);
  hover(server);
  newTab(server);
  switchTab(server);
  listTabs(server);
  userActivity(server);
  closeTab(server);
  playwrightType(server);
  playwrightPressKey(server);
  getUrl(server);

  // Documentation
  if (!webOnly) {
    answerAppium(server);
  }

  log.info(webOnly ? 'Web-only tools registered' : 'All tools registered');
}
