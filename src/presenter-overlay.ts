/**
 * In-page runtime for the presenter: a spotlight + pointing arrow + caption
 * bubble (and, in demo mode, a gliding cursor with click ripples) drawn over
 * a live page to walk a person through a flow.
 *
 * `installPresenter` is passed to `page.evaluate`, which serializes its
 * source — so it must stay fully self-contained: no imports, no references
 * to anything outside its own body.
 *
 * Isolation choices, because this runs on arbitrary sites:
 *  - everything lives in an open shadow root on a host attached to
 *    <html> (not <body>, which SPA frameworks re-render and wipe);
 *  - styles go in through a constructable stylesheet, which page CSP
 *    `style-src` does not block, with a <style> fallback;
 *  - DOM is built with createElement/textContent, never innerHTML, so
 *    Trusted Types enforcement can't break it;
 *  - the whole overlay is pointer-events:none except the caption buttons,
 *    so the person can click the real highlighted element underneath.
 *
 * It talks back to the Node side through an event queue on
 * `window.__squirePresenter` (`seq` + `events`), which the presenter polls.
 */
export function installPresenter(cfg?: {
  accent?: string;
  compact?: boolean;
}): boolean {
  const w = window as any;
  const existing = w.__squirePresenter;
  if (existing && existing.host && existing.host.isConnected) {
    if (cfg && cfg.accent) {
      existing.setAccent(cfg.accent);
    }
    return false;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const css = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { --acc: #7c5cff; --ease: cubic-bezier(.22, 1, .36, 1);
  position: fixed; inset: 0; pointer-events: none; }
.spot { position: fixed; left: 50%; top: 50%; width: 0; height: 0;
  border-radius: 12px; opacity: 0; pointer-events: none;
  box-shadow: 0 0 0 200vmax rgba(12, 14, 24, .58);
  outline: 3px solid var(--acc);
  transition: left .55s var(--ease), top .55s var(--ease),
    width .55s var(--ease), height .55s var(--ease), opacity .3s,
    outline-color .3s; }
.spot.on { opacity: 1; }
.spot.notarget { outline-color: transparent; }
.ring { position: fixed; left: 50%; top: 50%; width: 0; height: 0;
  border-radius: 12px; opacity: 0; pointer-events: none;
  animation: pulse 1.6s ease-out infinite;
  transition: left .55s var(--ease), top .55s var(--ease),
    width .55s var(--ease), height .55s var(--ease), opacity .3s; }
.ring.on { opacity: 1; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--acc) 75%, transparent); }
  100% { box-shadow: 0 0 0 20px transparent; } }
.arrow { position: fixed; left: 0; top: 0; width: 64px; height: 64px;
  opacity: 0; pointer-events: none;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, .35));
  transition: transform .55s var(--ease), opacity .3s; }
.arrow.on { opacity: 1; }
.rot { width: 100%; height: 100%; transition: transform .55s var(--ease); }
.bob { width: 100%; height: 100%; animation: bob 1.1s ease-in-out infinite; }
@keyframes bob { 0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); } }
.arrow svg { width: 100%; height: 100%; display: block; }
.bubble { position: fixed; left: 0; top: 0;
  width: min(340px, calc(100vw - 24px)); padding: 16px 16px 12px;
  background: #fff; color: #1b1d29; border-radius: 14px;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
  opacity: 0; pointer-events: auto;
  transition: transform .55s var(--ease), opacity .25s; }
