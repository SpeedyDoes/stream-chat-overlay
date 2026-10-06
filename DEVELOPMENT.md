# Developer guide

How Stream Chat Overlay works, how to work on it, and how to ship it. User-facing docs are in [README.md](README.md).

## At a glance

- **What it is:** an Electron app for Windows. A transparent, click-through, always-on-top chat window sits over a game. It's hidden from screen capture, so only the streamer sees it. A normal settings window controls it, and a tray icon keeps it running in the background.
- **Stack:** plain JavaScript, HTML and CSS. No framework, no bundler, no runtime dependencies. The only dev dependencies are `electron` and `electron-builder`.
- **Target:** Windows 10 2004+ and Windows 11. Capture exclusion needs 2004+. Nothing has been tested on macOS or Linux.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install Electron and electron-builder |
| `npm start` | Run from source. Logs from the main process print in this terminal |
| `start-overlay.bat` | Same as `npm start`, but detached with no console, and it installs dependencies on first run |
| `npm run icons` | Re-render `assets/icon.ico` and the PNGs from the SVGs |
| `npm run dist` | Build `dist/Stream-Chat-Overlay-Setup-<version>.exe` and delete the leftover build files |

> **Close the installed copy before `npm start`.** Both copies use the same settings folder and the same single-instance lock. If the installed copy is running, the source copy just opens the installed one's settings window and exits, and you end up testing old code.

## Project layout

```
main.js               Main process: windows, tray, hotkeys, config, IPC, startup
preload.js            Bridge for the overlay window   (window.overlay)
overlay.html/.css/.js Overlay page: Twitch chat client + message rendering
settings-preload.js   Bridge for the settings window  (window.settings)
settings.html/.css/.js Settings page: tabs, form, hotkey recorder, live overlay controls
faceit.js             FACEIT tracker (main process): Elo polling, sessions, local web server
gsi.js                CS2 Game State Integration: find CS2, write the cfg, follow matches
faceit-overlay.html/.css/.js  Browser Source page for Streamlabs/OBS, served by faceit.js
assets/               icon.svg (large), icon-small.svg (16 px), generated icon.ico + PNGs
scripts/build-icons.js Renders the SVGs to PNG/ICO using a hidden Electron window
start-overlay.bat     Double-click launcher for running from source
package.json          Scripts + electron-builder config ("build")
dist/                 Build output (installer only). Not source
```

## Architecture

```
                         ┌──────────────── main.js (main process) ────────────────┐
                         │ config + state on disk   global hotkeys   tray menu       │
                         │ sanitizeConfig()         EDIT_KEYS        login item      │
                         └───────┬──────────────────────────┬──────────────────────┘
               overlay:config ▲  │ edit-mode         settings:load/save ▲ │ overlay:state
               overlay:status │  ▼                  overlay:control    │ ▼
                  ┌───────────┴──────────┐           hotkeys:suspend  ┌┴───────────────────┐
                  │ Overlay window       │                            │ Settings window     │
                  │ overlay.html + .js   │                            │ settings.html + .js │
                  │  - or -              │                            └─────────────────────┘
                  │ Streamlabs widget URL│──► wss://irc-ws.chat.twitch.tv (anonymous, read-only)
                  └──────────────────────┘
```

### Windows

**Overlay window** (`createOverlay`). It runs in one of two modes:
- **Twitch mode** (default) loads `overlay.html`. It connects to Twitch IRC itself and renders the messages.
- **Widget mode** is used when `widgetUrl` starts with `https://`. It loads the Streamlabs Chat Box URL directly. No preload script is used, because the page is remote.

**Settings window** (`createSettings`) is a normal framed window.
- Minimizing hides it to the tray.
- Closing it calls `app.quit()`, which also closes the overlay. The `quitting` flag stops the close handler from running again during shutdown.

**Tray.**
- Left-click opens the settings window.
- Right-click opens a menu: show overlay, move/resize, opacity, reset position, quit.
- `updateTray()` rebuilds the menu every time the state changes.

### Overlay window rules (don't break these)

