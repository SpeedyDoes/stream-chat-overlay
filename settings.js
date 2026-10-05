'use strict';

const api = window.settings;
const $ = (id) => document.getElementById(id);

const TEXT = ['twitchChannel', 'widgetUrl'];
const NUMBERS = ['fontSize', 'fadeAfterSeconds', 'maxMessages'];
const SWITCHES = ['showEmotes', 'showSubsAndRaids', 'hideCommands', 'hideFromCapture', 'launchAtStartup', 'startMinimized'];
const LISTS = ['ignoreUsers', 'highlightWords'];
const HOTKEYS = { toggleVisible: 'Show / hide', editMode: 'Move / resize', cycleOpacity: 'Cycle opacity' };
const HOTKEY_HELP = 'Click a hotkey, then press the new combo. Backspace clears it, Esc cancels.';

let saved = null;
let snapshot = '';
let notice = null;
let noticeTimer;
let overlay = { visible: true, editing: false, opacity: 1, zoom: 1 };
let recording = null;

// ---------- form <-> config ----------

const splitList = (text) => text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const hotkeyButton = (name) => document.querySelector(`.hotkey[data-hotkey="${name}"]`);
const prettyKeys = (accelerator) =>
  accelerator.split('+').map((k) => ({ Control: 'Ctrl', Super: 'Win' })[k] || k);

function fill(config) {
  saved = config;
  for (const k of TEXT) $(k).value = config[k];
  for (const k of NUMBERS) $(k).value = config[k];
  for (const k of SWITCHES) $(k).checked = config[k];
  for (const k of LISTS) $(k).value = config[k].join(', ');
  $('messageBackgroundOpacity').value = Math.round(config.messageBackgroundOpacity * 100);
  for (const name of Object.keys(HOTKEYS)) setHotkey(hotkeyButton(name), config.hotkeys[name]);
  for (const name of Object.keys(HOTKEYS)) {
    const accelerator = config.hotkeys[name];
    $(`hint-${name}`).textContent = accelerator ? `Hotkey: ${prettyKeys(accelerator).join('+')}` : '';
  }
  snapshot = JSON.stringify(readForm());
  refresh();
}

function readForm() {
  const config = { hotkeys: {} };
  for (const k of TEXT) config[k] = $(k).value.trim();
  for (const k of NUMBERS) config[k] = $(k).value === '' ? null : Number($(k).value);
  for (const k of SWITCHES) config[k] = $(k).checked;
  for (const k of LISTS) config[k] = splitList($(k).value);
  config.messageBackgroundOpacity = Number($('messageBackgroundOpacity').value) / 100;
  for (const name of Object.keys(HOTKEYS)) config.hotkeys[name] = hotkeyButton(name).dataset.value;
  return config;
}

const panelOf = (element) => element.closest('[role=tabpanel]').id;

// Which tabs hold fields that differ from what's saved.
function dirtyPanels() {
  const current = readForm();
  const base = JSON.parse(snapshot);
  const panels = new Set();
  for (const key of Object.keys(current)) {
    if (key === 'hotkeys') {
      for (const name of Object.keys(HOTKEYS)) {
        if (current.hotkeys[name] !== base.hotkeys[name]) panels.add(panelOf(hotkeyButton(name)));
      }
    } else if (JSON.stringify(current[key]) !== JSON.stringify(base[key])) {
      panels.add(panelOf($(key)));
    }
  }
  return panels;
}

function refresh() {
  const panels = dirtyPanels();
  for (const tab of tabs) tab.classList.toggle('dirty', panels.has(tab.getAttribute('aria-controls')));
  const dirty = panels.size > 0;
  $('save').disabled = !dirty;
  $('revert').disabled = !dirty;

  const line = dirty ? { kind: 'dirty', text: 'Unsaved changes' } : notice || { kind: '', text: 'All changes saved' };
  $('saveState').className = line.kind;
  $('saveState').textContent = line.text;

  $('bgOut').textContent = `${$('messageBackgroundOpacity').value}%`;
  $('captureWarning').classList.toggle('hidden', $('hideFromCapture').checked);
  $('widgetNote').classList.toggle('hidden', !/^https:\/\//i.test($('widgetUrl').value.trim()));
}

function setNotice(kind, text, timeout) {
  clearTimeout(noticeTimer);
  notice = { kind, text };
  if (timeout) noticeTimer = setTimeout(() => { notice = null; refresh(); }, timeout);
  refresh();
}

async function save() {
  if ($('save').disabled) return;
  if (recording) stopRecording();
  $('save').disabled = true;
  const result = await api.save(readForm());
  fill(result.config);
  if (result.failedHotkeys.length) {
    const keys = result.failedHotkeys.map((a) => prettyKeys(a).join('+')).join(', ');
    setNotice('error', `Saved, but ${keys} is already used by another app. Pick a different hotkey.`);
  } else {
    setNotice('ok', 'Saved. Overlay reloaded.', 4000);
  }
}

// ---------- hotkey recorder ----------

const CODE_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Tab: 'Tab', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec', Pause: 'Pause', ScrollLock: 'Scrolllock',
};

