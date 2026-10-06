'use strict';
// CS2 Game State Integration (GSI): Valve's official way for apps to get game data. CS2 reads a
// gamestate_integration_*.cfg from its cfg folder at startup and POSTs JSON to the URI in it.
// Nothing here reads or touches the game process; CS2 sends the data itself.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CFG_NAME = 'gamestate_integration_streamchatoverlay.cfg';
const CS2_APP_ID = '730';
const CS2_FOLDER = 'Counter-Strike Global Offensive';

// ---------- finding CS2 ----------

function steamPathFromRegistry() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (err, stdout) => {
      const m = !err && /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout);
      resolve(m ? path.normalize(m[1].trim()) : null);
    });
  });
}

// libraryfolders.vdf lists every Steam library and the app IDs installed in each.
function librariesWithCs2(steamPath) {
  try {
    const vdf = fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    const libraries = [];
    for (const block of vdf.split(/"\d+"\s*\{\s*"path"/).slice(1)) {
      const m = /^\s*"((?:[^"\\]|\\.)*)"/.exec(block);
      const apps = /"apps"\s*\{([^}]*)\}/.exec(block);
      if (m && apps && new RegExp(`"${CS2_APP_ID}"`).test(apps[1])) libraries.push(m[1].replace(/\\\\/g, '\\'));
    }
    return libraries;
  } catch {
    return [];
  }
}

function cfgDirIn(library) {
  return path.join(library, 'steamapps', 'common', CS2_FOLDER, 'game', 'csgo', 'cfg');
}

async function findCfgDir() {
  const steam = await steamPathFromRegistry();
  const candidates = [];
  if (steam) candidates.push(...librariesWithCs2(steam), steam);
  candidates.push('C:\\Program Files (x86)\\Steam');
  for (const library of candidates) {
    const dir = cfgDirIn(library);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// Accepts whatever folder the user picked: the CS2 install folder, game\csgo, or cfg itself.
function cfgDirFromPick(folder) {
  const tries = [folder, path.join(folder, 'cfg'), path.join(folder, 'csgo', 'cfg'), path.join(folder, 'game', 'csgo', 'cfg')];
  return tries.find((dir) => path.basename(dir).toLowerCase() === 'cfg'
    && fs.existsSync(path.join(path.dirname(dir), 'gameinfo.gi'))) || null;
}

function writeConfig(dir, { port, token }) {
  const file = path.join(dir, CFG_NAME);
  fs.writeFileSync(file, `"Stream Chat Overlay FACEIT stats"
{
  "uri" "http://127.0.0.1:${port}/gsi"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.5"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider" "1"
    "map" "1"
    "round" "1"
    "player_id" "1"
    "player_state" "1"
    "player_match_stats" "1"
  }
}
`);
  return file;
}

function removeConfig(file) {
  if (file && path.basename(file) === CFG_NAME) fs.rmSync(file, { force: true });
}

// ---------- reading the data ----------

// Follows one match at a time from the updates CS2 sends. Only your own stats count: while you're
// dead CS2 sends whoever you're spectating, so `player` is ignored unless it's the local player.
function createGameTracker({ onGameOver }) {
  let game = null;
  let lastSeen = 0;

  function newGame(map) {
    return { map: map.name, mode: map.mode, kills: 0, deaths: 0, assists: 0, damage: 0, roundDamage: 0, team: null, over: false };
  }

  function finish(won) {
    game.over = true;
    const rounds = game.rounds || 0;
    onGameOver({
      endedAt: Date.now(),
      map: String(game.map || '').replace(/^de_/, ''),
      mode: game.mode,
      won,
      kills: game.kills,
      deaths: game.deaths,
      assists: game.assists,
      damage: game.damage + game.roundDamage,
      rounds,
    });
  }

  function update(p) {
    lastSeen = Date.now();
    const map = p.map;
    if (!map) {
      // Back in the menu. A match left before the end still gets reported so its stats count.
      if (game && !game.over && game.rounds > 0) finish(null);
      game = null;
      return;
    }
    if (!game || game.map !== map.name || (game.over && map.phase !== 'gameover')) game = newGame(map);
    if (game.over) return;
    game.phase = map.phase;

    const ct = Number(map.team_ct && map.team_ct.score) || 0;
    const t = Number(map.team_t && map.team_t.score) || 0;
    game.rounds = ct + t;

    const own = p.player && p.provider && p.player.steamid === p.provider.steamid ? p.player : null;
    if (map.phase === 'warmup') {
      game.damage = 0;
      game.roundDamage = 0;
    }
    if (own) {
      if (own.team) game.team = own.team;
      const stats = own.match_stats;
      if (stats) {
        game.kills = Number(stats.kills) || 0;
        game.deaths = Number(stats.deaths) || 0;
        game.assists = Number(stats.assists) || 0;
      }
      // round_totaldmg resets to 0 every round, so a drop means the previous round is done.
      const dmg = Number(own.state && own.state.round_totaldmg);
      if (Number.isFinite(dmg)) {
        if (dmg < game.roundDamage) game.damage += game.roundDamage;
        game.roundDamage = dmg;
      }
    }

    if (map.phase === 'gameover') {
      const mine = game.team === 'CT' ? ct : t;
      const theirs = game.team === 'CT' ? t : ct;
      finish(game.team ? mine > theirs : null);
    }
  }

  return {
    update,
    lastSeen: () => lastSeen,
    // The match in progress, if any.
    live() {
      if (!game || game.over || game.phase === 'warmup' || Date.now() - lastSeen > 60 * 1000) return null;
      if (game.rounds === 0 && game.kills === 0 && game.deaths === 0) return null;
      return {
        map: String(game.map || '').replace(/^de_/, ''),
        kills: game.kills,
        deaths: game.deaths,
        damage: game.damage + game.roundDamage,
        rounds: game.rounds,
      };
    },
  };
}

module.exports = { findCfgDir, cfgDirFromPick, writeConfig, removeConfig, createGameTracker, CFG_NAME };
