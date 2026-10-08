---
name: run-app
description: Launch git-ai in `tauri dev` on Windows and drive its window with Playwright over WebView2's CDP port (click, read text, screenshot, emulate dark mode and narrow widths).
---

# Run and drive git-ai

The window is WebView2, so Playwright can attach to it over CDP. No browser download is needed.

## 1. Free the ports

Only one dev instance can run, because vite needs port 1420. Check for a running instance first:

```powershell
Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
Get-Process git-ai -ErrorAction SilentlyContinue
```

If something is listening and the user started it, ask before stopping it.

## 2. Launch with a debug port

Run this in the background (PowerShell):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'; npm run tauri dev
```

Wait for the endpoint. The first Rust build takes about 2 minutes:

```bash
for i in $(seq 1 240); do curl -s localhost:9222/json/version >/dev/null && break; sleep 1; done
```

Rust edits rebuild and restart the window. The port comes back on its own, so wait for it again. Frontend edits hot-reload.

## 3. Set up the driver

Install `playwright-core` in the scratchpad, not in the repo, and copy the driver next to it:

```bash
cd <scratchpad> && npm init -y >/dev/null && npm i playwright-core
cp <repo>/.claude/skills/run-app/drive.mjs .
```

## 4. Drive the app

Write a snippet file, then run `node drive.mjs s.js shot.png`. Read the PNG to look at the result. A blank frame means the app failed to start.

```js
// s.js: open a repo from Recent, then list its buttons
await page.getByText('C:/Users/itsa4/gitai-play/conflict').click();
await page.waitForTimeout(1500);
return await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).join(' | '));
```

Notes:
- Read dialog text with `document.querySelectorAll('dialog[open]')`. Errors show as a dialog with an OK button.
- Closed dialogs and popovers stay in the DOM. Use `.first()` or `.filter({ visible: true })` to avoid strict-mode errors.
- Open repos from the home screen's Recent list. The Open dialog is native, so Playwright can't use it. The back button on the repo view is labeled "Back to repositories".
- Use `page.emulateMedia({ colorScheme: 'dark' })` for dark mode. This works when the theme is "System".
- For narrow widths, use `(await page.context().newCDPSession(page)).send('Emulation.setDeviceMetricsOverride', { width: 380, height: 800, deviceScaleFactor: 1, mobile: false })`. Below 672 px the sidebar becomes a drawer ("Branches and views"). Clear the override with `Emulation.clearDeviceMetricsOverride`.
- Set up or reset test repos in `~/gitai-play/` with plain git. Check their state with `git status` before testing, because the user may have used them.
- AI features call Gemini, which can return a 503 when busy. Retry once.

## Don't

- Don't create PRs on real GitHub repos, sign out of GitHub, or push to remotes you didn't set up yourself.
- Don't build tests into `src-tauri/target-test`, because the dev watcher sees `src-tauri`. Use `CARGO_TARGET_DIR=<scratchpad>/tt` so tests don't fight the running dev build for the lock.