function keyFromCode(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

function setHotkey(button, value) {
  button.dataset.value = value || '';
  button.replaceChildren();
  button.classList.toggle('unset', !value);
  if (!value) {
    button.textContent = 'Not set';
    return;
  }
  for (const key of prettyKeys(value)) {
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    button.append(kbd);
  }
}

function setHotkeyHelp(text, isError) {
  $('hotkeyHelp').textContent = text;
  $('hotkeyHelp').classList.toggle('error', Boolean(isError));
}

function startRecording(button) {
  if (recording) stopRecording();
  recording = button;
  button.classList.add('recording');
  button.replaceChildren('Press a key combo...');
  setHotkeyHelp(HOTKEY_HELP);
  api.suspendHotkeys(true);
}

function stopRecording() {
  const button = recording;
  recording = null;
  button.classList.remove('recording');
  setHotkey(button, button.dataset.value);
  api.suspendHotkeys(false);
  refresh();
}

function onRecordKey(event) {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') return stopRecording();
  if (event.key === 'Backspace') {
    recording.dataset.value = '';
    return stopRecording();
  }

  const key = keyFromCode(event.code);
  if (!key) return; // only a modifier so far

  const mods = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (!mods.length && !/^F\d+$/.test(key)) {
    setHotkeyHelp('Add Ctrl, Alt or Shift, or use an F-key, so it doesn\'t clash with game keys.', true);
    return;
  }

  const accelerator = [...mods, key].join('+');
  const clash = Object.keys(HOTKEYS).find((name) =>
    hotkeyButton(name) !== recording && hotkeyButton(name).dataset.value === accelerator);
  if (clash) {
    setHotkeyHelp(`${prettyKeys(accelerator).join('+')} is already used for "${HOTKEYS[clash]}".`, true);
    return;
  }

  recording.dataset.value = accelerator;
  setHotkeyHelp(HOTKEY_HELP);
  stopRecording();
}

// ---------- tabs ----------

const tabs = [...document.querySelectorAll('#tabs [role=tab]')];

function selectTab(tab, focus) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
  try {
    localStorage.setItem('tab', tab.id);
  } catch {
    // storage unavailable; the first tab is a fine default
  }
}

for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab));

$('tabs').addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i === -1) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(tabs[(next + tabs.length) % tabs.length], true);
});

function initialTab() {
  try {
    return $(localStorage.getItem('tab')) || tabs[0];
  } catch {
    return tabs[0];
  }
}

// ---------- live overlay controls ----------

function applyOverlayState(next) {
  overlay = next;
  $('ovVisible').checked = next.visible;
  $('ovEdit').textContent = next.editing ? 'Done' : 'Move / resize';
  $('ovEdit').classList.toggle('active', next.editing);
  for (const button of $('ovOpacity').querySelectorAll('button')) {
    button.classList.toggle('active', Number(button.dataset.v) === next.opacity);
  }
  if (document.activeElement !== $('ovZoom')) $('ovZoom').value = Math.round(next.zoom * 100);
  $('ovZoomOut').textContent = `${Math.round(next.zoom * 100)}%`;
  if (next.status) {
    $('status').className = `status ${next.status.kind}`;
    $('statusText').textContent = next.status.text;
  }
}

$('ovVisible').addEventListener('change', (e) => api.overlay('visible', e.target.checked));
$('ovEdit').addEventListener('click', () => api.overlay('editing', !overlay.editing));
$('ovReset').addEventListener('click', () => api.overlay('reset'));
$('ovOpacity').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) api.overlay('opacity', Number(button.dataset.v));
});
$('ovZoom').addEventListener('input', (e) => {
  $('ovZoomOut').textContent = `${e.target.value}%`;
  api.overlay('zoom', Number(e.target.value) / 100);
});

// ---------- wiring ----------

$('config').addEventListener('input', refresh);
$('config').addEventListener('change', refresh);
$('config').addEventListener('submit', (e) => {
  e.preventDefault();
  save();
});
$('save').addEventListener('click', save);
$('revert').addEventListener('click', () => {
  if (recording) stopRecording();
  fill(saved);
});
for (const name of Object.keys(HOTKEYS)) {
  hotkeyButton(name).addEventListener('click', (e) => startRecording(e.currentTarget));
}

window.addEventListener('keydown', onRecordKey, true);
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});
// Never leave the global hotkeys switched off because the window lost focus mid-recording.
window.addEventListener('blur', () => {
  if (recording) stopRecording();
});

selectTab(initialTab());

(async () => {
  const data = await api.load();
  if (!data.installed) {
    $('launchAtStartup').disabled = true;
    $('startupHint').textContent = 'Only available in the installed app';
  }
  fill(data.config);
  applyOverlayState(data.overlay);
  api.onOverlayState(applyOverlayState);

  if (data.configError) {
    setNotice('error', `config.json couldn't be read (${data.configError}). Showing defaults; Save overwrites it.`);
  } else if (data.failedHotkeys.length) {
    const keys = data.failedHotkeys.map((a) => prettyKeys(a).join('+')).join(', ');
    setNotice('error', `${keys} is already used by another app. Pick a different hotkey.`);
    selectTab($('tab-hotkeys'));
  }
  if (!data.config.twitchChannel && !data.config.widgetUrl) {
    selectTab($('tab-chat'));
    $('twitchChannel').focus();
  }
})();