These options are what make the overlay usable over a game and safe with anti-cheat. Each one has a reason:

| Setting | Why |
|---|---|
| `focusable: false` + `setIgnoreMouseEvents(true)` | Clicks go through to the game, and the overlay never takes focus. If it took focus, CS2 would minimize. Always show it with `showInactive()`, never `show()`/`focus()`. |
| `setContentProtection(true)` | Sets `WDA_EXCLUDEFROMCAPTURE`, so OBS/Streamlabs, screenshots and Discord screen share can't see the window. Applied to **both** windows, because the settings window shows the widget URL. |
| `setAlwaysOnTop(true, 'screen-saver')` | The highest z-level. It only works over *Fullscreen Windowed* games, not exclusive fullscreen. |
| `transparent: true`, `frame: false`, `resizable: false` | Transparent frameless windows don't resize reliably, so resizing is done from the keyboard in edit mode. |
| `app.disableHardwareAcceleration()` | A few lines of text don't need the GPU, so the game gets all of it. |
| Never touch the game process | No injection, memory reads, DirectX hooks, drivers or input simulation. That's the whole anti-cheat story. For game data, only use CS2's official Game State Integration. |

### FACEIT stats (`faceit.js`, `gsi.js`)

Unlike the chat overlay, this is **meant to be on stream**. It's not a window: `faceit.js` runs a tiny HTTP server, and Streamlabs/OBS loads its page as a Browser Source. No FACEIT API key is used; FACEIT's developer portal needs company and identity verification.

```
faceit.com/api/users/v1/nicknames/<nick>  <-- poll 60 s (15 s after a match) --+
                                                                               |
CS2 (gamestate_integration_streamchatoverlay.cfg) -- POST /gsi --> faceit.js (main process) -- /faceit, /faceit/data --> Browser Source
                                                                   session + history in state.json                       polls every 5 s
```