.bubble.on { opacity: 1; }
.bubble.pop { animation: pop .4s var(--ease); }
@keyframes pop { from { scale: .94; } to { scale: 1; } }
.bubble.demo { pointer-events: none; }
.bubble.demo .skip { pointer-events: auto; }
.count { font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--acc); font-weight: 700; }
h3 { margin: 4px 0 6px; font-size: 16px; font-weight: 700; }
h3:empty { display: none; }
p { margin: 0 0 12px; white-space: pre-wrap; }
.hint { font-size: 12px; color: #6f7287; margin: -4px 0 10px; }
.hint:empty { display: none; }
.bar { height: 4px; background: #ececf3; border-radius: 2px;
  overflow: hidden; margin-bottom: 12px; }
.bar i { display: block; height: 100%; width: 0; background: var(--acc);
  transition: width .55s var(--ease); }
.btns { display: flex; gap: 8px; align-items: center; }
.sp { flex: 1; }
button { font: inherit; font-weight: 600; border: 0; border-radius: 9px;
  padding: 7px 14px; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
.next { background: var(--acc); color: #fff; }
.back { background: #ececf3; color: #1b1d29; }
.skip { background: none; color: #6f7287; padding: 7px 4px; }
.hidden { display: none; }
.cursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px;
  opacity: 0; pointer-events: none;
  filter: drop-shadow(0 3px 6px rgba(0, 0, 0, .4));
  transition: transform .8s var(--ease), opacity .3s; }
.cursor.on { opacity: 1; }
.cursor svg { width: 100%; height: 100%; display: block; }
.ripple { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px;
  border-radius: 50%; border: 3px solid var(--acc); pointer-events: none;
  animation: rip .65s ease-out forwards; }
@keyframes rip { from { transform: scale(.4); opacity: 1; }
  to { transform: scale(3.4); opacity: 0; } }
.toast { position: fixed; left: 50%; top: 50%; translate: -50% -50%;
  padding: 18px 26px; border-radius: 16px; background: var(--acc);
  color: #fff; font: 600 17px/1.3 system-ui, -apple-system, "Segoe UI",
  Roboto, sans-serif; box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
  pointer-events: none; animation: toast 1.6s var(--ease) forwards; }
@keyframes toast { 0% { opacity: 0; scale: .8; } 15% { opacity: 1; scale: 1; }
  80% { opacity: 1; } 100% { opacity: 0; } }
.compact .arrow { width: 44px; height: 44px; }
.compact .bubble { width: min(240px, calc(100vw - 24px)); padding: 10px 12px 8px;
  font-size: 13px; border-radius: 12px; }
.compact .count { font-size: 10px; }
.compact h3 { margin: 2px 0 3px; font-size: 14px; }
.compact p { margin: 0 0 8px; }
.compact .hint, .compact .bar { display: none; }
.compact .bubble.demo .bar { display: block; margin: 0 0 8px; }
.compact button { padding: 5px 10px; border-radius: 8px; font-size: 12px; }
@media (prefers-color-scheme: dark) {
  .bubble { background: #1d2030; color: #eceef6; }
  .back { background: #2c3044; color: #eceef6; }
  .bar { background: #2c3044; }
  .hint, .skip { color: #9a9db3; } }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; } }
`;

  const el = (tag: string, cls?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) {
      e.className = cls;
    }
    return e;
  };
  const svg = (paths: string[], viewBox: string): SVGSVGElement => {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', viewBox);
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'currentColor');
      p.setAttribute('stroke', '#fff');
      p.setAttribute('stroke-width', '3');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
    }
    return s;
  };

  const host = document.createElement('squire-presenter');
  host.setAttribute('aria-live', 'polite');
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; z-index: 2147483647; ' +
    'pointer-events: none; display: block;';
  const root = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    (root as any).adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }

  const wrap = el('div', cfg && cfg.compact ? 'wrap compact' : 'wrap');
  const spot = el('div', 'spot notarget');
  const ring = el('div', 'ring');
  const arrow = el('div', 'arrow');
  const rot = el('div', 'rot');
  const bob = el('div', 'bob');
  // Arrow drawn pointing UP; rotated per placement side.
  const arrowSvg = svg(['M32 4 L58 32 H42 V60 H22 V32 H6 Z'], '0 0 64 64');
  arrowSvg.style.color = 'var(--acc)';
  bob.appendChild(arrowSvg);
  rot.appendChild(bob);
  arrow.appendChild(rot);

  const bubble = el('div', 'bubble');
  bubble.setAttribute('role', 'dialog');
  const count = el('div', 'count');
  const title = el('h3');
  const text = el('p');
  const hint = el('div', 'hint');
  const bar = el('div', 'bar');
  const barFill = el('i');
  bar.appendChild(barFill);
  const btns = el('div', 'btns');
  const skip = el('button', 'skip');
  skip.textContent = 'Skip tour';
  const sp = el('span', 'sp');
  const back = el('button', 'back');
  back.textContent = 'Back';
  const next = el('button', 'next');
  next.textContent = 'Next';
  btns.append(skip, sp, back, next);
  bubble.append(count, title, text, hint, bar, btns);

  const cursor = el('div', 'cursor');
  const cursorSvg = svg(
    ['M5 3 L5 25 L11 19 L15 28 L19 26 L15 17 L23 17 Z'],
    '0 0 30 30'
  );
  cursorSvg.style.color = '#1b1d29';
  cursor.appendChild(cursorSvg);

  wrap.append(spot, ring, arrow, bubble, cursor);
  root.appendChild(wrap);
  document.documentElement.appendChild(host);

  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const state: {
    active: boolean;
    el: Element | null;
    selector: string | null;
    rect: Rect | null;
    advance: string;
    last: string;
    raf: number;
    cursor: { x: number; y: number } | null;
  } = {
    active: false,
    el: null,
    selector: null,
    rect: null,
    advance: 'next',
    last: '',
    raf: 0,
    cursor: null,
  };

  const api: any = {
    host,
    touched: false,
    seq: 0,
    events: [] as { seq: number; type: string; at: number }[],
  };

  const emit = (type: string) => {
    api.seq += 1;
    api.events.push({ seq: api.seq, type, at: Date.now() });
    if (api.events.length > 50) {
      api.events.splice(0, api.events.length - 50);
    }
  };

  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

  const currentRect = (): Rect | null => {
    if (state.el && !state.el.isConnected && state.selector) {
      try {
        state.el = document.querySelector(state.selector);
      } catch {
        state.el = null;
      }
    }
    if (state.el && state.el.isConnected) {
      const r = state.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        return null;
      }
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return state.rect;
  };

  const place = (r: Rect | null) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bubble.offsetWidth || 340;
    const bh = bubble.offsetHeight || 160;
    const setBox = (
      node: HTMLElement,
      x: number,
      y: number,
      ww: number,
      hh: number
    ) => {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.width = `${ww}px`;
      node.style.height = `${hh}px`;
    };
    if (!r) {
      // No target: dim the whole page and centre the caption.
      spot.classList.add('notarget');
      setBox(spot, vw / 2, vh / 2, 0, 0);
      ring.classList.remove('on');
      arrow.classList.remove('on');
      bubble.style.transform = `translate(${(vw - bw) / 2}px, ${(vh - bh) / 2}px)`;
      return;
    }
    const pad = 8;
    const s = {
      x: r.x - pad,
      y: r.y - pad,
      w: r.w + pad * 2,
      h: r.h + pad * 2,
    };
    spot.classList.remove('notarget');
    setBox(spot, s.x, s.y, s.w, s.h);
    setBox(ring, s.x, s.y, s.w, s.h);
    ring.classList.add('on');

    const A = cfg && cfg.compact ? 44 : 64;
    const gap = 6;
    const space: Record<string, number> = {
      bottom: vh - (s.y + s.h),
      top: s.y,
      right: vw - (s.x + s.w),
      left: s.x,
    };
    const needV = A + gap * 2 + bh + 12;
    const needH = A + gap * 2 + bw + 12;
    const side =
      ['bottom', 'top', 'right', 'left'].find(
        (k) => space[k] >= (k === 'bottom' || k === 'top' ? needV : needH)
      ) ?? 'inside';
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    let ax = 0;
    let ay = 0;
    let deg = 0;
    let bx = 0;
    let by = 0;
    if (side === 'bottom' || side === 'top') {
      ax = clamp(cx - A / 2, 8, vw - A - 8);
      bx = clamp(cx - bw / 2, 12, vw - bw - 12);
      if (side === 'bottom') {
        ay = s.y + s.h + gap;
        by = ay + A + gap;
        deg = 0;
      } else {
        ay = s.y - gap - A;
        by = ay - gap - bh;
        deg = 180;
      }
    } else if (side === 'right' || side === 'left') {
      ay = clamp(cy - A / 2, 8, vh - A - 8);
      by = clamp(cy - bh / 2, 12, vh - bh - 12);
      if (side === 'right') {
        ax = s.x + s.w + gap;
        bx = ax + A + gap;
        deg = -90;
      } else {
        ax = s.x - gap - A;
        bx = ax - gap - bw;
        deg = 90;
      }
    } else {
      // Target fills the screen: park the caption in a corner, no arrow.
      bx = vw - bw - 16;
      by = vh - bh - 16;
    }
    if (side === 'inside') {
      arrow.classList.remove('on');
    } else {
      arrow.classList.add('on');
      arrow.style.transform = `translate(${ax}px, ${ay}px)`;
      rot.style.transform = `rotate(${deg}deg)`;
    }
    bubble.style.transform = `translate(${bx}px, ${by}px)`;
  };

  const frame = () => {
    if (!state.active) {
      return;
    }
    const r = currentRect();
    const key = r
      ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
      : 'none';
    const sizeKey = `${key}|${window.innerWidth}x${window.innerHeight}|${bubble.offsetHeight}`;
    if (sizeKey !== state.last) {
      state.last = sizeKey;
      place(r);
    }
    state.raf = requestAnimationFrame(frame);
  };

  let pending = false;
  const inTarget = (t: EventTarget | null, ev?: MouseEvent): boolean => {
    // The spotlight still shows the previous step's element until setTarget.
    if (pending) {
      return false;
    }
    if (t instanceof Node && host.contains(t)) {
      return false;
    }
    if (state.el && state.el.isConnected && t instanceof Node) {
      return state.el.contains(t);
    }
    if (state.rect && ev) {
      const r = state.rect;
      return (
        ev.clientX >= r.x &&
        ev.clientX <= r.x + r.w &&
        ev.clientY >= r.y &&
        ev.clientY <= r.y + r.h
      );
    }
    return false;
  };
  // Whether the person has clicked or edited the target since the step was
  // shown — so a Next press doesn't repeat what they already did.
  const onClick = (e: MouseEvent) => {
    if (!state.active) {
      return;
    }
    if (inTarget(e.target, e)) {
      api.touched = true;
    }
    if (
      (state.advance === 'click' || state.advance === 'navigation') &&
      inTarget(e.target, e)
    ) {
      emit('target-click');
    }
  };
  const onInput = (e: Event) => {
    if (state.active && inTarget(e.target)) {
      api.touched = true;
    }
  };
  const onChange = (e: Event) => {
    if (state.active && inTarget(e.target)) {
      api.touched = true;
    }
    if (state.active && state.advance === 'input' && inTarget(e.target)) {
      emit('target-input');
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (
      state.active &&
      state.advance === 'input' &&
      e.key === 'Enter' &&
      inTarget(e.target)
    ) {
      emit('target-input');
    }
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKey, true);

  next.addEventListener('click', () => emit('next'));
  back.addEventListener('click', () => emit('back'));
  skip.addEventListener('click', () => emit('skip'));

  const HINTS: Record<string, string> = {
    click: 'Click the highlighted spot to continue.',
    input: 'Fill it in, then press Enter or Next.',
    navigation: 'Go ahead — the tour continues on the next page.',
  };

  api.setAccent = (c: string) => {
    if (c) {
      wrap.style.setProperty('--acc', c);
    }
  };
  if (cfg && cfg.accent) {
    api.setAccent(cfg.accent);
  }

  const reveal = () => {
    if (state.el && state.el.isConnected) {
      const r = state.el.getBoundingClientRect();
      const visible =
        r.top >= 0 &&
        r.left >= 0 &&
        r.bottom <= window.innerHeight &&
        r.right <= window.innerWidth;
      if (!visible) {
        state.el.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        });
      }
    }
  };

  const activate = () => {
    state.last = '';
    state.active = true;
    bubble.classList.add('on');
    spot.classList.add('on');
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(frame);
  };

  /**
   * Point at a (new) target. Used after a `pending` show(): the caption goes
   * up at once and the spotlight follows when the element is found.
   */
  api.setTarget = (o: any) => {
    pending = false;
    state.el = o.el || null;
    state.selector = o.selector || null;
    state.rect = o.rect || null;
    api.touched = false;
    activate();
    reveal();
    return true;
  };

  api.show = (o: any) => {
    // `pending`: the caption changes now, the spotlight stays put until setTarget.
    pending = !!o.pending;
    if (!o.pending) {
      state.el = o.el || null;
      state.selector = o.selector || null;
      state.rect = o.rect || null;
    }
    api.touched = false;
    state.advance = o.advance || 'next';
    state.last = '';
    state.active = true;

    count.textContent = o.total > 1 ? `Step ${o.index + 1} of ${o.total}` : '';
    title.textContent = o.title || '';
    text.textContent = o.text || '';
    hint.textContent =
      o.mode === 'demo' ? '' : o.hint || HINTS[state.advance] || '';
    if (o.mode === 'demo' && o.holdMs > 0) {
      // Demo: the bar counts down to the moment the step is performed.
      barFill.style.transition = 'none';
      barFill.style.width = '0%';
      void barFill.offsetWidth;
      barFill.style.transition = `width ${o.holdMs}ms linear`;
      barFill.style.width = '100%';
    } else {
      barFill.style.transition = '';
      barFill.style.width = `${Math.round(((o.index + 1) / Math.max(1, o.total)) * 100)}%`;
    }
    next.textContent = o.isLast ? 'Done' : 'Next';
    skip.textContent = o.mode === 'demo' ? 'Stop' : 'Skip tour';
    back.classList.toggle('hidden', o.mode === 'demo' || !o.showBack);
    next.classList.toggle('hidden', o.mode === 'demo');
    bubble.classList.toggle('demo', o.mode === 'demo');

    bubble.classList.remove('pop');
    void bubble.offsetWidth;
    bubble.classList.add('pop', 'on');
    spot.classList.add('on');

    if (!o.pending) {
      reveal();
    }
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(frame);
    if (o.mode !== 'demo') {
      try {
        next.focus({ preventScroll: true });
      } catch {
        /* focus is best-effort */
      }
    }
    return true;
  };

  /** Fade everything out (e.g. before a vision screenshot) without tearing down. */
  api.hide = () => {
    state.active = false;
    cancelAnimationFrame(state.raf);
    for (const n of [spot, ring, arrow, bubble, cursor]) {
      n.classList.remove('on');
    }
    return true;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Glide the demo cursor to a viewport point; resolves when it lands. */
  api.moveCursor = async (x: number, y: number) => {
    const from = state.cursor ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight - 40,
    };
    if (!cursor.classList.contains('on')) {
      cursor.style.transition = 'none';
      cursor.style.transform = `translate(${from.x - 5}px, ${from.y - 3}px)`;
      void cursor.offsetWidth;
      cursor.style.transition = '';
      cursor.classList.add('on');
    }
    cursor.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
    state.cursor = { x, y };
    await sleep(820);
    return true;
  };

  api.ripple = (x: number, y: number) => {
    const r = el('div', 'ripple');
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    wrap.appendChild(r);
    setTimeout(() => r.remove(), 700);
    return true;
  };

  api.destroy = () => {
    state.active = false;
    cancelAnimationFrame(state.raf);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    if (w.__squirePresenter === api) {
      delete w.__squirePresenter;
    }
    return true;
  };

  /** Closing flourish, then tear down. */
  api.finish = async (message?: string) => {
    api.hide();
    const t = el('div', 'toast');
    t.textContent = message || '✓ All done';
    wrap.appendChild(t);
    await sleep(1600);
    api.destroy();
    return true;
  };

  w.__squirePresenter = api;
  return true;
}
