'use strict';
// Stream chat overlay: a plain, separate desktop window. It never touches the game process
// (no injection, no memory access, no DirectX hooks, no drivers), which is what keeps it
// anti-cheat friendly. It is click-through, never takes focus, and is excluded from capture.
// A normal settings window controls it; minimizing that hides to the tray, closing it quits.

const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeTheme, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Must match "build.appId" in package.json; the installer's shortcuts use it too.
const APP_ID = 'com.speedydoes.streamchatoverlay';
const LOGIN_ITEM_NAME = 'Stream Chat Overlay';
// Launched by Windows at sign-in (see applyLaunchAtStartup): start quietly in the tray.
const STARTUP_ARG = '--startup';

// Set in initPaths(): settings live in %APPDATA%\Stream Chat Overlay, because the install
// folder is read-only and every user (and every friend) needs their own.
let CONFIG_PATH;
let STATE_PATH;
// Multi-size .ico so Windows picks a sharp size for the tray, title bar and taskbar.
// Regenerate from assets/icon.svg with `npm run icons`.
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

const DEFAULT_CONFIG = {
  twitchChannel: '',
  widgetUrl: '',
  fadeAfterSeconds: 25,
  maxMessages: 14,
  fontSize: 15,
  messageBackgroundOpacity: 0.45,
  showEmotes: true,
  hideCommands: true,
  ignoreUsers: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot'],
  highlightWords: [],
  showSubsAndRaids: true,
  hideFromCapture: true,
  startMinimized: false,
  launchAtStartup: false,
  hotkeys: {
    toggleVisible: 'Control+Shift+F8',
    editMode: 'Control+Shift+F9',
    cycleOpacity: 'Control+Shift+F10',
  },
};

const OPACITY_STEPS = [1, 0.7, 0.45];
const MIN_W = 160;
const MIN_H = 80;

const EDIT_CSS = `
html {
  background: rgba(15, 15, 20, 0.6) !important;
  outline: 2px dashed #a78bfa !important;
  outline-offset: -2px;
  -webkit-app-region: drag;
  cursor: move;
}
html::before {
  content: 'EDIT MODE \\00B7  drag to move \\00B7  arrows = resize \\00B7  + / - = scale \\00B7  Esc = done';
  position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0;
  padding: 6px 8px; color: #fff; background: #6d28d9;
  font: 600 11px/1.3 'Segoe UI', sans-serif;
}
`;

let config;
let configError = null;
let state;
let overlayWin;
let settingsWin;
let tray;
let overlayVisible = true;
let editing = false;
let editCssKey = null;
let status = { kind: 'pending', text: 'Starting...' };
let registeredHotkeys = [];
let failedHotkeys = [];
let quitting = false;
let trayHintShown = false;

// ---------- config & state ----------

function readJson(file) {
  // Some editors (and PowerShell) save UTF-8 with a BOM, which JSON.parse rejects.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === '' || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function toList(value) {
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function sanitizeConfig(input = {}) {
  const d = DEFAULT_CONFIG;
  const bool = (key) => (typeof input[key] === 'boolean' ? input[key] : d[key]);
  const hotkeys = { ...d.hotkeys };
  for (const key of Object.keys(hotkeys)) {
    if (input.hotkeys && typeof input.hotkeys[key] === 'string') hotkeys[key] = input.hotkeys[key].trim();
  }
  return {
    twitchChannel: String(input.twitchChannel ?? d.twitchChannel).trim(),
    widgetUrl: String(input.widgetUrl ?? d.widgetUrl).trim(),
    fadeAfterSeconds: clampNumber(input.fadeAfterSeconds, 0, 600, d.fadeAfterSeconds),
    maxMessages: Math.round(clampNumber(input.maxMessages, 1, 50, d.maxMessages)),
    fontSize: clampNumber(input.fontSize, 8, 48, d.fontSize),
    messageBackgroundOpacity: clampNumber(input.messageBackgroundOpacity, 0, 1, d.messageBackgroundOpacity),
    showEmotes: bool('showEmotes'),
    hideCommands: bool('hideCommands'),
    ignoreUsers: Array.isArray(input.ignoreUsers) ? toList(input.ignoreUsers).map((u) => u.toLowerCase()) : d.ignoreUsers,
    highlightWords: Array.isArray(input.highlightWords) ? toList(input.highlightWords) : d.highlightWords,
    showSubsAndRaids: bool('showSubsAndRaids'),
    hideFromCapture: bool('hideFromCapture'),
    startMinimized: bool('startMinimized'),
    launchAtStartup: bool('launchAtStartup'),
    hotkeys,
  };
}

function initPaths() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  CONFIG_PATH = path.join(dir, 'config.json');
  STATE_PATH = path.join(dir, 'state.json');

  // One-time move from the project folder, where earlier versions kept these files.
  if (app.isPackaged) return;
  for (const file of ['config.json', 'state.json']) {
    const legacy = path.join(__dirname, file);
    const target = path.join(dir, file);
    if (fs.existsSync(legacy) && !fs.existsSync(target)) {
      fs.copyFileSync(legacy, target);
      fs.unlinkSync(legacy);
    }
  }
}

