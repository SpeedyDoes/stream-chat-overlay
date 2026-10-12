'use strict';
// Chat commands, answered from the main process with the streamer's (or a bot's) Twitch account.
//  - !link replies with the current Krunker game link, read from Krunker Vibe Client's local
//    endpoint. That endpoint sends no CORS headers on purpose, so it can only be read from here.
// Sign-in uses Twitch's device code flow: the settings window shows a code, the user enters it on
// twitch.tv/activate, and the tokens are kept in state.json, encrypted with Windows DPAPI.
// The overlay keeps its own anonymous read-only connection; this one only exists while a command
// is turned on.

// Public client ID from dev.twitch.tv/console/apps (Client Type: Public). Not a secret.
const TWITCH_CLIENT_ID = 'dmvtq8uhzyckfb7kh71dsdr7ma4cdh';
const SCOPES = 'chat:read chat:edit';
const TWITCH_IRC = 'wss://irc-ws.chat.twitch.tv:443';
const OAUTH = 'https://id.twitch.tv/oauth2';
// Twitch asks apps to re-validate their token every hour.
const VALIDATE_MS = 60 * 60 * 1000;

const KRUNKER_LINK_URL = 'http://127.0.0.1:47615/link';
const KRUNKER_TIMEOUT_MS = 2000;
const LINK_COOLDOWN_MS = 10 * 1000;
// Only ever post a real game link: no spaces or line breaks, nothing that could become a second
// IRC command.
const GAME_LINK = /^https:\/\/krunker\.io\/\?game=[^\s]{1,100}$/;
// Some chat clients append these so Twitch accepts a repeated message.
const INVISIBLE = /[͏​-‍⁠﻿\u{e0000}]/gu;

class AuthError extends Error {}

