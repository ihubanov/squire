---
name: captcha-dial
description: Solve a rotation-dial captcha from its live pixels with a portable, dependency-free browser-side scorer, then apply the angle and submit. Use when a page shows a dial/rotation challenge (a picture cut by a circular mask, a slider or draggable disc) and you need the correct angle rather than a hand-supplied guess. Ships a measured thin-ring profile plus a generic profile for other rotation widgets. Prefer this over playwright_captcha_solve when you want the solver itself (no APPIUM_MCP_CAPTCHA flag needed).
---

# Rotation-dial captcha solver

A browser-side module plus site adapters. It reads the live `#source` and piece
images straight from their `data:` URLs, computes the CSS-clockwise angle that
aligns the disc, applies it to the control, submits, reads the server status,
and retries once when the server asks for another round.

No native image library, no screenshots, no per-puzzle constant: the angle is
computed from the pixels of the current puzzle.

## Quick start (thin-ring rotation dial)

The widget is already on screen (after the reveal dialog opens):

1. Inject the solver once per page. Read `dial-solver.js` from this skill
   directory and pass its contents to `playwright_evaluate`:

   ```
   playwright_evaluate({ script: "<contents of dial-solver.js>; 'dial-solver loaded'" })
   ```

2. Run the callable step:

   ```
   playwright_evaluate({ script: "() => SquireDial.solve('rotation-dial')" })
   ```

   If the dial is still hidden behind the site's "Не съм робот" box, `solve`
   presses it first (profile selector `show`) and waits for the picture.

Result (JSON-safe):

```json
{
  "status": "pass",
  "angle": 279,
  "corr": 0.74,
  "confidence": 0.31,
  "rounds": 1,
  "attempts": [{ "n": 1, "angle": 279, "applied": 279, "status": "pass" }],
  "resultText": "089 948 4738 ..."
}
```

`status` is the server's own verdict (`pass`), not an assumption. `resultText`
is the revealed element's text when the profile names one.

## The callable step

`SquireDial.solve(profile, opts)` does exactly:

1. `show(profile)` — press the show control if the widget is hidden, wait for
   both images and for the load animation to settle.
2. `compute(profile)` — sample the two annular profiles, normalise, NCC over
   360°, refine ±1°, return `{angle, corr, confidence, candidates}`.
3. `apply(profile, angle)` — range-input: set `.value`, dispatch `input` +
   `change` (a trusted mouse drag is NOT required; the server grades geometry
   only). A custom control can supply `applyScript`.
4. Click the submit control, intercept the response (`fetch` and XHR are
   wrapped), read `submit.statusField`.
5. `pass` → return. `more_captchas` (or another configured retry value) →
   wait for the fresh picture (or press `refresh`), solve again, up to
   `retries + 1` rounds. Wrong angle → return the failure.

Lower-level calls are exposed too: `SquireDial.compute(profile)`,
`SquireDial.apply(profile, angle)`, `SquireDial.show(profile)`.

## Composing with the Squire MCP tool (`playwright_captcha_solve`)

The MCP tool and this skill are complementary, not alternatives. The tool owns
the real pointer drag, refresh and settle handling; `SquireDial.compute()`
supplies the angle. Three measured constraints (2026-11-08):

- The tool is registered only when the server starts with
  `APPIUM_MCP_CAPTCHA=1`.
- **The published server (1.33.1) requires a `handle` element and reads the
  start angle from it, so it cannot drive a control that has no knob element
  (a range input).** The repo source (1.34.0) adds a geometry contract —
  `angleScript` may return `{angle, startAngle, radius, grab}` — which is what
  makes range inputs work. Until 1.34.0 is published and the plugin pin in
  `plugin/.mcp.json` is raised, call `SquireDial.solve()` directly instead.
- The tool never clicks the submit control. `successScript` is a verdict, not
  a submission: the caller has to submit (or use `SquireDial.solve()`).

On 1.34.3+, for a range-input dial (inject this skill first). The control is
a track, not a disc, so the script returns a `track` line and the tool drags
straight along it — an arc leaves the control and the value stops updating:

```
playwright_captcha_solve({
  dial: '#source',
  angleScript: `(async () => {
    const el = document.querySelector('#rotateRange');
    const rot = Number(el.value) || 0;
    const c = await SquireDial.compute('mirror');
    const t = el.getBoundingClientRect();
    const d = document.querySelector('#source').getBoundingClientRect();
    // Thumb-centre travel, inset by half a thumb at both ends.
    const half = (t.width / 40);
    const y = t.y + t.height / 2 - d.y;
    window.__dialTarget = c.angle;
    return { angle: c.angle, startAngle: rot, min: Number(el.min), max: Number(el.max),
             track: { x1: t.x - d.x + half, y1: y, x2: t.x - d.x + t.width - half, y2: y },
             confidence: c.confidence };
  })()`,
  settleScript: "Math.abs(Number(document.querySelector('#rotateRange').value) - window.__dialTarget) <= 1",
  successScript: "Math.abs(Number(document.querySelector('#rotateRange').value) - window.__dialTarget) <= 1"
})
```

If the widget also refuses to submit without its own "a user moved it" flag
(checked live), add that flag to `settleScript` as well — a value set by the
load animation does not raise it.

