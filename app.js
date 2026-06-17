'use strict';

/*
 * app.js — UI wiring.
 *
 *   URL hash ──decode──▶ `state` (shared team config) ──render──▶ DOM
 *      ▲                                                            │
 *      └──────────────── encode (debounced) ◀──────────────────────┘
 *
 *   localStorage ──▶ `meetings` (private, per-workspace) ──▶ Saved-meetings UI
 *
 * `homeTz`, `refDate`, `search`, 12h-format are *viewer* settings (local, never
 * in the shared URL) so everyone opens the same team in their own context.
 */

// `DateTime` is provided by timeutil.js (classic scripts share one global scope).
const TEAM_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316'];
const LABEL_W = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--label-w')) || 200;
const SAFE_URL_LEN = 1800;
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];   // Mon=1 .. Sun=7

let state = clone(EMPTY_STATE);
let meetings = [];                   // from localStorage, keyed by state.wid
let homeTz = restoreHomeTz();
let refDate = todayISO(homeTz);
let scrubHour = nowAxisHour(homeTz);
let teamFilter = '';
let search = '';
let editingIndex = -1;               // member being edited
let pendingMeeting = null;           // {startUTC, durationMin, attendees} for the dialog
let editingMeetingId = null;

function restoreHomeTz() {
  const tz = localStorage.getItem('tzclock.home') || browserTz() || 'UTC';
  return isValidZone(tz) ? tz : 'UTC';
}

// ── boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  state = decodeState(readHash());
  if (!state.org && state.teams.length === 0 && state.members.length === 0) {
    state = demoWorkspace();
  }
  if (!state.wid) state.wid = shortId();
  meetings = loadMeetings(state.wid);

  const f12 = localStorage.getItem('tzclock.fmt12') === '1';
  setHour12(f12);
  document.getElementById('fmt12').checked = f12;

  populateZoneList();
  initDaysOff();
  bindControls();
  bindScrubber();
  bindMeetingDialog();
  window.addEventListener('hashchange', () => {
    state = decodeState(readHash());
    if (!state.wid) state.wid = shortId();
    meetings = loadMeetings(state.wid);
    render();
  });
  window.addEventListener('resize', positionMarkers);
  setInterval(positionMarkers, 30000);
  render();
});

function save() {
  saveStateDebounced(state, len => {
    const badge = document.getElementById('urlBadge');
    badge.textContent = `URL ${len} chars`;
    badge.classList.toggle('warn', len > SAFE_URL_LEN);
  });
}
function persistMeetings() { saveMeetings(state.wid, meetings); }

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
  renderMeetings();
  positionMarkers();
  updateScrub();
  save();
}

// team + name-search filter (for lanes); team-only (for the planner scope)
function laneEntries() {
  const q = search.trim().toLowerCase();
  return state.members
    .map((m, gi) => ({ m, gi }))
    .filter(e => (!teamFilter || e.m.teamId === teamFilter) && (!q || e.m.name.toLowerCase().includes(q)));
}
function teamMembers() { return state.members.filter(m => !teamFilter || m.teamId === teamFilter); }

function teamById(id) { return state.teams.find(t => t.id === id); }
function colorOf(member) {
  const t = teamById(member.teamId);
  return t ? TEAM_COLORS[t.color % TEAM_COLORS.length] : '#64748b';
}

// ── axis ───────────────────────────────────────────────────────────────────
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

