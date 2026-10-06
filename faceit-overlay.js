'use strict';
// Streamlabs/OBS Browser Source page. Polls the app's local server; the app does the FACEIT calls.
// Add ?layout=bar or ?layout=card to the URL to override the layout picked in settings.

const REFRESH_MS = 5000;
const $ = (id) => document.getElementById(id);
const layoutParam = new URLSearchParams(location.search).get('layout');

let last = {};

function levelColor(level) {
  if (level >= 10) return '#fe1f00';
  if (level >= 8) return '#ff6309';
  if (level >= 4) return '#ffc800';
  if (level >= 2) return '#1ce400';
  return '#eeeeee';
}

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

// Sets text and briefly highlights it when the value changed since the last update.
function set(id, text, tone) {
  const node = $(id);
  node.textContent = text;
  if (tone !== undefined) node.dataset.tone = tone;
  if (last[id] !== undefined && last[id] !== text) {
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
  }
  last[id] = text;
}

function render(data) {
  const root = $('root');
  root.hidden = !data.ready;
  root.className = (layoutParam === 'card' || layoutParam === 'bar') ? layoutParam : data.layout || 'bar';
  if (!data.ready) return;

  const { player, session, recent, streak } = data;
  const color = levelColor(player.level);
  root.style.setProperty('--level', color);

  set('level', String(player.level ?? '?'));
  set('nickname', player.nickname);
  set('elo', player.elo === null ? '-' : String(player.elo));

  const ring = $('ring');
  if (player.nextLevelElo && player.elo !== null) {
    const span = player.nextLevelElo - player.levelMin;
    const progress = Math.min(100, Math.max(4, ((player.elo - player.levelMin) / span) * 100));
    ring.style.strokeDasharray = `${progress} 100`;
    set('next', `${player.nextLevelElo - player.elo} to Level ${player.level + 1}`);
  } else {
    ring.style.strokeDasharray = '100 100';
    set('next', 'Max level');
  }

  set('eloChange', signed(session.eloChange), session.eloChange > 0 ? 'up' : session.eloChange < 0 ? 'down' : '');
  set('record', `${session.wins}–${session.losses}`);
  set('kd', session.kd === null ? '-' : session.kd.toFixed(2), session.kd === null ? '' : session.kd >= 1 ? 'up' : 'down');
  set('adr', session.adr === null ? '-' : String(Math.round(session.adr)));

  $('live').hidden = !session.live;
  $('recentBox').hidden = recent.length === 0;
  const chips = $('chips');
  chips.replaceChildren(...[...recent].reverse().map((m) => {
    const chip = document.createElement('span');
    chip.className = `chip ${m.win ? 'win' : 'loss'}`;
    chip.textContent = m.win ? 'W' : 'L';
    chip.title = `${m.map} ${signed(m.eloDelta)}`.trim();
    return chip;
  }));
  set('streak', streak && streak.count >= 2 ? `· ${streak.count} ${streak.win ? 'win' : 'loss'} streak` : '',
    streak ? (streak.win ? 'up' : 'down') : '');
}

async function refresh() {
  try {
    const res = await fetch('/faceit/data', { cache: 'no-store' });
    if (res.ok) render(await res.json());
  } catch {
    // App closed or restarting: keep showing the last numbers until it's back.
  }
  setTimeout(refresh, REFRESH_MS);
}

refresh();
