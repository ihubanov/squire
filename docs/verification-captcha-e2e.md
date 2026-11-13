# Verification — captcha tools, live E2E on vendor test keys

Verifier: e2e-verifier (task #3). Tree: worktree `/media/data/fun-noSync/tools/.sq-wt-verify`
on branch `verify/captcha-merge`, merged from `feat/captcha-turnstile` (404b617) and
`feat/captcha-recaptcha` (b8b4001). Branches left unpushed.

## Merge

Merge commit: `ba24d6818162bc244017fe80447812886da3a092`
(merge of b8b4001 into 404b617).

- One conflict, as predicted: add/add on `src/tools/web/captcha-recaptcha.ts`
  (turnstile's throwaway WIP vs recaptcha's final file).
- Resolution: `git checkout feat/captcha-recaptcha -- src/tools/web/captcha-recaptcha.ts`
  — b8b4001's file verbatim. `git diff feat/captcha-recaptcha -- src/tools/web/captcha-recaptcha.ts`
  is empty.
- No Playwright type fixes were needed: `npx tsc --noEmit` exits 0 with zero output.
- `src/tools/index.ts` registers both `captchaTurnstile` and `captchaRecaptcha` (and the
  dial solver). Since 1.34.9 they are on by default; `APPIUM_MCP_CAPTCHA=0` removes them.
  When this run was made they still sat behind the opt-in `APPIUM_MCP_CAPTCHA === '1'` gate.

## Offline gates

- `npx tsc --noEmit` → exit 0, no diagnostics.
- `npx jest src/tests/captcha-turnstile.test.ts src/tests/captcha-recaptcha.test.ts`
  → 2 suites, 19 tests, all pass.
- `npm test` (full suite) run 1 → 24 suites / 221 tests: 220 pass, 1 fail
  (`src/tests/presenter.test.ts`, "guided: the tour follows a navigation to the next page",
  `locator.waitFor` timeout). That suite alone → 10/10 pass. Full-suite rerun → 24/24 suites,
  221/221 tests pass, exit 0. The presenter failure is an unrelated flake.
- `npm run build` → exit 0. The MCP server used live is `dist/index.js` from this build,
  driven over the real stdio MCP transport with `@modelcontextprotocol/sdk`.

## Live E2E method

- Local fixture server `python3 -m http.server 8899 --bind 127.0.0.1` serving srcdoc-free
  HTML that loads the real vendor JS (`https://challenges.cloudflare.com/turnstile/v0/api.js`,
  `https://www.google.com/recaptcha/api.js`) with the vendor test sitekeys.
- Each case runs through the MCP surface: `select_platform` → `create_session(platform=web,
  headless)` → `playwright_captcha_turnstile` / `playwright_captcha_recaptcha`, with a
  page reload between tool calls and a 3 s probe after each call. Attempts-to-pass is the
  number of tool invocations until the tool reports solved/pass.
- Host fixture records `window.__cbFired` and the response field, read back with
  `playwright_evaluate`; screenshots captured with `appium_screenshot`.

## Results

| Case | Key | Calls | Tool status | Token in page | Callback | Verdict |
|---|---|---|---|---|---|---|
| Turnstile always-pass, visible | `1x00000000000000000000AA` | 2 (cap 3); 3 earlier | `not solved` every call — `turnstile_widget_detected_but_checkbox_not_exposed` | after call +≈2 s (`XXXX.DUMMY.TOKEN.XXXX`, 21 ch); 0 at call time | fires once at ≈2 s | **FAILED as a pass** — tool never reports solved |
| Turnstile always-fail, visible | `2x00000000000000000000AB` | 3 | `not solved` — `turnstile_widget_detected_but_checkbox_not_exposed` | none; widget shows "Verification failed / Troubleshoot" | none | **FAILED** (expected: this key cannot pass; wrong reason reported) |
| Turnstile forced interaction | `3x00000000000000000000FF` | 3 | `not solved` — `turnstile_widget_detected_but_checkbox_not_exposed` | none from the tool | none | **FAILED** |
| reCAPTCHA v2 checkbox | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | 1 | `pass`, `verified: true`, token returned | yes — 1700 ch in `g-recaptcha-response` | fires once | **PASSED, 1 attempt, 7.2 s** |
| reCAPTCHA v3 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | 1 | `unverified` (by design), token 1700 ch | n/a (v3 token returned only) | v3 has no callback contract | **PASSED as asserted (unverified)** |

### Root cause of the three Turnstile failures (observed, not fixed)

The live Cloudflare widget renders its checkbox inside a **closed shadow root**, while the
offline jest harness uses an `srcdoc` iframe with an **open** shadow root
(`src/tests/captcha-turnstile.test.ts`). `pressCheckbox()`
(`src/tools/web/captcha-turnstile.ts:260-307`) walks only `element.shadowRoot`, so against
the live widget it finds no candidate and throws
`turnstile_widget_detected_but_checkbox_not_exposed`; the loop treats that as fatal
(`:600-602`) and returns in 28-290 ms.

Evidence the gate itself is solvable by a plain coordinate click at the moment the tool gives up:

- In the live 3x frames, `document.querySelectorAll('*').length === 11`, `document.body.innerHTML === ''`,
  no iframes in the page's open DOM, yet a 300x65 frame renders "Verify you are human".
- `page.locator('iframe')` in the main page times out (the iframe sits behind a closed shadow);
  `playwright_frames` does list it (it comes from `page.frames()`), which is why
  `resolveFrame()` succeeds and the failure lands in `pressCheckbox`.
- A standalone Playwright click at `frameElement().boundingBox()` + (25, 25) on the same
  fixture produced `XXXX.DUMMY.TOKEN.XXXX` and `__cbFired = 1` on the very next tick.
- On 1x, the widget needs no press at all: token + callback arrive ≈2 s after load, after
  the tool has already returned. There is no poll of the host response field before/without
  a press, so the auto-pass is never observed.

## Verdict

- Merge/offline: green (tsc clean, all 19 captcha tests pass, build OK). One unrelated
  flaky presenter test in the full suite, green when rerun alone.
- Live: **reCAPTCHA v2 and v3 behave as specified on Google's test key. All three Turnstile
  cases fail** — the solver does not work against the production widget even on Cloudflare's
  deterministic test keys. The 1x key's auto-pass is missed entirely, and the interactive
  checkbox is not reachable because of the closed shadow root.
- Not fixed here (verifier role): the turnstile press path needs a closed-shadow-capable
  fallback (click the frame's checkbox offset, or poll the host field for the 1x auto-pass)
  and a fresh live run.
- Unverified by design: v3 score (server-side only), audio transcription, and any real
  production sitekey. The v2 test key always passes without a grid, so **this table does not
  cover the image grid** — see the separate live run below.

### reCAPTCHA image-grid live evidence (2026-11-12)

Run against Google's real demo (`recaptcha-demo.appspot.com/recaptcha-v2-checkbox.php`,
sitekey `6LfW6wATAAAAAHLqO2pb8bDBahxlMxNdo9g947u9`), headed-by-default solver driven over
stdio MCP, tiles classified by a real vision endpoint
(`nvidia/Nemotron-3.5-Super-VL-NVFP4` via the hunch-config fallback; not a stub):

| Run | Result |
|---|---|
| `live3` (`playwright_captcha_recaptcha`, maxAttempts 5) | **PASS** — rounds 1-3 rejected, round 4 selected `4,7` and the widget issued a **2297-char** token; 49.2 s total. Demo form submitted; response body echoed the same token in `g-recaptcha-response` (the capture was truncated at 600 chars before the verdict line, so server-side acceptance of the token is **not** shown in the log). |
| `auto1` (`playwright_captcha_solve`, provider auto) | **PASS** — dispatched to the reCAPTCHA solver, 48.9 s; token present in the host page (2340 ch). |
| `live4` (repeat, 2026-11-12 later) | **FAIL** — 5/5 grid rounds rejected, 71 s, no token, `retry_cap`. |
| `live5-headed` (same harness, `headless: false`, under Xvfb) | **FAIL** — first headed run. Rounds 1-2 rejected on 3×3; the widget then escalated to 4×4 ("Select all squares with motorcycles"), round 3 rejected, round 4 the vision endpoint returned no usable selection → `needs_answer`, 56 s. Confirms the demo escalates grid size after repeated rejects and that the 4×4 path can lose the model. |

All runs above except `live5-headed` were headless (`headless: true` in the harness), so the
pass rate is a headless number.

So the grid path is real and has passed live, but the vision classifier's tile picks are
**unreliable**: 2 passes and 3 failures across the five runs recorded above. `live4` failed
on 3×3 rounds (all five selections rejected); `live5-headed` is the only run that reached
4×4, and there the whole-grid classifier ran out of token budget and returned no JSON.
Treat the grid as experimental until a larger pass-rate sample exists; the checkbox and v3
paths are the stable ones. Audio transcription remains unverified.

### 4×4 fix, live-verified (2026-11-13)

The capture now crops the image to the tile grid instead of the whole panel (the
instruction header is passed as text and was skewing row/column reading), the whole-grid
budget is 8192 tokens (a 4×4 was measured finishing at 3941/4096 with the JSON cut off), and
an unusable whole-grid answer falls back to classifying each tile crop separately
(~1.3 s/tile, four in parallel).

Same harness and demo, headed, three consecutive runs on a fresh build:

| Run | Result |
|---|---|
| `live6-headed` | **PASS** — 3×3, first selection `0,3,7` accepted, 8.9 s, token 2297. Server echo: `success => 1`, empty `errorCodes`. |
| `live7-headed` | **PASS** — 3×3, first selection `0,3,8` accepted, 7.8 s, token 2254. Server echo: success, empty `errorCodes`. |
| `live8-headed` | **PASS** — **4×4**, first selection `8,9` accepted, 9.1 s, token 2297. Server echo: success, empty `errorCodes`. |

3/3 at ~8–9 s, versus 2/5 at 49–71 s before. The 4×4 whole-grid path is the one that
previously returned no answer; it now answers on the first round. The per-tile fallback is
covered by unit tests only — none of these three runs needed it.

### MCP-sampling classifier, live-verified (2026-11-13)

The zero-config path (no `APPIUM_MCP_CAPTCHA_VLM_URL`, no hunch config) was exercised over
stdio by a client that advertises `sampling` and forwards `sampling/createMessage` to the same
VL gateway. Server ran with `HOME` pointed at an empty dir so only sampling could classify.
Same demo page, headless:

| Run | Result |
|---|---|
| `sampling-live1` | **FAIL** — 10 sampling round-trips reached the client, but the first driver reply omitted the schema-required `role: "assistant"`, so every reply was rejected and the tool correctly reported `needs_answer` (22 s). A client bug, not a solver bug — but worth noting the rejection is silent in the tool log. |
| `sampling-live2` | **PASS** — 4 grid rounds (rejected 3 times, accepted `[4]` on round 4), 2276-char token in the host field, 49.1 s. 4 sampling calls, whole-grid only, ~1.7-2.2 s each. |
| `sampling-live3` | **PASS** — same shape, accepted `[2]` on round 4, 2297-char token, 44.9 s. Run on the rebuilt 1.34.9; sampling failures now also surface in the run log (`sampling: …`) instead of a silent `needs_answer`. |

The sampling reply contract matters: a result without `role: "assistant"` is schema-invalid
and the SDK drops it. With the field present the grid path behaves the same as the local
endpoint. Harness: `/tmp/e2e/sampling-recaptcha.mjs`.

## SAGE

- Observation with full evidence: `93f7cacf-9903-4a79-bdad-dc6a920be062` (corroborated).
- Durable fact (live widget DOM is closed-shadow; corrected test-key semantics):
  `900a21ed-bf7d-4c79-a3c9-267f6f344c42`.

## Reproduce

Fixture files and driver scripts are in `/tmp/e2e` (`client.mjs` takes
`<url> <tool> <maxCalls> <toolArgsJson> <frameHint>`; `E2E_SERVER=/media/data/fun-noSync/tools/.sq-wt-verify/dist/index.js
APPIUM_MCP_CAPTCHA=1` — note the tools are on by default since 1.34.9, so the variable is
only needed to reproduce on an older build). Fixture server: `python3 -m http.server 8899 --bind 127.0.0.1` in `/tmp/e2e`.

Raw runs: `/tmp/e2e/turnstile-matrix.txt`, `/tmp/e2e/recaptcha-v3.txt`,
`/tmp/e2e/run-recaptcha-v2b.txt`, `/tmp/jest-full.log`, `/tmp/jest-full2.log`,
`/tmp/jest-captcha.log`, screenshots `/tmp/e2e/2x.png`, `/tmp/e2e/3x.png`.
