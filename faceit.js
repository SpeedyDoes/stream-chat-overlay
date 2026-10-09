'use strict';
// FACEIT stats for the stream, without a FACEIT API key:
//  - Elo and level come from the public profile endpoint faceit.com uses for its own pages.
//  - A FACEIT match finished whenever that Elo changes: up is a win, down is a loss.
//  - Kills, deaths and damage come from CS2's Game State Integration (see gsi.js). Only competitive
//    games on regular maps are tracked, so deathmatch, casual and community servers never count. A
//    finished game only counts once FACEIT moves your Elo right after it, which leaves out Premier.
// It serves a page on http://127.0.0.1:<port>/faceit that Streamlabs/OBS loads as a Browser Source,
// and takes CS2's GSI updates on /gsi. Unlike the chat overlay, this page is meant to be on stream.
// Nothing here reads or touches the game, or the FACEIT client.

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const gsi = require('./gsi');

const PROFILE_URL = 'https://www.faceit.com/api/users/v1/nicknames/';
const USER_AGENT = `StreamChatOverlay/${require('./package.json').version} (+https://github.com/SpeedyDoes/stream-chat-overlay)`;
const GAME = 'cs2';
const POLL_MS = 60 * 1000;
// Right after a CS2 game ends, check more often so the result shows up quickly.
const FAST_POLL_MS = 15 * 1000;
const FAST_FOR_MS = 5 * 60 * 1000;
// How far apart a finished CS2 game and a FACEIT Elo change can be and still be the same match.
const LINK_WINDOW_MS = 15 * 60 * 1000;
const HISTORY_SIZE = 20;
const MAX_BODY = 256 * 1024;

// CS2 level floors. Level 10 is open-ended.
const LEVEL_MIN = [0, 100, 501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];

// The only files the server hands out; everything else is a 404.
const STATIC = {
  '/faceit': ['faceit-overlay.html', 'text/html; charset=utf-8'],
  '/faceit/': ['faceit-overlay.html', 'text/html; charset=utf-8'],
  '/faceit/overlay.css': ['faceit-overlay.css', 'text/css; charset=utf-8'],
  '/faceit/overlay.js': ['faceit-overlay.js', 'text/javascript; charset=utf-8'],
};

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'";

class FaceitError extends Error {}

function levelInfo(level) {
  if (!level || level >= 10) return { min: LEVEL_MIN[10], next: null };
  return { min: LEVEL_MIN[level], next: LEVEL_MIN[level + 1] };
}

const statsOf = (game) => (game ? {
  map: game.map, kills: game.kills, deaths: game.deaths, damage: game.damage, rounds: game.rounds,
} : {});

function summarize(matches, extra) {
  const games = [...matches.filter((m) => Number.isFinite(m.kills)), ...extra];
  const kills = games.reduce((n, g) => n + g.kills, 0);
  const deaths = games.reduce((n, g) => n + g.deaths, 0);
  const damage = games.reduce((n, g) => n + (g.damage || 0), 0);
  const rounds = games.reduce((n, g) => n + (g.rounds || 0), 0);
  const wins = matches.filter((m) => m.win).length;
  return {
    matches: matches.length,
    wins,
    losses: matches.length - wins,
    kills,
    deaths,
    kd: games.length ? kills / Math.max(1, deaths) : null,
    adr: rounds && damage ? damage / rounds : null,
  };
}

function streakOf(history) {
  if (!history.length) return null;
  const win = history[0].win;
  let count = 0;
  while (count < history.length && history[count].win === win) count++;
  return { win, count };
}