// Only the installed app registers itself; a dev copy would point Windows at the wrong exe.
function applyLaunchAtStartup() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ name: LOGIN_ITEM_NAME, openAtLogin: config.launchAtStartup, args: [STARTUP_ARG] });
}

function writeConfig(value) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    writeConfig(DEFAULT_CONFIG);
    return sanitizeConfig({});
  }
  try {
    return sanitizeConfig(readJson(CONFIG_PATH));
  } catch (err) {
    configError = err.message;
    return sanitizeConfig({});
  }
}

function loadState() {
  try {
    return readJson(STATE_PATH);
  } catch {
    return {};
  }
}

function saveState() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  state.bounds = overlayWin.getBounds();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function isWidgetMode() {
  return /^https:\/\//i.test(config.widgetUrl);
}

// ---------- overlay window ----------

// Left edge, between the CS2 radar (top-left) and the in-game chat/health (bottom-left).
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    width: Math.round(wa.width * 0.19),
    height: Math.round(wa.height * 0.28),
    x: wa.x + 12,
    y: wa.y + Math.round(wa.height * 0.33),
  };
}

function isOnScreen(b) {
  return screen.getAllDisplays().some(({ workArea: d }) =>
    b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y);
}

function overlayState() {
  return { visible: overlayVisible, editing, opacity: state.opacity ?? 1, zoom: state.zoom || 1, status };
}

function pushState() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('overlay:state', overlayState());
  updateTray();
}

function setStatus(kind, text) {
  status = { kind, text };
  pushState();
}

function createOverlay() {
  const bounds = state.bounds && isOnScreen(state.bounds) ? state.bounds : defaultBounds();
  const widgetMode = isWidgetMode();

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: widgetMode ? undefined : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWin = win;

  win.setAlwaysOnTop(true, 'screen-saver');
  // WDA_EXCLUDEFROMCAPTURE: the window is visible on your monitor but absent from
  // Streamlabs/OBS display capture, screenshots, Discord screen share, etc.
  win.setContentProtection(config.hideFromCapture);
  win.setIgnoreMouseEvents(true);
  win.setOpacity(OPACITY_STEPS.includes(state.opacity) ? state.opacity : 1);

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(state.zoom || 1));
  win.on('moved', saveState);
  win.once('ready-to-show', () => {
    if (overlayVisible) win.showInactive();
  });

  if (widgetMode) {
    setStatus('pending', 'Loading Streamlabs widget...');
    win.webContents.on('did-finish-load', () => setStatus('ok', 'Showing Streamlabs chat widget'));
    win.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) setStatus('error', `Widget failed to load (${description})`);
    });
    win.loadURL(config.widgetUrl);
  } else {
    win.loadFile(path.join(__dirname, 'overlay.html'));
  }
}

function recreateOverlay() {
  if (editing) {
    editing = false;
    editCssKey = null;
    setEditKeys(false);
  }
  saveState();
  const old = overlayWin;
  createOverlay();
  old.destroy();
  pushState();
}

function setVisible(on) {
  overlayVisible = on;
  if (on) {
    overlayWin.showInactive();
  } else {
    if (editing) setEditing(false);
    overlayWin.hide();
  }
  pushState();
}

