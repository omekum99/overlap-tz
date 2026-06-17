'use strict';

/*
 * app.js — UI wiring.
 *
 *   URL hash ──decode──▶ `state` (shared team config) ──render──▶ DOM
 *      ▲                                                            │
 *      └──────────────── encode (debounced) ◀──────────────────────┘
 *   localStorage ──▶ `meetings` (private, per-workspace) + viewer prefs
 *
 * Viewer-only settings (mode, home tz, date, zoom, 12h, search) never enter the
 * shared URL, so everyone opens the same team in their own context.
 *
 * `DateTime` comes from timeutil.js (classic scripts share one global scope).
 */

const TEAM_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316'];
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];   // Mon=1 .. Sun=7
const SAFE_URL_LEN = 1800;
const ZOOM_MIN = 34, ZOOM_MAX = 104;

let state = clone(EMPTY_STATE);
let meetings = [];
let homeTz = restoreHomeTz();
let refDate = todayISO(homeTz);
let scrubHour = nowAxisHour(homeTz);
let plannerScope = '';               // '' = everyone, else team id
let search = '';
let zoom = +(localStorage.getItem('tzclock.zoom') || 56);
let editingIndex = -1;

const $ = id => document.getElementById(id);
function restoreHomeTz() {
  const tz = localStorage.getItem('tzclock.home') || browserTz() || 'UTC';
  return isValidZone(tz) ? tz : 'UTC';
}
function cssNum(name) { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0; }

// ── boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  state = decodeState(readHash());
  if (!state.org && state.teams.length === 0 && state.members.length === 0) state = demoWorkspace();
  if (!state.wid) state.wid = shortId();
  meetings = loadMeetings(state.wid);

  setMode(localStorage.getItem('tzclock.mode') || 'zen');
  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  const f12 = localStorage.getItem('tzclock.fmt12') === '1';
  setHour12(f12); $('fmt12').checked = f12;
  if (localStorage.getItem('tzclock.mtgOpen') === '0') $('toggleMeetings').closest('.meetings-card').classList.add('collapsed');

  initDaysOff();
  bindControls();
  bindScrubber();
  bindMeetingDialog();
  setupComboboxes();
  $('boardInner').title = 'Double-click to block / schedule time';

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
  renderPlannerScope();
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

function memberEntries() {
  const q = search.trim().toLowerCase();
  return state.members.map((m, gi) => ({ m, gi })).filter(e => !q || e.m.name.toLowerCase().includes(q));
}
function teamById(id) { return state.teams.find(t => t.id === id); }
function colorOf(member) {
  const t = teamById(member.teamId);
  return t ? TEAM_COLORS[t.color % TEAM_COLORS.length] : '#94a3b8';
}

// ── timeline ───────────────────────────────────────────────────────────────
function renderAxis() {
  const track = $('axisTrack');
  track.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const cell = document.createElement('div');
    cell.className = 'tick';
    cell.innerHTML = `<span>${String(h).padStart(2, '0')}</span>`;
    track.appendChild(cell);
  }
}