// ── lanes ─────────────────────────────────────────────────────────────────
function renderLanes() {
  const wrap = document.getElementById('lanes');
  wrap.innerHTML = '';
  const entries = laneEntries();

  if (entries.length === 0) {
    wrap.innerHTML = `<div class="empty">No teammates match. Add one on the left, or hit 🎲 for a dummy user.</div>`;
    return;
  }

  for (const { m, gi } of entries) {
    const off = isMemberOff(m, refDate);
    const row = document.createElement('div');
    row.className = 'row lane' + (off ? ' off' : '');
    row.dataset.gi = gi;

    const bands = bandToAxisIntervals(m, refDate, homeTz)
      .map(iv => `<div class="band" style="left:${iv.start / 24 * 100}%;width:${(iv.end - iv.start) / 24 * 100}%;background:${colorOf(m)}"></div>`)
      .join('');

    row.innerHTML = `
      <div class="lane-label">
        <span class="dot" style="background:${colorOf(m)}"></span>
        <div class="who">
          <div class="name">${esc(m.name)}${off ? ' <span class="tag-off">off</span>' : ''}</div>
          <div class="meta">${esc(m.tz)} · ${hourLabel(m.start)}–${hourLabel(m.end)}</div>
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
    const pct = Math.min(1, Math.max(0, (clientX - rect.left - LABEL_W) / (rect.width - LABEL_W)));
    scrubHour = pct * 24;
    updateScrub();
  };
  board.addEventListener('pointerdown', e => {
    if (e.target.closest('.lane-actions')) return;
    const rect = board.getBoundingClientRect();
    if (e.clientX - rect.left < LABEL_W) return;
    dragging = true;
    board.setPointerCapture(e.pointerId);
    setFromX(e.clientX);
  });
  board.addEventListener('pointermove', e => { if (dragging) setFromX(e.clientX); });
  board.addEventListener('pointerup', () => { dragging = false; });

  const scrub = document.getElementById('scrubber');
  scrub.tabIndex = 0;
  scrub.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { scrubHour = mod24(scrubHour + 0.25); updateScrub(); }
    if (e.key === 'ArrowLeft')  { scrubHour = mod24(scrubHour - 0.25); updateScrub(); }
  });
}

function xForHour(h) {
  const board = document.getElementById('board');
  return LABEL_W + (h / 24) * (board.clientWidth - LABEL_W);
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

function updateScrub() {
  document.getElementById('scrubber').style.left = xForHour(scrubHour) + 'px';
  document.getElementById('scrubReadout').textContent = `${hourLabel(scrubHour)} · ${homeTz}`;
  for (const { m, gi } of laneEntries()) {
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
      state.members.forEach(m => { if (m.teamId === id) m.teamId = ''; });
      if (teamFilter === id) teamFilter = '';
      render();
    }));
}

// ── meeting planner ────────────────────────────────────────────────────────────
function renderPlanner() {
  const scope = teamMembers();
  const working = scope.filter(m => !isMemberOff(m, refDate));
  const offToday = scope.filter(m => isMemberOff(m, refDate));
  document.getElementById('plannerScopeName').textContent =
    teamFilter ? (teamById(teamFilter)?.name || 'team') : 'everyone';

  const box = document.getElementById('planner');
  const offNote = offToday.length
    ? `<p class="muted off-note">Off on ${prettyDate(refDate)}: ${offToday.map(m => esc(m.name)).join(', ')} (excluded)</p>` : '';

  if (working.length < 2) {
    box.innerHTML = offNote + '<p class="muted">Need at least two available teammates to find a window.</p>';
    return;
  }

  const windows = findOverlapWindows(working, refDate, homeTz);
  if (windows.length === 0) {
    box.innerHTML = offNote + '<p class="no-overlap">No time works for everyone available. Try a smaller group, a sub-team, or another date.</p>';
    return;
  }

  const durMin = +document.getElementById('duration').value;
  const slots = generateSlots(windows, durMin / 60);
  const attendees = working.map(m => m.name);

  const top = windows.slice(0, 3).map((w, i) => {
    const rows = working.map(m =>
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

  const slotBtns = slots.length
    ? `<div class="slots"><span class="muted">Pick a ${durMin}-min slot:</span>${slots.map(s =>
        `<button class="slot" data-start="${s.start}">${hourLabel(s.start)}</button>`).join('')}</div>`
    : `<p class="muted">No ${durMin}-min slot fits the overlap — try a shorter meeting.</p>`;

  box.innerHTML = offNote + top + slotBtns;
  box.querySelectorAll('.slot').forEach(b =>
    b.addEventListener('click', () => openMeetingDialog(+b.dataset.start, durMin, attendees)));
}

// ── saved meetings ─────────────────────────────────────────────────────────────
function renderMeetings() {
  const box = document.getElementById('meetings');
  if (meetings.length === 0) {
    box.innerHTML = '<p class="muted">No saved meetings yet. Pick a slot in the planner to create one.</p>';
    return;
  }
  const sorted = [...meetings].sort((a, b) => a.startUTC < b.startUTC ? -1 : 1);
  box.innerHTML = sorted.map(m => {
    const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
    const sh = dt.hour + dt.minute / 60;
    const when = `${dt.toFormat('ccc dd LLL')} · ${hourLabel(sh)}–${hourLabel(sh + m.durationMin / 60)} ${homeTz}`;
    return `<div class="mtg ${m.status}">
      <div class="mtg-head">
        <strong>${esc(m.title)}</strong>
        <span class="status-pill ${m.status}">${m.status}</span>
      </div>
      <div class="muted">${esc(when)} · ${m.durationMin} min</div>
      ${m.attendees.length ? `<div class="muted">👥 ${m.attendees.map(esc).join(', ')}</div>` : ''}
      ${m.notes ? `<div class="mtg-notes">${esc(m.notes)}</div>` : ''}
      <div class="mtg-actions">
        <button class="btn btn-ghost" data-medit="${m.id}">Edit</button>
        <button class="btn btn-ghost" data-mbook="${m.id}">${m.status === 'booked' ? 'Mark proposed' : 'Mark booked'}</button>
        <button class="btn btn-ghost" data-mics="${m.id}">⬇︎ .ics</button>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleCalUrl(m)}">📅 Google</a>
        <button class="btn btn-ghost danger" data-mdel="${m.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  const find = id => meetings.find(x => x.id === id);
  box.querySelectorAll('[data-medit]').forEach(b => b.addEventListener('click', () => editMeeting(b.dataset.medit)));
  box.querySelectorAll('[data-mbook]').forEach(b => b.addEventListener('click', () => {
    const m = find(b.dataset.mbook); m.status = m.status === 'booked' ? 'proposed' : 'booked'; persistMeetings(); renderMeetings();
  }));
  box.querySelectorAll('[data-mics]').forEach(b => b.addEventListener('click', () => downloadIcs(find(b.dataset.mics))));
  box.querySelectorAll('[data-mdel]').forEach(b => b.addEventListener('click', () => {
    meetings = meetings.filter(x => x.id !== b.dataset.mdel); persistMeetings(); renderMeetings();
  }));
}

