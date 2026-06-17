'use strict';

/*
 * app.js — UI wiring. Reads the team from the URL, renders the board in a chosen
 * home timezone on a chosen date, handles the scrubber/forms/planner, and writes
 * team changes back to the URL.
 *
 * State flow:  URL hash  ──decode──▶  `state`  ──render──▶  DOM
 *                 ▲                                            │
 *                 └──────────── encode (debounced) ◀──────────┘
 *
 * `homeTz` and `refDate` are *viewer* settings (not part of the shared URL) — so
 * everyone opens the same team but sees it in their own timezone, on today.
 */

const TEAM_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316'];
const LABEL_W = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--label-w')) || 200;
const SAFE_URL_LEN = 1800;   // warn before chat apps start truncating (~2000)

let state = clone(EMPTY_STATE);
let homeTz = restoreHomeTz();        // timezone the board is drawn in
let refDate = todayISO(homeTz);      // ISO date the board shows
let scrubHour = nowAxisHour(homeTz); // scrubber position, in home-tz hours
let teamFilter = '';                 // '' = show all teams
let editingIndex = -1;               // index into state.members, or -1 when adding

function restoreHomeTz() {
  const saved = localStorage.getItem('tzclock.home');
  const tz = saved || browserTz() || 'UTC';
  return isValidZone(tz) ? tz : 'UTC';
}

// ── boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  state = decodeState(readHash());
  if (!state.org && state.teams.length === 0 && state.members.length === 0) {
    state = demoWorkspace();   // friendly first-run; not saved until you edit
  }
  populateZoneList();
  bindControls();
  bindScrubber();
  window.addEventListener('hashchange', () => { state = decodeState(readHash()); render(); });
  window.addEventListener('resize', positionMarkers);
  setInterval(positionMarkers, 30000);  // keep the "now" line fresh
  render();
});

function save() {
  saveStateDebounced(state, len => {
    const badge = document.getElementById('urlBadge');
    badge.textContent = `URL ${len} chars`;
    badge.classList.toggle('warn', len > SAFE_URL_LEN);
  });
}

// ── render ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('org').value = state.org;
  document.getElementById('homeTz').value = homeTz;
  document.getElementById('datePick').value = refDate;
  document.getElementById('dateLabel').textContent =
    prettyDate(refDate) + (isTodayISO(refDate, homeTz) ? ' · today' : '');
  renderTeamFilter();
  renderTeamSelect();
  renderTeamList();
  renderAxis();
  renderLanes();
  renderPlanner();
  positionMarkers();
  updateScrub();
  save();
}

function memberEntries() {
  return state.members
    .map((m, gi) => ({ m, gi }))
    .filter(e => !teamFilter || e.m.teamId === teamFilter);
}

function teamById(id) { return state.teams.find(t => t.id === id); }
function colorOf(member) {
  const t = teamById(member.teamId);
  return t ? TEAM_COLORS[t.color % TEAM_COLORS.length] : '#64748b';
}

// ── axis (24 hour ticks, in home tz) ──────────────────────────────────────────
function renderAxis() {
  const track = document.getElementById('axisTrack');
  track.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const cell = document.createElement('div');
    cell.className = 'tick';
    cell.innerHTML = `<span>${String(h).padStart(2, '0')}</span>`;
    track.appendChild(cell);
  }
}

// ── lanes (one per member) ──────────────────────────────────────────────────
function renderLanes() {
  const wrap = document.getElementById('lanes');
  wrap.innerHTML = '';
  const entries = memberEntries();

  if (entries.length === 0) {
    wrap.innerHTML = `<div class="empty">No teammates yet. Add one on the left, or hit 🎲 for a dummy user.</div>`;
    return;
  }

  for (const { m, gi } of entries) {
    const row = document.createElement('div');
    row.className = 'row lane';
    row.dataset.gi = gi;

    const bands = bandToAxisIntervals(m, refDate, homeTz)
      .map(iv => `<div class="band" style="left:${iv.start / 24 * 100}%;width:${(iv.end - iv.start) / 24 * 100}%;background:${colorOf(m)}"></div>`)
      .join('');

    row.innerHTML = `
      <div class="lane-label">
        <span class="dot" style="background:${colorOf(m)}"></span>
        <div class="who">
          <div class="name">${esc(m.name)}</div>
          <div class="meta">${esc(m.tz)} · ${pad(m.start)}–${pad(m.end)}</div>
        </div>
        <div class="lane-actions">
          <button class="icon" data-edit="${gi}" title="Edit">✏️</button>
          <button class="icon" data-del="${gi}" title="Remove">🗑️</button>
        </div>
      </div>
      <div class="track">
        ${bands}
        <span class="live" id="live-${gi}"></span>
      </div>`;
    wrap.appendChild(row);
  }

  wrap.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => startEdit(+b.dataset.edit)));
  wrap.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => { state.members.splice(+b.dataset.del, 1); render(); }));
}

