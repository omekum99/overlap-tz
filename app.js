'use strict';

/*
 * app.js — UI wiring.
 *
 *   URL hash ──decode──▶ `state` (shared team config) ──render──▶ DOM
 *      ▲                                                            │
 *      └──────────────── encode (debounced) ◀──────────────────────┘
 *   localStorage ──▶ `meetings` (private, per-workspace) + viewer prefs
 *
 * Viewer-only settings (home tz, date, zoom, 12h, search, team filter) never
 * enter the shared URL, so everyone opens the same team in their own context.
 *
 * `DateTime` comes from timeutil.js (classic scripts share one global scope).
 */

// Central team palette — 12 hues at a fixed saturation/lightness so every team
// color is equally vivid and harmonious (color theory: same S/L, spread hue).
// Ordered to keep neighbours visually distinct. Stored as hex so the native
// colour picker and CSS agree. A team holds an index into this, or an arbitrary
// `customColor` hex when overridden.
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const TEAM_HUES = [212, 28, 150, 330, 265, 45, 122, 352, 190, 88, 300, 14];
const TEAM_COLORS = TEAM_HUES.map(h => hslToHex(h, 62, 52));
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];   // Mon=1 .. Sun=7
const SAFE_URL_LEN = 1800;
const ZOOM_MIN = 30, ZOOM_MAX = 120;
const DUR_OPTS = [15, 30, 45, 60, 90, 120];               // meeting-dialog lengths

// Continuous timeline: the board is a sliding window of WIN_DAYS days rendered
// as one horizontal strip. refDate is the *focused* day, sitting at CENTER_DAY.
// All timeline positions are "global hours" g = dayIndex*24 + hourWithinDay,
// 0..TOTAL_H across the window.
const WIN_BEFORE = 1, WIN_AFTER = 1;
const WIN_DAYS = WIN_BEFORE + 1 + WIN_AFTER;
const TOTAL_H = WIN_DAYS * 24;
const CENTER_DAY = WIN_BEFORE;
function winDayISO(i) { return shiftISO(refDate, i - CENTER_DAY); }
function gHour(dayIdx, hour) { return dayIdx * 24 + hour; }
function gToDay(g) { return Math.max(0, Math.min(WIN_DAYS - 1, Math.floor(g / 24))); }

let state = clone(EMPTY_STATE);
let meetings = [];
let homeTz = restoreHomeTz();
let refDate = todayISO(homeTz);
let scrubHour = nowAxisHour(homeTz);    // pinned scrubber position (home-tz hours)
let activeTeams = new Set();            // team ids shown on the board; empty = everyone
let boardCustom = false;                // board "Custom" mode: pick specific people
let boardPeople = new Set();            // member indices shown when boardCustom
let showBands = localStorage.getItem('tzclock.bands') !== '0';    // working-hour bands
let dayNight = localStorage.getItem('tzclock.daynight') === '1';   // day/night gradient view
let compact = localStorage.getItem('tzclock.compact') === '1';     // dense rows
let expandedPeople = new Set();                                    // per-person expanded lanes
let povPerson = -1;                                                // person whose POV is shown (-1 = device tz)
let search = '';
let userZoomed = localStorage.getItem('tzclock.userZoom') === '1';
let zoom = +(localStorage.getItem('tzclock.zoom') || 48);
let editingIndex = -1;

const $ = id => document.getElementById(id);
function toggleSync(id, on) { const el = $(id); if (el) el.classList.toggle('active', on); }
function restoreHomeTz() {
  const tz = localStorage.getItem('tzclock.home') || browserTz() || 'UTC';
  return isValidZone(tz) ? tz : 'UTC';
}
function cssNum(name) { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0; }
const LW = () => cssNum('--label-w');
const HW = () => cssNum('--hour-w');

// ── boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  state = decodeState(readHash());
  if (!state.org && state.teams.length === 0 && state.members.length === 0) state = demoWorkspace();
  if (!state.wid) state.wid = shortId();
  meetings = loadMeetings(state.wid);

  // First-visit onboarding
  if (!localStorage.getItem('tzclock.onboarded')) showOnboarding();

  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  document.documentElement.style.setProperty('--total-h', TOTAL_H);
  const f12 = localStorage.getItem('tzclock.fmt12');
  if (f12 !== null) setHour12(f12 === '1');
  document.documentElement.classList.toggle('compact-mode', compact);
  $('stage').classList.toggle('daynight-active', dayNight);
  if (localStorage.getItem('tzclock.sideCollapsed') === '1') document.querySelector('.app').classList.add('side-collapsed');
  if (localStorage.getItem('tzclock.mtgOpen') === '0') $('toggleMeetings').closest('.meetings-card').classList.add('collapsed');

  initDaysOff();
  bindControls();
  bindBoard();
  bindMeetingDialog();
  setupComboboxes();

  window.addEventListener('hashchange', () => {
    state = decodeState(readHash());
    if (!state.wid) state.wid = shortId();
    meetings = loadMeetings(state.wid);
    render();
  });
  window.addEventListener('resize', () => { if (!userZoomed) fitZoom(); positionMarkers(); });
  setInterval(positionMarkers, 30000);

  render();
  if (!userZoomed) fitZoom();           // by default, one day fits the screen
  scrollToFocus();                      // ...centered on the focused day in the window
});

function save() {
  saveStateDebounced(state, len => {
    const b = $('urlBadge');
    b.textContent = `${len} chars`;
    b.classList.toggle('warn', len > SAFE_URL_LEN);
  });
  mirrorWorkspace();
}
// Keep a plain-JSON copy of the workspace in localStorage so it's easy to read,
// inspect, or recover — the URL stays the source of truth, this just mirrors it.
function mirrorWorkspace() {
  try { localStorage.setItem('tzclock.workspace.' + state.wid, JSON.stringify(state)); } catch (err) { /* quota/full — non-fatal */ }
}
function persistMeetings() { saveMeetings(state.wid, meetings); }

// ── render ────────────────────────────────────────────────────────────────────
function render() {
  $('org').value = state.org;
  $('datePick').value = refDate;
  syncHomeCombo();
  // Sync toggle buttons
  toggleSync('bandsBtn', showBands);
  toggleSync('dayNightBtn', dayNight);
  toggleSync('compactBtn', compact);
  toggleSync('fmt12Btn', HOUR_12);
  pruneActiveTeams();
  renderDateStrip();
  renderTeamFilter();
  renderTeamSelect();
  renderTeamList();
  renderAxis();
  renderLanes();
  renderRoster();
  renderPlanner();
  renderMeetings();
  positionMarkers();
  updateScrub();
  save();
}

// Members visible on the board (team filter / custom people + search).
// POV person is always sorted first.
function visibleEntries() {
  const q = search.trim().toLowerCase();
  let entries = state.members
    .map((m, gi) => ({ m, gi }))
    .filter(e => inBoardScope(e.gi, e.m) && (!q || e.m.name.toLowerCase().includes(q)));
  if (povPerson >= 0) {
    const idx = entries.findIndex(e => e.gi === povPerson);
    if (idx > 0) { const p = entries.splice(idx, 1)[0]; entries.unshift(p); }
  }
  return entries;
}
function inBoardScope(gi, m) {
  if (boardCustom) return boardPeople.has(gi);
  return activeTeams.size === 0 || activeTeams.has(m.teamId);
}
function scopeMembers() {
  return state.members.filter((m, gi) => inBoardScope(gi, m));
}
function teamById(id) { return state.teams.find(t => t.id === id); }
function hoursLabel(m) { return m.always ? 'Always available' : `${hourLabel(m.start)}–${hourLabel(m.end)}`; }
function teamColor(t) { return t ? (t.customColor || TEAM_COLORS[t.color % TEAM_COLORS.length]) : '#94a3b8'; }
function colorOf(member) { return teamColor(teamById(member.teamId)); }
function pruneActiveTeams() {
  for (const id of [...activeTeams]) if (!teamById(id)) activeTeams.delete(id);
  for (const i of [...boardPeople]) if (!state.members[i]) boardPeople.delete(i);
}