// ── meeting dialog ─────────────────────────────────────────────────────────────
function bindMeetingDialog() {
  const dlg = document.getElementById('meetingDialog');
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save' || !pendingMeeting) { pendingMeeting = null; editingMeetingId = null; return; }
    const data = {
      title: document.getElementById('meetingTitle').value.trim() || 'Meeting',
      attendees: document.getElementById('meetingAttendees').value.split(',').map(s => s.trim()).filter(Boolean),
      notes: document.getElementById('meetingNotes').value.trim(),
      startUTC: pendingMeeting.startUTC,
      durationMin: pendingMeeting.durationMin,
    };
    if (editingMeetingId) {
      const m = meetings.find(x => x.id === editingMeetingId);
      Object.assign(m, data);
    } else {
      meetings.push(makeMeeting(data));
    }
    pendingMeeting = null; editingMeetingId = null;
    persistMeetings();
    renderMeetings();
    toast('💾 Meeting saved on this device.');
  });
}

function openMeetingDialog(slotStart, durationMin, attendees) {
  pendingMeeting = {
    startUTC: axisInstant(slotStart, refDate, homeTz).toUTC().toISO(),
    durationMin, attendees,
  };
  editingMeetingId = null;
  document.getElementById('meetingDialogTitle').textContent = 'New meeting';
  document.getElementById('meetingWhen').textContent =
    `${prettyDate(refDate)} · ${hourLabel(slotStart)}–${hourLabel(slotStart + durationMin / 60)} (${homeTz})`;
  document.getElementById('meetingTitle').value = '';
  document.getElementById('meetingAttendees').value = attendees.join(', ');
  document.getElementById('meetingNotes').value = '';
  document.getElementById('meetingDialog').showModal();
}

function editMeeting(id) {
  const m = meetings.find(x => x.id === id);
  if (!m) return;
  pendingMeeting = { startUTC: m.startUTC, durationMin: m.durationMin, attendees: m.attendees };
  editingMeetingId = id;
  const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
  const sh = dt.hour + dt.minute / 60;
  document.getElementById('meetingDialogTitle').textContent = 'Edit meeting';
  document.getElementById('meetingWhen').textContent =
    `${dt.toFormat('ccc dd LLL')} · ${hourLabel(sh)}–${hourLabel(sh + m.durationMin / 60)} (${homeTz})`;
  document.getElementById('meetingTitle').value = m.title;
  document.getElementById('meetingAttendees').value = m.attendees.join(', ');
  document.getElementById('meetingNotes').value = m.notes;
  document.getElementById('meetingDialog').showModal();
}

// ── days-off toggles ───────────────────────────────────────────────────────────
function initDaysOff() {
  const box = document.getElementById('mDaysOff');
  box.innerHTML = DAY_LABELS.map((lbl, i) =>
    `<button type="button" class="day-toggle" data-day="${i + 1}">${lbl}</button>`).join('');
  box.querySelectorAll('.day-toggle').forEach(b =>
    b.addEventListener('click', () => b.classList.toggle('on')));
  setDaysOff(DEFAULT_WEEKEND);
}
function setDaysOff(days) {
  document.querySelectorAll('#mDaysOff .day-toggle').forEach(b =>
    b.classList.toggle('on', days.includes(+b.dataset.day)));
}
function getDaysOff() {
  return [...document.querySelectorAll('#mDaysOff .day-toggle.on')].map(b => +b.dataset.day);
}

