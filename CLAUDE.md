# Stream Chat Overlay

Electron app for Windows: a click-through chat overlay that's hidden from capture, plus a settings window and a tray icon. Read [DEVELOPMENT.md](DEVELOPMENT.md) before making changes. It covers the architecture, IPC, data locations and release process.

Rules that are easy to break:
- The overlay window must never take focus or touch the game process. That's what keeps it anti-cheat safe; see "Overlay window rules" in DEVELOPMENT.md.
- New settings need `DEFAULT_CONFIG` + `sanitizeConfig()` in `main.js`, and a field whose `id` equals the key in `settings.html` + `settings.js`.
- New app files must be added to `build.files` in `package.json`, or they're missing from the installer.
- Chat text is untrusted. Only insert it with `textContent`, never `innerHTML`.
- `APP_ID` in `main.js` must match `build.appId` in `package.json`.
- Settings live in `%APPDATA%\Stream Chat Overlay\`. The installed app and `npm start` share them and a single-instance lock, so close the installed copy before running from source.
- Both windows are hidden from screen capture, so screenshots won't show them. Turn off "Hide from stream & screenshots" in the General tab while testing visually.
