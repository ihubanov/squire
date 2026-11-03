/**
 * What the user did in their own browser, so the AI and the user can work
 * in the same tab.
 *
 * In CDP-attach mode a passive listener in each of the user's tabs reports
 * (as a tagged console.debug message, which needs no per-tab setup, unlike
 * a Playwright binding that waits on every tab including frozen ones)
 * their clicks, field changes, Enter presses and form submits; Squire also
 * notes page loads and new tabs. Events that happen while a Squire tool is
 * running are Squire's own and are dropped. The next tool result then starts
 * with "The user did this since your last action", and
 * playwright_user_activity can wait for the user to do something.
 *
 * Password and payment-card fields never report their value.
 */
import type { BrowserContext, Page } from 'playwright';

export interface UserEvent {
  at: number;
  kind: string;
  tab: string;
  detail: string;
}

const MAX_EVENTS = 200;
/** Prefix of the console messages the in-page listener sends. */
const TAG = '\u2063squire-user ';
/** Events this soon after a tool finishes are still the tool's doing. */
const SETTLE_MS = 400;

const events: UserEvent[] = [];
let acting = 0;
let lastActionEnd = 0;
const watched = new WeakSet<BrowserContext>();
const waiters = new Set<() => void>();

function isSquires(at: number): boolean {
  return acting > 0 || at - lastActionEnd < SETTLE_MS;
}

function record(e: UserEvent): void {
  if (isSquires(e.at)) return;
  events.push(e);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const w of waiters) w();
}

/** Bracket a tool's run so its own clicks and loads are not reported as the user's. */
export function beginAction(): void {
  acting++;
}
export function endAction(): void {
  acting = Math.max(0, acting - 1);
  lastActionEnd = Date.now();
}

/** Take the events recorded so far. */
export function takeUserEvents(): UserEvent[] {
  return events.splice(0, events.length);
}

/** Wait up to `ms` for the user to do something; resolves early on the first event. */
export function waitForUserEvent(ms: number): Promise<void> {
  if (events.length) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.add(done);
  });
}

function host(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function formatUserEvents(list: UserEvent[]): string {
  if (!list.length) return '';
  const lines = list.slice(-20).map((e) => {
    const t = new Date(e.at).toTimeString().slice(0, 8);
    return `- ${t} ${e.kind} ${e.detail} (${host(e.tab)})`;
  });
  const more = list.length > 20 ? `\n(${list.length - 20} earlier events left out)` : '';
  return `The user did this in their browser since your last action:\n${lines.join('\n')}${more}`;
}

/** Runs in the page. Reports trusted user events as tagged console.debug messages. */
const WATCH_SCRIPT = `(() => {
  if (window.__squireWatch2) return;
  window.__squireWatch2 = true;
  const report = (kind, detail) => {
    try { console.debug(${JSON.stringify(TAG)} + JSON.stringify({ kind, detail })); } catch {}
  };
  const name = (el) => {
    if (!el || !el.tagName) return '';
    const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText)
      || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title')
      || (el.innerText || el.value || '').trim();
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return role + (label ? ' "' + String(label).replace(/\\s+/g, ' ').slice(0, 60) + '"' : '');
  };
  const secret = (el) => el.type === 'password' || /cc-|card|cvc|cvv/i.test((el.autocomplete || '') + ' ' + (el.name || ''));
  const clickable = (el) => el.closest && (el.closest('a,button,[role=button],[role=menuitem],[role=tab],[role=option],[role=link],input,select,label,summary') || el);
  document.addEventListener('click', (e) => { if (e.isTrusted) report('clicked', name(clickable(e.target))); }, true);
  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    let v = '';
    if (el.type === 'checkbox' || el.type === 'radio') v = el.checked ? ' (checked)' : ' (unchecked)';
    else if (!secret(el) && typeof el.value === 'string') v = ' to "' + el.value.slice(0, 80) + '"';
    report('changed', name(el) + v);
  }, true);
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!e.isTrusted || !el.isContentEditable) return;
    clearTimeout(el.__squireT);
    el.__squireT = setTimeout(() => report('typed in', name(el) + ' "' + (el.innerText || '').slice(0, 80) + '"'), 1200);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.isTrusted && e.key === 'Enter') report('pressed Enter in', name(e.target)); }, true);
  document.addEventListener('submit', (e) => { report('submitted form', name(e.target)); }, true);
})();`;

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref()),
  ]);
}

function watchPage(page: Page): void {
  page.on('console', (msg) => {
    if (msg.type() !== 'debug') return;
    const text = msg.text();
    if (!text.startsWith(TAG)) return;
    try {
      const { kind, detail } = JSON.parse(text.slice(TAG.length)) as { kind: string; detail: string };
      record({ at: Date.now(), kind, detail, tab: page.url() });
    } catch {
      /* malformed report */
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    record({ at: Date.now(), kind: 'loaded', tab: frame.url(), detail: 'a page' });
  });
  // Tabs that already have a document need the listener now; new
  // documents get it from the init script.
  void within(page.evaluate(WATCH_SCRIPT), 2000);
}

/**
 * Start reporting what the user does in `context` (the user's own browser).
 * Safe to call more than once. Frozen tabs are skipped, not waited on.
 */
export async function watchUserActivity(context: BrowserContext): Promise<void> {
  if (watched.has(context)) return;
  watched.add(context);
  await within(context.addInitScript(WATCH_SCRIPT), 5000);
  for (const p of context.pages()) watchPage(p);
  context.on('page', (p) => {
    record({ at: Date.now(), kind: 'opened a tab', tab: p.url(), detail: '' });
    watchPage(p);
  });
}