// ── scrubber + now marker ──────────────────────────────────────────────────────
function bindScrubber() {
  const board = document.getElementById('board');
  let dragging = false;

  const setFromX = clientX => {
    const rect = board.getBoundingClientRect();
    const trackW = rect.width - LABEL_W;
    const pct = Math.min(1, Math.max(0, (clientX - rect.left - LABEL_W) / trackW));
    scrubHour = pct * 24;
    updateScrub();
  };

  board.addEventListener('pointerdown', e => {
    if (e.target.closest('.lane-actions')) return;   // don't hijack edit/delete
    const rect = board.getBoundingClientRect();
    if (e.clientX - rect.left < LABEL_W) return;      // ignore clicks in label col
    dragging = true;
    board.setPointerCapture(e.pointerId);
    setFromX(e.clientX);
  });
  board.addEventListener('pointermove', e => { if (dragging) setFromX(e.clientX); });
  board.addEventListener('pointerup', () => { dragging = false; });

  const scrub = document.getElementById('scrubber');
  scrub.tabIndex = 0;                                 // keyboard nudge (a11y)
  scrub.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { scrubHour = mod24(scrubHour + 0.25); updateScrub(); }
    if (e.key === 'ArrowLeft')  { scrubHour = mod24(scrubHour - 0.25); updateScrub(); }
  });
}

function xForHour(h) {
  const board = document.getElementById('board');
  const trackW = board.clientWidth - LABEL_W;
  return LABEL_W + (h / 24) * trackW;
}

function positionMarkers() {
  const now = document.getElementById('nowMarker');
  if (isTodayISO(refDate, homeTz)) {
    now.style.display = '';
    now.style.left = xForHour(nowAxisHour(homeTz)) + 'px';
  } else {
    now.style.display = 'none';
  }
  document.getElementById('scrubber').style.left = xForHour(scrubHour) + 'px';
}

// Cheap per-frame update — no full re-render while dragging.
function updateScrub() {
  document.getElementById('scrubber').style.left = xForHour(scrubHour) + 'px';
  document.getElementById('scrubReadout').textContent = `${hourLabel(scrubHour)} · ${homeTz}`;
  for (const { m, gi } of memberEntries()) {
    const el = document.getElementById('live-' + gi);
    if (!el) continue;
    const { label, working } = localAt(scrubHour, m, refDate, homeTz);
    el.textContent = label;
    el.classList.toggle('working', working);
  }
}

// ── teams ────────────────────────────────────────────────────────────────────
function renderTeamFilter() {
  const box = document.getElementById('teamFilter');
  const chip = (id, name, active) =>
    `<button class="chip ${active ? 'active' : ''}" data-team="${id}">${esc(name)}</button>`;
  box.innerHTML = chip('', 'All', teamFilter === '')
    + state.teams.map(t => chip(t.id, t.name, teamFilter === t.id)).join('');
  box.querySelectorAll('[data-team]').forEach(b =>
    b.addEventListener('click', () => { teamFilter = b.dataset.team; render(); }));
}

function renderTeamSelect() {
  const sel = document.getElementById('mTeam');
  const keep = sel.value;
  sel.innerHTML = '<option value="">— No team —</option>'
    + state.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = keep;
}