`startAngle` must be the widget's _current_ control value, because the tool
issues one absolute drag from live state to the answer; `angle` is the answer
in the same units. `track`, `min` and `max` are px from the dial box's
top-left and the control's own value bounds. Verify the control really is
linear in the rotation before trusting it: set a value, read the computed
transform, and check the degrees move proportionally with no offset.

Watch mode (`APPIUM_MCP_WATCH=1`) captions each drag with the target angle, so
a person watching sees the turn instead of a jump.

## Generic case

Site specifics live only in `DIAL_PROFILES` (top of `dial-solver.js`). The
solver underneath is selector/band/submit driven. To plug in another widget,
pass a profile object instead of a preset name:

```js
SquireDial.solve({
  selectors: {
    source: '#source', // full picture (the mask/outer image)
    piece: '#sourceCropedImg', // the rotating disc image
    control: '#rotateRange', // range input, or use applyScript
    submit: '#submitCaptcha',
    hash: '#captchaHash', // optional
    show: '#notRobotWrapper', // optional: control that reveals the widget
    refresh: '#reloadCaptcha', // optional: new-picture control
    result: '#open_contact_ajax', // optional: revealed-content element
  },
  bands: {
    // Absolute px, or fractions (<=1) of each image's half-size.
    source: [116.5, 126], // or 'auto' to try candidate pairs
    piece: [99.5, 90],
    count: 9, // rings
    mode: 'thin', // 'thin' = grayscale rings; 'wide' = RGB rings
  },
  apply: 'range-input', // or provide applyScript(angle, control, profile)
  submit: {
    urlMatch: 'ajax=rotate_captcha_submit', // substring of the status request
    statusField: 'status',
    passValues: ['pass'],
    retryValues: ['more_captchas'],
    timeoutMs: 15000,
  },
  wait: { imageMs: 15000, settleMs: 1100, refreshMs: 5000 },
  retries: 2,
});
```

Band choice matters. Use `mode:'wide'` with matching radii when the source
image is the full photo and the disc is a 1:1 cut-out (same scale at the same
radius). Use `mode:'thin'` when the source has a masked hole: sample the ring
just outside the hole and the ring near the disc's rim. `bands:'auto'` tries a
few candidate pairs and keeps the one with the highest peak separation — good
for an unknown widget, but an explicit measured pair is more reliable.

## Thin-ring rotation-dial profile (measured, 2026-11-08)

- Selectors: `#source` (300×300, WHITE HOLE at r≤116), `#sourceCropedImg`
  (200×200 disc), `#rotateRange` (range 0–360), `#submitCaptcha`,
  `#captchaHash`, `#notRobotWrapper` (reveal control), `#reloadCaptcha`.
- Bands: crop `99.5..90` ↔ source `116.5..126`, `mode:'thin'`, 9 rings. The
  matched-wide bands read flat white inside the hole and score 0.
- Angle is per-puzzle random; do not reuse a constant (passes observed at 12°,
  49°, 62°, 92°, 107°, 157°, 158°, 256°, 279°, 327°).
- Status comes from `GET /ajax.php?ajax=rotate_captcha_submit&captchaHash=…&userRotateDegrees=…`.
  `status:"pass"` = solved. `status:"more_captchas"` = the angle was accepted
  but another round is required — NOT a wrong angle; solve the next picture.
- Reveal itself is `POST /<adId>?force_session=1` with
  `open_contact=<per-button token>&step=request&data=<captchaHash|empty>`;
  the response is either the dial dialog (step 1) or the contact dialog.
- Space submissions: the endpoint starts refusing after roughly 20 rapid
  submits. A few seconds between rounds is enough.

## Smoke test against the local mirror

Acceptance is a real PASS from the mirror, not a code review.

```bash
# terminal 1
python3 /media/data/fun-noSync/tools/security/captcha/mirror/server.py \
    --port 8788 --ttl 1800

# terminal 2
python3 <this-skill-dir>/smoke.py
```

`smoke.py` injects `dial-solver.js`, computes the angle, reads the mirror's
ground truth with `/grade` (non-consuming), then runs `SquireDial.solve('mirror')`.
Expected shape:

```
computed  : {"angle":236,"corr":0.9385,"confidence":0.0689,"bands":{...}}
mirror    : {"error":0.79,"status":"pass","tol":6.0,"truth":235.21}
solve     : {"status":"pass","rounds":1,...}
page text : +359 88 123 4567
SMOKE: PASS
```

Exit code 0 only on `status:"pass"` with the revealed content present.

## Caveats

- The thin-ring peak on the live rotation dial is broad; `corr` around 0.5 is
  normal and `confidence` can look low. Do not gate a rotation dial on
  `confidence`; gate on variant spread instead — agreement within ~2° is worth
  the drag even at a low peak (a 25° scatter at peak ~0.46 is not, and a
  genuine live seam peaks only ~0.42, so a 0.7 peak floor vetoes everything).
  `dial/angle.js` in the web-driving skill computes exactly that gate.
- `compute` assumes the images are same-origin or `data:` (they are here);
  a canvas-tainted cross-origin image will throw.
- `show` presses the show control only when the source has no `data:` image;
  it is safe to call when the widget is already open.
- Files: `dial-solver.js` (the module), `smoke.py` (mirror harness),
  `SKILL.md` (this doc).
