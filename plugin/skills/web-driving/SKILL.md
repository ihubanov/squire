---
name: web-driving
description: Drive a web page through the Squire Playwright tools the right way — how to run multi-step flows (login, forms, open-menu-then-click) as one human-like unit, survive navigations, reach hidden modals, and respect the user's own tabs in CDP-attach mode. Use whenever a task involves browsing, filling forms, logging in, scraping, or clicking through a site with the Squire `playwright_*` / `appium_*` web tools.
---

# Driving a web page with Squire

The Squire web tools drive a **real** browser (real JS, cookies, redirects, captchas). Prefer `playwright_run_script` for any flow that is more than one action; fall back to the single-action tools only for genuinely one-off interactions.

## Pick the right tool

- **`playwright_run_script`** — a sequence that should run as one human-like unit: a login, a multi-field form, open-a-menu-then-click, click-through-then-read. It is the default for multi-step work.
- **Single-action tools** (`appium_click`, `appium_set_value`, `playwright_type`, `playwright_navigate`, …) — one-off interactions, or when you must inspect the result of each step before deciding the next.
- **`playwright_evaluate`** — read structured data out of the page, call a page JS API, or `fetch()` a same-origin endpoint. Not for multi-step interaction.

## Plan for parallel tabs — prefer it when the task fans out

**Before you start a multi-unit task, decide: is this N *independent* units?** Scraping 6 listings, checking 10 URLs, pulling the same field from 4 sites, filling one form on 3 portals — the units don't depend on each other's results and don't share one sequential login/state flow. If so, **do them in parallel, one tab per unit** — it's faster and it's what Squire is built for (tabs are addressed by stable id, so several can be driven at once without interfering).

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

1. **A submit/click navigates and destroys the JS context.** A raw `playwright_evaluate` that submits a form dies with *"Execution context was destroyed, most likely because of a navigation"* and everything after it is lost. `playwright_run_script` **absorbs the navigation** — the step is marked `navigated: true` and the remaining steps run on the settled new page. Put the post-login check as a later step in the same script; it will run on the far side.

2. **The element is hidden / not actionable / behind an overlay** (menus, modals, custom dropdowns). Each step tries the fast normal path first; on a wall it **escalates to a human path** that reveals the element (unhides ancestors, pierces shadow DOM, scrolls into view), paces input, and can dispatch the event in-page. Look at each step's `via` field: `"normal"` vs `"human"` tells you whether the fallback was needed. Leave `humanize: "auto"` (the default); use `"always"` only for a site that actively fights automation, `"never"` to force a hard failure instead of a fallback.

3. **A step fails mid-flow.** With `stopOnError` (default true) the run stops at the first failing step and returns a `continuationId` plus the per-step results. Inspect what failed, then call `playwright_run_script` again with `resume: "<continuationId>"` to pick up from the next step — after you fix the selector, dismiss a blocker, or navigate. Don't restart the whole flow.

4. **CDP-attach mode shares the user's real browser** — the open tabs are the *user's* real tabs. There are two cases, and getting them backwards is a common failure:
   - **The user points you at a tab** ("look at the tab I just opened", "use this tab", "check that one", "the page I'm on"): **do NOT open a new tab.** Call `playwright_list_tabs`, pick the tab they mean — the newest one, or the one whose URL/title matches what they described, skipping the protected TUI tab — `playwright_switch_tab` to it, and work there. Reading it (screenshot, page source, get_url) never needs a new tab; switching and reading are always allowed.
   - **Self-initiated work** (they gave a goal or a URL, not a specific tab): open your **own** tab first with `playwright_new_tab`, so you don't hijack a page the user is using.

   When in doubt about which existing tab is "theirs," `playwright_list_tabs` and reason from the URLs/titles — never default to opening a new tab when the user clearly meant an existing one. Only the protected TUI tab is truly off-limits.

   **Several Chrome profiles in one window.** Each profile has its own logins. When Chrome has more than one open, `playwright_list_tabs` groups the tabs by profile, and `playwright_new_tab` opens in the profile of the AI-active tab. To pick a profile, pass one of its tabs as `sameProfileAs`. A tab in the wrong profile shows a login wall instead of the user's account.

   **The user's site is already open.** If one of the user's tabs already has the site, `playwright_new_tab` points you at it instead of opening another. Work in that tab when the user asked you to, or when they are clearly fine with it; it is logged in and in the right profile. Close only tabs you opened.

   **Working in the same tab as the user.** You can act in the tab the user is looking at. Every tool result starts with what the user did in their browser since your last action (clicks, field changes, page loads). To hand a step to the user (log in, approve a 2FA prompt, choose something), ask them, then call `playwright_user_activity` with `waitSeconds` to see when and what they did.

   **Allow prompts.** With Chrome's remote-debugging toggle, Chrome asks the user to click Allow when Squire connects. Squire keeps one connection for its whole life, so this happens once, or again only if Chrome drops it. Tell the user before `create_session` that a prompt is coming.

