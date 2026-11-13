---
name: web-driving
description: Drive a web page through the Squire Playwright tools the right way — how to run multi-step flows (login, forms, open-menu-then-click) as one human-like unit, survive navigations, reach hidden modals, and respect the user's own tabs in CDP-attach mode. Use whenever a task involves browsing, filling forms, logging in, scraping, or clicking through a site with the Squire `playwright_*` / `appium_*` web tools.
---

# Driving a web page with Squire

The Squire web tools drive a **real** browser (real JS, cookies, redirects, captchas). Prefer `playwright_run_script` for any flow that is more than one action; fall back to the single-action tools only for genuinely one-off interactions.

**Which browser runs (Chromium sessions).** The default tries the installed Google Chrome stable (`channel: 'chrome'`), then an installed distro/snap Chromium (`/usr/bin/chromium`, `/snap/bin/chromium`, …), then Playwright's bundled Chromium. The bundled build is **Chrome for Testing**, which announces "only for automated testing" in the window and lowers trust with sites like Google; distro Chromium does not. When that matters, pass `channel: 'chrome'` to `create_session`: it then requires real Chrome and fails clearly if it is missing instead of falling back. `executablePath` pins an exact binary; `channel` and `executablePath` also work with `userDataDir`. The session reply names the binary that actually launched.

**DataDome hard-block.** If the initial URL lands on a `geo.captcha-delivery.com` frame with `data-dd-response-page="hard-block"`, Squire closes that browser and retries **once** with the `patchright` engine on the same profile, then reports `datadome_hard_block` if it still refuses. That block is IP/ASN reputation (datacenter/VPN egress), not a puzzle. A measured A/B on one blocked egress re-blocked on every attempt with both engines (`navigator.webdriver` false under patchright, true under Playwright), so a retry from the same IP is expected **not** to clear it — treat the typed error as "change egress or warm a profile", not "retry harder". `patchright` is optional: `npm install patchright && npx patchright install chromium`; select it directly with `browser: "patchright"`. Set `APPIUM_MCP_DATADOME_FALLBACK=0` to disable the automatic retry.

## Pick the right tool

- **`playwright_run_script`** — a sequence that should run as one human-like unit: a login, a multi-field form, open-a-menu-then-click, click-through-then-read. It is the default for multi-step work.
- **Single-action tools** (`appium_click`, `appium_set_value`, `playwright_type`, `playwright_navigate`, …) — one-off interactions, or when you must inspect the result of each step before deciding the next.
- **`playwright_evaluate`** — read structured data out of the page, call a page JS API, or `fetch()` a same-origin endpoint. Not for multi-step interaction.

## Plan for parallel tabs — prefer it when the task fans out

**Before you start a multi-unit task, decide: is this N _independent_ units?** Scraping 6 listings, checking 10 URLs, pulling the same field from 4 sites, filling one form on 3 portals — the units don't depend on each other's results and don't share one sequential login/state flow. If so, **do them in parallel, one tab per unit** — it's faster and it's what Squire is built for (tabs are addressed by stable id, so several can be driven at once without interfering).

Two ways to fan out, cheapest first:

1. **Concurrent `run_script` calls (no subagents).** Open a tab per unit with `playwright_new_tab`, note each returned tab id, then issue multiple `playwright_run_script({ tab: "<id>", steps })` calls **in a single turn** — they run concurrently, each on its own tab (targeting the stable id, never the shared active pointer). Best for a handful of short, similar scripts where you want all the results back together.

2. **One `browser-driver` subagent per tab.** Spawn them in one message so they run concurrently, giving each a specific tab id and its unit. Best when each unit is long, dumps a lot of page text, or needs its own reasoning — the isolation keeps the main context clean.

