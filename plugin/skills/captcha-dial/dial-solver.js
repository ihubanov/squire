/**
 * Squire rotation-dial captcha solver — browser side, zero dependencies.
 *
 * Injected into the page once (playwright_evaluate with this file's contents),
 * it exposes window.SquireDial:
 *
 *   SquireDial.compute(profile)        -> {angle, corr, confidence, ...}
 *   SquireDial.apply(profile, angle)   -> applies the angle to the control
 *   SquireDial.solve(profile, opts)    -> compute + apply + submit + retry
 *
 * The generic solver is selector/band/submit driven; site specifics live in
 * DIAL_PROFILES as small adapters.  It reads the live #source and pieced
 * pixels straight from their data: URLs, so it needs no screenshots and no
 * server-side image library.
 *
 * Angle convention matches the sites: the value is a CSS clockwise rotation —
 * exactly the <input type=range> value the widget submits.
 */
(function (root) {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const DEFAULTS = {
    selectors: {
      source: '#source',
      piece: '#sourceCropedImg',
      control: '#rotateRange',
      submit: '#submitCaptcha',
      hash: '#captchaHash',
      show: '#notRobotWrapper',
      refresh: '#reloadCaptcha',
      result: '#open_contact_ajax',
    },
    bands: { source: [116.5, 126], piece: [99.5, 90], count: 9, mode: 'thin' },
    angularSamples: 720,
    apply: 'range-input',
    submit: {
      urlMatch: 'ajax=rotate_captcha_submit',
      statusField: 'status',
      passValues: ['pass'],
      retryValues: ['more_captchas'],
      timeoutMs: 15000,
    },
    wait: {
      imageMs: 15000,
      settleMs: 1100,
      refreshMs: 5000,
      resultMs: 10000,
      // Minimum spacing between submit clicks, including across solve() calls.
      // The submit endpoint starts refusing after ~20 rapid submits.
      minSubmitGapMs: 2500,
    },
    retries: 1,
  };

  // Site adapters.  Everything site-specific stays here.
  const DIAL_PROFILES = {
    // Live thin-ring rotation dial: #source (300x300) has a WHITE HOLE at r<=116, so the
    // matched-wide bands read flat white.  The measured bridge is the thin ring
    // crop 99.5..90 <-> source 116.5..126 (inverse radius direction).
    'rotation-dial': {
      selectors: {
        source: '#source',
        piece: '#sourceCropedImg',
        control: '#rotateRange',
        submit: '#submitCaptcha',
        hash: '#captchaHash',
        show: '#notRobotWrapper',
        refresh: '#reloadCaptcha',
        result: '#open_contact_ajax',
      },
      bands: {
        source: [116.5, 126],
        piece: [99.5, 90],
        count: 9,
        mode: 'thin',
      },
      apply: 'range-input',
      submit: {
        urlMatch: 'ajax=rotate_captcha_submit',
        statusField: 'status',
        passValues: ['pass'],
        // "more_captchas" = correct solve, another round required (NOT a
        // wrong angle): the widget loads a fresh picture; solve again.
        retryValues: ['more_captchas'],
        timeoutMs: 15000,
      },
      wait: {
        imageMs: 15000,
        settleMs: 1100,
        refreshMs: 5000,
        resultMs: 12000,
      },
      retries: 2,
    },

    // Local mirror (mirror/server.py): the source is the full square photo
    // (no white hole) and the disc is a 1:1 cut-out, so matched bands work.
    mirror: {
      bands: { source: [55, 98], piece: [55, 98], count: 12, mode: 'wide' },
      submit: {
        urlMatch: '/submit',
        statusField: 'status',
        passValues: ['pass'],
        retryValues: [],
        timeoutMs: 10000,
      },
      wait: {
        imageMs: 15000,
        settleMs: 400,
        refreshMs: 4000,
        resultMs: 4000,
        minSubmitGapMs: 0,
      },
      retries: 0,
    },

    // Generic starting point for an unknown widget: same DOM shape as the
    // rotation-dial family, with band auto-detection.  Override selectors/bands for
    // a widget that differs.
    generic: {
      bands: 'auto',
      angularSamples: 720,
      apply: 'range-input',
      submit: {
        urlMatch: 'captcha',
        statusField: 'status',
        passValues: ['pass', 'ok', 'success', 'true'],
        retryValues: ['more_captchas', 'retry', 'again'],
        timeoutMs: 15000,
      },
      wait: { imageMs: 15000, settleMs: 1100, refreshMs: 5000, resultMs: 8000 },
      retries: 1,
    },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function merge(base, extra) {
    const out = clone(base);
    for (const [k, v] of Object.entries(extra || {})) {
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        out[k] &&
        typeof out[k] === 'object' &&
        !Array.isArray(out[k])
      ) {
        out[k] = merge(out[k], v);
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  }

  function resolve(profile, overrides) {
    let p;
    if (typeof profile === 'string') {
      p = clone(DIAL_PROFILES[profile] || {});
    } else {
      p = clone(profile || {});
    }
    p = merge(DEFAULTS, p);
    if (overrides) p = merge(p, overrides);
    return p;
  }

  // ---------------------------------------------------------------- pixels
  function dataUrlOf(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element for ' + sel);
    const src = el.currentSrc || el.src || '';
    if (!src.startsWith('data:')) {
      throw new Error('element ' + sel + ' has no data: image yet');
    }
    return src;
  }

  function decode(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = src;
    });
  }

  function pixels(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  }

  // Bilinear sample at image coords, clamped at the edges.
  function sample(px, x, y, out, o) {
    const { data, w, h } = px;
    let x0 = Math.floor(x),
      y0 = Math.floor(y);
    const fx = x - x0,
      fy = y - y0;
    let x1 = x0 + 1,
      y1 = y0 + 1;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 < 0) x1 = 0;
    if (y1 < 0) y1 = 0;
    if (x0 > w - 1) x0 = w - 1;
    if (y0 > h - 1) y0 = h - 1;
    if (x1 > w - 1) x1 = w - 1;
    if (y1 > h - 1) y1 = h - 1;
    const i00 = (y0 * w + x0) * 4,
      i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4,
      i11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const v =
        data[i00 + c] * (1 - fx) * (1 - fy) +
        data[i10 + c] * fx * (1 - fy) +
        data[i01 + c] * (1 - fx) * fy +
        data[i11 + c] * fx * fy;
      out[o + c] = v;
    }
  }

  // Radial profile: count rings x N angular samples, RGB.
  function annulus(px, cx, cy, r0, r1, count, N) {
    const out = new Float32Array(count * N * 3);
    for (let k = 0; k < count; k++) {
      const r = count === 1 ? r0 : r0 + (r1 - r0) * (k / (count - 1));
      for (let i = 0; i < N; i++) {
        const phi = (i * 2 * Math.PI) / N;
        const x = cx + r * Math.cos(phi);
        const y = cy + r * Math.sin(phi);
        sample(px, x, y, out, (k * N + i) * 3);
      }
    }
    return out;
  }

  // Per-ring normalisation (mean over angular samples; RGB jointly for wide,
  // grayscale first for thin — matching the Python scorers this was ported from).
  function normalise(prof, count, N, mode) {
    const out = new Float32Array(prof.length);
    const stride = mode === 'thin' ? 1 : 3;
    for (let k = 0; k < count; k++) {
      const base = k * N;
      let sum = 0,
        n = 0;
      for (let i = 0; i < N; i++) {
        if (mode === 'thin') {
          const o = (base + i) * 3;
          sum += (prof[o] + prof[o + 1] + prof[o + 2]) / 3;
          n++;
        } else {
          for (let c = 0; c < 3; c++) {
            sum += prof[(base + i) * 3 + c];
            n++;
          }
        }
      }
      const mean = sum / n;
      let varSum = 0;
      for (let i = 0; i < N; i++) {
        if (mode === 'thin') {
          const o = (base + i) * 3;
          const v = (prof[o] + prof[o + 1] + prof[o + 2]) / 3 - mean;
          varSum += v * v;
        } else {
          for (let c = 0; c < 3; c++) {
            const v = prof[(base + i) * 3 + c] - mean;
            varSum += v * v;
          }
        }
      }
      const sd = Math.sqrt(varSum / n) || 1e-6;
      for (let i = 0; i < N; i++) {
        if (mode === 'thin') {
          const o = (base + i) * 3;
          const v = ((prof[o] + prof[o + 1] + prof[o + 2]) / 3 - mean) / sd;
          out[base + i] = v;
        } else {
          for (let c = 0; c < 3; c++) {
            out[(base + i) * 3 + c] = (prof[(base + i) * 3 + c] - mean) / sd;
          }
        }
      }
    }
    void stride;
    return out;
  }

  // NCC over 360 clockwise degrees.  numpy.roll(pc, 2*ang) semantics:
  // pc is read at (i - 2*ang) mod N.
  function correlate(ps, pc, count, N, mode, step) {
    const scores = [];
    for (let ang = 0; ang < 360; ang += step) {
      const shift = (2 * ang) % N;
      let sum = 0,
        n = 0;
      for (let k = 0; k < count; k++) {
        const base = k * N;
        for (let i = 0; i < N; i++) {
          const j = (i - shift + N) % N;
          if (mode === 'thin') {
            sum += ps[base + i] * pc[base + j];
            n++;
          } else {
            for (let c = 0; c < 3; c++) {
              sum += ps[(base + i) * 3 + c] * pc[(base + j) * 3 + c];
              n++;
            }
          }
        }
      }
      scores.push([sum / n, ang]);
    }
    return scores;
  }

  function bandPair(bands, w, h) {
    // values <= 1 are fractions of the image's half-size; larger are px
    const half = Math.min(w, h) / 2;
    const conv = (v) => (Math.abs(v) <= 1 ? v * half : v);
    return [conv(bands[0]), conv(bands[1])];
  }

  function bestOf(scores) {
    let best = scores[0];
    for (const s of scores) if (s[0] > best[0]) best = s;
    const ordered = scores.map((s) => s[0]).sort((a, b) => a - b);
    const median = ordered[Math.floor(ordered.length / 2)];
    const spread = Math.max(
      ordered[Math.floor(ordered.length * 0.9)] - median,
      1e-9
    );
    const confidence = Math.max(
      0,
      Math.min(1, (best[0] - median) / (1 - median + 1e-9))
    );
    return { corr: best[0], angle: best[1], median, spread, confidence };
  }

  function topAngles(scores, n, gap) {
    const out = [];
    for (const s of [...scores].sort((a, b) => b[0] - a[0])) {
      if (
        out.every(
          (o) =>
            Math.min(
              Math.abs(o.angle - s[1]),
              360 - Math.abs(o.angle - s[1])
            ) >= (gap || 22)
        )
      ) {
        out.push({ corr: s[0], angle: s[1] });
        if (out.length >= n) break;
      }
    }
    return out;
  }

  const BAND_CANDIDATES = [
    { source: [0.35, 0.65], piece: [0.55, 0.99] }, // matched wide
    { source: [0.55, 0.95], piece: [0.55, 0.95] }, // matched outer
    { source: [0.777, 0.84], piece: [0.995, 0.9] }, // thin-ring bridge
    { source: [0.55, 0.95], piece: [0.45, 0.75] },
  ];

  async function compute(profile) {
    const p = resolve(profile);
    const srcUrl = dataUrlOf(p.selectors.source);
    const pieceUrl = dataUrlOf(p.selectors.piece);
    const [srcImg, pieceImg] = await Promise.all([
      decode(srcUrl),
      decode(pieceUrl),
    ]);
    const S = pixels(srcImg);
    const P = pixels(pieceImg);
    const N = p.angularSamples || 720;
    const scx = S.w / 2,
      scy = S.h / 2;
    const pcx = P.w / 2,
      pcy = P.h / 2;

    const run = (bands) => {
      const count = bands.count || 9;
      const mode = bands.mode || 'thin';
      const [s0, s1] = bandPair(bands.source, S.w, S.h);
      const [p0, p1] = bandPair(bands.piece, P.w, P.h);
      const ps = normalise(
        annulus(S, scx, scy, s0, s1, count, N),
        count,
        N,
        mode
      );
      const pc = normalise(
        annulus(P, pcx, pcy, p0, p1, count, N),
        count,
        N,
        mode
      );
      const coarse = correlate(ps, pc, count, N, mode, 2);
      const b = bestOf(coarse);
      // refine +/- 1 deg around the coarse peak
      const fine = correlate(ps, pc, count, N, mode, 1).filter(
        (s) => Math.abs(((s[1] - b.angle + 540) % 360) - 180) <= 1
      );
      const bf = bestOf(fine);
      return {
        ...bf,
        bands: { source: [s0, s1], piece: [p0, p1], count, mode },
        candidates: topAngles(fine, 3),
      };
    };

    let best;
    if (p.bands === 'auto' || !p.bands) {
      const tried = [];
      for (const cand of BAND_CANDIDATES) {
        const r = run({ ...cand, count: 8, mode: 'wide' });
        tried.push({
          bands: r.bands,
          corr: r.corr,
          angle: r.angle,
          confidence: r.confidence,
        });
        if (!best || r.confidence > best.confidence) best = r;
      }
      best.auto = tried;
    } else {
      best = run(p.bands);
    }
    best.sourceId = srcUrl.length + ':' + srcUrl.slice(-48);
    best.pieceId = pieceUrl.length + ':' + pieceUrl.slice(-48);
    return best;
  }

  // ---------------------------------------------------------------- control
  async function apply(profile, angle) {
    const p = resolve(profile);
    const v = ((Math.round(angle) % 360) + 360) % 360;
    const ctl = document.querySelector(p.selectors.control);
    if (!ctl) throw new Error('no control element for ' + p.selectors.control);
    if (p.apply === 'range-input') {
      ctl.value = String(v);
      ctl.dispatchEvent(new Event('input', { bubbles: true }));
      ctl.dispatchEvent(new Event('change', { bubbles: true }));
      return v;
    }
    if (p.applyScript) {
      return await (0, eval)(p.applyScript)(v, ctl, p);
    }
    throw new Error('unsupported apply mode: ' + p.apply);
  }

  // ------------------------------------------------------------ status hook
  function hooks() {
    if (!root.__squireDialPending) root.__squireDialPending = [];
    const pending = root.__squireDialPending;
    if (!root.__squireDialHooked) {
      root.__squireDialHooked = true;
      const origFetch = root.fetch;
      if (origFetch) {
        root.fetch = function (input, init) {
          const url =
            typeof input === 'string' ? input : (input && input.url) || '';
          return origFetch.apply(this, arguments).then((res) => {
            try {
              res
                .clone()
                .json()
                .then((json) => pending.push({ url, json }))
                .catch(() => {});
            } catch (e) {
              /* ignore */
            }
            return res;
          });
        };
      }
      const X = root.XMLHttpRequest;
      if (X && X.prototype) {
        const open = X.prototype.open,
          send = X.prototype.send;
        X.prototype.open = function (m, u) {
          this.__squireUrl = u;
          return open.apply(this, arguments);
        };
        X.prototype.send = function () {
          this.addEventListener('load', function () {
            let json;
            try {
              json = JSON.parse(this.responseText);
            } catch (e) {
              /* not json */
            }
            pending.push({
              url: this.__squireUrl,
              json,
              text: this.responseText,
            });
          });
          return send.apply(this, arguments);
        };
      }
    }
    return pending;
  }

  function matchUrl(url, pattern) {
    if (!pattern) return true;
    return String(url || '').indexOf(pattern) !== -1;
  }

  async function waitForStatus(pending, from, submit, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (let i = from; i < pending.length; i++) {
        const rec = pending[i];
        if (!matchUrl(rec.url, submit.urlMatch)) continue;
        if (rec.json && rec.json[submit.statusField] !== undefined) return rec;
      }
      await sleep(80);
    }
    return null;
  }

  function click(sel) {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return false;
    el.click();
    return true;
  }

  function readResult(p) {
    try {
      // A site can leave the old dialog in the DOM and append the new one;
      // the newest match is the live one.
      const all = document.querySelectorAll(p.selectors.result);
      if (!all || !all.length) return '';
      const r = all[all.length - 1];
      return (r.innerText || r.textContent || '').trim();
    } catch (e) {
      return '';
    }
  }

  // The success side-effect (a second POST and a dialog swap) lands a moment
  // after the status JSON.  Wait for the result element to change, otherwise
  // resultText is the stale captcha dialog ("Не съм робот").
  async function waitResultChange(p, before, timeoutMs) {
    const t0 = Date.now();
    let text = readResult(p);
    while (Date.now() - t0 < (timeoutMs || 0)) {
      text = readResult(p);
      if (text && text !== before) return text;
      await sleep(120);
    }
    return text;
  }

  async function waitDataUrl(sel, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const el = document.querySelector(sel);
      const src = el && (el.currentSrc || el.src || '');
      if (src && src.startsWith('data:')) return src;
      await sleep(120);
    }
    throw new Error('timed out waiting for image: ' + sel);
  }

  async function waitImageChange(profile, oldId, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const src = dataUrlOf(profile.selectors.source);
        const id = src.length + ':' + src.slice(-48);
        if (id !== oldId) return true;
      } catch (e) {
        /* not yet */
      }
      await sleep(120);
    }
    return false;
  }

  // ------------------------------------------------------------------- show
  async function show(profile) {
    const p = resolve(profile);
    // If the widget offers a "show" control and the picture is not loaded,
    // press it (idempotent when already open).
    let src = null;
    try {
      src = dataUrlOf(p.selectors.source);
    } catch (e) {
      src = null;
    }
    if (!src && p.selectors.show) {
      const w = document.querySelector(p.selectors.show);
      if (w) {
        w.click();
        await sleep(300);
      }
      await waitDataUrl(p.selectors.source, p.wait.imageMs);
    } else {
      await waitDataUrl(p.selectors.source, p.wait.imageMs);
    }
    if (p.selectors.piece) await waitDataUrl(p.selectors.piece, p.wait.imageMs);
    await sleep(p.wait.settleMs); // let the load animation finish
    return true;
  }

  // ------------------------------------------------------------------ solve
  async function solve(profile, opts) {
    const p = resolve(profile);
    const o = opts || {};
    const maxAttempts = o.maxAttempts || p.retries + 1;
    const pending = hooks();
    await show(p);

    const attempts = [];
    let last = null;
    for (let n = 1; n <= maxAttempts; n++) {
      const c = await compute(p);
      last = c;
      const applied = await apply(p, c.angle);
      await sleep(o.settleMs || p.wait.settleMs);
      // Rate-limit guard: minimum spacing between submissions, including
      // across solve() calls on the same page.
      const gap = (p.wait && p.wait.minSubmitGapMs) || 0;
      if (gap > 0 && root.__squireDialLastSubmit) {
        const left = gap - (Date.now() - root.__squireDialLastSubmit);
        if (left > 0) await sleep(left);
      }
      root.__squireDialLastSubmit = Date.now();
      const beforeText = readResult(p);
      const from = pending.length;
      const clicked = click(p.selectors.submit);
      if (!clicked)
        throw new Error('no submit element for ' + p.selectors.submit);
      const rec = await waitForStatus(
        pending,
        from,
        p.submit,
        p.submit.timeoutMs
      );
      const status =
        rec && rec.json ? String(rec.json[p.submit.statusField]) : '';
      const passed = p.submit.passValues.indexOf(status) !== -1;
      const retry = p.submit.retryValues.indexOf(status) !== -1;
      attempts.push({
        n,
        angle: c.angle,
        applied,
        corr: Number(c.corr.toFixed(4)),
        confidence: Number(c.confidence.toFixed(3)),
        status: status || 'unknown',
      });
      if (passed) {
        const text = await waitResultChange(p, beforeText, p.wait.resultMs);
        return {
          status: 'pass',
          angle: c.angle,
          corr: c.corr,
          confidence: c.confidence,
          rounds: n,
          attempts,
          resultText: text,
          profile: p,
        };
      }
      if (!retry || n >= maxAttempts) {
        return {
          status: status || 'unknown',
          angle: c.angle,
          corr: c.corr,
          confidence: c.confidence,
          rounds: n,
          attempts,
        };
      }
      // Another round is required (e.g. a rotation dial's "more_captchas").  The widget
      // normally fetches a fresh picture by itself; if it does not, refresh.
      const changed = await waitImageChange(p, c.sourceId, p.wait.refreshMs);
      if (!changed && p.selectors.refresh) {
        click(p.selectors.refresh);
        await waitImageChange(p, c.sourceId, p.wait.refreshMs);
      }
      await sleep(300);
    }
    return { status: 'unknown', rounds: maxAttempts, attempts, last };
  }

  root.SquireDial = {
    DEFAULTS,
    profiles: DIAL_PROFILES,
    resolve,
    compute,
    apply,
    solve,
    show,
  };
})(typeof window !== 'undefined' ? window : globalThis);
