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

const TEAM_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316'];
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];   // Mon=1 .. Sun=7
const SAFE_URL_LEN = 1800;
const ZOOM_MIN = 30, ZOOM_MAX = 120;
const DUR_OPTS = [15, 30, 45, 60, 90, 120];               // meeting-dialog lengths

let state = clone(EMPTY_STATE);
let meetings = [];
let homeTz = restoreHomeTz();
let refDate = todayISO(homeTz);
let scrubHour = nowAxisHour(homeTz);    // pinned scrubber position (home-tz hours)
let activeTeams = new Set();            // team ids shown on the board; empty = everyone
let search = '';
let userZoomed = localStorage.getItem('tzclock.userZoom') === '1';
let zoom = +(localStorage.getItem('tzclock.zoom') || 48);
let editingIndex = -1;

const $ = id => document.getElementById(id);
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

  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  const f12 = localStorage.getItem('tzclock.fmt12') === '1';
  setHour12(f12); $('fmt12').checked = f12;
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
  if (!userZoomed) fitZoom();           // by default, the whole day fits the screen
});

function save() {
  saveStateDebounced(state, len => {
    const b = $('urlBadge');
    b.textContent = `${len} chars`;
    b.classList.toggle('warn', len > SAFE_URL_LEN);
  });
}
function persistMeetings() { saveMeetings(state.wid, meetings); }

// ── render ────────────────────────────────────────────────────────────────────
function render() {
  $('org').value = state.org;
  $('homeTz').value = labelForTz(homeTz);
  $('datePick').value = refDate;
  $('dateLabel').textContent = prettyDate(refDate) + (isTodayISO(refDate, homeTz) ? ' · today' : '');
  pruneActiveTeams();
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

// Members visible on the board / counted by the planner (team filter + search).
function visibleEntries() {
  const q = search.trim().toLowerCase();
  return state.members
    .map((m, gi) => ({ m, gi }))
    .filter(e => (activeTeams.size === 0 || activeTeams.has(e.m.teamId)) && (!q || e.m.name.toLowerCase().includes(q)));
}
function scopeMembers() {
  return state.members.filter(m => activeTeams.size === 0 || activeTeams.has(m.teamId));
}
function teamById(id) { return state.teams.find(t => t.id === id); }
function colorOf(member) {
  const t = teamById(member.teamId);
  return t ? TEAM_COLORS[t.color % TEAM_COLORS.length] : '#94a3b8';
}
function pruneActiveTeams() {
  for (const id of [...activeTeams]) if (!teamById(id)) activeTeams.delete(id);
}

// ── team filter (multi-select; also the planner scope) ─────────────────────────
function renderTeamFilter() {
  const box = $('teamFilter');
  const chip = (id, label, on, dot) =>
    `<button class="tf-chip ${on ? 'active' : ''}" data-team="${id}">${dot}${esc(label)}</button>`;
  const chips = [chip('__all', 'Everyone', activeTeams.size === 0, '')];
  for (const t of state.teams) {
    const dot = `<span class="dot" style="background:${TEAM_COLORS[t.color % TEAM_COLORS.length]}"></span>`;
    chips.push(chip(t.id, t.name, activeTeams.has(t.id), dot));
  }
  box.innerHTML = chips.join('');
  box.querySelectorAll('.tf-chip').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.team;
    if (id === '__all') activeTeams.clear();
    else { activeTeams.has(id) ? activeTeams.delete(id) : activeTeams.add(id); }
    render();
  }));
}

// ── timeline ───────────────────────────────────────────────────────────────
function renderAxis() {
  const track = $('axisTrack');
  track.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const cell = document.createElement('div');
    cell.className = 'tick' + (h === 0 ? ' daybreak' : '');
    cell.innerHTML = `<span>${HOUR_12 ? hourLabel(h) : String(h).padStart(2, '0')}</span>`;
    track.appendChild(cell);
  }
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
    const row = document.createElement('div');
    row.className = 'tl-row lane' + (off ? ' off' : '');
    row.dataset.gi = gi;
    const bands = bandToAxisIntervals(m, refDate, homeTz)
      .map(iv => `<div class="band" style="left:${iv.start / 24 * 100}%;width:${(iv.end - iv.start) / 24 * 100}%;background:${colorOf(m)}"></div>`)
      .join('');
    row.innerHTML = `
      <div class="tl-label">
        <span class="dot" style="background:${colorOf(m)}"></span>
        <div class="who">
          <div class="name">${esc(m.name)}${off ? ' <span class="tag-off">off</span>' : ''}</div>
          <div class="meta">${esc(labelForTz(m.tz))} · ${hourLabel(m.start)}–${hourLabel(m.end)}</div>
        </div>
      </div>
      <div class="tl-track work">${bands}<span class="live" id="live-${gi}"></span></div>`;
    wrap.appendChild(row);
  }
}