// `store` reads and writes the app's state.json: faceitSession, faceitHistory, faceitGsi.
function createFaceitTracker({ appDir, store, pickFolder, onStatus }) {
  let config = null;
  let server = null;
  let serverPort = null;
  let timer = null;
  let generation = 0;
  let player = null;
  let updatedAt = null;
  let fastUntil = 0;
  let status = { kind: 'off', text: 'Not set up' };
  let gsiSummary = '';
  // CS2 games that ended and are waiting for FACEIT to move the Elo.
  let finishedGames = [];

  const active = () => Boolean(config && config.faceitNickname);
  const session = () => store.get('faceitSession');
  const history = () => store.get('faceitHistory') || [];

  function setStatus(kind, text) {
    status = { kind, text };
    onStatus();
  }

  // ---------- CS2 game data ----------

  function gsiSettings() {
    let settings = store.get('faceitGsi');
    if (!settings || !settings.token) {
      settings = { token: crypto.randomBytes(16).toString('hex'), cfgPath: null };
      store.set('faceitGsi', settings);
    }
    return settings;
  }

  function onGameOver(game) {
    const recent = Date.now() - LINK_WINDOW_MS;
    // FACEIT can move the Elo before CS2 reports the end; fill in that match if so.
    const s = session();
    const waiting = s && s.matches.find((m) => m.at >= recent && !Number.isFinite(m.kills));
    if (waiting) {
      attachStats(waiting.at, game);
    } else {
      finishedGames = [...finishedGames.filter((g) => g.endedAt >= recent), game];
    }
    fastUntil = Date.now() + FAST_FOR_MS;
    if (active() && player) {
      clearTimeout(timer);
      timer = setTimeout(poll, FAST_POLL_MS);
    }
    onStatus();
  }

  const games = gsi.createGameTracker({ onGameOver });

  function attachStats(at, game) {
    const add = (m) => (m.at === at ? { ...m, ...statsOf(game) } : m);
    const s = session();
    if (s) store.set('faceitSession', { ...s, matches: s.matches.map(add) });
    store.set('faceitHistory', history().map(add));
  }

  function takeFinishedGame() {
    const recent = Date.now() - LINK_WINDOW_MS;
    finishedGames = finishedGames.filter((g) => g.endedAt >= recent);
    return finishedGames.pop() || null;
  }

  function gsiState() {
    const { cfgPath } = gsiSettings();
    const installed = Boolean(cfgPath && fs.existsSync(cfgPath));
    const lastSeen = games.lastSeen();
    const receiving = Date.now() - lastSeen < 60 * 1000;
    return { installed, path: installed ? cfgPath : null, receiving, inMatch: Boolean(games.live()) };
  }

  // Called every few seconds so the settings window notices CS2 starting and stopping.
  function checkGsi() {
    const summary = JSON.stringify(gsiState());
    if (summary !== gsiSummary) {
      gsiSummary = summary;
      onStatus();
    }
  }
  setInterval(checkGsi, 5000).unref();

  async function installGsi() {
    const settings = gsiSettings();
    let dir = await gsi.findCfgDir();
    if (!dir) {
      const picked = await pickFolder();
      if (!picked) return { ok: false, error: null };
      dir = gsi.cfgDirFromPick(picked);
      if (!dir) return { ok: false, error: "That isn't the CS2 folder. Pick the \"Counter-Strike Global Offensive\" folder." };
    }
    try {
      const cfgPath = gsi.writeConfig(dir, { port: config.faceitPort, token: settings.token });
      store.set('faceitGsi', { ...settings, cfgPath });
      checkGsi();
      return { ok: true, path: cfgPath };
    } catch (err) {
      return { ok: false, error: `Couldn't write the file (${err.code || err.message})` };
    }
  }

  function removeGsi() {
    const settings = gsiSettings();
    try {
      gsi.removeConfig(settings.cfgPath);
    } catch {
      // already gone
    }
    store.set('faceitGsi', { ...settings, cfgPath: null });
    checkGsi();
  }

  // The cfg holds the port, so it has to follow a port change.
  function refreshGsiConfig() {
    const { cfgPath, token } = gsiSettings();
    if (!cfgPath || !fs.existsSync(cfgPath)) return;
    try {
      gsi.writeConfig(path.dirname(cfgPath), { port: config.faceitPort, token });
    } catch (err) {
      console.error('GSI config update failed:', err.message);
    }
  }

  // ---------- FACEIT profile ----------

  async function fetchProfile() {
    let res;
    try {
      res = await fetch(PROFILE_URL + encodeURIComponent(config.faceitNickname), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new FaceitError("Can't reach FACEIT. Retrying...");
    }
    if (res.status === 404) throw new FaceitError(`No FACEIT player called "${config.faceitNickname}"`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.payload) {
      throw new FaceitError(`FACEIT didn't answer (${res.status}). Retrying...`);
    }
    const profile = body.payload;
    const game = profile.games && profile.games[GAME];
    if (!game || !Number.isFinite(game.faceit_elo)) throw new FaceitError(`${profile.nickname} has no CS2 profile on FACEIT`);
    return { id: profile.id, nickname: profile.nickname, elo: game.faceit_elo, level: game.skill_level };
  }

  // ---------- session ----------

  function newSession(p) {
    const s = { playerId: p.id, startedAt: Date.now(), startElo: p.elo, lastElo: p.elo, lastActivityAt: Date.now(), matches: [] };
    store.set('faceitSession', s);
    return s;
  }

  // Picks up where the last session left off unless it's for another player, or nothing was
  // played for `faceitSessionResetHours`. That way a restart mid-stream keeps the numbers.
  function currentSession(p) {
    const s = session();
    const idleMs = config.faceitSessionResetHours * 3600 * 1000;
    if (s && s.playerId !== p.id) store.set('faceitHistory', []);
    if (!s || s.playerId !== p.id || !Array.isArray(s.matches)) return newSession(p);
    if (idleMs > 0 && Date.now() - s.lastActivityAt > idleMs) return newSession(p);
    return s;
  }

  function recordMatch(s, p) {
    const delta = p.elo - s.lastElo;
    const match = { at: Date.now(), eloDelta: delta, win: delta > 0, elo: p.elo, ...statsOf(takeFinishedGame()) };
    store.set('faceitSession', { ...s, lastElo: p.elo, lastActivityAt: match.at, matches: [...s.matches, match] });
    store.set('faceitHistory', [match, ...history()].slice(0, HISTORY_SIZE));
  }

  // ---------- polling ----------

  function schedule() {
    clearTimeout(timer);
    if (active()) timer = setTimeout(poll, Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS);
  }

  async function poll() {
    clearTimeout(timer);
    const gen = generation;
    try {
      const p = await fetchProfile();
      if (gen !== generation) return;
      const s = currentSession(p);
      if (p.elo !== s.lastElo) {
        recordMatch(s, p);
        fastUntil = 0;
      }
      player = p;
      updatedAt = Date.now();
      setStatus('ok', `${p.nickname} · Level ${p.level} · ${p.elo} Elo`);
    } catch (err) {
      if (gen !== generation) return;
      console.error('FACEIT:', err.message);
      setStatus('error', err instanceof FaceitError ? err.message : `FACEIT update failed (${err.message})`);
    }
    if (gen === generation) schedule();
  }

  function restartPolling() {
    generation++;
    clearTimeout(timer);
    player = null;
    updatedAt = null;
    if (!active()) {
      setStatus('off', 'Add your FACEIT nickname to turn this on');
      return;
    }
    setStatus('pending', 'Loading FACEIT stats...');
    poll();
  }

  function resetSession() {
    if (!active()) return;
    if (player) newSession(player);
    else store.set('faceitSession', null);
    finishedGames = [];
    generation++;
    poll();
  }

  // ---------- data for the page ----------

  function snapshot() {
    if (!player) return { ready: false, layout: config.faceitLayout };
    const s = session();
    const { min, next } = levelInfo(player.level);
    const live = games.live();
    // Games that ended but aren't matched to an Elo change yet still count, so K/D doesn't
    // jump back while FACEIT catches up. If no Elo change comes, they drop out again.
    const recent = Date.now() - LINK_WINDOW_MS;
    const provisional = [...finishedGames.filter((g) => g.endedAt >= recent), ...(live ? [live] : [])];
    const matches = s ? s.matches : [];
    return {
      ready: true,
      layout: config.faceitLayout,
      updatedAt,
      player: {
        nickname: player.nickname,
        elo: player.elo,
        level: player.level,
        levelMin: min,
        nextLevelElo: next,
      },
      session: {
        startedAt: s ? s.startedAt : null,
        eloChange: s ? player.elo - s.startElo : 0,
        live: Boolean(live),
        ...summarize(matches, provisional),
      },
      recent: history().slice(0, 5).map((m) => ({ win: m.win, eloDelta: m.eloDelta, map: m.map || '' })),
      streak: streakOf(history()),
    };
  }

  // ---------- local web server ----------

  function receiveGsi(req, res) {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end();
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      // Only CS2 knows the token from the cfg we wrote.
      if (!payload || !payload.auth || payload.auth.token !== gsiSettings().token) return;
      games.update(payload);
      checkGsi();
    });
  }

  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/gsi') return receiveGsi(req, res);
    if (req.method !== 'GET') return send(405, 'text/plain', 'Method not allowed');
    if (url.pathname === '/faceit/data') return send(200, 'application/json', JSON.stringify(snapshot()));

    const file = STATIC[url.pathname];
    if (!file) return send(404, 'text/plain', 'Not found');
    fs.readFile(path.join(appDir, file[0]), (err, body) => {
      if (err) send(500, 'text/plain', 'Missing file');
      else send(200, file[1], body, { 'Content-Security-Policy': PAGE_CSP });
    });
  }

  function stopServer() {
    if (server) server.close();
    server = null;
    serverPort = null;
  }

  function startServer(port) {
    if (server && serverPort === port) return;
    stopServer();
    const s = http.createServer(handle);
    s.on('error', (err) => {
      if (server !== s) return;
      server = null;
      serverPort = null;
      const why = err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port.` : err.message;
      generation++;
      clearTimeout(timer);
      setStatus('error', why);
    });
    // Loopback only: the page and GSI are for apps on this PC, not the network.
    s.listen(port, '127.0.0.1');
    server = s;
    serverPort = port;
  }

  return {
    configure(next) {
      const previous = config;
      config = next;
      if (!active()) {
        stopServer();
        restartPolling();
        return;
      }
      if (previous && previous.faceitPort !== next.faceitPort) refreshGsiConfig();
      startServer(config.faceitPort);
      const changed = !previous || !player || status.kind === 'error'
        || previous.faceitNickname !== next.faceitNickname
        || previous.faceitSessionResetHours !== next.faceitSessionResetHours;
      if (changed) restartPolling();
      else onStatus();
    },
    resetSession,
    installGsi,
    removeGsi,
    stop() {
      generation++;
      clearTimeout(timer);
      stopServer();
    },
    state() {
      const s = session();
      const data = player ? snapshot().session : null;
      return {
        status,
        url: `http://127.0.0.1:${config.faceitPort}/faceit`,
        gsi: gsiState(),
        session: data && s ? { startedAt: s.startedAt, eloChange: data.eloChange, wins: data.wins, losses: data.losses, kd: data.kd } : null,
      };
    },
  };
}

module.exports = { createFaceitTracker };
