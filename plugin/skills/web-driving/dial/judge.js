// judgeScript for the same rotate-the-disc captcha. Screenshot arrives as
// { image, width, height, dial, handle, angle, attempt } where dial/handle are
// PAGE boxes and image is the capture region (dial + pad, default pad 32).
//
// Returns { ok, score, note, strip }. strip is the unrolled seam (outer band
// above the red line, disc band below) as a data URL, for a vision confirm.
// The score is 1 - |residual shift| / tolerance: the shot itself is
// re-correlated, so a drag that landed 2 degrees off scores 0.67, not 0.
async (arg) => {
  const PAD = 32;                      // capture pad used by the tool
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = arg.image; });
  const cv = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);

  const N = 720, TOL = 6;
  const cx = PAD + arg.dial.width / 2, cy = PAD + arg.dial.height / 2;
  const OUTER = [], INNER = [];
  for (let i = 0; i < 9; i++) { OUTER.push(121 + i * 1.0); INNER.push(97 - i * 1.0); }

  const profile = radii => {
    const d = g.getImageData(0, 0, cv.width, cv.height).data, w = cv.width;
    const acc = new Float64Array(N);
    for (const r of radii) {
      for (let k = 0; k < N; k++) {
        const phi = (k * 2 * Math.PI) / N;
        const x = cx + r * Math.cos(phi), y = cy + r * Math.sin(phi);
        const x0 = Math.min(Math.max(Math.floor(x), 0), cv.width - 2);
        const y0 = Math.min(Math.max(Math.floor(y), 0), cv.height - 2);
        const o = (y0 * w + x0) * 4;
        acc[k] += (d[o] + d[o + 1] + d[o + 2]) / 3;
      }
    }
    let m = 0;
    for (const v of acc) m += v;
    m /= N;
    let sd = 0;
    for (const v of acc) sd += (v - m) * (v - m);
    sd = Math.sqrt(sd / N);
    return { p: acc.map(v => (v - m) / (sd || 1)), sd };
  };

  const po = profile(OUTER), pi = profile(INNER);

  // Seam strip: outer band above the red line, disc band below.
  const rows = 40, cols = N, H = rows * 2 + 2;
  const strip = Object.assign(document.createElement('canvas'), { width: cols, height: H });
  const sg = strip.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data, w = cv.width;
  const band = (r0, r1, y0) => {
    for (let x = 0; x < cols; x++) {
      const phi = (x * 2 * Math.PI) / cols;
      for (let y = 0; y < rows; y++) {
        const r = r0 + ((r1 - r0) * y) / (rows - 1);
        const px = Math.min(Math.max(Math.floor(cx + r * Math.cos(phi)), 0), cv.width - 1);
        const py = Math.min(Math.max(Math.floor(cy + r * Math.sin(phi)), 0), cv.height - 1);
        const o = (py * w + px) * 4;
        sg.fillStyle = `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`;
        sg.fillRect(x, y0 + y, 1, 1);
      }
    }
  };
  band(140, 121, 0);
  band(97, 85, rows + 2);
  sg.fillStyle = 'red'; sg.fillRect(0, rows, cols, 2);

  // Residual shift: only ±30 deg matter after a drag.
  let best = -2, bestK = 0;
  for (let k = -60; k <= 60; k++) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += po.p[i] * pi.p[(i + k + N) % N];
    if (sum > best) { best = sum; bestK = k; }
  }
  const shift = Math.abs(bestK / 2);
  const flat = Math.min(po.sd, pi.sd) < 6;
  const score = Math.max(0, 1 - shift / TOL);
  return {
    ok: !flat && shift <= TOL,
    score,
    note: `${flat ? 'flat band' : `residual ${shift.toFixed(1)}°`} (peak ${best.toFixed(2)}, sd ${po.sd.toFixed(0)}/${pi.sd.toFixed(0)})`,
    strip: strip.toDataURL('image/png'),
  };
}
