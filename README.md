# Stream Chat Overlay

A small, see-through chat window that sits on top of your game so you can read chat without alt-tabbing.

- **Only you can see it.** It's left out of screen capture, so Streamlabs/OBS (display, window *and* game capture), screenshots and Discord screen share don't show it.
- **It stays out of your way.** Clicks pass straight through to the game and it never takes focus. Messages fade out after 25 s, so it's empty when chat is quiet.
- **It doesn't touch the game.** It's a normal desktop window like Discord or Spotify. It doesn't inject into CS2, read or write game memory, hook DirectX, or install a driver. Those are the things VAC and FACEIT AC look for.

## Download

Get the latest **`Stream-Chat-Overlay-Setup-<version>.exe`** from the [Releases page](https://github.com/SpeedyDoes/stream-chat-overlay/releases/latest). It needs Windows 10 (version 2004 or newer) or Windows 11.

## Setup

1. Run the installer. It installs for your Windows user only, with no admin prompt, and opens the app when it's done. If Windows shows "Windows protected your PC", click **More info → Run anyway**. That appears because the installer isn't code-signed.
2. In the settings window that opens, enter your Twitch channel and click **Save**.
3. **In CS2, set Video → Display Mode to *Fullscreen Windowed*.** In exclusive *Fullscreen*, the game covers every other window, including this one.
4. Click **Move / resize** (or press **Ctrl+Shift+F9**), drag the overlay where you want it, then press **Esc**.

Look at the Streamlabs preview while the overlay is running. It shouldn't appear there.

## Settings window

- **Minimize** it and it goes to the tray (the purple chat-bubble icon by the clock) while the overlay keeps running. Click the tray icon to bring it back.
- **Close** it and the whole app quits, overlay included.
- Settings are split into tabs: **Overlay, Chat, Appearance, Filters, Hotkeys, General**. A yellow dot marks a tab with unsaved changes.
- The **Overlay** tab (show/hide, move/resize, opacity, scale) applies instantly. Everything else applies when you click **Save** (or press Ctrl+S). Saving reloads the overlay.
- The settings window is hidden from capture too, because it shows your channel and widget URL.
- Turn on **Start minimized to tray** to skip the window on launch. It still opens if something needs your attention, such as no channel being set or a hotkey that's already taken.

Settings are stored in `%APPDATA%\Stream Chat Overlay\config.json`. The overlay's position, opacity and scale are stored in `state.json` in the same folder. Uninstalling keeps them, so a reinstall picks up where you left off.

## Hotkeys

| Keys | Action |
|---|---|
| Ctrl+Shift+F8 | Show / hide |
| Ctrl+Shift+F9 | Move / resize mode |
| Ctrl+Shift+F10 | Cycle opacity (100 / 70 / 45 %) |

You can change these under **Hotkeys** in the settings window. Click a hotkey and press the new combo.

These keys work only in move/resize mode: drag to move, **arrows** resize (hold Shift for bigger steps), **+ / -** change the scale, **0** resets it, and **Esc** or **Enter** finishes.

### YouTube / Kick / other platforms

In the Streamlabs dashboard, go to **All Widgets → Chat Box** and copy the widget URL. Paste it into **Streamlabs chat widget URL** in the settings window. The overlay then shows that widget, styled the way you set it up in Streamlabs, with the same click-through and capture hiding. Keep that URL private.

## Running it

- Start it from the **Start menu** or the **desktop shortcut**. Once it's running it lives in the tray.
- Turn on **General → Launch when Windows starts** and it starts quietly in the tray every time you sign in.
- Uninstall it from **Windows Settings → Apps → Installed apps**.

## Developing

See [DEVELOPMENT.md](DEVELOPMENT.md) for how the app works, how to run it from source, and how to build and release the installer.

## Anti-cheat notes

- **VAC** only bans for software that modifies or reads CS2. This app does neither.
- **FACEIT AC** blocks software it doesn't allow, and it tells you which program to close before you can play. It doesn't silently ban for that. Nobody can promise how FACEIT will treat a given program, so start the overlay, then start FACEIT AC and CS2. If FACEIT ever complains, close the overlay. Don't try to work around it.
- Don't add things to this app that read game data, such as health or round timers from memory. That's where real ban risk starts. CS2's official Game State Integration is the allowed way to get that kind of data.

## License

[MIT](LICENSE). It's free to use, change and share. The software comes with no warranty, including about anti-cheat behaviour.
