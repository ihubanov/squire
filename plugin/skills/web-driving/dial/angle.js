// angleScript for a rotate-the-disc captcha ("unroll the rim") — the rotation
// dial / radial slider type, drawn here over a horizontal <input type=range>
// track. Returns { angle, startAngle, radius,
// grab, confidence } in playwright_drag_arc convention.
//
// The fit: both pictures are sampled as a wide RGB annulus around the disc
// centre (radii well inside the rim, so wall lines and floor patterns carry
// the signal, not just the rim), the disc profile is rolled over all 360
// bearings and the highest normalised cross-correlation wins. A thin
// mean-intensity rim ring reports a decoy seam under a strong local
// structure; the wide colour band does not.
//
// Reliability is bimodal, not continuous: the same picture either fits
// tightly or not at all. So the fit is run three times over slightly
// different annuli, and confidence is built from how well those variants
// agree plus the peak — a twin-peaked or flat picture scatters the variants
// and reports ~0, which is what minAngleConfidence gates on. Spread is the
// only honest signal here; a single high peak on its own was measured to
// happen on hopeless pictures.
async () => {
  const q = (s) => document.querySelector(s);
  const track = q('#rotateRange');
  const src = q('#source');
  const cr = q('#sourceCropedImg');
  if (!track || !src || !cr || !src.src.startsWith('data:')) {
    return { confidence: 0, confidenceNote: 'widget or picture not found' };
  }

  const load = (el) =>
    new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = el.src;
    });

  const N = 720;
  // Three overlapping annuli, offset by 2 px: each covers 55..97.5 in crop px
  // but samples slightly different radii, so a fit that only exists at one
  // scale does not survive all three.
  const VARIANTS = [53, 55, 57].map((start) => {
    const radii = [];
    for (let r = start; r <= 97.5; r += 3) radii.push(r);
    return radii;
  });

  /** Bilinear RGB profiles around (cx, cy): Float32Array[nRad][N][3]. */
  const profiles = (cv, cx, cy, RADII) => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const w = cv.width,
      h = cv.height;
    const out = [];
    for (const r of RADII) {
      const row = new Float32Array(N * 3);
      for (let k = 0; k < N; k++) {
        const phi = (k * 2 * Math.PI) / N;
        const x = cx + r * Math.cos(phi);
        const y = cy + r * Math.sin(phi);
        const x0 = Math.min(Math.max(Math.floor(x), 0), w - 2);
        const y0 = Math.min(Math.max(Math.floor(y), 0), h - 2);
        const fx = x - x0,
          fy = y - y0;
        for (let c = 0; c < 3; c++) {
          const p = (xx, yy) => d[(yy * w + xx) * 4 + c];
          row[k * 3 + c] =
            p(x0, y0) * (1 - fx) * (1 - fy) +
            p(x0 + 1, y0) * fx * (1 - fy) +
            p(x0, y0 + 1) * (1 - fx) * fy +
            p(x0 + 1, y0 + 1) * fx * fy;
        }
      }
      out.push(row);
    }
    return out;
  };

  const normalise = (profs) =>
    profs.map((row) => {
      let m = 0;
      for (let i = 0; i < row.length; i++) m += row[i];
      m /= row.length;
      let v = 0;
      for (let i = 0; i < row.length; i++) {
        const t = row[i] - m;
        v += t * t;
      }
      const sd = Math.sqrt(v / row.length) || 1;
      const out = new Float32Array(row.length);
      for (let i = 0; i < row.length; i++) out[i] = (row[i] - m) / sd;
      return out;
    });

  const [si, ci] = await Promise.all([load(src), load(cr)]);
  const sc = Object.assign(document.createElement('canvas'), {
    width: si.naturalWidth,
    height: si.naturalHeight,
  });
  sc.getContext('2d').drawImage(si, 0, 0);
  const cc = Object.assign(document.createElement('canvas'), {
    width: ci.naturalWidth,
    height: ci.naturalHeight,
  });
  cc.getContext('2d').drawImage(ci, 0, 0);

  // The source is the photo at 1.5x the crop's scale; radii stay in crop px,
  // which the photo carries at the same pixel distance (only the rim radius
  // differs, and the band stays inside it).
  //
  // Three independent fits over slightly different annuli. Measured on the
  // live widget: a clean picture puts all three within ~2 deg at a peak
  // around 0.9; a hopeless one scatters them 25+ deg at peak ~0.46. Spread
  // is the pass/fail signal, the peak only weights it.
  const fits = VARIANTS.map((RADII) => {
    const ps = normalise(
      profiles(sc, si.naturalWidth / 2, si.naturalHeight / 2, RADII)
    );
    const pc = normalise(
      profiles(cc, ci.naturalWidth / 2, ci.naturalHeight / 2, RADII)
    );
    let best = -2,
      bestA = 0;
    const scores = new Float32Array(360);
    for (let a = 0; a < 360; a++) {
      const shift = 2 * a; // 0.5 deg per sample
      let sum = 0,
        n = 0;
      for (let r = 0; r < ps.length; r++) {
        const srow = ps[r],
          crow = pc[r];
        for (let k = 0; k < N; k++) {
          const ck = (k + shift) % N;
          sum +=
            srow[k * 3] * crow[ck * 3] +
            srow[k * 3 + 1] * crow[ck * 3 + 1] +
            srow[k * 3 + 2] * crow[ck * 3 + 2];
        }
        n += N * 3;
      }
      const v = sum / n;
      scores[a] = v;
      if (v > best) {
        best = v;
        bestA = a;
      }
    }
    // Sub-degree: parabolic vertex through the two neighbours.
    const at = (a) => scores[(a + 360) % 360];
    const den = at(bestA - 1) - 2 * best + at(bestA + 1);
    const fine =
      den < -1e-6
        ? bestA + (0.5 * (at(bestA - 1) - at(bestA + 1))) / den
        : bestA;
    return { scores, best, fine: (fine + 360) % 360 };
  });

  // Circular spread of the three answers, and a medoid answer so one wild
  // variant cannot drag the press off the agreeing pair.
  const ref = fits[0].fine;
  const rel = fits
    .map((f) => {
      let d = f.fine - ref;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return d;
    })
    .sort((a, b) => a - b);
  const spread = rel[rel.length - 1] - rel[0];
  const fine = (ref + rel[(rel.length - 1) >> 1] + 360) % 360;
  const worstPeak = Math.min(...fits.map((f) => f.best));
  // Median, not min: live peaks sit near the floor (a genuine seam measured
  // ~0.42), so one variant dipping low must not zero an otherwise agreeing fit.
  const midPeak = fits.map((f) => f.best).sort((a, b) => a - b)[1];
  const bestFit = fits.reduce((a, b) => (b.best > a.best ? b : a));

  // Distance to the first decoy far enough away to be a different seam: the
  // closer the runner-up, the less this fit is worth a press.
  const at = (a) => bestFit.scores[((a % 360) + 360) % 360];
  let decoy = -2;
  for (let d = 25; d <= 335; d++) {
    const v = at(Math.round(fine) + d);
    if (v > decoy) decoy = v;
  }
  // Spread carries the decision — 6 deg is already a coin toss, 2 deg or less
  // is worth a drag — because peak does not separate live pictures (a genuine
  // live seam peaks ~0.42, a hopeless one ~0.46). Peak only damps, and its
  // floor sits below the live range so a real seam is never scored out.
  const spreadTerm = Math.max(0, Math.min(1, (6 - spread) / 4));
  const peakTerm = Math.max(0, Math.min(1, (midPeak - 0.3) / 0.25));
  const confidence = Math.max(0, Math.min(1, spreadTerm * peakTerm));

  // Straight track, arc press: the pointer travels an arc of the target's
  // radius and the input reads x alone, so give exact endpoint bearings.
  const b = track.getBoundingClientRect();
  const cx = b.width / 2,
    cy = b.height / 2;
  const THUMB = 26,
    travel = Math.max(1, b.width - THUMB),
    off = THUMB / 2;
  const xAt = (v) => off + travel * (Math.max(0, Math.min(360, v)) / 360);
  const cur = Number(track.value) || 0;
  const x0 = xAt(cur),
    x1 = xAt(fine);
  const radius = Math.max(20, Math.abs(x1 - cx), Math.abs(x0 - cx)) || 20;
  const bearing = (x) => {
    const k = Math.max(-1, Math.min(1, (x - cx) / radius));
    return (Math.acos(k) * 180) / Math.PI; // same side for both endpoints
  };
  return {
    angle: bearing(x1),
    startAngle: bearing(x0),
    radius,
    grab: { x: x0, y: cy },
    confidence,
    confidenceNote: `spread ${spread.toFixed(1)}° peak ${worstPeak.toFixed(3)} decoy ${decoy.toFixed(3)}`,
  };
};