// ── date strip (scrollable; click any day) ────────────────────────────────────
function renderDateStrip() {
  const box = $('dateStrip');
  let html = '';
  for (let d = -7; d <= 14; d++) {
    const iso = shiftISO(refDate, d);
    const dt = DateTime.fromISO(iso);
    const sel = iso === refDate, today = isTodayISO(iso, homeTz);
    html += `<button class="day-cell ${sel ? 'sel' : ''} ${today ? 'today' : ''}" data-iso="${iso}">
      <span class="dc-dow">${dt.toFormat('ccc')}</span><span class="dc-day">${dt.toFormat('dd')}</span><span class="dc-mon">${dt.toFormat('LLL')}</span>${today ? '<span class="dc-dot">●</span>' : ''}</button>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.day-cell').forEach(b => b.addEventListener('click', () => { refDate = b.dataset.iso; render(); scrollToFocus(); }));
  const sel = box.querySelector('.day-cell.sel');
  if (sel) requestAnimationFrame(() => sel.scrollIntoView({ inline: 'center', block: 'nearest' }));
}

// ── team filter (multi-select; also the planner scope) ─────────────────────────
function renderTeamFilter() {
  const box = $('teamFilter');
  const chip = (attr, val, label, on, dot) =>
    `<button class="tf-chip ${dot ? 'person-chip' : ''} ${on ? 'active' : ''}" data-${attr}="${val}">${dot || ''}${esc(label)}</button>`;
  let html = chip('team', '__all', '🌐 Everyone', !boardCustom && activeTeams.size === 0, '');
  for (const t of state.teams) {
    const dot = `<span class="dot" style="background:${teamColor(t)}"></span>`;
    html += chip('team', t.id, t.name, !boardCustom && activeTeams.has(t.id), dot);
  }
  html += chip('team', '__custom', '⭐ Custom', boardCustom, '');
  if (boardCustom && state.members.length) {
    html += '<span class="scope-sep">People</span>';
    state.members.forEach((m, gi) => {
      const dot = `<span class="dot" style="background:${colorOf(m)}"></span>`;
      html += chip('bperson', gi, m.name, boardPeople.has(gi), dot);
    });
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-team]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.team;
    if (id === '__custom') { boardCustom = true; if (boardPeople.size === 0) state.members.forEach((m, gi) => boardPeople.add(gi)); }
    else if (id === '__all') { boardCustom = false; activeTeams.clear(); }
    else { boardCustom = false; activeTeams.has(id) ? activeTeams.delete(id) : activeTeams.add(id); }
    render();
  }));
  box.querySelectorAll('[data-bperson]').forEach(b => b.addEventListener('click', () => {
    const gi = +b.dataset.bperson;
    boardPeople.has(gi) ? boardPeople.delete(gi) : boardPeople.add(gi);
    render();
  }));
}

// ── timeline ───────────────────────────────────────────────────────────────
function renderAxis() {
  const track = $('axisTrack');
  track.innerHTML = '';
  for (let g = 0; g < TOTAL_H; g++) {
    const dayIdx = Math.floor(g / 24), h = g % 24;
    const cell = document.createElement('div');
    cell.className = 'tick' + (h === 0 ? ' daybreak' : '') + (dayIdx === CENTER_DAY ? ' focus-day' : '');
    // At each midnight, label the day instead of "00" so boundaries read clearly.
    const label = h === 0
      ? DateTime.fromISO(winDayISO(dayIdx)).toFormat('ccc d')
      : (HOUR_12 ? hourLabel(h) : String(h).padStart(2, '0'));
    cell.innerHTML = `<span>${label}</span>`;
    track.appendChild(cell);
  }
}

// Their UTC offset on the selected date, e.g. "UTC+5:30" / "UTC−4".
function utcOffsetLabel(tz, iso) {
  const o = DateTime.fromISO(iso, { zone: tz }).offset;     // minutes
  const sign = o >= 0 ? '+' : '−';
  const am = Math.abs(o), h = Math.floor(am / 60), m = am % 60;
  return `UTC${sign}${h}${m ? ':' + pad2(m) : ''}`;
}
// The member's local clock hour at a given axis hour (for the day/night ramp).
function localHourAtAxis(axisH, m, iso = refDate) {
  const inst = axisInstant(axisH, iso, homeTz).setZone(m.tz);
  return inst.hour + inst.minute / 60;
}
// Day/night colour palettes — pick one from settings.
const DN_PALETTES = [
  { name: 'Warm Ember', keys: [
    { h:0,c:[10,10,30]},{h:4,c:[20,15,50]},{h:5,c:[80,25,50]},{h:6,c:[180,70,50]},
    { h:7,c:[220,140,60]},{h:9,c:[245,200,80]},{h:12,c:[253,230,138]},
    { h:15,c:[245,200,80]},{h:17,c:[220,140,60]},{h:18,c:[180,70,50]},
    { h:19,c:[100,30,55]},{h:21,c:[40,20,60]},{h:24,c:[10,10,30]},
  ]},
  { name: 'Soft Gray', keys: [
    { h:0,c:[40,40,42]},{h:4,c:[50,50,52]},{h:5,c:[75,75,77]},{h:6,c:[115,115,117]},
    { h:7,c:[155,155,157]},{h:9,c:[195,195,197]},{h:12,c:[220,220,222]},
    { h:15,c:[195,195,197]},{h:17,c:[155,155,157]},{h:18,c:[115,115,117]},
    { h:19,c:[75,75,77]},{h:21,c:[50,50,52]},{h:24,c:[40,40,42]},
  ]},
  { name: 'Ocean Blue', keys: [
    { h:0,c:[5,10,35]},{h:4,c:[10,25,55]},{h:5,c:[20,55,100]},{h:6,c:[40,110,170]},
    { h:7,c:[80,160,210]},{h:9,c:[140,200,235]},{h:12,c:[180,225,245]},
    { h:15,c:[140,200,235]},{h:17,c:[80,160,210]},{h:18,c:[40,110,170]},
    { h:19,c:[20,55,100]},{h:21,c:[10,25,55]},{h:24,c:[5,10,35]},
  ]},
  { name: 'Mint Forest', keys: [
    { h:0,c:[5,20,15]},{h:4,c:[10,35,25]},{h:5,c:[20,70,50]},{h:6,c:[45,120,85]},
    { h:7,c:[80,165,120]},{h:9,c:[130,205,165]},{h:12,c:[170,225,195]},
    { h:15,c:[130,205,165]},{h:17,c:[80,165,120]},{h:18,c:[45,120,85]},
    { h:19,c:[20,70,50]},{h:21,c:[10,35,25]},{h:24,c:[5,20,15]},
  ]},
  { name: 'Lavender Dusk', keys: [
    { h:0,c:[20,10,35]},{h:4,c:[35,20,55]},{h:5,c:[65,40,90]},{h:6,c:[110,75,140]},
    { h:7,c:[155,120,180]},{h:9,c:[200,175,220]},{h:12,c:[225,205,240]},
    { h:15,c:[200,175,220]},{h:17,c:[155,120,180]},{h:18,c:[110,75,140]},
    { h:19,c:[65,40,90]},{h:21,c:[35,20,55]},{h:24,c:[20,10,35]},
  ]},
  { name: 'Desert Sand', keys: [
    { h:0,c:[30,20,15]},{h:4,c:[45,30,20]},{h:5,c:[85,55,35]},{h:6,c:[145,105,65]},
    { h:7,c:[195,160,110]},{h:9,c:[225,200,155]},{h:12,c:[240,220,185]},
    { h:15,c:[225,200,155]},{h:17,c:[195,160,110]},{h:18,c:[145,105,65]},
    { h:19,c:[85,55,35]},{h:21,c:[45,30,20]},{h:24,c:[30,20,15]},
  ]},
  { name: 'Rose Blush', keys: [
    { h:0,c:[30,10,15]},{h:4,c:[45,18,25]},{h:5,c:[85,35,50]},{h:6,c:[145,70,90]},
    { h:7,c:[195,115,140]},{h:9,c:[225,170,190]},{h:12,c:[240,200,215]},
    { h:15,c:[225,170,190]},{h:17,c:[195,115,140]},{h:18,c:[145,70,90]},
    { h:19,c:[85,35,50]},{h:21,c:[45,18,25]},{h:24,c:[30,10,15]},
  ]},
  { name: 'Cool Arctic', keys: [
    { h:0,c:[15,20,35]},{h:4,c:[20,30,50]},{h:5,c:[35,55,85]},{h:6,c:[65,100,145]},
    { h:7,c:[110,155,195]},{h:9,c:[165,200,225]},{h:12,c:[200,225,240]},
    { h:15,c:[165,200,225]},{h:17,c:[110,155,195]},{h:18,c:[65,100,145]},
    { h:19,c:[35,55,85]},{h:21,c:[20,30,50]},{h:24,c:[15,20,35]},
  ]},
];

// The active palette's gradient stops (Soft Gray is the default = index 1).
function dnKeys() { return DN_PALETTES[1].keys; }   // Soft Gray — the central day/night ramp
function dnColor(h) {
  const keys = dnKeys();
  h = mod24(h);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (h >= a.h && h <= b.h) {
      const t = (h - a.h) / (b.h - a.h || 1);
      const c = a.c.map((v, k) => Math.round(v + (b.c[k] - v) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(13,17,38)';
}
function dayNightGradient(m) {
  const stops = [];
  for (let g = 0; g <= TOTAL_H; g++) {
    const d = Math.min(WIN_DAYS - 1, Math.floor(g / 24)), h = g - d * 24;
    stops.push(`${dnColor(localHourAtAxis(h, m, winDayISO(d)))} ${(g / TOTAL_H * 100).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(',')})`;
}

function renderLanes() {
  const wrap = $('lanes');
  wrap.innerHTML = '';
  const entries = visibleEntries();
  if (entries.length === 0) {
    const why = state.members.length ? 'No teammates match this filter.' : 'No teammates yet — add one from the Team panel.';
    wrap.innerHTML = `<div class="tl-row"><div class="empty" style="grid-column:1/-1">${why}</div></div>`;
    return;
  }
  for (const { m, gi } of entries) {
    const off = isMemberOff(m, refDate);
    const offset = utcOffsetLabel(m.tz, refDate);
    const isExpanded = expandedPeople.has(gi);
    const isPov = gi === povPerson;
    const row = document.createElement('div');
    row.className = 'tl-row lane' + (off ? ' off' : '') + (isPov ? ' pov' : '');
    row.dataset.gi = gi;

    let bands = '';
    if (showBands) {
      for (let d = 0; d < WIN_DAYS; d++) {
        const iso = winDayISO(d);
        bands += bandToAxisIntervals(m, iso, homeTz)
          .map(iv => `<div class="band" style="left:${gHour(d, iv.start) / TOTAL_H * 100}%;width:${(iv.end - iv.start) / TOTAL_H * 100}%;--bc:${colorOf(m)}"></div>`)
          .join('');
      }
    }

    let dn = '', trackStyle = '';
    if (dayNight) {
      trackStyle = ` style="background:${dayNightGradient(m)}"`;
      for (let d = 0; d < WIN_DAYS; d++) {
        const iso = winDayISO(d);
        const pos = (mh) => gHour(d, memberHourToAxis(mh, m.tz, iso, homeTz)) / TOTAL_H * 100;
        dn += `<span class="celestial sun" style="left:${pos(12)}%" title="Their midday ☀">☀️</span>
            <span class="celestial moon" style="left:${pos(0)}%" title="Their midnight ☾">☾</span>
            <span class="celestial dawn" style="left:${pos(6)}%" title="Their sunrise">⬆</span>
            <span class="celestial dusk" style="left:${pos(18)}%" title="Their sunset">⬇</span>`;
      }
    }

    const expandIcon = isExpanded ? '▾' : '▸';
    row.innerHTML = `
      <div class="tl-label">
        <span class="dot" style="background:${colorOf(m)}"></span>
        <button class="lane-expand ${isExpanded ? 'expanded' : ''}" data-expand="${gi}" title="Toggle details">${expandIcon}</button>
        <div class="who">
          <div class="name">${esc(m.name)}${off ? ' <span class="tag-off">off</span>' : ''}
            <span class="live mono" id="live-${gi}" title="Their local time at the scrubber">—</span></div>
          <div class="meta">${esc(labelForTz(m.tz))} · ${hoursLabel(m)} · <span class="mono">${offset}</span></div>
        </div>
        <button class="lane-tz ${gi === povPerson ? 'active' : ''}" data-ltz="${esc(m.tz)}" data-gi="${gi}" title="${gi === povPerson ? esc(m.name) + "'s view — click to reset" : 'View board from ' + esc(m.name) + "'s perspective"}">⌖</button>
      </div>
      <div class="tl-track work${dayNight ? ' dn' : ''}"${trackStyle}>${dn}${bands}</div>`;
    wrap.appendChild(row);

    if (isExpanded) {
      const localNow = localAt(scrubHour, m, refDate, homeTz);
      const detail = document.createElement('div');
      detail.className = 'tl-row lane-detail open';
      detail.innerHTML = `<div class="tl-label"></div>
        <div class="tl-track">
          <span class="utc-big">${offset}</span>
          <span>📍 ${esc(labelForTz(m.tz))}</span>
          <span>🕐 <span class="local-clock">${localNow.label}</span></span>
          <span>⏰ ${hoursLabel(m)}</span>
          ${off ? '<span>🔴 Off today</span>' : '<span>🟢 Working today</span>'}
        </div>`;
      wrap.appendChild(detail);
    }
  }
  wrap.querySelectorAll('.lane-tz').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const gi = +b.dataset.gi;
    // Toggle: clicking the active POV resets to device timezone
    if (povPerson === gi) { povPerson = -1; localStorage.removeItem('tzclock.home'); homeTz = browserTz(); }
    else { povPerson = gi; homeTz = b.dataset.ltz; localStorage.setItem('tzclock.home', homeTz); }
    render();
  }));
}

function xForHour(g) { return LW() + g * HW(); }      // g = global window hour (0..TOTAL_H)
function scrubGlobal() { return gHour(CENTER_DAY, scrubHour); }   // pinned scrubber's global hour
function daysBetween(a, b) { return Math.round(DateTime.fromISO(b).diff(DateTime.fromISO(a), 'days').days); }
function scrollToFocus() { $('board').scrollLeft = CENTER_DAY * 24 * HW(); }   // bring the focused day into view

// Pointer x (client coords) → global window hour, or null if over the name column.
function hourFromClientX(clientX) {
  const r = $('boardInner').getBoundingClientRect();
  const x = clientX - r.left - LW();
  if (x < 0) return null;
  return Math.min(TOTAL_H, Math.max(0, x / HW()));
}

// Hover to read every zone's time; click to pin; double-click to block; wheel
// past either edge spills into the next/previous day (the "infinite" scroll).
function bindBoard() {
  const inner = $('boardInner');
  const board = $('board');
  const lanes = $('lanes');
  let downX = null;

  // Per-person expand/collapse (single delegation, not per-render)
  lanes.addEventListener('click', e => {
    const btn = e.target.closest('[data-expand]');
    if (!btn) return;
    const gi = +btn.dataset.expand;
    expandedPeople.has(gi) ? expandedPeople.delete(gi) : expandedPeople.add(gi);
    renderLanes(); positionMarkers(); updateScrub();
  });

  inner.addEventListener('pointermove', e => {
    if (e.target.closest('.tl-label')) return;
    const g = hourFromClientX(e.clientX);
    if (g == null) return;
    placeScrub(g); updateScrub(g); showTip(g);
  });
  inner.addEventListener('pointerleave', () => { placeScrub(scrubGlobal()); updateScrub(); hideTip(); });
  inner.addEventListener('pointerdown', e => { if (!e.target.closest('.tl-label')) downX = e.clientX; });
  inner.addEventListener('pointerup', e => {
    if (e.target.closest('.tl-label')) return;
    const g = hourFromClientX(e.clientX);
    if (g != null) pinScrub(g);
    downX = null;
  });

  inner.addEventListener('dblclick', e => {
    if (e.target.closest('.tl-label')) return;
    const g = hourFromClientX(e.clientX);
    if (g == null) return;
    const scope = currentScopeWorking();
    openMeetingDialog({ date: winDayISO(gToDay(g)), start: Math.round((g % 24) * 2) / 2, attendees: scope.map(m => m.name) });
  });

  $('scrubber').addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { scrubHour = mod24(scrubHour + 0.25); placeScrub(scrubGlobal()); updateScrub(); }
    if (e.key === 'ArrowLeft') { scrubHour = mod24(scrubHour - 0.25); placeScrub(scrubGlobal()); updateScrub(); }
  });

  // Edge spill-over: keep scrolling past the end of the day to roll into the next.
  let spill = 0;
  board.addEventListener('wheel', e => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
    if (!dx) return;
    const atRight = board.scrollLeft + board.clientWidth >= board.scrollWidth - 2;
    const atLeft = board.scrollLeft <= 1;
    if (dx > 0 && atRight) { spill += dx; if (spill > 140) { spill = 0; rollDay(+1); } e.preventDefault(); }
    else if (dx < 0 && atLeft) { spill += dx; if (spill < -140) { spill = 0; rollDay(-1); } e.preventDefault(); }
    else spill = 0;
  }, { passive: false });
}

function rollDay(dir) {
  refDate = shiftISO(refDate, dir);
  render();
  scrollToFocus();        // keep the focused day centered as the window slides
}

// Pin the scrubber at global hour g. Clicking into a neighbour day promotes it to
// the focused day (so the planner, blocks and "now" follow you across days).
function pinScrub(g) {
  const dayIdx = gToDay(g);
  scrubHour = g % 24;
  if (dayIdx !== CENTER_DAY) { refDate = winDayISO(dayIdx); render(); scrollToFocus(); }
  else { placeScrub(scrubGlobal()); updateScrub(); }
}

function placeScrub(g) { $('scrubber').style.left = xForHour(g) + 'px'; }
function showTip(g) { const t = $('hoverTip'); t.hidden = false; t.textContent = hourLabel(g % 24); t.style.left = xForHour(g) + 'px'; }
function hideTip() { $('hoverTip').hidden = true; }

function positionMarkers() {
  const now = $('nowMarker');
  const dayIdx = CENTER_DAY + daysBetween(refDate, todayISO(homeTz));
  if (dayIdx >= 0 && dayIdx < WIN_DAYS) { now.style.display = ''; now.style.left = xForHour(gHour(dayIdx, nowAxisHour(homeTz))) + 'px'; }
  else now.style.display = 'none';
  placeScrub(scrubGlobal());
  renderBlocks();
}

// Translucent spans for meetings anywhere in the visible window.
function renderBlocks() {
  const inner = $('boardInner');
  inner.querySelectorAll('.block-span').forEach(e => e.remove());
  const hw = HW(), lw = LW();
  for (const m of meetings) {
    const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
    const dayIdx = CENTER_DAY + daysBetween(refDate, dt.toISODate());
    if (dayIdx < 0 || dayIdx >= WIN_DAYS) continue;
    const g = gHour(dayIdx, dt.hour + dt.minute / 60);
    const el = document.createElement('div');
    el.className = 'block-span';
    el.style.left = (lw + g * hw) + 'px';
    el.style.width = (m.durationMin / 60 * hw) + 'px';
    el.innerHTML = `<span>${esc(m.title)}</span>`;
    inner.appendChild(el);
  }
}

function updateScrub(g = scrubGlobal()) {
  const dayIdx = gToDay(g), hourWithin = g % 24, dayISO = winDayISO(dayIdx);
  const dateStr = DateTime.fromISO(dayISO).toFormat('ccc dd LLL');
  const povLabel = povPerson >= 0 && state.members[povPerson]
    ? esc(state.members[povPerson].name) + "'s view"
    : esc(labelForTz(homeTz));
  $('scrubReadout').innerHTML = `<b>${esc(dateStr)}</b> · ${hourLabel(hourWithin)} · ${povLabel}`;
  for (const { m, gi } of visibleEntries()) {
    const el = $('live-' + gi);
    if (!el) continue;
    const { label, working } = localAt(hourWithin, m, dayISO, homeTz);
    el.textContent = label;
    el.classList.toggle('working', working);
  }
}

// ── roster (drag & drop) ─────────────────────────────────────────────────────
function renderRoster() {
  const box = $('roster');
  box.innerHTML = '';
  const q = search.trim().toLowerCase();
  const groups = [...state.teams.map(t => ({ id: t.id, name: t.name, color: t.color })), { id: '', name: 'Unassigned', color: -1 }];

  for (const g of groups) {
    const members = state.members.map((m, gi) => ({ m, gi }))
      .filter(e => (e.m.teamId || '') === g.id && (!q || e.m.name.toLowerCase().includes(q)));
    if (g.id === '' && members.length === 0) continue;   // hide empty Unassigned

    const grp = document.createElement('div');
    grp.className = 'team-group';
    grp.dataset.team = g.id;
    const swatch = g.color >= 0 ? `<span class="dot" style="background:${teamColor(teamById(g.id))}"></span>` : '';
    grp.innerHTML = `<div class="group-head">${swatch}${esc(g.name)} <span class="count">${members.length}</span></div>
      <div class="chips">${members.map(({ m, gi }) => personChip(m, gi)).join('') || '<span class="muted small">drop here</span>'}</div>`;
    box.appendChild(grp);
  }

  box.querySelectorAll('.person').forEach(chip => {
    chip.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', chip.dataset.gi); chip.classList.add('dragging'); });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    chip.addEventListener('click', () => { startEdit(+chip.dataset.gi); openDrawer(); });
  });
  box.querySelectorAll('.team-group').forEach(grp => {
    grp.addEventListener('dragover', e => { e.preventDefault(); grp.classList.add('drop'); });
    grp.addEventListener('dragleave', () => grp.classList.remove('drop'));
    grp.addEventListener('drop', e => {
      e.preventDefault(); grp.classList.remove('drop');
      const gi = +e.dataTransfer.getData('text/plain');
      if (!Number.isNaN(gi) && state.members[gi]) { state.members[gi].teamId = grp.dataset.team; render(); }
    });
  });
}

function personChip(m, gi) {
  const initials = m.name.trim().slice(0, 1).toUpperCase() || '?';
  return `<span class="person" draggable="true" data-gi="${gi}" title="Drag to a team · click to edit">
    <span class="avatar" style="background:${colorOf(m)}">${esc(initials)}</span>
    ${esc(m.name)} <span class="ptz">${esc(labelForTz(m.tz))}</span></span>`;
}

// ── planner ──────────────────────────────────────────────────────────────────
function currentScopeWorking() {
  return scopeMembers().filter(m => !isMemberOff(m, refDate));
}
// 15-min occupancy of saved meetings on the selected date (in home tz).
function busyCellsForDate() {
  const cells = new Array(96).fill(false);
  for (const m of meetings) {
    const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
    if (dt.toISODate() !== refDate) continue;
    markCells(cells, dt.hour + dt.minute / 60, m.durationMin / 60);
  }
  return cells;
}
function markCells(cells, startH, durH) {
  const n = Math.max(1, Math.round(durH / 0.25)), s0 = Math.round(startH / 0.25);
  for (let i = 0; i < n; i++) cells[(((s0 + i) % 96) + 96) % 96] = true;
}
function slotIsBusy(startH, durH, cells) {
  const n = Math.max(1, Math.round(durH / 0.25)), s0 = Math.round(startH / 0.25);
  for (let i = 0; i < n; i++) if (cells[(((s0 + i) % 96) + 96) % 96]) return true;
  return false;
}
function refreshPlanner() { renderPlanner(); positionMarkers(); }

// The planner follows whoever is shown on the board (the "Show" filter at the
// top) — one scope, not a second duplicate selector. Narrow the board to a
// sub-team and the planner narrows with it.
function boardScopeLabel() {
  if (boardCustom) return `${boardPeople.size} selected`;
  if (activeTeams.size === 0) return 'everyone';
  const names = [...activeTeams].map(id => teamById(id)?.name).filter(Boolean);
  return names.length === 1 ? names[0] : 'the selected teams';
}

function renderPlanner() {
  const scope = scopeMembers();
  const working = scope.filter(m => !isMemberOff(m, refDate));
  const offToday = scope.filter(m => isMemberOff(m, refDate));
  $('plannerScopeName').textContent = boardScopeLabel();

  const box = $('planner');
  const offNote = offToday.length
    ? `<p class="muted small off-note">Off today: ${offToday.map(m => esc(m.name)).join(', ')} (excluded)</p>` : '';
  if (working.length < 2) { box.innerHTML = offNote + '<p class="muted small">Pick at least two available teammates in “Show” above.</p>'; return; }

  const windows = findOverlapWindows(working, refDate, homeTz);
  if (windows.length === 0) { box.innerHTML = offNote + '<p class="no-overlap small">No shared time today. Narrow “Show” to a sub-team, or try another date.</p>'; return; }

  const durMin = +$('duration').value;
  const busy = busyCellsForDate();
  const slots = generateSlots(windows, durMin / 60).filter(s => !slotIsBusy(s.start, durMin / 60, busy));
  const blockedCount = meetings.filter(m => DateTime.fromISO(m.startUTC).setZone(homeTz).toISODate() === refDate).length;
  const attendees = working.map(m => m.name);

  const blockNote = blockedCount
    ? `<p class="muted small block-note">⛌ ${blockedCount} block${blockedCount > 1 ? 's' : ''} on this day.</p>` : '';
  const slotBtns = slots.length
    ? `<div class="slots"><span class="muted small">${durMin} min · </span>${slots.slice(0, 6).map(s => `<button class="slot" data-start="${s.start}">${hourLabel(s.start)}</button>`).join('')}</div>`
    : `<p class="muted small">No free ${durMin}-min slot${blockedCount ? ' (time is blocked)' : ''} — try shorter or another date.</p>`;

  box.innerHTML = offNote + blockNote + slotBtns;
  box.querySelectorAll('.slot').forEach(b => b.addEventListener('click', () => openMeetingDialog({ start: +b.dataset.start, durationMin: durMin, attendees })));
}

// ── saved meetings ─────────────────────────────────────────────────────────────
function renderMeetings() {
  $('mtgCount').textContent = meetings.length ? `(${meetings.length})` : '';
  const box = $('meetings');
  if (meetings.length === 0) { box.innerHTML = '<p class="muted small">No saved meetings yet. Use ＋ Block time, double-click the timeline, or pick a slot.</p>'; return; }
  const sorted = [...meetings].sort((a, b) => a.startUTC < b.startUTC ? -1 : 1);
  box.innerHTML = sorted.map(m => {
    const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
    const sh = dt.hour + dt.minute / 60;
    const when = `${dt.toFormat('ccc dd LLL')} · ${hourLabel(sh)}–${hourLabel(sh + m.durationMin / 60)}`;
    return `<div class="mtg ${m.status}">
      <div class="mtg-head"><strong>${esc(m.title)}</strong><span class="status-pill ${m.status}">${m.status}</span></div>
      <div class="muted small">${esc(when)} · ${m.durationMin} min</div>
      ${m.attendees.length ? `<div class="muted small">👥 ${m.attendees.map(esc).join(', ')}</div>` : ''}
      ${m.notes ? `<div class="mtg-notes">${esc(m.notes)}</div>` : ''}
      <div class="mtg-actions">
        <button class="btn ghost" data-medit="${m.id}">Edit</button>
        <button class="btn ghost" data-mbook="${m.id}">${m.status === 'booked' ? 'Unbook' : 'Book'}</button>
        <button class="btn ghost" data-mics="${m.id}">⬇︎ .ics</button>
        <a class="btn ghost" target="_blank" rel="noopener" href="${googleCalUrl(m)}">📅 Google</a>
        <button class="btn ghost danger" data-mdel="${m.id}">✕</button>
      </div></div>`;
  }).join('');
  const find = id => meetings.find(x => x.id === id);
  box.querySelectorAll('[data-medit]').forEach(b => b.addEventListener('click', () => editMeeting(b.dataset.medit)));
  box.querySelectorAll('[data-mbook]').forEach(b => b.addEventListener('click', () => { const m = find(b.dataset.mbook); m.status = m.status === 'booked' ? 'proposed' : 'booked'; persistMeetings(); renderMeetings(); }));
  box.querySelectorAll('[data-mics]').forEach(b => b.addEventListener('click', () => downloadIcs(find(b.dataset.mics))));
  box.querySelectorAll('[data-mdel]').forEach(b => b.addEventListener('click', () => {
    const m = find(b.dataset.mdel);
    if (m && !confirm(`Delete meeting "${m.title}"?`)) return;
    meetings = meetings.filter(x => x.id !== b.dataset.mdel); persistMeetings(); renderMeetings(); refreshPlanner();
  }));
}

// ── meeting dialog (date / time / length editable inline) ──────────────────────
let editingMeetingId = null;
function bindMeetingDialog() {
  $('mtgDur').innerHTML = DUR_OPTS.map(d => `<option value="${d}">${durLabel(d)}</option>`).join('');
  ['mtgDate', 'mtgStart', 'mtgDur'].forEach(id => $(id).addEventListener('input', updateMeetingWhen));

  const dlg = $('meetingDialog');
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') { editingMeetingId = null; return; }
    const date = $('mtgDate').value || refDate;
    const sh = parseTime($('mtgStart').value || '09:00');
    const durationMin = +$('mtgDur').value;
    const data = {
      title: $('meetingTitle').value.trim() || 'Blocked',
      attendees: $('meetingAttendees').value.split(',').map(s => s.trim()).filter(Boolean),
      notes: $('meetingNotes').value.trim(),
      startUTC: axisInstant(sh, date, homeTz).toUTC().toISO(),
      durationMin,
    };
    if (editingMeetingId) Object.assign(meetings.find(x => x.id === editingMeetingId), data);
    else meetings.push(makeMeeting(data));
    editingMeetingId = null;
    persistMeetings(); renderMeetings(); refreshPlanner(); toast('💾 Saved on this device.');
  });
}
function updateMeetingWhen() {
  const date = $('mtgDate').value, t = $('mtgStart').value;
  if (!date || !t) { $('meetingWhen').textContent = ''; return; }
  const sh = parseTime(t), dur = +$('mtgDur').value;
  $('meetingWhen').textContent = `${prettyDate(date)} · ${hourLabel(sh)}–${hourLabel(sh + dur / 60)} (${labelForTz(homeTz)})`;
}
function openMeetingDialog({ date = refDate, start = scrubHour, durationMin = 60, attendees = [], title = '' } = {}) {
  editingMeetingId = null;
  $('meetingDialogTitle').textContent = 'Block / schedule time';
  $('mtgDate').value = date;
  $('mtgStart').value = toTimeInput(Math.round(start * 4) / 4);   // snap to 15 min
  $('mtgDur').value = String(nearestDur(durationMin));
  $('meetingTitle').value = title;
  $('meetingAttendees').value = attendees.join(', ');
  $('meetingNotes').value = '';
  updateMeetingWhen();
  $('meetingDialog').showModal();
}
function editMeeting(id) {
  const m = meetings.find(x => x.id === id); if (!m) return;
  editingMeetingId = id;
  const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
  $('meetingDialogTitle').textContent = 'Edit meeting';
  $('mtgDate').value = dt.toISODate();
  $('mtgStart').value = toTimeInput(dt.hour + dt.minute / 60);
  $('mtgDur').value = String(nearestDur(m.durationMin));
  $('meetingTitle').value = m.title; $('meetingAttendees').value = m.attendees.join(', '); $('meetingNotes').value = m.notes;
  updateMeetingWhen();
  $('meetingDialog').showModal();
}
function durLabel(d) { return d % 60 === 0 ? (d / 60 === 1 ? '1 hour' : (d / 60) + ' hours') : d + ' min'; }
function nearestDur(d) { return DUR_OPTS.reduce((a, b) => Math.abs(b - d) < Math.abs(a - d) ? b : a, DUR_OPTS[0]); }

// ── days-off toggles ───────────────────────────────────────────────────────────
function initDaysOff() {
  const box = $('mDaysOff');
  box.innerHTML = DAY_LABELS.map((l, i) => `<button type="button" class="day-toggle" data-day="${i + 1}">${l}</button>`).join('');
  box.querySelectorAll('.day-toggle').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
  setDaysOff(DEFAULT_WEEKEND);
}
function setDaysOff(days) { document.querySelectorAll('#mDaysOff .day-toggle').forEach(b => b.classList.toggle('on', days.includes(+b.dataset.day))); }
function getDaysOff() { return [...document.querySelectorAll('#mDaysOff .day-toggle.on')].map(b => +b.dataset.day); }

// ── comboboxes (timezone search) ───────────────────────────────────────────────
function setupComboboxes() {
  makeCombo($('mTz'), $('mTzList'), () => {});
  makeCombo($('homeTz'), $('homeTzList'), setHomeTz);
}

// Explicitly view the whole board in a chosen zone. Unlike POV (which re-bases to
// a teammate), this is just a viewer zone, so it cancels any active POV.
function setHomeTz(tz) {
  if (!isValidZone(tz)) return;
  homeTz = tz;
  povPerson = -1;
  localStorage.setItem('tzclock.home', tz);
  render();
}
// Keep the picker showing the current home zone, but never overwrite what the
// user is actively typing into it.
function syncHomeCombo() {
  const el = $('homeTz');
  if (el && document.activeElement !== el) { el.value = labelForTz(homeTz); el.dataset.tz = homeTz; }
}
function makeCombo(input, list, onPick) {
  let items = [], active = -1;
  const optId = i => `${list.id}-opt-${i}`;
  const syncAria = () => {
    const open = !list.hidden;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && active >= 0) input.setAttribute('aria-activedescendant', optId(active));
    else input.removeAttribute('aria-activedescendant');
  };
  const open = () => { items = tzSearch(input.value, 8); active = -1; draw(); list.hidden = items.length === 0; syncAria(); };
  const close = () => { list.hidden = true; syncAria(); };
  const draw = () => {
    list.innerHTML = items.map((it, i) => `<li id="${optId(i)}" role="option" aria-selected="${i === active}" class="cb-item ${i === active ? 'active' : ''}" data-i="${i}">${esc(it.label)}<span class="cb-tz">${esc(it.tz)}</span></li>`).join('');
    syncAria();
  };
  const pick = it => { input.value = it.label; input.dataset.tz = it.tz; close(); onPick(it.tz); };
  // Typing invalidates any previously-picked zone, so we never save a stale tz
  // (pick "India", retype "London" without re-picking → must not save Kolkata).
  input.addEventListener('input', () => { input.dataset.tz = ''; open(); });
  input.addEventListener('focus', open);
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[active]) { pick(items[active]); e.preventDefault(); } }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(items[+li.dataset.i]); } });
  input.addEventListener('blur', () => setTimeout(close, 120));
  return { resolve: () => input.dataset.tz || (tzSearch(input.value, 1)[0] || {}).tz || '' };
}

// ── forms & controls ───────────────────────────────────────────────────────────
function bindControls() {
  $('org').addEventListener('input', e => { state.org = e.target.value; save(); });

  $('prevDay').addEventListener('click', () => { refDate = shiftISO(refDate, -1); render(); scrollToFocus(); });
  $('nextDay').addEventListener('click', () => { refDate = shiftISO(refDate, +1); render(); scrollToFocus(); });
  $('todayBtn').addEventListener('click', () => { refDate = todayISO(homeTz); render(); scrollToFocus(); });
  $('datePick').addEventListener('change', e => { if (e.target.value) { refDate = e.target.value; render(); scrollToFocus(); } });
  $('dsPrev').addEventListener('click', () => { $('dateStrip').scrollBy({ left: -200, behavior: 'smooth' }); });
  $('dsNext').addEventListener('click', () => { $('dateStrip').scrollBy({ left: 200, behavior: 'smooth' }); });

  $('zoomIn').addEventListener('click', () => setZoom(zoom + 12));
  $('zoomOut').addEventListener('click', () => setZoom(zoom - 12));
  $('fitBtn').addEventListener('click', () => { userZoomed = false; localStorage.setItem('tzclock.userZoom', '0'); fitZoom(); });
  $('bandsBtn').addEventListener('click', () => {
    showBands = !showBands; localStorage.setItem('tzclock.bands', showBands ? '1' : '0');
    toggleSync('bandsBtn', showBands); renderLanes();
  });
  $('dayNightBtn').addEventListener('click', () => {
    dayNight = !dayNight; localStorage.setItem('tzclock.daynight', dayNight ? '1' : '0');
    $('stage').classList.toggle('daynight-active', dayNight);
    toggleSync('dayNightBtn', dayNight); renderLanes(); positionMarkers(); updateScrub(); renderPlanner();
  });
  $('compactBtn').addEventListener('click', () => {
    compact = !compact; localStorage.setItem('tzclock.compact', compact ? '1' : '0');
    document.documentElement.classList.toggle('compact-mode', compact);
    toggleSync('compactBtn', compact); positionMarkers();
  });
  $('fmt12Btn').addEventListener('click', () => {
    const v = !HOUR_12; setHour12(v); localStorage.setItem('tzclock.fmt12', v ? '1' : '0');
    toggleSync('fmt12Btn', v); render();
  });
  // Settings panel toggle
  const settingsBtn = $('settingsBtn');
  const settingsPanel = $('settingsPanel');
  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', () => { settingsPanel.hidden = !settingsPanel.hidden; });
    document.addEventListener('click', e => { if (!settingsPanel.hidden && !e.target.closest('.settings-wrap')) settingsPanel.hidden = true; });
  }
  $('search').addEventListener('input', e => { search = e.target.value; renderLanes(); renderRoster(); updateScrub(); });
  $('duration').addEventListener('change', renderPlanner);
  $('blockBtn').addEventListener('click', () => {
    const scope = currentScopeWorking();
    openMeetingDialog({ start: Math.round(scrubHour * 2) / 2, attendees: scope.map(m => m.name) });
  });

  $('openAdd').addEventListener('click', () => { resetForm(); openDrawer(); $('mName').focus(); });
  $('openTeams').addEventListener('click', () => { openDrawer(); $('teamName').focus(); });
  $('closeDrawer').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  $('memberForm').addEventListener('submit', onSubmitMember);
  $('mAlways').addEventListener('change', syncAlways);
  document.querySelectorAll('.hours-presets .chip-btn').forEach(b => b.addEventListener('click', () => {
    const [s, e] = b.dataset.preset.split('-').map(Number);
    $('mAlways').checked = false; syncAlways();
    $('mStart').value = pad2(s) + ':00'; $('mEnd').value = pad2(e) + ':00';
    $('mOvernight').checked = s >= e;
  }));
  $('dummyBtn').addEventListener('click', addDummy);
  $('deleteMemberBtn').addEventListener('click', () => {
    if (editingIndex < 0) return;
    const m = state.members[editingIndex];
    if (!confirm(`Remove ${m.name} from the team?`)) return;
    state.members.splice(editingIndex, 1); closeDrawer(); render();
  });

  $('teamForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('teamName').value.trim(); if (!name) return;
    state.teams.push({ id: shortId(), name, color: state.teams.length % TEAM_COLORS.length });
    $('teamName').value = ''; render();
  });

  $('toggleMeetings').addEventListener('click', () => {
    const card = $('toggleMeetings').closest('.meetings-card');
    card.classList.toggle('collapsed');
    localStorage.setItem('tzclock.mtgOpen', card.classList.contains('collapsed') ? '0' : '1');
  });

  $('sideToggle').addEventListener('click', () => {
    const collapsed = document.querySelector('.app').classList.toggle('side-collapsed');
    localStorage.setItem('tzclock.sideCollapsed', collapsed ? '1' : '0');
    if (!userZoomed) fitZoom(); else positionMarkers();
  });

  $('shareBtn').addEventListener('click', share);
}

// Fit the whole 24h day inside the board (the default — no horizontal scroll).
function fitZoom() {
  const board = $('board');
  const avail = board.clientWidth - LW() - 2;
  if (avail <= 0) return;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor(avail / 24)));   // one day to the screen
  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  positionMarkers();
  scrollToFocus();
}
function setZoom(z) {
  userZoomed = true;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  localStorage.setItem('tzclock.zoom', zoom);
  localStorage.setItem('tzclock.userZoom', '1');
  positionMarkers();
  scrollToFocus();
}
function openDrawer() { $('scrim').hidden = false; $('drawer').hidden = false; }
function closeDrawer() { $('scrim').hidden = true; $('drawer').hidden = true; resetForm(); }

function renderTeamSelect() {
  const sel = $('mTeam'); const keep = sel.value;
  sel.innerHTML = '<option value="">— No team —</option>' + state.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = keep;
}
function renderTeamList() {
  const ul = $('teamList');
  if (state.teams.length === 0) { ul.innerHTML = '<li class="muted small">No teams yet.</li>'; return; }
  ul.innerHTML = state.teams.map(t => {
    const count = state.members.filter(m => m.teamId === t.id).length;
    return `<li><button class="dot dot-btn" style="background:${teamColor(t)}" data-colorteam="${t.id}" title="Change colour" aria-label="Change ${esc(t.name)} colour"></button>
      <span class="tname">${esc(t.name)}</span><span class="muted small">${count}</span>
      <button class="icon" data-delteam="${t.id}" title="Delete team">🗑️</button></li>`;
  }).join('');
  ul.querySelectorAll('[data-colorteam]').forEach(b => b.addEventListener('click', e => openColorPicker(b.dataset.colorteam, b)));
  ul.querySelectorAll('[data-delteam]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.delteam;
    const t = teamById(id);
    const count = state.members.filter(m => m.teamId === id).length;
    const note = count ? ` ${count} teammate${count > 1 ? 's' : ''} will move to Unassigned.` : '';
    if (!confirm(`Delete team "${t ? t.name : ''}"?` + note)) return;
    state.teams = state.teams.filter(t => t.id !== id);
    state.members.forEach(m => { if (m.teamId === id) m.teamId = ''; });
    activeTeams.delete(id);
    render();
  }));
}

// ── team colour picker (palette swatches + custom) ─────────────────────────────
let _colorPop = null;
function closeColorPicker() {
  if (_colorPop) { _colorPop.remove(); _colorPop = null; document.removeEventListener('mousedown', _cpOutside, true); }
}
function _cpOutside(e) {
  if (!e.target.closest('.color-pop') && !e.target.closest('[data-colorteam]')) closeColorPicker();
}
function openColorPicker(teamId, anchor) {
  closeColorPicker();
  const t = teamById(teamId); if (!t) return;
  const pop = document.createElement('div');
  pop.className = 'color-pop';
  const swatches = TEAM_COLORS.map((c, i) =>
    `<button class="cp-swatch ${!t.customColor && t.color === i ? 'sel' : ''}" style="background:${c}" data-ci="${i}" title="Colour ${i + 1}"></button>`).join('');
  pop.innerHTML = `<div class="cp-grid">${swatches}</div>
    <label class="cp-custom">Custom <input type="color" value="${teamColor(t)}" aria-label="Custom team colour" /></label>`;
  document.body.appendChild(pop);
  _colorPop = pop;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.querySelectorAll('[data-ci]').forEach(b => b.addEventListener('click', () => {
    t.color = +b.dataset.ci; delete t.customColor; closeColorPicker(); render();
  }));
  const inp = pop.querySelector('input[type=color]');
  inp.addEventListener('input', e => { t.customColor = e.target.value; render(); });   // live preview
  inp.addEventListener('change', () => { closeColorPicker(); render(); });
  setTimeout(() => document.addEventListener('mousedown', _cpOutside, true), 0);
}

function onSubmitMember(e) {
  e.preventDefault();
  const name = $('mName').value.trim();
  const raw = $('mTz').value.trim();
  const tz = $('mTz').dataset.tz || (tzSearch(raw, 1)[0] || {}).tz || (isValidZone(raw) ? raw : '');
  const always = $('mAlways').checked;
  const start = parseTime($('mStart').value);
  const end = parseTime($('mEnd').value);
  const overnight = $('mOvernight').checked;
  const teamId = $('mTeam').value;
  const weekend = getDaysOff();

  const err = validateMember({ name, tz, start, end, overnight, always });
  const errEl = $('formError');
  if (err) { errEl.textContent = err; errEl.hidden = false; return; }
  errEl.hidden = true;

  const member = { name, tz, start, end, teamId, weekend, always };
  if (editingIndex >= 0) state.members[editingIndex] = member; else state.members.push(member);
  closeDrawer(); render();
}

function validateMember({ name, tz, start, end, overnight, always }) {
  if (!name) return 'Please enter a name.';
  if (!isValidZone(tz)) return 'Pick a location, or type a UTC offset like +5:30.';
  if (always) return null;                                  // "always available" ignores hours
  if (!isWorkHour(start) || !isWorkHour(end)) return 'Use 30-minute steps.';
  if (start === end) return 'Start and end cannot be the same.';
  if (!overnight && start >= end) return 'Start must be before end — or tick “Overnight shift”.';
  return null;
}

// Grey out the hours fields when "always available" is on.
function syncAlways() {
  const on = $('mAlways').checked;
  $('hoursRow').classList.toggle('disabled', on);
  document.querySelectorAll('.hours-presets .chip-btn').forEach(b => b.disabled = on);
  $('mStart').disabled = on; $('mEnd').disabled = on;
}

function startEdit(gi) {
  const m = state.members[gi];
  editingIndex = gi;
  $('mName').value = m.name;
  $('mTz').value = labelForTz(m.tz); $('mTz').dataset.tz = m.tz;
  $('mAlways').checked = !!m.always;
  $('mStart').value = toTimeInput(m.start); $('mEnd').value = toTimeInput(m.end);
  $('mOvernight').checked = m.start >= m.end;
  syncAlways();
  setDaysOff(m.weekend || DEFAULT_WEEKEND);
  renderTeamSelect(); $('mTeam').value = m.teamId;
  $('drawerTitle').textContent = 'Edit teammate';
  $('saveMemberBtn').textContent = 'Save changes';
  $('deleteMemberBtn').hidden = false;
}
function resetForm() {
  editingIndex = -1;
  $('memberForm').reset();
  $('mTz').dataset.tz = '';
  $('mAlways').checked = false;
  $('mStart').value = '09:00'; $('mEnd').value = '17:00';
  syncAlways();
  setDaysOff(DEFAULT_WEEKEND);
  $('formError').hidden = true;
  $('drawerTitle').textContent = 'Add a teammate';
  $('saveMemberBtn').textContent = 'Add teammate';
  $('deleteMemberBtn').hidden = true;
}

const DUMMY_NAMES = ['Ava', 'Noah', 'Mei', 'Omar', 'Sofia', 'Liam', 'Priya', 'Diego', 'Zara', 'Kenji', 'Nina', 'Tom'];
const DUMMY_ZONES = ['America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Berlin', 'Africa/Nairobi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
function addDummy() {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const start = 8 + Math.floor(Math.random() * 3);
  state.members.push({ name: pick(DUMMY_NAMES), tz: pick(DUMMY_ZONES), start, end: start + 8, teamId: state.teams.length ? pick(state.teams).id : '', weekend: DEFAULT_WEEKEND.slice() });
  render();
}

// ── share ──────────────────────────────────────────────────────────────────────
async function share() {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast(url.length > 2000 ? '⚠️ Copied, but the URL is long — chat apps may cut it.' : '🔗 Workspace link copied!');
  } catch { toast('Copy failed — copy the address bar manually.'); }
}
let _toastTimer = null;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.hidden = false; el.classList.add('show');
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, 3000);
}

// ── misc ─────────────────────────────────────────────────────────────────────
function demoWorkspace() {
  const eng = shortId(), mkt = shortId();
  return {
    org: 'My Global Team', wid: shortId(),
    teams: [{ id: eng, name: 'Engineering', color: 0 }, { id: mkt, name: 'Marketing', color: 2 }],
    members: [
      { name: 'Mia', tz: 'America/New_York', start: 9, end: 17, teamId: eng, weekend: [6, 7] },
      { name: 'Oliver', tz: 'Europe/London', start: 9, end: 17, teamId: eng, weekend: [6, 7] },
      { name: 'Lukas', tz: 'Europe/Berlin', start: 9, end: 17, teamId: mkt, weekend: [6, 7] },
      { name: 'Priya', tz: 'Asia/Kolkata', start: 12, end: 20, teamId: mkt, weekend: [6, 7] },
    ],
  };
}
function parseTime(s) { const [h, m] = String(s).split(':').map(Number); return h + (m || 0) / 60; }
function toTimeInput(f) { const h = Math.floor(f); return pad2(h) + ':' + pad2(Math.round((f - h) * 60)); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── first-visit onboarding ────────────────────────────────────
function showOnboarding() {
  const overlay = $('onboardOverlay');
  if (!overlay) return;
  const modal = overlay.querySelector('.onboard-modal');
  const prevFocus = document.activeElement;
  overlay.hidden = false;

  const dismiss = () => {
    overlay.hidden = true;
    localStorage.setItem('tzclock.onboarded', '1');
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    pulseAddPerson();
  };
  // Escape closes; Tab is trapped inside the modal (it's a focus-capturing dialog).
  const onKey = e => {
    if (e.key === 'Escape') { dismiss(); return; }
    if (e.key !== 'Tab') return;
    const f = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  };
  $('onboardClose').addEventListener('click', dismiss);
  $('onboardGotIt').addEventListener('click', dismiss);
  overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', onKey, true);
  $('onboardGotIt').focus();
}
function pulseAddPerson() {
  const btn = $('openAdd');
  if (!btn) return;
  btn.classList.add('pulse');
  const tip = document.createElement('div');
  tip.className = 'pulse-tooltip';
  tip.textContent = '👆 Add your real team';
  btn.appendChild(tip);
  setTimeout(() => {
    btn.classList.remove('pulse');
    if (tip.parentNode) tip.parentNode.removeChild(tip);
  }, 4500);
}