**Guardrails (it's one shared browser):**

- **Cap concurrency at ~3–5 tabs.** Too many parallel tabs thrash CPU and trip rate-limits / bot-detection. For 20 units, batch in waves of ~4.
- **One worker per tab.** Never point two `run_script` calls or two subagents at the same tab id — they clobber each other.
- **Address tabs by stable id** from `playwright_list_tabs`, never by index (indices shift as tabs open/close).
- **Don't hijack a tab the user is using** for self-initiated work — open your own with `playwright_new_tab`. (Exception: a tab the user explicitly handed you — use that one.) The protected TUI tab is always off-limits.
- **Close the tabs you opened** when done.

**Keep it sequential when there's a real dependency:** a login whose session the later steps need, a wizard where step N needs N−1, or when one result decides the next action. Parallel is for genuinely independent units only — don't fan out a single stateful flow.

Shape:

```
plan  → split into independent units u1..uN (cap a wave at ~4)
open  → playwright_new_tab per unit; keep each tab id
fan   → run_script({tab: id_i, steps_i}) for all i in one turn   (or one subagent per tab)
collect → gather per-tab results; resume/retry only the tabs that failed
clean → close the tabs you opened
```

## The five things that bite you (and how run_script handles them)

1. **A submit/click navigates and destroys the JS context.** A raw `playwright_evaluate` that submits a form dies with _"Execution context was destroyed, most likely because of a navigation"_ and everything after it is lost. `playwright_run_script` **absorbs the navigation** — the step is marked `navigated: true` and the remaining steps run on the settled new page. Put the post-login check as a later step in the same script; it will run on the far side.

2. **The element is hidden / not actionable / behind an overlay** (menus, modals, custom dropdowns). Each step tries the fast normal path first; on a wall it **escalates to a human path** that reveals the element (unhides ancestors, pierces shadow DOM, scrolls into view), paces input, and can dispatch the event in-page. Look at each step's `via` field: `"normal"` vs `"human"` tells you whether the fallback was needed. Leave `humanize: "auto"` (the default); use `"always"` only for a site that actively fights automation, `"never"` to force a hard failure instead of a fallback.

3. **A step fails mid-flow.** With `stopOnError` (default true) the run stops at the first failing step and returns a `continuationId` plus the per-step results. Inspect what failed, then call `playwright_run_script` again with `resume: "<continuationId>"` to pick up from the next step — after you fix the selector, dismiss a blocker, or navigate. Don't restart the whole flow.

4. **CDP-attach mode shares the user's real browser** — the open tabs are the _user's_ real tabs. There are two cases, and getting them backwards is a common failure:
   - **The user points you at a tab** ("look at the tab I just opened", "use this tab", "check that one", "the page I'm on"): **do NOT open a new tab.** Call `playwright_list_tabs`, pick the tab they mean — the newest one, or the one whose URL/title matches what they described, skipping the protected TUI tab — `playwright_switch_tab` to it, and work there. Reading it (screenshot, page source, get_url) never needs a new tab; switching and reading are always allowed.
   - **Self-initiated work** (they gave a goal or a URL, not a specific tab): open your **own** tab first with `playwright_new_tab`, so you don't hijack a page the user is using.

   When in doubt about which existing tab is "theirs," `playwright_list_tabs` and reason from the URLs/titles — never default to opening a new tab when the user clearly meant an existing one. Only the protected TUI tab is truly off-limits.

   **Several Chrome profiles in one window.** Each profile has its own logins. When Chrome has more than one open, `playwright_list_tabs` groups the tabs by profile, and `playwright_new_tab` opens in the profile of the AI-active tab. To pick a profile, pass one of its tabs as `sameProfileAs`. A tab in the wrong profile shows a login wall instead of the user's account.

   **The user's site is already open.** If one of the user's tabs already has the site, `playwright_new_tab` points you at it instead of opening another. Work in that tab when the user asked you to, or when they are clearly fine with it; it is logged in and in the right profile. Close only tabs you opened.

   **Working in the same tab as the user.** You can act in the tab the user is looking at. Every tool result starts with what the user did in their browser since your last action (clicks, field changes, page loads). To hand a step to the user (log in, approve a 2FA prompt, choose something), ask them, then call `playwright_user_activity` with `waitSeconds` to see when and what they did.

   **Allow prompts.** With Chrome's remote-debugging toggle, Chrome asks the user to click Allow when Squire connects. Squire keeps one connection for its whole life, so this happens once, or again only if Chrome drops it. Tell the user before `create_session` that a prompt is coming.

   **On a herdr card.** When the user asks to see or co-drive a browser ("open it", "show me", "let's do it together"), pass `shared: true` to `create_session` so the card's visible browser opens and the user can watch and take over. Leave it out for background scrapes, which stay private and headless. If a tool error starts with "Control revoked:", the user has taken control of that browser: stop and ask them in chat before doing anything else in it, and do not create a new session on your own.

5. **Click like a person.** Use `playwright_run_script` click steps or `appium_click`: they send real mouse events at the element's centre. `element.click()` inside `playwright_evaluate` is an untrusted synthetic event that sites such as LinkedIn ignore. Find elements by visible text and role (`text=…`, ARIA roles), not by a site's CSS class names, which change without notice.

   **Match exactly.** Pick elements by an exact accessible name (`[aria-label="Edit about"]`, an exact button text), not by a name that merely _contains_ your words: a "Show credential" link can contain a certificate's name too, and clicking it leaves the site. Don't click a link that leads off the current site unless that is the task.

   **Rich text boxes** (`contenteditable` divs such as profile headlines and "About" fields) are not inputs: `fill` and `el.focus()` from script often don't land. Click inside the box with a real click, check `document.activeElement` is the box, select all (Ctrl+A), delete, then type. Type multi-line text one line at a time with Enter between lines, and afterwards read the text back to check every line made it.

   **Ask before saving anything public or irreversible** (posting, deleting, saving a profile change), unless the user already approved that kind of change. Leave settings such as "notify my network" as the user has them.

   **Checking for an open dialog in `playwright_evaluate`:** many confirmations ("Delete post?") are native `<dialog>` elements shown in the top layer, and `offsetParent` is `null` for those even when they are on screen. Look for `dialog[open]`, `:modal` and `[role=dialog]`/`[role=alertdialog]`, and test visibility with `el.checkVisibility()` or a non-zero `getBoundingClientRect()`, never `offsetParent`.

## Attaching to the user's browser

- **Allow is per connection, not remembered.** Chrome's `chrome://inspect` toggle asks the user to click Allow for every new DevTools connection; there is no persistent Allow. Never open your own CDP/WebSocket connection to the browser alongside Squire — do everything through Squire's tools, which share one connection.
- **A 403 means the prompt was not accepted.** If `create_session` fails with a 403 (or "Chrome refused the CDP connection …"), the user denied or dismissed the prompt, or it is still waiting. Ask them to click Allow in Chrome, then retry once. Do not treat it as the user taking control, and do not loop.
- **Pick the right profile.** One Chrome can hold several profiles, each with its own logins. Choose by the tabs in `playwright_list_tabs` (for example the one with the user's work email or GitHub), open tabs with `sameProfileAs`, and if unsure ask which profile. A browser that seems "wrong" usually means the wrong profile.
- **Secrets shown once.** A value read with `playwright_evaluate` normally lands in the transcript. To put a secret shown once (such as an API key in a dialog) into a local file without returning it, pass `saveTo`: the file is written 0600 and only its path comes back. If that path is unavailable, say so; never work around it with a side connection.

## Step vocabulary for run_script

`fill`, `type`, `click`, `hover`, `select`, `scrollTo`, `press` (with `key`), `reveal` (force-unhide a selector), `wait` (with `ms`, or `waitFor: load|domcontentloaded|networkidle|navigation`), `eval` (with `script`), `upload` (with `files`: absolute paths). Selectors are CSS by default; `xpath=…` and `text=…` prefixes work too.

**Uploading a file** (an avatar, a thumbnail, an attachment): one `upload` step, never a native file dialog. Point its selector at the `<input type=file>` (hidden is fine) or at the button that opens the picker; Squire catches the picker so no OS dialog appears. Scope the selector to the open dialog (`[role=dialog] input[type=file]`): sites such as LinkedIn leave stale hidden file inputs elsewhere on the page, and the step tells you when more than one element matched.

## When the DOM has nothing: the vision rung

Canvas, WebGL, embedded viewers (PDFs, maps) and images have **no locatable DOM nodes** — every selector fails. For those, add a `visual` hint on click/fill/type steps. Two forms, strongest signal first:

**1. Visible text label** — the control has readable text:

```json
{ "action": "click", "selector": "#canvas-app", "visual": "Sign in to Portal" }
```

OCR grounds the label; when an icon detector is also configured, the match is refined to the detected _control_ region — click the button, not its caption (`via: "vision"`, backend `tesseract+onnx`).

**2. Position hint** — icon-only control, nothing readable:

```json
{
  "action": "click",
  "selector": "#canvas-app",
  "visual": "hamburger menu icon top left"
}
```

The icon detector (OmniParser YOLOv9-E, MIT) finds interactive regions; the named screen zone (`top left`, `top right`, `bottom left`, `bottom right`, `center`) picks the right one. Good for ✕ close buttons, hamburger menus, play icons in canvas apps.

Partial OCR matches count (half the label's words, contiguous). Vision works for `click`/`fill`/`type` only, is lazy (the sidecar spawns on first use), and can be disabled with `APPIUM_MCP_VISION=0`. The detector needs `APPIUM_MCP_VISION_MODEL` (path to the `.onnx`) and usually `APPIUM_MCP_VISION_PYTHON` (a venv interpreter with `onnxruntime` — system Pythons too new for wheels are fine to skip via this override). Without a detector, OCR-only still grounds text labels; icon-only targets need the position form _and_ a detector.

## Example — log in and verify, across the navigation

```json
{
  "steps": [
    { "action": "fill", "selector": "#email", "text": "user@example.com" },
    { "action": "fill", "selector": "#password", "text": "••••••" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait", "waitFor": "load" },
    {
      "action": "eval",
      "script": "!!document.querySelector('#logout') || location.pathname"
    }
  ]
}
```

The submit navigates; the `wait` and the verify `eval` run on the logged-in page. If the submit selector is wrong, the run stops there with a `continuationId` — fix the selector and `resume`.

## Captchas

Captchas are a small family, not one thing. Identify the kind before reaching for a tool.

- **Widget (reCAPTCHA, hCaptcha, Turnstile, image-grid).** It lives in a cross-origin iframe, which page JS cannot see into. `playwright_frames` lists the frame; `playwright_evaluate({ frame: "recaptcha" })` runs inside it. The sitekey is in that frame's URL (`k=` parameter) and the response token is a hidden textarea in the _main_ frame (`#g-recaptcha-response`, `.h-captcha-response`, `[name="cf-turnstile-response"]`) that page JS reads after the widget passes. Checkbox widgets usually just need one real click; then verify the token has a value, and only then submit.
- **Google reCAPTCHA v2 / v3.** The checkbox and image grid are solved by `playwright_captcha_recaptcha` (or `playwright_captcha_solve` with `provider: "auto"`, which dispatches to it when a reCAPTCHA widget is on the page). The grid is classified tile by tile by a vision endpoint (`APPIUM_MCP_CAPTCHA_VLM_URL`, else the claude-local hunch config); each fresh round is re-captured and re-solved, and a rejected round buys a new one up to the retry cap. With no endpoint configured the tool returns the grid PNG and tile boxes as `needs_answer` for you to answer with `tiles`. v3 is passive: a token is returned, never a claimed pass (the score is server-side). The real demo `https://recaptcha-demo.appspot.com/recaptcha-v2-checkbox.php` shows a grid to a fresh session — use it to check the solver.
- **Rotation dial / knob / radial slider.** Also called rotate-the-disc: a disc with a seam and a knob, with a bundled loop (`playwright_captcha_solve`, `provider: "dial"`) and a worked angle/judge pair. A circle with a handle, driven by absolute pointer angle from the centre. `playwright_element_box` gives the dial and handle boxes; `playwright_drag_arc({ elementUUID: dial, handleUUID: handle, endAngle })` presses the knob and drags it round in small real moves. **The knob is not always an element** — a native `<input type=range>` thumb or a canvas sprite has no box of its own (the range input's box spans the whole track, so a `handleUUID` box aims at the wrong point). Then measure only the dial and pass `centerX/centerY` from its centre plus `startAngle`, `radius` (and `grab: {x, y}` if you know the exact point) — never a handle box. The true angle often has to be recovered from an image — screenshot the widget and correlate rotated candidates in `playwright_evaluate`, do not expect the answer in a JS variable. `dial/angle.js` and `dial/judge.js` next to this file are a worked pair (fit from the two pictures, verdict from an unrolled seam strip) to copy and re-point at another widget's selectors.
- **Plain image / text challenge.** Screenshot it, read it, type into the input.

`playwright_captcha_solve` is the single entry point and dispatches on the page: `provider: "auto"` (default) sends a reCAPTCHA page to the reCAPTCHA solver and everything else to the dial loop. For a dial, pass a `dial` selector and an `angleScript` that names the next angle (keep its search window in a `window` variable), a `successScript` for the token verdict, and a `refresh` selector so a dead image gets replaced. `handle` is optional: when the knob is not an element, the `angleScript` returns `{ angle, startAngle, radius }` or `{ angle, grab: {x, y} }` (offsets from the dial box top-left) instead. Do the angle judgement yourself when the tool is not registered.

Two things the DOM rarely gives you, and both move:

- **Where the knob is.** Do not assume a cursor hotspot — plenty of range-thumb dials report `cursor: auto`. Read the control's own value and map it along the track box to get `grab`, and work the geometry out inside `angleScript` on every call rather than as a constant: the script is re-run when a drag has to be repeated, and a stale grab presses empty space.
- **One drag, and an absolute one.** The press goes from the live start angle to the target in a single motion. Nothing survives a widget that re-fits itself, so do not model the solve as wheel ticks or deltas that add up — land the final precision in `angle` and let each press start over. Measured on a live rotation dial: the wheel-in phase was a no-op (control came back exactly at its fit-start value) and the returned `direction` is dead weight. The same applies to a repeated drag: it re-solves first, and the score read after one is a new baseline, not an improvement.
- **Whether the fit is worth the drag.** An adversarial puzzle is bimodal: sometimes candidates agree on an angle and the peak is clear, sometimes they scatter on a flat band and any drag is a coin toss. If `angleScript` can tell, return `confidence` (0–1) — candidate spread and peak are the cheap version — and pass `minAngleConfidence`. **Spread carries that call, not peak.** A live calibration on a rotation-dial captcha of this kind: variants within ~2° of each other is worth a drag even at a low peak (~0.42 is normal for a genuine live seam), while a 116/122/97 scatter (~25°) at peak 0.46 is not — those peaks barely differ, so a peak floor above ~0.45 vetoes every live drag. A gate around 0.35 is sensible. Below it the loop refreshes rather than dragging, spending the attempt on a new image.
- **Whether the drag was accepted.** Widgets animate into place, and a value set mid-flight is silently discarded (some clear their own "touched" flag as well, and then submit refuses without a request). Pass `settleScript` returning truthy only when the control value equals the target **and** the widget's touched flag is set; the loop polls it, repeats an unrecorded drag, and will not score the picture as a pass while the dial is unsettled.

The pass/fail call is where dial solvers usually go wrong — a vision model asked "is this solved?" on the raw widget scores near zero at every angle, right or wrong. Judge with code instead: `judgeScript` receives a PNG data URL of the capture region plus the geometry and must return a score. Make the test linear rather than visual — unroll the ring either side of its mask into bands, so a correct angle is a line that crosses without a sideways jump. A band with no texture (flat sky, water, a plain wall) lines up at any angle and will hand you a 1.000 on a wrong one: take its greyscale stddev and treat a flat band as unscorable instead of letting it gate the decision. Put the band stddevs in the score note — a run of identical low scores then reads as "the grab is missing the control", not "try another angle" (the loop says so itself when every attempt matches). Keep `successScript` alongside it for the token field when the site has one: a picture score is the guess, the token is the fact. The loop prefers the token whenever both exist. `beforeNext` re-shows a widget that hides itself after each drag, `maxAgeMs` replaces one whose signed image expires, and `holdMs` is the settle before the screenshot. When the capture clips, `playwright_element_box` reports page coordinates and scroll alongside the viewport ones.

`successScript` must test something that only exists after a pass — a revealed number or token. A dialog wrapper's `innerText` is not enough: it permanently contains its own static strings ("the code expired", help text), so it never distinguishes a pass. Same for age: a challenge URL carrying a fresh token per image needs a short `maxAgeMs`; a card with a stable per-session token is fine at 20 s or more.

A widget can also swap the picture between your drag and your screenshot, and then submit refuses with a "different picture" error. Where the page carries a session-level identity for the challenge — a hash or token in a hidden field that survives image fetches — pass it as `identityScript`: it is read before the drag and re-checked before judging, and a change skips the now-meaningless score. A per-image URL is not an identity; it changes on every fetch and would report a swap that never happened.

Rules that apply to all of them:

- A single jump does not register on angle- and movement-driven widgets; pass enough `steps` and a small `stepDelayMs`.
- Solve in **consecutive** attempts, and refresh after ~3 misses rather than hammering an unsolvable image — click the widget's own reload control.
- Detect success and failure, never assume: success is the thing the captcha guarded (the field, the reveal, the next page); failure is a changed challenge image or an error element. Poll for either with `playwright_evaluate`.
- Have the user solve it when they are at the machine and it is cheap; hand over when a solve fails twice.

## Watch it happen

With `APPIUM_MCP_WATCH=1` every click, fill, hover and navigation draws a brief cue over the live page: a cursor glides to the target, a box highlights where it lands, a click ripples, a navigation shows a toast with the destination host, and a one-line caption names the action. Captcha drags are cued the same way ("set rotation to 212°") so the turn itself is visible rather than a jump. Nothing is clickable and no step waits for the person — it runs over real automation, at real speed, for someone watching the browser.

It adds well under a second per action (cues in a captcha loop carry a ~0.7 s cap) and is best-effort: cues on a mid-navigation or unusual page are skipped, never fatal. Use `playwright_present` instead when the person should do the steps themselves or needs explanations.

## Verify, don't assume

A step returning `status: "ok"` means the action didn't throw — not that the flow achieved its goal. Confirm with a final `eval` (a logged-in-only element, the expected URL/host, a success banner) or a screenshot before reporting success.