function renderTeamList() {
  const ul = document.getElementById('teamList');
  if (state.teams.length === 0) { ul.innerHTML = '<li class="muted">No teams yet.</li>'; return; }
  ul.innerHTML = state.teams.map(t => {
    const count = state.members.filter(m => m.teamId === t.id).length;
    return `<li>
      <span class="dot" style="background:${TEAM_COLORS[t.color % TEAM_COLORS.length]}"></span>
      <span class="tname">${esc(t.name)}</span>
      <span class="muted">${count} member${count === 1 ? '' : 's'}</span>
      <button class="icon" data-delteam="${t.id}" title="Delete team">🗑️</button>
    </li>`;
  }).join('');
  ul.querySelectorAll('[data-delteam]').forEach(b =>
    b.addEventListener('click', () => {
      const id = b.dataset.delteam;
      state.teams = state.teams.filter(t => t.id !== id);
      state.members.forEach(m => { if (m.teamId === id) m.teamId = ''; });   // unassign, don't delete
      if (teamFilter === id) teamFilter = '';
      render();
    }));
}

// ── meeting planner ────────────────────────────────────────────────────────────
function renderPlanner() {
  const members = memberEntries().map(e => e.m);
  const scopeName = teamFilter ? (teamById(teamFilter)?.name || 'team') : 'everyone';
  document.getElementById('plannerScopeName').textContent = scopeName;

  const box = document.getElementById('planner');
  if (members.length < 2) {
    box.innerHTML = '<p class="muted">Add at least two teammates to find a meeting window.</p>';
    return;
  }

  const windows = findOverlapWindows(members, refDate, homeTz).slice(0, 3);
  if (windows.length === 0) {
    box.innerHTML = '<p class="no-overlap">No time of day works for everyone selected. Try a smaller group, a sub-team, or another date.</p>';
    return;
  }

  box.innerHTML = windows.map((w, i) => {
    const rows = members.map(m =>
      `<tr><td>${esc(m.name)}</td><td class="mono">${localAt(w.start, m, refDate, homeTz).label}–${localAt(w.end, m, refDate, homeTz).label}</td><td class="muted">${esc(m.tz)}</td></tr>`
    ).join('');
    return `<div class="window ${i === 0 ? 'best' : ''}">
      <div class="window-head">
        <span class="badge-utc">${hourLabel(w.start)}–${hourLabel(w.end)} · your time</span>
        <span class="muted">${w.hours.toFixed(2).replace(/\.?0+$/, '')}h overlap${i === 0 ? ' · best' : ''}</span>
      </div>
      <table class="window-tbl">${rows}</table>
    </div>`;
  }).join('');
}

// ── forms & controls ───────────────────────────────────────────────────────────
function bindControls() {
  document.getElementById('org').addEventListener('input', e => { state.org = e.target.value; save(); });

  // Home timezone (viewer setting, remembered locally)
  document.getElementById('homeTz').addEventListener('change', e => {
    const tz = e.target.value.trim();
    if (!isValidZone(tz)) { e.target.value = homeTz; return; }
    homeTz = tz;
    localStorage.setItem('tzclock.home', tz);
    render();
  });

  // Date navigation
  document.getElementById('prevDay').addEventListener('click', () => { refDate = shiftISO(refDate, -1); render(); });
  document.getElementById('nextDay').addEventListener('click', () => { refDate = shiftISO(refDate, +1); render(); });
  document.getElementById('todayBtn').addEventListener('click', () => { refDate = todayISO(homeTz); render(); });
  document.getElementById('datePick').addEventListener('change', e => {
    if (e.target.value) { refDate = e.target.value; render(); }
  });

  document.getElementById('memberForm').addEventListener('submit', onSubmitMember);
  document.getElementById('cancelEditBtn').addEventListener('click', resetForm);
  document.getElementById('dummyBtn').addEventListener('click', addDummy);

  document.getElementById('teamForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('teamName');
    const name = input.value.trim();
    if (!name) return;
    state.teams.push({ id: shortId(), name, color: state.teams.length % TEAM_COLORS.length });
    input.value = '';
    render();
  });

  document.getElementById('shareBtn').addEventListener('click', share);
}