- **Elo and level:** `GET https://www.faceit.com/api/users/v1/nicknames/<nick>` is the unauthenticated endpoint faceit.com uses for profiles. It returns `{ payload: { id, nickname, games: { cs2: { faceit_elo, skill_level } } } }`, and 404 for an unknown nickname. It's undocumented, so expect it to change. faceit.com's match-history/stats endpoints sit behind a Cloudflare bot block: **don't try to get around that.**
- **Wins/losses:** every change of `faceit_elo` between polls is one finished FACEIT match (`recordMatch`), up = win. Matches with a 0 Elo change are invisible.
- **K/D, ADR (gsi.js):** `createGameTracker` follows one match from GSI posts. It only uses `player` when `player.steamid === provider.steamid` (while you're dead, CS2 sends the player you spectate). Kills/deaths come from `player.match_stats`. Damage is `player.state.round_totaldmg`, summed whenever it drops (new round). Rounds are `team_ct.score + team_t.score`. `map.phase === 'gameover'` (or leaving to the menu mid-match) reports a finished game.
- **Linking the two:** a finished game waits in `finishedGames` until the next Elo change takes it (`LINK_WINDOW_MS`, 15 min). If the Elo changes first, the game fills in that match's stats when it ends. Waiting games and the live match count towards K/D on the page (`provisional`), so K/D doesn't jump while FACEIT catches up. A game with no Elo change (Premier, DM) drops out after the window.
- **GSI setup:** `findCfgDir()` reads `SteamPath` from `HKCU\Software\Valve\Steam`, then `steamapps/libraryfolders.vdf` for libraries containing app 730. If that fails, the settings window asks for the folder (`cfgDirFromPick` accepts the CS2 folder, `game/csgo` or `cfg`, and checks for `gameinfo.gi`). The cfg holds a random token (`faceitGsi.token` in state.json); posts without it are ignored. The cfg also holds the port, so `configure()` rewrites it when the port changes. CS2 only reads cfgs at startup.
- **State:** `faceitSession` = `{ playerId, startedAt, startElo, lastElo, lastActivityAt, matches[] }`, `faceitHistory` = the last 20 matches across sessions (for Last 5 and the streak), `faceitGsi` = `{ token, cfgPath }`. A new session starts when the stored one is for another player, or when `lastActivityAt` is older than `faceitSessionResetHours`.
- **The server** listens on `127.0.0.1` only. It serves a fixed whitelist (`STATIC`), `/faceit/data` and `POST /gsi`, and nothing else. It's stopped when the nickname is empty, and restarted when the port changes. `EADDRINUSE` is shown as a status error.
- `generation` makes sure a poll that finishes after a config change or reset is dropped.
- **Layout:** `faceitLayout` in config (`bar`/`card`), overridable per source with `?layout=`.
- **Testing:** require `faceit.js` from a plain Node script after replacing `globalThis.fetch` with a fake profile endpoint. Then POST GSI payloads (`provider`, `map`, `player`, `auth.token`) to `/gsi` to play a match. Don't call `installGsi()` in tests: it writes into the real CS2 folder.

### Edit mode (move/resize)

- `setEditing(true)` makes the overlay accept the mouse and injects `EDIT_CSS` with `webContents.insertCSS`. That adds the dashed border, the banner and `-webkit-app-region: drag`. Because it's injected CSS, it also works in widget mode, where we don't control the page.
- **Keys are global shortcuts, not keyboard events.** Windows won't let a background process take keyboard focus (the foreground lock), so `before-input-event` never fires. Instead, `EDIT_KEYS` (arrows, `=`/`-`/`0`, Esc, Enter) are registered with `globalShortcut` while edit mode is on, and unregistered when it ends. Leaving edit mode must always go through `setEditing(false)`, or those keys stay taken system-wide.
- Position is saved when the `moved` event fires, and size is saved on every resize step.

### Hotkeys

- `globalShortcut` uses Win32 `RegisterHotKey`. A registered combo is **taken from every other app**, which is why the defaults are unusual Ctrl+Shift+F-key combos.
- `register()` returns false if another app already owns the combo. Those failures are collected in `failedHotkeys` and shown in the settings window, and the window opens on the Hotkeys tab.
- While the settings window records a new combo, it sends `hotkeys:suspend` so the current combo doesn't fire. It resumes on stop and on window blur, so the hotkeys can't be left switched off.

### IPC

Every handler checks the sender (`fromSettings` / `fromOverlay`), so neither page can call the other one's channels.

| Channel | Direction | Purpose |
|---|---|---|
| `overlay:config` | overlay → main (invoke) | Get the current config |
| `overlay:status` | overlay → main | Connection status (`ok` / `pending` / `error` / `off`), shown in the settings header and tray tooltip |
| `edit-mode` | main → overlay | Show faded messages while editing |
| `settings:load` | settings → main (invoke) | `{ config, configError, failedHotkeys, overlay, faceit, installed }` |
| `settings:save` | settings → main (invoke) | Sanitize, write, re-register hotkeys, update the login item, **recreate the overlay** |
| `overlay:control` | settings → main (invoke) | Instant actions: `visible`, `editing`, `opacity`, `zoom`, `reset` |
| `hotkeys:suspend` | settings → main | Pause/resume global hotkeys while recording |
| `overlay:state` | main → settings | Push `{ visible, editing, opacity, zoom, status }` whenever it changes |
| `faceit:reset` | settings → main (invoke) | Start a new FACEIT session now |
| `faceit:state` | main → settings | Push `{ status, url, gsi, session }` for the FACEIT tab |
| `faceit:gsi` | settings → main (invoke) | `install` (find CS2 or ask for the folder, write the cfg) or `remove` |

Saving **recreates** the overlay window instead of updating it in place. The overlay mode and its preload are fixed when the window is created, and recreating it is simpler and more reliable than patching live state. The new window is created before the old one is destroyed, so the app never has zero windows.

### Twitch chat (`overlay.js`)

- **Connection:** anonymous IRC over WebSocket (`wss://irc-ws.chat.twitch.tv:443`) with `NICK justinfanNNNNN`. That's read-only and needs no token. It requests the `tags` and `commands` capabilities.
- **Messages handled:**
  - `PRIVMSG` is a chat message; `/me` arrives as `\u0001ACTION …\u0001`.
  - `USERNOTICE` covers subs, gifts and raids, using the `system-msg` tag.
  - `CLEARCHAT` and `CLEARMSG` remove messages that mods ban or delete.
  - `PING` gets a `PONG` reply, `RECONNECT` triggers a reconnect, and `NOTICE` is shown as a system line.
- **Emotes:** the `emotes` tag gives positions in Unicode **code points**, so the text is split with `Array.from(text)`, not by string index. Images come from `static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0`. Only Twitch-native emotes are supported, not BTTV, FFZ or 7TV.
- **Reconnects:** exponential backoff capped at 30 s. If no data arrives for 6 minutes (Twitch pings about every 5), the socket is treated as dead and closed.
- **Name colours:** very dark name colours are lightened in `readableColor()`. Users with no colour get one picked from a hash of their name.

### Security model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every window. Pages only see the small APIs exposed by the preloads.
- Strict CSP in both HTML files. The overlay may only connect to Twitch IRC and load images from the Twitch emote CDN. If you add a new host, such as a BTTV/7TV emote CDN, **you must add it to the CSP** in `overlay.html` or it will silently fail.
- Chat text is only ever inserted with `textContent` and DOM nodes. **Never use `innerHTML` with chat content**, because chat is untrusted input.
- `window.open` is denied for every window, and the settings window can't navigate away from its page.

## Data on disk

Everything lives in `%APPDATA%\Stream Chat Overlay\`, which is `app.getPath('userData')`. The folder name comes from `productName`.

| File | Contents | Written when |
|---|---|---|
| `config.json` | Everything on the Chat, Appearance, Filters, FACEIT, Hotkeys and General tabs | Save in the settings window |
| `state.json` | Overlay `bounds`, `opacity`, `zoom`; `faceitSession`, `faceitHistory`, `faceitGsi` | Move, resize, opacity or scale changes; FACEIT session start/reset and new matches |
| Chromium folders (`Cache`, `Local Storage`, …) | Electron's own data. Local Storage remembers the last open settings tab | Automatically |

- **Config is sanitized on every load and save** (`sanitizeConfig`). Unknown keys are dropped, numbers are clamped, and bad values fall back to defaults. If `config.json` can't be parsed, the app runs with defaults and the settings window shows the error.
- **UTF-8 BOMs are stripped before parsing.** PowerShell's `Set-Content -Encoding utf8` and some editors add one, and `JSON.parse` fails on it.
- **Migration from old builds:** builds before the installer kept `config.json`/`state.json` next to `main.js`. `initPaths()` moves them to AppData once, only when running from source.
- **Uninstalling keeps this folder** (`deleteAppDataOnUninstall: false`), so a reinstall keeps the user's settings.
- **To reset to defaults:** quit the app and delete `config.json` (and `state.json` to reset the position).

## Common changes

### Add a setting

1. Add the default to `DEFAULT_CONFIG` in `main.js`.
2. Add it to `sanitizeConfig()` (clamp numbers, check types). If you skip this, the setting is silently dropped on load.
3. Add the control to the right tab panel in `settings.html`. **Its `id` must equal the config key.**
4. Add the key to the matching list at the top of `settings.js`: `TEXT`, `NUMBERS`, `SWITCHES` or `LISTS`. A value that needs conversion (like `messageBackgroundOpacity`, shown as a percentage) needs its own lines in `fill()` and `readForm()`.
5. Use it where it matters: `overlay.js` (it arrives through `getConfig()`) or `main.js`.
6. Update the README if users need to know about it.

Unsaved-change tracking and the per-tab dots work automatically once the field is in `readForm()`.

### Add a settings tab

Add a `<button role="tab" id="tab-x" aria-controls="panel-x">` to `#tabs`, and a `<section class="panel" id="panel-x" role="tabpanel" aria-labelledby="tab-x" hidden>` inside the form. The tab script picks both up automatically.

### Add a hotkey action

1. Add it to `DEFAULT_CONFIG.hotkeys`.
2. Add a handler in `registerHotkeys()`.
3. Add a `.hotkey[data-hotkey=...]` button to the Hotkeys tab.
4. Add an entry to `HOTKEYS` in `settings.js`.

`sanitizeConfig()` copies every key in `DEFAULT_CONFIG.hotkeys` automatically.

### Add a file to the app

**Add it to `build.files` in `package.json`.** That list is a whitelist. A new file left out of it works with `npm start` but is missing from the installed app.

### Change the icon

Edit `assets/icon.svg` for 32 px and up, or `assets/icon-small.svg` for 16–24 px. The small one is drawn on a 16 px grid so the tray icon stays sharp. Then run `npm run icons`. The ICO contains 16, 20, 24, 32, 40, 48, 64, 128 and 256 px images, so Windows can pick a sharp one at any display scaling.

## Building and releasing

1. Bump `"version"` in `package.json`.
2. Run `npm run dist`.
3. Test `dist/Stream-Chat-Overlay-Setup-<version>.exe`. Close the running app, then run the installer over the existing install; it upgrades in place and keeps settings. Then go through the manual test list below.
4. Commit, then publish a GitHub release with **only** the `Setup.exe` attached. The `.blockmap` is only needed for auto-updates:
   ```
   git tag v<version> && git push --tags
   gh release create v<version> "dist/Stream-Chat-Overlay-Setup-<version>.exe" --title "v<version>" --notes "What changed..."
   ```
   The README's Download link always points to the latest release.

How the installer behaves (`build.nsis` in `package.json`):
- **One-click, per-user install:** no wizard and no admin prompt. It installs to `%LOCALAPPDATA%\Programs\stream-chat-overlay\`.
- It creates Start Menu and desktop shortcuts, then launches the app.
- It registers "Stream Chat Overlay <version>" under Windows Settings → Apps, with the publisher taken from `author`.
- **`build.appId` must match `APP_ID` in `main.js`.** The installer stamps it on the shortcuts, and the app sets the same ID (only when installed) so notifications show the right name.
- **Launch at startup** uses `app.setLoginItemSettings` with the name "Stream Chat Overlay" and the `--startup` argument. That writes an entry under `HKCU\…\Run`. The `--startup` argument makes the app start silently in the tray. This only runs when installed (`app.isPackaged`), because from source it would point Windows at the dev `electron.exe`.

### Code signing and SmartScreen

- The installer is **unsigned**. Files downloaded from the internet carry a "Mark of the Web" tag (a `Zone.Identifier` alternate data stream). SmartScreen checks those files and shows *"Windows protected your PC"* for unsigned, unknown programs. Users click **More info → Run anyway**.
- **A locally built installer has no tag, so you won't see the warning yourself.** To see what others see, upload the installer somewhere, download it again, and run that copy.
- **To sign:** get a certificate (Azure Trusted Signing is about $10/month; OV certificates cost a few hundred dollars a year). Then configure `build.win.signtoolOptions` or `azureSignOptions` in electron-builder. The "signing with signtool.exe" lines in today's build log are electron-builder probing for a certificate; nothing is actually signed. Check with `Get-AuthenticodeSignature`.
- Sharing a VirusTotal scan link alongside the installer reassures people for free.

## Testing and debugging

There are no automated tests. Run through this list before a release:

- [ ] Overlay connects; the settings header shows "Connected to #channel"; messages and emotes show up
- [ ] FACEIT tab: status turns green with level and Elo; a wrong nickname shows a clear error
- [ ] CS2 match stats: Set up writes the cfg; after restarting CS2 the tab shows "Receiving data"; Remove deletes it
- [ ] The Browser Source URL shows the panel in Streamlabs (bar and card); K/D shows LIVE in a match; W/L and Elo update within a minute after it
- [ ] Reset session (button, tray, Ctrl+Shift+F11) zeroes the session numbers; restarting the app keeps the session
- [ ] Messages fade after the configured time; deleted and banned messages disappear
- [ ] Ctrl+Shift+F8 / F9 / F10 work, including over CS2 in *Fullscreen Windowed*
- [ ] Edit mode: drag, arrows, Shift+arrows, `+`/`-`/`0`, Esc. Afterwards, arrows work normally in other apps
- [ ] The overlay and settings window are **missing** from a Streamlabs/OBS display capture preview
- [ ] Clicks pass through the overlay, and the game never loses focus
- [ ] Save reloads the overlay; Revert works; tab dots appear and clear
- [ ] A hotkey that's already taken (e.g. one Discord uses) shows the error and opens the Hotkeys tab
- [ ] Minimize goes to the tray; the tray click brings the window back; closing the window quits everything
- [ ] Installer: clean install, upgrade over the old version, uninstall keeps `%APPDATA%\Stream Chat Overlay`
- [ ] Launch at startup: toggle on, sign out and in, and it starts in the tray

Tips:

- **Seeing the windows in screenshots:** capture-hiding also hides them from your own screenshot tools. Turn off **General → Hide from stream & screenshots** while testing, and turn it back on afterwards.
- **DevTools:** the windows have no menu. Temporarily add `win.webContents.openDevTools({ mode: 'detach' })` after the window is created. In the overlay, DevTools is the only way to see renderer errors.
- **Main-process logs:** run `npm start` from a terminal. `start-overlay.bat` detaches, so its output is lost.
- **Testing the overlay without Twitch:** temporarily point `twitchChannel` at any busy live channel. Reading chat is anonymous and harmless.
- **Previewing the settings UI without the app:** load `settings.html` in a hidden window with `webPreferences.offscreen: true`, and use a preload that defines a fake `window.settings` returning sample data. Grab frames from the `paint` event. Hidden on-screen windows often never paint, and `capturePage()` on them can hang.

## Known quirks

| Symptom | Cause / fix |
|---|---|
| Overlay doesn't show over CS2 | The game is in exclusive *Fullscreen*. Switch to *Fullscreen Windowed* |
| Settings window starts minimized to the tray | The process was started with a "minimized" or "hidden" window style, such as a shortcut set to *Run: Minimized* or `Start-Process` from a script. Windows applies it to the first window shown. Use `-WindowStyle Normal` |
| Launching does nothing | Another copy is already running (single-instance lock). It brings up that copy's settings window instead |
| Start menu search finds the app before you've installed it | Windows indexes `Documents`, so it finds `dist/win-unpacked`. `npm run dist` now deletes that folder |
| `node_modules/electron/dist/electron.exe` missing after `npm install` | npm is configured with `ignore-scripts`. Run `node node_modules/electron/install.js` (the `.bat` does this) |
| Notification titled "Electron" | Running from source, where no AppUserModelID is set. The installed app sets `APP_ID` to match its shortcuts, so it should show "Stream Chat Overlay" (not yet confirmed) |
| Config change ignored | The key is missing from `sanitizeConfig()`, or the file has a parse error (shown in the settings footer) |
| Chromium "Unable to move the cache" errors in the log | Two copies started with the same profile. They're harmless, but usually mean the single-instance case above |

## Ideas for later

- **Auto-update:** publish releases on GitHub and add `electron-updater`. electron-builder already generates the `.blockmap` it needs.
- **Third-party emotes:** fetch BTTV, FFZ and 7TV emote sets per channel, and add their CDNs to the CSP.
- **Native Kick or YouTube chat**, instead of relying on the Streamlabs widget.
- **Multiple channels** at once, e.g. when co-streaming.
- **Code signing**, to remove the SmartScreen warning.
- **A setup wizard installer:** set `nsis.oneClick: false` and `allowToChangeInstallationDirectory: true`.

## Repository

- **Hosted at** https://github.com/SpeedyDoes/stream-chat-overlay, under the MIT license.
- **Not committed** (see `.gitignore`): `node_modules/`, `dist/`, and stray `config.json`/`state.json`. Installers are published as GitHub release assets, not committed.
- **Commit email:** this repo commits with the GitHub no-reply address. It's set in the repo-local git config so your personal email stays out of the public history. A fresh clone needs `git config user.email "80622063+SpeedyDoes@users.noreply.github.com"` before committing.
