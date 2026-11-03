/**
 * Playwright Adapter
 *
 * Bridges Playwright's Locator/ElementHandle-based API to the UUID-based
 * element model used by the existing tool infrastructure.
 */
import type {
  Browser,
  BrowserContext,
  Page,
  ElementHandle,
} from 'playwright';
import { randomUUID } from 'node:crypto';
import { releaseUserBrowser } from './cdp-connection.js';

/**
 * Wraps a Playwright Browser + BrowserContext + Page into a single object
 * that can be stored in the session store alongside Appium drivers.
 *
 * Maintains an element registry that maps generated UUIDs to Playwright
 * ElementHandles so that downstream tools can reference elements the
 * same way they do with Appium's W3C element IDs.
 */
export class PlaywrightDriver {
  readonly browser: Browser;
  readonly context: BrowserContext;
  private _page: Page;
  private readonly elements = new Map<string, ElementHandle>();
  /**
   * Stable per-tab ids. Playwright exposes no public stable Page id, and tab
   * *indices* shift whenever a tab opens or closes — unusable when several
   * agents address tabs concurrently. We assign our own id lazily, keyed by
   * the Page object (stable for the page's lifetime), so a tab can be named
   * and driven directly without depending on the single "active page" pointer.
   */
  private readonly pageIds = new WeakMap<Page, string>();
  /**
   * True when this driver is attached (over CDP) to a browser the user is
   * also using. In that mode the context is the user's OWN default context
   * and its pages are the user's real tabs — teardown must not close them.
   */
  readonly attachedToUserBrowser: boolean;
  /** Set by whoever created the session; undoes its browser listeners. */
  onDelete?: () => void;

  constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    attachedToUserBrowser = false,
  ) {
    this.browser = browser;
    this.context = context;
    this._page = page;
    this.attachedToUserBrowser = attachedToUserBrowser;
  }

  get page(): Page {
    return this._page;
  }

  /** Switch the active page (tab). */
  setPage(page: Page): void {
    this._page = page;
  }

  // ── Stable tab addressing ───────────────────────────────────────

  /**
   * Stable id for a tab, assigned on first sight and stable for the page's
   * life. Lets tools target a specific background tab directly instead of
   * mutating the shared active-page pointer — the primitive that makes
   * concurrent, per-tab driving safe.
   */
  getTabId(page: Page): string {
    let id = this.pageIds.get(page);
    if (!id) {
      id = `tab-${randomUUID().slice(0, 8)}`;
      this.pageIds.set(page, id);
    }
    return id;
  }

  /** Resolve a stable tab id to a live Page in this context, or undefined. */
  resolvePage(tabId: string): Page | undefined {
    for (const p of this.context.pages()) {
      if (this.getTabId(p) === tabId) return p;
    }
    return undefined;
  }

  /** Live tabs with their stable ids, current url, and which is AI-active. */
  listTabs(): { id: string; url: string; active: boolean }[] {
    const active = this._page;
    return this.context.pages().map((p) => ({
      id: this.getTabId(p),
      url: p.url(),
      active: p === active,
    }));
  }

  // ── Element Registry ────────────────────────────────────────────

  /** Register an ElementHandle and return a UUID for it. */
  registerElement(handle: ElementHandle): string {
    const uuid = randomUUID();
    this.elements.set(uuid, handle);
    return uuid;
  }

  /** Look up a previously registered ElementHandle by UUID. */
  getElement(uuid: string): ElementHandle | undefined {
    return this.elements.get(uuid);
  }

  /** Require an element handle or throw. */
  requireElement(uuid: string): ElementHandle {
    const el = this.elements.get(uuid);
    if (!el) {
      throw new Error(
        `Element with UUID "${uuid}" not found. It may have been removed from the DOM or the page navigated away.`
      );
    }
    return el;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Clean up: close context and browser. */
  async deleteSession(): Promise<void> {
    this.elements.clear();
    this.onDelete?.();
    if (this.attachedToUserBrowser) {
      // Other sessions share this connection, and a new one makes Chrome
      // ask the user to click Allow again. cdp-connection.ts closes it
      // once no session has used it for a while.
      // Never close `context`: it holds the user's real tabs.
      releaseUserBrowser();
      return;
    }
    await this.context.close();
    await this.browser.close();
  }

  // ── Element Operations (Appium-compatible surface) ──────────────

  async findElement(
    strategy: string,
    selector: string
  ): Promise<Record<string, string>> {
    let pwSelector: string;

    switch (strategy) {
      case 'css selector':
        pwSelector = selector;
        break;
      case 'xpath':
        pwSelector = `xpath=${selector}`;
        break;
      case 'id':
        pwSelector = `#${selector}`;
        break;
      case 'name':
        pwSelector = `[name="${selector}"]`;
        break;
      case 'class name':
        pwSelector = `.${selector}`;
        break;
      case 'tag name':
        pwSelector = selector;
        break;
      case 'text':
        pwSelector = `text=${selector}`;
        break;
      case 'accessibility id':
      case 'role':
        pwSelector = `[aria-label="${selector}"]`;
        break;
      case 'data-testid':
      case 'test id':
        pwSelector = `[data-testid="${selector}"]`;
        break;
      case 'placeholder':
        pwSelector = `[placeholder="${selector}"]`;
        break;
      default:
        // Treat unknown strategies as CSS selectors
        pwSelector = selector;
    }

    const handle = await this._page.waitForSelector(pwSelector, {
      timeout: 10000,
    });
    if (!handle) {
      throw new Error(
        `Element not found with strategy "${strategy}" and selector "${selector}"`
      );
    }

    const uuid = this.registerElement(handle);
    return { 'element-6066-11e4-a52e-4f735466cecf': uuid };
  }
}