function onSubmitMember(e) {
  e.preventDefault();
  const name = document.getElementById('mName').value.trim();
  const tz = document.getElementById('mTz').value.trim();
  const start = parseInt(document.getElementById('mStart').value, 10);
  const end = parseInt(document.getElementById('mEnd').value, 10);
  const overnight = document.getElementById('mOvernight').checked;
  const teamId = document.getElementById('mTeam').value;

  const err = validateMember({ name, tz, start, end, overnight });
  const errEl = document.getElementById('formError');
  if (err) { errEl.textContent = err; errEl.hidden = false; return; }
  errEl.hidden = true;

  const member = { name, tz, start, end, teamId };
  if (editingIndex >= 0) state.members[editingIndex] = member;
  else state.members.push(member);

  resetForm();
  render();
}

function validateMember({ name, tz, start, end, overnight }) {
  if (!name) return 'Please enter a name.';
  if (!isValidZone(tz)) return 'Pick a valid timezone from the list (e.g. Asia/Kolkata).';
  if (!isHour(start) || !isHour(end)) return 'Hours must be whole numbers between 0 and 23.';
  if (start === end) return 'Start and end hour cannot be the same.';
  if (!overnight && start >= end) return 'Start must be before end — or tick “Overnight shift”.';
  return null;
}

function startEdit(gi) {
  const m = state.members[gi];
  editingIndex = gi;
  document.getElementById('mName').value = m.name;
  document.getElementById('mTz').value = m.tz;
  document.getElementById('mStart').value = m.start;
  document.getElementById('mEnd').value = m.end;
  document.getElementById('mOvernight').checked = m.start >= m.end;
  renderTeamSelect();
  document.getElementById('mTeam').value = m.teamId;
  document.getElementById('formTitle').textContent = 'Edit teammate';
  document.getElementById('saveMemberBtn').textContent = 'Save changes';
  document.getElementById('cancelEditBtn').hidden = false;
  document.getElementById('mName').focus();
}

function resetForm() {
  editingIndex = -1;
  document.getElementById('memberForm').reset();
  document.getElementById('mStart').value = 9;
  document.getElementById('mEnd').value = 17;
  document.getElementById('formError').hidden = true;
  document.getElementById('formTitle').textContent = 'Add a teammate';
  document.getElementById('saveMemberBtn').textContent = 'Add teammate';
  document.getElementById('cancelEditBtn').hidden = true;
}

const DUMMY_NAMES = ['Ava', 'Noah', 'Mei', 'Omar', 'Sofia', 'Liam', 'Priya', 'Diego', 'Zara', 'Kenji', 'Nina', 'Tom'];
const DUMMY_ZONES = ['America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Berlin', 'Africa/Nairobi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

function addDummy() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const start = 8 + Math.floor(Math.random() * 3);   // 8–10
  state.members.push({
    name: pick(DUMMY_NAMES),
    tz: pick(DUMMY_ZONES),
    start,
    end: start + 8,
    teamId: state.teams.length ? pick(state.teams).id : '',
  });
  render();
}

// ── share ──────────────────────────────────────────────────────────────────────
async function share() {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast(url.length > 2000 ? '⚠️ Copied, but the URL is long — some chat apps may cut it.' : '🔗 Workspace link copied to clipboard!');
  } catch {
    toast('Copy failed — select the address bar and copy manually.');
  }
}

let _toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, 3000);
}

// ── misc ─────────────────────────────────────────────────────────────────────
function populateZoneList() {
  const list = document.getElementById('zones');
  const zones = VALID_ZONES ? [...VALID_ZONES] : DUMMY_ZONES;
  list.innerHTML = zones.map(z => `<option value="${z}"></option>`).join('');
}

function demoWorkspace() {
  const eng = shortId(), mkt = shortId();
  return {
    org: 'My Global Team',
    teams: [{ id: eng, name: 'Engineering', color: 0 }, { id: mkt, name: 'Marketing', color: 1 }],
    members: [
      { name: 'Sriram', tz: 'Asia/Kolkata', start: 9, end: 17, teamId: eng },
      { name: 'Mia', tz: 'America/New_York', start: 9, end: 17, teamId: eng },
      { name: 'Lukas', tz: 'Europe/Berlin', start: 8, end: 16, teamId: mkt },
      { name: 'Yuki', tz: 'Asia/Tokyo', start: 10, end: 18, teamId: mkt },
    ],
  };
}

function pad(h) { return String(h).padStart(2, '0') + ':00'; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
