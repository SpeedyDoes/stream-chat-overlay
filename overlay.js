'use strict';
// Reads Twitch chat anonymously (read-only "justinfan" login, no account or token needed).

const TWITCH_IRC = 'wss://irc-ws.chat.twitch.tv:443';
const DEFAULT_COLORS = ['#ff7f50', '#1e90ff', '#00ff7f', '#9acd32', '#daa520', '#ff69b4', '#5f9ea0', '#b88cff', '#d2691e', '#ff4500'];

const chat = document.getElementById('chat');
let config;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function add(node, { persistent = false } = {}) {
  chat.appendChild(node);
  while (chat.children.length > config.maxMessages) chat.firstElementChild.remove();
  if (!persistent && config.fadeAfterSeconds > 0) {
    setTimeout(() => node.classList.add('faded'), config.fadeAfterSeconds * 1000);
  }
}

function addSystem(text, options) {
  add(el('div', 'msg system', text), options);
}

function hash(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// Twitch lets people pick very dark name colours; lift those so they stay readable.
function readableColor(hex, login) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return DEFAULT_COLORS[hash(login) % DEFAULT_COLORS.length];
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  if (luminance >= 100) return hex;
  const mix = 0.55;
  return `rgb(${rgb.map((c) => Math.round(c + (255 - c) * mix)).join(',')})`;
}

// emotes tag looks like "25:0-4,12-16/1902:6-10"; positions are in code points.
function renderText(target, text, emotesTag) {
  const chars = Array.from(text);
  const ranges = [];
  for (const part of (emotesTag || '').split('/')) {
    const [id, positions] = part.split(':');
    if (!id || !positions) continue;
    for (const range of positions.split(',')) {
      const [start, end] = range.split('-').map(Number);
      if (Number.isInteger(start) && Number.isInteger(end)) ranges.push({ id, start, end });
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  let i = 0;
  for (const { id, start, end } of ranges) {
    if (start < i) continue;
    if (start > i) target.append(chars.slice(i, start).join(''));
    const img = el('img', 'emote');
    img.alt = chars.slice(start, end + 1).join('');
    img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`;
    target.append(img);
    i = end + 1;
  }
  if (i < chars.length) target.append(chars.slice(i).join(''));
}

function parseIrc(line) {
  const msg = { tags: {}, prefix: '', command: '', params: [], trailing: '' };
  let rest = line;
  if (rest[0] === '@') {
    const space = rest.indexOf(' ');
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      msg.tags[key] = value.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
    }
    rest = rest.slice(space + 1);
  }
  if (rest[0] === ':') {
    const space = rest.indexOf(' ');
    msg.prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  const trailingAt = rest.indexOf(' :');
  if (trailingAt !== -1) {
    msg.trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  [msg.command, ...msg.params] = rest.split(' ');
  return msg;
}

function startTwitch(channel, highlightWords, ignoreUsers) {
  let ws;
  let retries = 0;
  let lastData = Date.now();
  let joinedOnce = false;

  function showChat(tags, login, text) {
    let action = false;
    if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) {
      action = true;
      text = text.slice(8, -1);
    }
    if (ignoreUsers.has(login)) return;
    if (config.hideCommands && text.startsWith('!')) return;

    const node = el('div', action ? 'msg action' : 'msg');
    node.dataset.id = tags.id || '';
    node.dataset.user = tags['user-id'] || '';

    const color = readableColor(tags.color, login);
    const name = el('span', 'name', tags['display-name'] || login);
    name.style.color = color;
    const body = el('span', 'text');
    if (action) body.style.color = color;
    renderText(body, text, config.showEmotes ? tags.emotes : '');
    node.append(name, action ? ' ' : ': ', body);

    const lower = text.toLowerCase();
    if (highlightWords.some((w) => lower.includes(w))) node.classList.add('mention');
    add(node);
  }

  function showEvent(tags, text) {
    if (!config.showSubsAndRaids || !tags['system-msg']) return;
    const node = el('div', 'msg event', tags['system-msg']);
    if (text) {
      const reply = el('span', 'reply');
      renderText(reply, text, config.showEmotes ? tags.emotes : '');
      node.append(reply);
    }
    add(node);
  }

  function handle(msg) {
    switch (msg.command) {
      case 'PING':
        ws.send(`PONG :${msg.trailing}`);
        break;
      case 'RECONNECT':
        ws.close();
        break;
      case 'JOIN':
        retries = 0;
        addSystem(joinedOnce ? 'Reconnected to chat' : `Connected to #${channel}`);
        window.overlay.reportStatus('ok', `Connected to #${channel}`);
        joinedOnce = true;
        break;
      case 'NOTICE':
        if (msg.trailing) addSystem(msg.trailing);
        break;
      case 'PRIVMSG':
        showChat(msg.tags, msg.prefix.split('!')[0], msg.trailing);
        break;
      case 'USERNOTICE':
        showEvent(msg.tags, msg.trailing);
        break;
      case 'CLEARCHAT': {
        const target = msg.tags['target-user-id'];
        const selector = target ? `.msg[data-user="${CSS.escape(target)}"]` : '.msg:not(.system)';
        chat.querySelectorAll(selector).forEach((n) => n.remove());
        break;
      }
      case 'CLEARMSG': {
        const id = msg.tags['target-msg-id'];
        if (id) chat.querySelectorAll(`.msg[data-id="${CSS.escape(id)}"]`).forEach((n) => n.remove());
        break;
      }
    }
  }

  function connect() {
    ws = new WebSocket(TWITCH_IRC);
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = (event) => {
      lastData = Date.now();
      for (const line of String(event.data).split('\r\n')) if (line) handle(parseIrc(line));
    };
    ws.onclose = () => {
      const delay = Math.min(30000, 1000 * 2 ** retries++);
      addSystem(`Chat disconnected, retrying in ${Math.round(delay / 1000)}s`);
      window.overlay.reportStatus('error', `Disconnected, retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(connect, delay);
    };
  }

  // Twitch pings about every 5 minutes; if it goes quiet for longer, the socket is dead.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastData > 6 * 60 * 1000) ws.close();
  }, 60 * 1000);

  addSystem(`Connecting to #${channel}...`);
  window.overlay.reportStatus('pending', `Connecting to #${channel}...`);
  connect();
}

(async () => {
  config = await window.overlay.getConfig();

  const root = document.documentElement.style;
  root.setProperty('--font-size', `${Number(config.fontSize) || 15}px`);
  root.setProperty('--msg-bg', `rgba(0, 0, 0, ${Number(config.messageBackgroundOpacity) || 0})`);

  window.overlay.onEditMode((on) => document.body.classList.toggle('editing', on));

  // Accept "name", "#name" or a full twitch.tv URL.
  const channel = String(config.twitchChannel || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
    .replace(/^#/, '')
    .split(/[/?#]/)[0]
    .toLowerCase();

  if (!/^[a-z0-9_]{2,25}$/.test(channel)) {
    addSystem('No chat source yet. Set your Twitch channel in the settings window.', { persistent: true });
    window.overlay.reportStatus('off', 'No chat source set');
    return;
  }

  const highlightWords = [channel, ...(config.highlightWords || [])].map((w) => String(w).toLowerCase()).filter(Boolean);
  const ignoreUsers = new Set((config.ignoreUsers || []).map((u) => String(u).toLowerCase()));
  startTwitch(channel, highlightWords, ignoreUsers);
})();