async function setEditing(on) {
  if (on === editing) return;
  editing = on;
  if (on) {
    if (!overlayVisible) setVisible(true);
    overlayWin.setIgnoreMouseEvents(false);
    overlayWin.setFocusable(true);
    setEditKeys(true);
    pushState();
    editCssKey = await overlayWin.webContents.insertCSS(EDIT_CSS);
  } else {
    setEditKeys(false);
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.setFocusable(false);
    pushState();
    if (editCssKey) await overlayWin.webContents.removeInsertedCSS(editCssKey);
    editCssKey = null;
    saveState();
  }
  overlayWin.webContents.send('edit-mode', on);
}

function setZoom(zoom) {
  state.zoom = Math.min(2, Math.max(0.5, Math.round(zoom * 10) / 10));
  overlayWin.webContents.setZoomFactor(state.zoom);
  saveState();
  pushState();
}

function setOpacity(opacity) {
  if (!OPACITY_STEPS.includes(opacity)) return;
  state.opacity = opacity;
  overlayWin.setOpacity(opacity);
  saveState();
  pushState();
}

function cycleOpacity() {
  const i = OPACITY_STEPS.indexOf(state.opacity ?? 1);
  setOpacity(OPACITY_STEPS[(i + 1) % OPACITY_STEPS.length]);
}

function resetPosition() {
  overlayWin.setBounds(defaultBounds());
  saveState();
}

function resizeBy(dw, dh) {
  const b = overlayWin.getBounds();
  b.width = Math.max(MIN_W, b.width + dw);
  b.height = Math.max(MIN_H, b.height + dh);
  overlayWin.setBounds(b);
  saveState();
}

// ---------- hotkeys ----------

// Windows won't let a background app grab keyboard focus, so edit-mode keys are registered
// as global shortcuts for as long as edit mode is on, then released again.
const EDIT_KEYS = {
  Right: () => resizeBy(10, 0),
  Left: () => resizeBy(-10, 0),
  Down: () => resizeBy(0, 10),
  Up: () => resizeBy(0, -10),
  'Shift+Right': () => resizeBy(50, 0),
  'Shift+Left': () => resizeBy(-50, 0),
  'Shift+Down': () => resizeBy(0, 50),
  'Shift+Up': () => resizeBy(0, -50),
  '=': () => setZoom((state.zoom || 1) + 0.1),
  Plus: () => setZoom((state.zoom || 1) + 0.1),
  '-': () => setZoom((state.zoom || 1) - 0.1),
  '0': () => setZoom(1),
  Escape: () => setEditing(false),
  Enter: () => setEditing(false),
};

function setEditKeys(on) {
  for (const [accelerator, handler] of Object.entries(EDIT_KEYS)) {
    if (on) globalShortcut.register(accelerator, handler);
    else globalShortcut.unregister(accelerator);
  }
}

function unregisterHotkeys() {
  for (const accelerator of registeredHotkeys) globalShortcut.unregister(accelerator);
  registeredHotkeys = [];
}

function registerHotkeys() {
  unregisterHotkeys();
  const actions = {
    toggleVisible: () => setVisible(!overlayVisible),
    editMode: () => setEditing(!editing),
    cycleOpacity,
  };
  const failed = [];
  for (const [name, handler] of Object.entries(actions)) {
    const accelerator = config.hotkeys[name];
    if (!accelerator) continue;
    try {
      if (globalShortcut.register(accelerator, handler)) registeredHotkeys.push(accelerator);
      else failed.push(accelerator);
    } catch {
      failed.push(accelerator);
    }
  }
  return failed;
}

// ---------- settings window ----------

function createSettings(show) {
  settingsWin = new BrowserWindow({
    width: 580,
    height: 680,
    minWidth: 500,
    minHeight: 460,
    show: false,
    title: 'Stream Chat Overlay',
    icon: ICON_PATH,
    backgroundColor: '#15151b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.removeMenu();
  // Shows your widget URL and channel, so keep it off stream too.
  settingsWin.setContentProtection(config.hideFromCapture);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());

  settingsWin.on('minimize', () => {
    settingsWin.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      tray.displayBalloon({
        title: 'Still running in the tray',
        content: 'The overlay keeps running. Click the tray icon to reopen settings.',
        icon: path.join(__dirname, 'assets', 'icon-256.png'),
      });
    }
  });
  settingsWin.on('close', () => {
    if (!quitting) app.quit();
  });

  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  if (show) settingsWin.once('ready-to-show', () => settingsWin.show());
}

