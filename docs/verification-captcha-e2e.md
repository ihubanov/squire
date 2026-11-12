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
- `src/tools/index.ts` registers both `captchaTurnstile` and `captchaRecaptcha` under the
  existing `APPIUM_MCP_CAPTCHA === '1'` gate (index.ts:289-293).

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
- Unverified by design: v3 score (server-side only), reCAPTCHA image-grid tiles and audio
  transcription (the test key always passes without a grid), and any real production sitekey.

## SAGE

- Observation with full evidence: `93f7cacf-9903-4a79-bdad-dc6a920be062` (corroborated).
- Durable fact (live widget DOM is closed-shadow; corrected test-key semantics):
  `900a21ed-bf7d-4c79-a3c9-267f6f344c42`.

## Reproduce

Fixture files and driver scripts are in `/tmp/e2e` (`client.mjs` takes
`<url> <tool> <maxCalls> <toolArgsJson> <frameHint>`; `E2E_SERVER=/media/data/fun-noSync/tools/.sq-wt-verify/dist/index.js
APPIUM_MCP_CAPTCHA=1`). Fixture server: `python3 -m http.server 8899 --bind 127.0.0.1` in `/tmp/e2e`.

Raw runs: `/tmp/e2e/turnstile-matrix.txt`, `/tmp/e2e/recaptcha-v3.txt`,
`/tmp/e2e/run-recaptcha-v2b.txt`, `/tmp/jest-full.log`, `/tmp/jest-full2.log`,
`/tmp/jest-captcha.log`, screenshots `/tmp/e2e/2x.png`, `/tmp/e2e/3x.png`.