function renderLanes() {
  const wrap = $('lanes');
  wrap.innerHTML = '';
  const entries = memberEntries();
  if (entries.length === 0) {
    wrap.innerHTML = `<div class="tl-row"><div class="empty" style="grid-column:1/-1">No teammates yet — add one from the Team panel.</div></div>`;
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

function bindScrubber() {
  const inner = $('boardInner');
  let dragging = false;
  const setFromX = clientX => {
    const rect = inner.getBoundingClientRect();
    const x = clientX - rect.left - cssNum('--label-w');
    scrubHour = Math.min(24, Math.max(0, x / cssNum('--hour-w')));
    updateScrub();
  };
  inner.addEventListener('pointerdown', e => {
    if (e.target.closest('.tl-label')) return;
    const rect = inner.getBoundingClientRect();
    if (e.clientX - rect.left < cssNum('--label-w')) return;
    dragging = true; inner.setPointerCapture(e.pointerId); setFromX(e.clientX);
  });
  inner.addEventListener('pointermove', e => { if (dragging) setFromX(e.clientX); });
  inner.addEventListener('pointerup', () => { dragging = false; });

  // Double-click the calendar to block / schedule time at that moment.
  inner.addEventListener('dblclick', e => {
    if (e.target.closest('.tl-label')) return;
    const rect = inner.getBoundingClientRect();
    const x = e.clientX - rect.left - cssNum('--label-w');
    if (x < 0) return;
    let h = Math.min(23.5, Math.max(0, x / cssNum('--hour-w')));
    h = Math.round(h * 2) / 2;                 // snap to 30 min
    const scope = currentScopeWorking();
    openMeetingDialog(h, +$('duration').value, scope.map(m => m.name), 'Blocked');
  });
  $('scrubber').addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { scrubHour = mod24(scrubHour + 0.25); updateScrub(); }
    if (e.key === 'ArrowLeft')  { scrubHour = mod24(scrubHour - 0.25); updateScrub(); }
  });
}

function xForHour(h) { return cssNum('--label-w') + h * cssNum('--hour-w'); }

function positionMarkers() {
  const now = $('nowMarker');
  if (isTodayISO(refDate, homeTz)) { now.style.display = ''; now.style.left = xForHour(nowAxisHour(homeTz)) + 'px'; }
  else now.style.display = 'none';
  $('scrubber').style.left = xForHour(scrubHour) + 'px';
  renderBlocks();
}

