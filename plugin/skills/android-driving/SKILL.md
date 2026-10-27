---
name: android-driving
description: Develop and debug an Android app on a real emulator or device through the Squire Appium tools — build and install the APK, launch it, read the screen as locators, tap and type, set GPS, read logcat, and iterate. Use whenever a task involves running, testing, clicking through, or debugging an Android app (an .apk, a Gradle Android project, an emulator, adb) with the Squire `appium_*` tools.
---

# Driving an Android app with Squire

The Squire `appium_*` tools drive a **real** Android device or emulator through Appium UiAutomator2. Use them to see what the app actually does after a change, not what the code suggests it does. The `playwright_*` tools are for web pages only; they do not see native Android UI.

## The loop

1. **Device.** `adb devices` must list one `device` (not `offline`/`unauthorized`). If none is listed, say so and stop; do not try to create a session without one. If the machine provides an emulator launcher (for example `android-up`), use it; otherwise ask the user to start the emulator.
2. **Build + install.** In the Gradle project: `./gradlew installDebug` (builds and installs to the connected device). For an existing APK use `appium_install_app` with its path (`app/build/outputs/apk/debug/app-debug.apk`) or `adb install -r <apk>`. A build failure is the answer for this round: report the compiler error, do not drive a stale build.
3. **Session.** `select_platform` with `platform: "android"`, then `create_session` with `platform: "android"` and capabilities. Add `select_device` only when more than one device is listed.
   ```json
   {"appium:udid": "emulator-5554", "appium:noReset": true}
   ```
   `noReset: true` keeps app data (a logged-in user stays logged in). For a clean first-run state use `"appium:fullReset": true` or `adb shell pm clear <package>` first. The first session on a device installs the UiAutomator2 server on it and is noticeably slower; that is not a hang.
4. **Launch.** `appium_activate_app` with the package (`applicationId` in `app/build.gradle`). Activating a running app only brings it to the front, so after installing a new build call `appium_terminate_app` first, then `appium_activate_app`, or the old process keeps running.
5. **Read the screen.** `generate_locators` returns every interactable element with ready-made locators (`id`, `xpath`, `-android uiautomator`), its text and its `resourceId`. It is cheaper and more exact than a screenshot; use `appium_screenshot` (pass `maxWidth: 400`) when layout or visuals matter, and `appium_get_page_source` only when you need the full hierarchy.
6. **Act.** `appium_find_element` → it answers `Element id <uuid>` → pass that uuid as `elementUUID` to `appium_click`, `appium_set_value`, `appium_get_text`. Locator order of preference:
   - `id` with the full resource id: `com.example.app:id/login_button`
   - `accessibility id` (the view's contentDescription)
   - `-android uiautomator`: `new UiSelector().text("Login")` for views with no id
   - `xpath` last: slow and breaks on layout changes.
7. **Verify.** After each meaningful step read the screen again (`generate_locators` or `appium_get_text`) and check the result you expected. A click that returned OK does not prove the app reacted.
8. **Clean up.** `delete_session` when done. Sessions persist on the shared backend across conversations (`list_sessions` shows them; `select_session` reuses one), so an abandoned session keeps the device busy.

## Element ids expire

An element uuid is valid only until the screen changes. After a navigation, dialog, keyboard opening or list refresh, a click fails with *"not present in the cache or has expired"*: call `appium_find_element` again, do not retry the old uuid.

## Debugging

- **Crash or silent failure:** `adb logcat -d -b crash` for the last crash, `adb logcat -d -t 300 --pid=$(adb shell pidof -s <package>)` for the app's own log. Read the stack trace before changing code.
- **Network/API calls:** filter logcat by the tag the app's HTTP client logs under (find it in the code first; OkHttp's logging interceptor uses `okhttp.OkHttpClient`).
- **Location-based features:** `appium_set_geolocation` with latitude/longitude (and `appium_reset_geolocation` after). The app must hold the location permission; grant it with `adb shell pm grant <package> android.permission.ACCESS_FINE_LOCATION`.
- **Deep links / notifications:** `appium_deep_link`, `appium_mobile_open_notifications`.
- **Back/Home:** `appium_mobile_press_key` with `BACK` or `HOME`.
- **WebView screens:** `appium_get_contexts`, then `appium_switch_context` to the `WEBVIEW_*` context to use web locators; switch back to `NATIVE_APP` afterwards.

## Emulator hazards

- **"System UI isn't responding" / "App isn't responding"** dialogs are common on emulators without a GPU and cover the app. Tap **Wait** (`android:id/aerr_wait`) and carry on; on a development emulator they can usually be suppressed with `adb shell settings put global hide_error_dialogs 1`. They are emulator slowness, not an app bug, unless the named app is yours.
- The software-rendered emulator is slow: allow a few seconds after launches and transitions before reading the screen, and prefer a re-read over a fixed long sleep.

## The user may be watching

The emulator screen is often shown live to the user (for example in herdr-web's embedded view). Say what you are about to do before a long run of taps, and stop driving if the user says they are using the device: input from both sides at once corrupts both.

## If the tools are missing / unreachable

If `select_platform` finds no Android device, the problem is adb or the emulator, not Squire: check `adb devices`. If the `appium_*` tools are absent or the server is unreachable, the shared backend is still provisioning or failed; check `~/.cache/appium-mcp/install-backend.log` and tell the user plainly rather than retrying.