function xForHour(h) { return LW() + h * HW(); }

// Pointer x (client coords) → axis hour, or null if over the sticky name column.
function hourFromClientX(clientX) {
  const r = $('boardInner').getBoundingClientRect();
  const x = clientX - r.left - LW();
  if (x < 0) return null;
  return Math.min(24, Math.max(0, x / HW()));
}

// Hover to read every zone's time; click to pin; double-click to block; wheel
// past either edge spills into the next/previous day (the "infinite" scroll).
function bindBoard() {
  const inner = $('boardInner');
  const board = $('board');
  let downX = null;

  inner.addEventListener('pointermove', e => {
    if (e.target.closest('.tl-label')) return;
    const h = hourFromClientX(e.clientX);
    if (h == null) return;
    placeScrub(h); updateScrub(h); showTip(h);
  });
  inner.addEventListener('pointerleave', () => { placeScrub(scrubHour); updateScrub(scrubHour); hideTip(); });
  inner.addEventListener('pointerdown', e => { if (!e.target.closest('.tl-label')) downX = e.clientX; });
  inner.addEventListener('pointerup', e => {
    if (e.target.closest('.tl-label')) return;
    const h = hourFromClientX(e.clientX);
    if (h != null) { scrubHour = h; placeScrub(h); updateScrub(h); }
    downX = null;
  });

  inner.addEventListener('dblclick', e => {
    if (e.target.closest('.tl-label')) return;
    const h = hourFromClientX(e.clientX);
    if (h == null) return;
    const scope = currentScopeWorking();
    openMeetingDialog({ start: Math.round(h * 2) / 2, attendees: scope.map(m => m.name) });
  });

  $('scrubber').addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { scrubHour = mod24(scrubHour + 0.25); placeScrub(scrubHour); updateScrub(scrubHour); }
    if (e.key === 'ArrowLeft') { scrubHour = mod24(scrubHour - 0.25); placeScrub(scrubHour); updateScrub(scrubHour); }
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
  // land at the matching edge so the motion feels continuous
  const board = $('board');
  board.scrollLeft = dir > 0 ? 0 : board.scrollWidth;
}

function placeScrub(h) { $('scrubber').style.left = xForHour(h) + 'px'; }
function showTip(h) { const t = $('hoverTip'); t.hidden = false; t.textContent = hourLabel(h); t.style.left = xForHour(h) + 'px'; }
function hideTip() { $('hoverTip').hidden = true; }

function positionMarkers() {
  const now = $('nowMarker');
  if (isTodayISO(refDate, homeTz)) { now.style.display = ''; now.style.left = xForHour(nowAxisHour(homeTz)) + 'px'; }
  else now.style.display = 'none';
  placeScrub(scrubHour);
  renderBlocks();
}

// Translucent spans on the timeline for meetings on the selected date.
function renderBlocks() {
  const inner = $('boardInner');
  inner.querySelectorAll('.block-span').forEach(e => e.remove());
  const hw = HW(), lw = LW();
  for (const m of meetings) {
    const dt = DateTime.fromISO(m.startUTC).setZone(homeTz);
    if (dt.toISODate() !== refDate) continue;
    const startAxis = dt.hour + dt.minute / 60;
    const el = document.createElement('div');
    el.className = 'block-span';
    el.style.left = (lw + startAxis * hw) + 'px';
    el.style.width = (m.durationMin / 60 * hw) + 'px';
    el.innerHTML = `<span>${esc(m.title)}</span>`;
    inner.appendChild(el);
  }
}

