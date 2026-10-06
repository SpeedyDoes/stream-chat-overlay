# Stream Chat Overlay

A small, see-through chat window that sits on top of your game so you can read chat without alt-tabbing.

- **Only you can see it.** It's left out of screen capture, so Streamlabs/OBS (display, window *and* game capture), screenshots and Discord screen share don't show it.
- **It stays out of your way.** Clicks pass straight through to the game and it never takes focus. Messages fade out after 25 s, so it's empty when chat is quiet.
- **FACEIT stats on stream (optional).** Your level, Elo, and this session's Elo gain/loss, wins/losses and K/D, as a Browser Source for Streamlabs/OBS. Unlike the chat, this part is meant to be seen. No API key needed.
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
| Ctrl+Shift+F11 | Reset the FACEIT session |

You can change these under **Hotkeys** in the settings window. Click a hotkey and press the new combo.

These keys work only in move/resize mode: drag to move, **arrows** resize (hold Shift for bigger steps), **+ / -** change the scale, **0** resets it, and **Esc** or **Enter** finishes.

### YouTube / Kick / other platforms

In the Streamlabs dashboard, go to **All Widgets → Chat Box** and copy the widget URL. Paste it into **Streamlabs chat widget URL** in the settings window. The overlay then shows that widget, styled the way you set it up in Streamlabs, with the same click-through and capture hiding. Keep that URL private.

## FACEIT stats on stream

The app can show a small FACEIT panel **on your stream**: level (with progress to the next level), Elo, and for the current session: Elo gained or lost, wins/losses, K/D and ADR, plus your last 5 results and streak. K/D updates live during a match. No FACEIT developer account or API key is needed.

### 1. Turn it on

Open the settings window, go to the **FACEIT** tab, enter your FACEIT nickname and click **Save**. The status should turn green and show your level and Elo.

### 2. Set up CS2 match stats (for K/D and ADR)

In the same tab, click **Set up** next to **CS2 match stats**. The app finds CS2 through Steam and adds a small config file to CS2's `cfg` folder. If it can't find CS2, it asks you to pick the `Counter-Strike Global Offensive` folder. **Restart CS2 once afterwards**, because CS2 only reads these files at startup. The tab shows "Receiving data from CS2" once it works.

This uses CS2's official **Game State Integration**: CS2 itself sends your kills, deaths and the score to the app on your PC. It's the same thing HUD tools and Logitech/SteelSeries/Razer lighting use, and nothing reads the game. Without it, Elo and W/L still work, but K/D and ADR show "-".

### 3. Add it to Streamlabs

1. In the FACEIT tab, click **Copy** next to **Browser Source URL** (by default `http://127.0.0.1:4545/faceit`).
2. In Streamlabs, click **+** in your scene's Sources, pick **Browser Source**, and paste the URL.
3. Set the size: **680 x 80** for the bar layout, **320 x 260** for the card layout. Then position it like any other source.

The page has a transparent background. **Stream Chat Overlay has to be running** for it to update, so turning on **General > Launch when Windows starts** helps. If the app is closed, the panel keeps showing its last numbers.

Pick **Bar** or **Card** under **Layout**. To use both in different scenes, add `?layout=bar` or `?layout=card` to the end of each source's URL.

### How the numbers are worked out

- **Elo and level** come from the public profile FACEIT's own website loads. The app checks once a minute, and every 15 seconds right after a CS2 match ends.
- **Wins and losses** come from Elo changes. Each time your Elo moves, a FACEIT match just ended: up is a win, down is a loss.
- **K/D and ADR** come from CS2. A finished CS2 match only counts when your FACEIT Elo changes right after it, so Premier, deathmatch and other non-FACEIT games are left out. During a match it counts live (shown as **LIVE**). If no Elo change follows within 15 minutes, that match drops out again.
- A session starts at your Elo when the app first loads your stats. Elo +/- is your current Elo minus that number.
- **A new session starts automatically** after 6 hours without a match (change this under **New session after**; 0 turns it off). Restarting the app or Streamlabs mid-stream keeps the session.
- **Reset it yourself** with **Reset session** in the FACEIT tab, the tray menu, or **Ctrl+Shift+F11**.

Limits:
- The profile endpoint is unofficial. FACEIT could change or block it, and the panel would then stop updating until the app is fixed.
- A match where FACEIT doesn't move your Elo (for example a loss forgiven because a teammate left) isn't counted. An Elo correction from FACEIT would count as a match.
- **Last 5** only includes matches the app saw while it was running.

## Running it

- Start it from the **Start menu** or the **desktop shortcut**. Once it's running it lives in the tray.
- Turn on **General → Launch when Windows starts** and it starts quietly in the tray every time you sign in.
- Uninstall it from **Windows Settings → Apps → Installed apps**.

## Developing

See [DEVELOPMENT.md](DEVELOPMENT.md) for how the app works, how to run it from source, and how to build and release the installer.

## Anti-cheat notes

- **VAC** only bans for software that modifies or reads CS2. This app does neither.
- **FACEIT AC** blocks software it doesn't allow, and it tells you which program to close before you can play. It doesn't silently ban for that. Nobody can promise how FACEIT will treat a given program, so start the overlay, then start FACEIT AC and CS2. If FACEIT ever complains, close the overlay. Don't try to work around it.
- The FACEIT panel uses FACEIT's public profile page data and CS2's official Game State Integration, where CS2 sends the data itself. It never reads CS2 or the FACEIT client.
- Don't add things to this app that read game data, such as health or round timers from memory. That's where real ban risk starts. CS2's official Game State Integration is the allowed way to get that kind of data.

## License

[MIT](LICENSE). It's free to use, change and share. The software comes with no warranty, including about anti-cheat behaviour.