5. **Click like a person.** Use `playwright_run_script` click steps or `appium_click`: they send real mouse events at the element's centre. `element.click()` inside `playwright_evaluate` is an untrusted synthetic event that sites such as LinkedIn ignore. Find elements by visible text and role (`text=…`, ARIA roles), not by a site's CSS class names, which change without notice.

   **Match exactly.** Pick elements by an exact accessible name (`[aria-label="Edit about"]`, an exact button text), not by a name that merely *contains* your words: a "Show credential" link can contain a certificate's name too, and clicking it leaves the site. Don't click a link that leads off the current site unless that is the task.

   **Rich text boxes** (`contenteditable` divs such as profile headlines and "About" fields) are not inputs: `fill` and `el.focus()` from script often don't land. Click inside the box with a real click, check `document.activeElement` is the box, select all (Ctrl+A), delete, then type. Type multi-line text one line at a time with Enter between lines, and afterwards read the text back to check every line made it.

   **Ask before saving anything public or irreversible** (posting, deleting, saving a profile change), unless the user already approved that kind of change. Leave settings such as "notify my network" as the user has them.

   **Checking for an open dialog in `playwright_evaluate`:** many confirmations ("Delete post?") are native `<dialog>` elements shown in the top layer, and `offsetParent` is `null` for those even when they are on screen. Look for `dialog[open]`, `:modal` and `[role=dialog]`/`[role=alertdialog]`, and test visibility with `el.checkVisibility()` or a non-zero `getBoundingClientRect()`, never `offsetParent`.

## Step vocabulary for run_script

`fill`, `type`, `click`, `hover`, `select`, `scrollTo`, `press` (with `key`), `reveal` (force-unhide a selector), `wait` (with `ms`, or `waitFor: load|domcontentloaded|networkidle|navigation`), `eval` (with `script`). Selectors are CSS by default; `xpath=…` and `text=…` prefixes work too.

## When the DOM has nothing: the vision rung

Canvas, WebGL, embedded viewers (PDFs, maps) and images have **no locatable DOM nodes** — every selector fails. For those, add a `visual` hint on click/fill/type steps. Two forms, strongest signal first:

**1. Visible text label** — the control has readable text:
```json
{ "action": "click", "selector": "#canvas-app", "visual": "Sign in to Portal" }
```
OCR grounds the label; when an icon detector is also configured, the match is refined to the detected *control* region — click the button, not its caption (`via: "vision"`, backend `tesseract+onnx`).

**2. Position hint** — icon-only control, nothing readable:
```json
{ "action": "click", "selector": "#canvas-app", "visual": "hamburger menu icon top left" }
```
The icon detector (OmniParser YOLOv9-E, MIT) finds interactive regions; the named screen zone (`top left`, `top right`, `bottom left`, `bottom right`, `center`) picks the right one. Good for ✕ close buttons, hamburger menus, play icons in canvas apps.

Partial OCR matches count (half the label's words, contiguous). Vision works for `click`/`fill`/`type` only, is lazy (the sidecar spawns on first use), and can be disabled with `APPIUM_MCP_VISION=0`. The detector needs `APPIUM_MCP_VISION_MODEL` (path to the `.onnx`) and usually `APPIUM_MCP_VISION_PYTHON` (a venv interpreter with `onnxruntime` — system Pythons too new for wheels are fine to skip via this override). Without a detector, OCR-only still grounds text labels; icon-only targets need the position form *and* a detector.

## Example — log in and verify, across the navigation

```json
{
  "steps": [
    { "action": "fill",  "selector": "#email",    "text": "user@example.com" },
    { "action": "fill",  "selector": "#password", "text": "••••••" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait",  "waitFor": "load" },
    { "action": "eval",  "script": "!!document.querySelector('#logout') || location.pathname" }
  ]
}
```

The submit navigates; the `wait` and the verify `eval` run on the logged-in page. If the submit selector is wrong, the run stops there with a `continuationId` — fix the selector and `resume`.

## Verify, don't assume

A step returning `status: "ok"` means the action didn't throw — not that the flow achieved its goal. Confirm with a final `eval` (a logged-in-only element, the expected URL/host, a success banner) or a screenshot before reporting success.