// ── forms & controls ───────────────────────────────────────────────────────────
function bindControls() {
  document.getElementById('org').addEventListener('input', e => { state.org = e.target.value; save(); });

  document.getElementById('homeTz').addEventListener('change', e => {
    const tz = e.target.value.trim();
    if (!isValidZone(tz)) { e.target.value = homeTz; return; }
    homeTz = tz;
    localStorage.setItem('tzclock.home', tz);
    render();
  });

  document.getElementById('prevDay').addEventListener('click', () => { refDate = shiftISO(refDate, -1); render(); });
  document.getElementById('nextDay').addEventListener('click', () => { refDate = shiftISO(refDate, +1); render(); });
  document.getElementById('todayBtn').addEventListener('click', () => { refDate = todayISO(homeTz); render(); });
  document.getElementById('datePick').addEventListener('change', e => { if (e.target.value) { refDate = e.target.value; render(); } });

  document.getElementById('search').addEventListener('input', e => { search = e.target.value; renderLanes(); updateScrub(); });
  document.getElementById('fmt12').addEventListener('change', e => {
    setHour12(e.target.checked);
    localStorage.setItem('tzclock.fmt12', e.target.checked ? '1' : '0');
    render();
  });
  document.getElementById('duration').addEventListener('change', renderPlanner);

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
  const start = parseTime(document.getElementById('mStart').value);
  const end = parseTime(document.getElementById('mEnd').value);
  const overnight = document.getElementById('mOvernight').checked;
  const teamId = document.getElementById('mTeam').value;
  const weekend = getDaysOff();

  const err = validateMember({ name, tz, start, end, overnight });
  const errEl = document.getElementById('formError');
  if (err) { errEl.textContent = err; errEl.hidden = false; return; }
  errEl.hidden = true;

  const member = { name, tz, start, end, teamId, weekend };
  if (editingIndex >= 0) state.members[editingIndex] = member;
  else state.members.push(member);

  resetForm();
  render();
}

function validateMember({ name, tz, start, end, overnight }) {
  if (!name) return 'Please enter a name.';
  if (!isValidZone(tz)) return 'Pick a valid timezone from the list (e.g. Asia/Kolkata).';
  if (!isWorkHour(start) || !isWorkHour(end)) return 'Use 30-minute steps between 00:00 and 23:30.';
  if (start === end) return 'Start and end time cannot be the same.';
  if (!overnight && start >= end) return 'Start must be before end — or tick “Overnight shift”.';
  return null;
}

function startEdit(gi) {
  const m = state.members[gi];
  editingIndex = gi;
  document.getElementById('mName').value = m.name;
  document.getElementById('mTz').value = m.tz;
  document.getElementById('mStart').value = toTimeInput(m.start);
  document.getElementById('mEnd').value = toTimeInput(m.end);
  document.getElementById('mOvernight').checked = m.start >= m.end;
  setDaysOff(m.weekend || DEFAULT_WEEKEND);
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
  document.getElementById('mStart').value = '09:00';
  document.getElementById('mEnd').value = '17:00';
  setDaysOff(DEFAULT_WEEKEND);
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
  const start = 8 + Math.floor(Math.random() * 3);
  state.members.push({
    name: pick(DUMMY_NAMES), tz: pick(DUMMY_ZONES), start, end: start + 8,
    teamId: state.teams.length ? pick(state.teams).id : '', weekend: DEFAULT_WEEKEND.slice(),
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
    org: 'My Global Team', wid: shortId(),
    teams: [{ id: eng, name: 'Engineering', color: 0 }, { id: mkt, name: 'Marketing', color: 1 }],
    members: [
      { name: 'Sriram', tz: 'Asia/Kolkata', start: 9, end: 17, teamId: eng, weekend: [6, 7] },
      { name: 'Mia', tz: 'America/New_York', start: 9, end: 17, teamId: eng, weekend: [6, 7] },
      { name: 'Lukas', tz: 'Europe/Berlin', start: 8, end: 16, teamId: mkt, weekend: [6, 7] },
      { name: 'Yuki', tz: 'Asia/Tokyo', start: 10, end: 18, teamId: mkt, weekend: [6, 7] },
    ],
  };
}

function parseTime(str) { const [h, m] = String(str).split(':').map(Number); return h + (m || 0) / 60; }
function toTimeInput(frac) { const h = Math.floor(frac); return pad2(h) + ':' + pad2(Math.round((frac - h) * 60)); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