function updateScrub(h = scrubHour) {
  $('scrubReadout').textContent = `${hourLabel(h)} · ${labelForTz(homeTz)}`;
  for (const { m, gi } of visibleEntries()) {
    const el = $('live-' + gi);
    if (!el) continue;
    const { label, working } = localAt(h, m, refDate, homeTz);
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
    const swatch = g.color >= 0 ? `<span class="dot" style="background:${TEAM_COLORS[g.color % TEAM_COLORS.length]}"></span>` : '';
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

function scopeLabel() {
  if (activeTeams.size === 0) return 'everyone';
  if (activeTeams.size === 1) return teamById([...activeTeams][0])?.name || 'team';
  return 'the selected teams';
}

function renderPlanner() {
  const scope = scopeMembers();
  const working = scope.filter(m => !isMemberOff(m, refDate));
  const offToday = scope.filter(m => isMemberOff(m, refDate));
  $('plannerScopeName').textContent = scopeLabel();

  const box = $('planner');
  const offNote = offToday.length
    ? `<p class="muted small off-note">Off today: ${offToday.map(m => esc(m.name)).join(', ')} (excluded)</p>` : '';
  if (working.length < 2) { box.innerHTML = offNote + '<p class="muted small">Need two available teammates.</p>'; return; }

  const windows = findOverlapWindows(working, refDate, homeTz);
  if (windows.length === 0) { box.innerHTML = offNote + '<p class="no-overlap small">No shared time today. Try a sub-team or another date.</p>'; return; }

  const durMin = +$('duration').value;
  const busy = busyCellsForDate();
  const slots = generateSlots(windows, durMin / 60).filter(s => !slotIsBusy(s.start, durMin / 60, busy));
  const blockedCount = meetings.filter(m => DateTime.fromISO(m.startUTC).setZone(homeTz).toISODate() === refDate).length;
  const attendees = working.map(m => m.name);

  const top = windows.slice(0, 2).map((w, i) => {
    const rows = working.map(m =>
      `<tr><td>${esc(m.name)}</td><td class="mono">${localAt(w.start, m, refDate, homeTz).label}–${localAt(w.end, m, refDate, homeTz).label}</td></tr>`).join('');
    return `<div class="window ${i === 0 ? 'best' : ''}">
      <div class="window-head"><span class="badge-utc">${hourLabel(w.start)}–${hourLabel(w.end)}</span>
        <span class="muted small">${w.hours.toFixed(2).replace(/\.?0+$/, '')}h${i === 0 ? ' · best' : ''}</span></div>
      <table class="window-tbl">${rows}</table></div>`;
  }).join('');

  const blockNote = blockedCount
    ? `<p class="muted small block-note">⛌ ${blockedCount} block${blockedCount > 1 ? 's' : ''} on this day reduce${blockedCount > 1 ? '' : 's'} availability.</p>` : '';
  const slotBtns = slots.length
    ? `<div class="slots"><span class="muted small">${durMin}-min slots:</span>${slots.map(s => `<button class="slot" data-start="${s.start}">${hourLabel(s.start)}</button>`).join('')}</div>`
    : `<p class="muted small">No free ${durMin}-min slot${blockedCount ? ' (time is blocked)' : ''} — try shorter or another date.</p>`;

  box.innerHTML = offNote + blockNote + top + slotBtns;
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
  box.querySelectorAll('[data-mdel]').forEach(b => b.addEventListener('click', () => { meetings = meetings.filter(x => x.id !== b.dataset.mdel); persistMeetings(); renderMeetings(); refreshPlanner(); }));
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
  makeCombo($('homeTz'), $('homeTzList'), tz => { homeTz = tz; localStorage.setItem('tzclock.home', tz); render(); });
  makeCombo($('mTz'), $('mTzList'), () => {});
}
function makeCombo(input, list, onPick) {
  let items = [], active = -1;
  const open = () => { items = tzSearch(input.value, 8); active = -1; draw(); list.hidden = items.length === 0; };
  const draw = () => {
    list.innerHTML = items.map((it, i) => `<li class="cb-item ${i === active ? 'active' : ''}" data-i="${i}">${esc(it.label)}<span class="cb-tz">${esc(it.tz)}</span></li>`).join('');
  };
  const pick = it => { input.value = it.label; input.dataset.tz = it.tz; list.hidden = true; onPick(it.tz); };
  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[active]) { pick(items[active]); e.preventDefault(); } }
    else if (e.key === 'Escape') { list.hidden = true; }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(items[+li.dataset.i]); } });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 120));
  return { resolve: () => input.dataset.tz || (tzSearch(input.value, 1)[0] || {}).tz || '' };
}