// Translucent spans on the timeline for meetings on the selected date.
function renderBlocks() {
  const inner = $('boardInner');
  inner.querySelectorAll('.block-span').forEach(e => e.remove());
  const hw = cssNum('--hour-w'), lw = cssNum('--label-w');
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

function updateScrub() {
  $('scrubber').style.left = xForHour(scrubHour) + 'px';
  $('scrubReadout').textContent = `${hourLabel(scrubHour)} ${labelForTz(homeTz)}`;
  for (const { m, gi } of memberEntries()) {
    const el = $('live-' + gi);
    if (!el) continue;
    const { label, working } = localAt(scrubHour, m, refDate, homeTz);
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

  // drag wiring
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
function renderPlannerScope() {
  const sel = $('plannerScope');
  sel.innerHTML = '<option value="">Everyone</option>' + state.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = plannerScope;
}

function currentScopeWorking() {
  return state.members.filter(m => (!plannerScope || m.teamId === plannerScope) && !isMemberOff(m, refDate));
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

function renderPlanner() {
  const scope = state.members.filter(m => !plannerScope || m.teamId === plannerScope);
  const working = scope.filter(m => !isMemberOff(m, refDate));
  const offToday = scope.filter(m => isMemberOff(m, refDate));
  $('plannerScopeName').textContent = plannerScope ? (teamById(plannerScope)?.name || 'team') : 'everyone';

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
    ? `<p class="muted small">⛌ ${blockedCount} block${blockedCount > 1 ? 's' : ''} on this day reduce${blockedCount > 1 ? '' : 's'} availability.</p>` : '';
  const slotBtns = slots.length
    ? `<div class="slots"><span class="muted small">${durMin}-min slots:</span>${slots.map(s => `<button class="slot" data-start="${s.start}">${hourLabel(s.start)}</button>`).join('')}</div>`
    : `<p class="muted small">No free ${durMin}-min slot${blockedCount ? ' (time is blocked)' : ''} — try shorter or another date.</p>`;

  box.innerHTML = offNote + blockNote + top + slotBtns;
  box.querySelectorAll('.slot').forEach(b => b.addEventListener('click', () => openMeetingDialog(+b.dataset.start, durMin, attendees)));
}

// ── saved meetings ─────────────────────────────────────────────────────────────
function renderMeetings() {
  $('mtgCount').textContent = meetings.length ? `(${meetings.length})` : '';
  const box = $('meetings');
  if (meetings.length === 0) { box.innerHTML = '<p class="muted small">No saved meetings yet. Pick a slot above to create one.</p>'; return; }
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

// ── meeting dialog ─────────────────────────────────────────────────────────────
let pendingMeeting = null, editingMeetingId = null;
function bindMeetingDialog() {
  const dlg = $('meetingDialog');
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save' || !pendingMeeting) { pendingMeeting = editingMeetingId = null; return; }
    const data = {
      title: $('meetingTitle').value.trim() || 'Meeting',
      attendees: $('meetingAttendees').value.split(',').map(s => s.trim()).filter(Boolean),
      notes: $('meetingNotes').value.trim(),
      startUTC: pendingMeeting.startUTC, durationMin: pendingMeeting.durationMin,
    };
    if (editingMeetingId) Object.assign(meetings.find(x => x.id === editingMeetingId), data);
    else meetings.push(makeMeeting(data));
    pendingMeeting = editingMeetingId = null;
    persistMeetings(); renderMeetings(); refreshPlanner(); toast('💾 Saved on this device.');
  });
}
function openMeetingDialog(slotStart, durationMin, attendees, title = '') {
  pendingMeeting = { startUTC: axisInstant(slotStart, refDate, homeTz).toUTC().toISO(), durationMin, attendees };
  editingMeetingId = null;
  $('meetingDialogTitle').textContent = title ? 'Block / schedule time' : 'New meeting';
  $('meetingWhen').textContent = `${prettyDate(refDate)} · ${hourLabel(slotStart)}–${hourLabel(slotStart + durationMin / 60)} (${labelForTz(homeTz)})`;
  $('meetingTitle').value = title; $('meetingAttendees').value = attendees.join(', '); $('meetingNotes').value = '';
  $('meetingDialog').showModal();
}
function editMeeting(id) {
  const m = meetings.find(x => x.id === id); if (!m) return;
  pendingMeeting = { startUTC: m.startUTC, durationMin: m.durationMin }; editingMeetingId = id;
  const dt = DateTime.fromISO(m.startUTC).setZone(homeTz); const sh = dt.hour + dt.minute / 60;
  $('meetingDialogTitle').textContent = 'Edit meeting';
  $('meetingWhen').textContent = `${dt.toFormat('ccc dd LLL')} · ${hourLabel(sh)}–${hourLabel(sh + m.durationMin / 60)}`;
  $('meetingTitle').value = m.title; $('meetingAttendees').value = m.attendees.join(', '); $('meetingNotes').value = m.notes;
  $('meetingDialog').showModal();
}

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

  document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('prevDay').addEventListener('click', () => { refDate = shiftISO(refDate, -1); render(); });
  $('nextDay').addEventListener('click', () => { refDate = shiftISO(refDate, +1); render(); });
  $('todayBtn').addEventListener('click', () => { refDate = todayISO(homeTz); render(); });
  $('datePick').addEventListener('change', e => { if (e.target.value) { refDate = e.target.value; render(); } });
  $('zoomIn').addEventListener('click', () => setZoom(zoom + 12));
  $('zoomOut').addEventListener('click', () => setZoom(zoom - 12));
  $('fmt12').addEventListener('change', e => { setHour12(e.target.checked); localStorage.setItem('tzclock.fmt12', e.target.checked ? '1' : '0'); render(); });
  $('search').addEventListener('input', e => { search = e.target.value; renderLanes(); renderRoster(); updateScrub(); });
  $('plannerScope').addEventListener('change', e => { plannerScope = e.target.value; renderPlanner(); });
  $('duration').addEventListener('change', renderPlanner);

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

function setMode(m) {
  document.documentElement.dataset.mode = m;
  localStorage.setItem('tzclock.mode', m);
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  positionMarkers();
}
function setZoom(z) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  document.documentElement.style.setProperty('--hour-w', zoom + 'px');
  localStorage.setItem('tzclock.zoom', zoom);
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
    if (plannerScope === id) plannerScope = '';
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