function showSettings() {
  settingsWin.show();
  settingsWin.restore();
  settingsWin.focus();
}

// ---------- tray ----------

function hotkeyHint(accelerator) {
  return accelerator ? `   (${accelerator.replace(/Control/g, 'Ctrl')})` : '';
}

function updateTray() {
  if (!tray || !overlayWin) return;
  tray.setToolTip(`Stream Chat Overlay: ${status.text}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open settings', click: showSettings },
    { type: 'separator' },
    {
      label: `Show overlay${hotkeyHint(config.hotkeys.toggleVisible)}`,
      type: 'checkbox',
      checked: overlayVisible,
      click: () => setVisible(!overlayVisible),
    },
    {
      label: `Move / resize${hotkeyHint(config.hotkeys.editMode)}`,
      type: 'checkbox',
      checked: editing,
      click: () => setEditing(!editing),
    },
    {
      label: `Opacity${hotkeyHint(config.hotkeys.cycleOpacity)}`,
      submenu: OPACITY_STEPS.map((o) => ({
        label: `${Math.round(o * 100)}%`,
        type: 'radio',
        checked: (state.opacity ?? 1) === o,
        click: () => setOpacity(o),
      })),
    },
    { label: 'Reset position', click: resetPosition },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ---------- IPC ----------

const fromSettings = (event) => settingsWin && event.sender === settingsWin.webContents;
const fromOverlay = (event) => overlayWin && event.sender === overlayWin.webContents;

function registerIpc() {
  ipcMain.handle('overlay:config', (event) => (fromOverlay(event) ? config : null));
  ipcMain.on('overlay:status', (event, s) => {
    if (fromOverlay(event) && s) setStatus(String(s.kind), String(s.text));
  });

  ipcMain.handle('settings:load', (event) => {
    if (!fromSettings(event)) return null;
    return { config, configError, failedHotkeys, overlay: overlayState(), installed: app.isPackaged };
  });

  ipcMain.handle('settings:save', (event, input) => {
    if (!fromSettings(event)) return null;
    config = sanitizeConfig(input);
    configError = null;
    writeConfig(config);
    applyLaunchAtStartup();
    failedHotkeys = registerHotkeys();
    settingsWin.setContentProtection(config.hideFromCapture);
    recreateOverlay();
    return { config, failedHotkeys };
  });

  ipcMain.handle('overlay:control', (event, action, value) => {
    if (!fromSettings(event)) return;
    if (action === 'visible') setVisible(Boolean(value));
    else if (action === 'editing') setEditing(Boolean(value));
    else if (action === 'opacity') setOpacity(Number(value));
    else if (action === 'zoom') setZoom(Number(value));
    else if (action === 'reset') resetPosition();
  });

  // Lets the settings window record a new combo without the current one firing.
  ipcMain.on('hotkeys:suspend', (event, on) => {
    if (!fromSettings(event)) return;
    if (on) unregisterHotkeys();
    else failedHotkeys = registerHotkeys();
  });
}

// ---------- app ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Software rendering: a few lines of text don't need the GPU, so leave it all to the game.
  app.disableHardwareAcceleration();
  nativeTheme.themeSource = 'dark';

  if (app.isPackaged) app.setAppUserModelId(APP_ID);

  app.on('second-instance', (_event, argv) => {
    if (!argv.includes(STARTUP_ARG)) showSettings();
  });

  app.whenReady().then(() => {
    initPaths();
    config = loadConfig();
    state = loadState();
    applyLaunchAtStartup();
    registerIpc();

    tray = new Tray(ICON_PATH);
    tray.on('click', showSettings);

    createOverlay();
    failedHotkeys = registerHotkeys();

    const quiet = config.startMinimized || process.argv.includes(STARTUP_ARG);
    const needsSetup = !config.twitchChannel && !isWidgetMode();
    createSettings(!quiet || needsSetup || Boolean(configError) || failedHotkeys.length > 0);
    updateTray();
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