// ── forms & controls ───────────────────────────────────────────────────────────
function bindControls() {
  $('org').addEventListener('input', e => { state.org = e.target.value; save(); });

  $('prevDay').addEventListener('click', () => { refDate = shiftISO(refDate, -1); render(); });
  $('nextDay').addEventListener('click', () => { refDate = shiftISO(refDate, +1); render(); });
  $('todayBtn').addEventListener('click', () => { refDate = todayISO(homeTz); render(); });
  $('datePick').addEventListener('change', e => { if (e.target.value) { refDate = e.target.value; render(); } });

  $('zoomIn').addEventListener('click', () => setZoom(zoom + 12));
  $('zoomOut').addEventListener('click', () => setZoom(zoom - 12));
  $('fitBtn').addEventListener('click', () => { userZoomed = false; localStorage.setItem('tzclock.userZoom', '0'); fitZoom(); });
  $('fmt12').addEventListener('change', e => { setHour12(e.target.checked); localStorage.setItem('tzclock.fmt12', e.target.checked ? '1' : '0'); render(); });
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
  $('dummyBtn').addEventListener('click', addDummy);
  $('deleteMemberBtn').addEventListener('click', () => { if (editingIndex >= 0) { state.members.splice(editingIndex, 1); closeDrawer(); render(); } });

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

  $('shareBtn').addEventListener('click', share);
}

// Fit the whole 24h day inside the board (the default — no horizontal scroll).
function fitZoom() {
  const board = $('board');
  const avail = board.clientWidth - LW() - 2;
  if (avail <= 0) return;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor(avail / 24)));
  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  positionMarkers();
}
function setZoom(z) {
  userZoomed = true;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  localStorage.setItem('tzclock.zoom', zoom);
  localStorage.setItem('tzclock.userZoom', '1');
  positionMarkers();
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
    return `<li><span class="dot" style="background:${TEAM_COLORS[t.color % TEAM_COLORS.length]}"></span>
      <span class="tname">${esc(t.name)}</span><span class="muted small">${count}</span>
      <button class="icon" data-delteam="${t.id}" title="Delete team">🗑️</button></li>`;
  }).join('');
  ul.querySelectorAll('[data-delteam]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.delteam;
    state.teams = state.teams.filter(t => t.id !== id);
    state.members.forEach(m => { if (m.teamId === id) m.teamId = ''; });
    activeTeams.delete(id);
    render();
  }));
}

function onSubmitMember(e) {
  e.preventDefault();
  const name = $('mName').value.trim();
  const tz = $('mTz').dataset.tz || (tzSearch($('mTz').value, 1)[0] || {}).tz || '';
  const start = parseTime($('mStart').value);
  const end = parseTime($('mEnd').value);
  const overnight = $('mOvernight').checked;
  const teamId = $('mTeam').value;
  const weekend = getDaysOff();

  const err = validateMember({ name, tz, start, end, overnight });
  const errEl = $('formError');
  if (err) { errEl.textContent = err; errEl.hidden = false; return; }
  errEl.hidden = true;

  const member = { name, tz, start, end, teamId, weekend };
  if (editingIndex >= 0) state.members[editingIndex] = member; else state.members.push(member);
  closeDrawer(); render();
}

function validateMember({ name, tz, start, end, overnight }) {
  if (!name) return 'Please enter a name.';
  if (!isValidZone(tz)) return 'Pick a location from the list (search a city or country).';
  if (!isWorkHour(start) || !isWorkHour(end)) return 'Use 30-minute steps.';
  if (start === end) return 'Start and end cannot be the same.';
  if (!overnight && start >= end) return 'Start must be before end — or tick “Overnight shift”.';
  return null;
}

function startEdit(gi) {
  const m = state.members[gi];
  editingIndex = gi;
  $('mName').value = m.name;
  $('mTz').value = labelForTz(m.tz); $('mTz').dataset.tz = m.tz;
  $('mStart').value = toTimeInput(m.start); $('mEnd').value = toTimeInput(m.end);
  $('mOvernight').checked = m.start >= m.end;
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
  $('mStart').value = '09:00'; $('mEnd').value = '17:00';
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
      { name: 'Sriram', tz: 'Asia/Kolkata', start: 9, end: 17, teamId: eng, weekend: [6, 7] },
      { name: 'Mia', tz: 'America/New_York', start: 9, end: 17, teamId: eng, weekend: [6, 7] },
      { name: 'Lukas', tz: 'Europe/Berlin', start: 8, end: 16, teamId: mkt, weekend: [6, 7] },
      { name: 'Yuki', tz: 'Asia/Tokyo', start: 10, end: 18, teamId: mkt, weekend: [6, 7] },
    ],
  };
}
function parseTime(s) { const [h, m] = String(s).split(':').map(Number); return h + (m || 0) / 60; }
function toTimeInput(f) { const h = Math.floor(f); return pad2(h) + ':' + pad2(Math.round((f - h) * 60)); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