function parseIrc(line) {
  const msg = { prefix: '', command: '', params: [], trailing: '' };
  let rest = line;
  if (rest[0] === '@') rest = rest.slice(rest.indexOf(' ') + 1);
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

// Accept "name", "#name" or a full twitch.tv URL, like the overlay does.
function channelOf(config) {
  const channel = String(config.twitchChannel || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
    .replace(/^#/, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(channel) ? channel : null;
}

// Never throws: a missing client, a timeout or a bad answer all mean "no link".
async function fetchGameLink() {
  try {
    const res = await fetch(KRUNKER_LINK_URL, { signal: AbortSignal.timeout(KRUNKER_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.link === 'string' && GAME_LINK.test(body.link) ? body.link : null;
  } catch {
    return null;
  }
}

async function postForm(url, fields) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(fields), signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// `store` reads and writes state.json (twitchAuth). `secrets` seals the tokens (DPAPI in the app).
function createChatBot({ store, secrets, openUrl, onStatus }) {
  let config = null;
  let status = { kind: 'off', text: 'Off' };
  let pending = null; // device code sign-in in progress
  let ws = null;
  let wsKey = '';
  let generation = 0;
  let retries = 0;
  let retryTimer = null;
  let lastData = 0;
  let refreshing = null;
  let cooldownUntil = 0;

  const auth = () => store.get('twitchAuth');
  const channel = () => (config ? channelOf(config) : null);

  function setStatus(kind, text) {
    status = { kind, text };
    onStatus();
  }

  function tokens() {
    const a = auth();
    if (!a) return null;
    try {
      return JSON.parse(secrets.open(a.tokens));
    } catch {
      return null;
    }
  }

  function saveAuth(login, access, refresh) {
    store.set('twitchAuth', { login, tokens: secrets.seal(JSON.stringify({ access, refresh })) });
  }

  // ---------- tokens ----------

  async function validate(access) {
    const res = await fetch(`${OAUTH}/validate`, {
      headers: { Authorization: `OAuth ${access}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`Twitch didn't answer (${res.status})`);
    return res.json();
  }

  // Refresh tokens are single-use, so two refreshes at once would sign the user out.
  function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const t = tokens();
        if (!t) throw new AuthError('Connect a Twitch account to reply in chat');
        const { status: code, body } = await postForm(`${OAUTH}/token`, {
          client_id: TWITCH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: t.refresh,
        });
        if (code === 400 || code === 401) throw new AuthError('Twitch sign-in expired. Connect again.');
        if (!body.access_token) throw new Error(`Twitch didn't answer (${code})`);
        saveAuth(auth().login, body.access_token, body.refresh_token || t.refresh);
        return body.access_token;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // A working access token, refreshed when it's expired or about to.
  async function accessToken() {
    const t = tokens();
    if (!t) throw new AuthError('Connect a Twitch account to reply in chat');
    const info = await validate(t.access);
    if (info && info.expires_in > 600) return t.access;
    return refresh();
  }

  function signOut(text) {
    store.set('twitchAuth', null);
    disconnect();
    setStatus('error', text);
  }

  async function checkToken() {
    if (!auth()) return;
    try {
      await accessToken();
    } catch (err) {
      if (err instanceof AuthError) signOut(err.message);
    }
  }
  setInterval(checkToken, VALIDATE_MS).unref();

  // ---------- device code sign-in ----------

  async function login() {
    if (!TWITCH_CLIENT_ID) return;
    cancelLogin();
    const mine = {};
    pending = mine;
    onStatus();
    try {
      const { body: device } = await postForm(`${OAUTH}/device`, { client_id: TWITCH_CLIENT_ID, scopes: SCOPES });
      if (pending !== mine) return;
      if (!device.device_code) throw new Error(device.message || 'no device code');
      Object.assign(mine, { code: device.user_code, url: device.verification_uri });
      if (/^https:\/\/(www\.)?twitch\.tv\//.test(mine.url)) openUrl(mine.url);
      onStatus();

      let interval = (device.interval || 5) * 1000;
      const expiresAt = Date.now() + (device.expires_in || 1800) * 1000;
      while (pending === mine && Date.now() < expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        if (pending !== mine) return;
        const { body } = await postForm(`${OAUTH}/token`, {
          client_id: TWITCH_CLIENT_ID,
          scopes: SCOPES,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (pending !== mine) return;
        if (body.access_token) {
          const info = await validate(body.access_token);
          if (!info) throw new Error('the new token was rejected');
          pending = null;
          saveAuth(info.login, body.access_token, body.refresh_token);
          restart();
          return;
        }
        if (body.message === 'slow_down') interval += 5000;
        else if (body.message !== 'authorization_pending') throw new Error(body.message || 'sign-in was declined');
      }
      if (pending === mine) throw new Error('the code expired');
    } catch (err) {
      if (pending !== mine) return;
      pending = null;
      setStatus('error', `Twitch sign-in failed (${err.message})`);
    }
  }

  function cancelLogin() {
    pending = null;
    onStatus();
  }

  async function logout() {
    const t = tokens();
    store.set('twitchAuth', null);
    restart();
    if (t) await postForm(`${OAUTH}/revoke`, { client_id: TWITCH_CLIENT_ID, token: t.access }).catch(() => {});
  }

  // ---------- chat connection ----------

  function say(text) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(`PRIVMSG #${channel()} :${text.replace(/[\r\n]+/g, ' ')}`);
  }

  async function onChat(text) {
    if (!config.linkCommand) return;
    if (text.replace(INVISIBLE, '').trim().toLowerCase() !== '!link') return;
    if (Date.now() < cooldownUntil) return;
    cooldownUntil = Date.now() + LINK_COOLDOWN_MS;
    const link = await fetchGameLink();
    say(link ? `Current game: ${link}` : 'No game link right now.');
  }

  function disconnect() {
    generation++;
    clearTimeout(retryTimer);
    if (ws) ws.close();
    ws = null;
    wsKey = '';
  }

  function retry(gen, why) {
    if (gen !== generation) return;
    const delay = Math.min(30000, 1000 * 2 ** retries++);
    setStatus('error', `${why}, retrying in ${Math.round(delay / 1000)}s`);
    retryTimer = setTimeout(() => connect(gen), delay);
  }

  async function connect(gen, renew = false) {
    const name = channel();
    let access;
    try {
      access = renew ? await refresh() : await accessToken();
    } catch (err) {
      if (gen !== generation) return;
      if (err instanceof AuthError) signOut(err.message);
      else retry(gen, "Can't reach Twitch");
      return;
    }
    if (gen !== generation) return;

    const { login: user } = auth();
    let authFailed = false;
    const socket = new WebSocket(TWITCH_IRC);
    ws = socket;
    lastData = Date.now();
    socket.onopen = () => {
      socket.send('CAP REQ :twitch.tv/commands');
      socket.send(`PASS oauth:${access}`);
      socket.send(`NICK ${user}`);
      socket.send(`JOIN #${name}`);
    };
    socket.onmessage = (event) => {
      if (gen !== generation) return;
      lastData = Date.now();
      for (const line of String(event.data).split('\r\n')) {
        if (!line) continue;
        const msg = parseIrc(line);
        if (msg.command === 'PING') socket.send(`PONG :${msg.trailing}`);
        else if (msg.command === 'RECONNECT') socket.close();
        else if (msg.command === 'NOTICE' && /authentication failed|improperly formatted auth/i.test(msg.trailing)) authFailed = true;
        else if (msg.command === 'JOIN' && msg.prefix.startsWith(`${user}!`)) {
          retries = 0;
          setStatus('ok', `Listening in #${name} as ${user}`);
        } else if (msg.command === 'PRIVMSG') onChat(msg.trailing).catch((err) => console.error('Chat command:', err.message));
      }
    };
    socket.onclose = () => {
      if (gen !== generation || ws !== socket) return;
      ws = null;
      if (authFailed && !renew) {
        connect(gen, true);
        return;
      }
      retry(gen, 'Disconnected from Twitch chat');
    };
  }

  // Twitch pings about every 5 minutes; if it goes quiet for longer, the socket is dead.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastData > 6 * 60 * 1000) ws.close();
  }, 60 * 1000).unref();

  function restart() {
    const a = auth();
    const name = channel();
    const key = config.linkCommand && a && name ? `${a.login}#${name}` : '';
    if (key && key === wsKey && status.kind !== 'error') return onStatus();
    disconnect();
    retries = 0;
    if (!TWITCH_CLIENT_ID) return setStatus('error', 'No Twitch client ID set in chatbot.js');
    if (!config.linkCommand) return setStatus('off', 'Off');
    if (!name) return setStatus('off', 'Set your Twitch channel on the Chat tab');
    if (!a) return setStatus('off', 'Connect a Twitch account to reply in chat');
    wsKey = key;
    setStatus('pending', `Connecting to #${name}...`);
    connect(generation);
  }

  return {
    configure(next) {
      config = next;
      restart();
    },
    login,
    cancelLogin,
    logout,
    stop: disconnect,
    state() {
      const a = auth();
      return {
        status,
        account: a ? a.login : null,
        pending: pending ? { code: pending.code || null } : null,
        ready: Boolean(TWITCH_CLIENT_ID),
      };
    },
  };
}

module.exports = { createChatBot, fetchGameLink };
