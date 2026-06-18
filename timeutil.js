'use strict';

/*
 * timeutil.js — all the timezone math, kept pure and small.
 *
 * The board is a 24-hour axis rendered in a chosen *home timezone* (the viewer's
 * own zone by default) on a chosen *date*. Everyone's local working hours are
 * projected onto that axis. The date matters: offsets between zones change with
 * daylight-saving, so "the same meeting" overlaps differently in January vs July.
 *
 * We lean on Luxon for the one hard part — converting a wall-clock time in one
 * zone, on a specific date, into another zone (DST included). Everything else is
 * plain arithmetic.
 */

const { DateTime } = luxon;

function mod24(h) { return ((h % 24) + 24) % 24; }
function pad2(n) { return String(n).padStart(2, '0'); }

// Is local hour `h` inside the working band [start, end)? Handles overnight.
function isWithin(h, start, end) {
  if (start === end) return false;
  if (end > start) return h >= start && h < end;
  return h >= start || h < end;            // wraps past midnight
}

// 12h vs 24h display, toggled from the UI.
let HOUR_12 = true;
function setHour12(v) { HOUR_12 = !!v; }

// "13:30" (or "1:30 PM") from a fractional hour.
function hourLabel(h) {
  h = mod24(h);
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60) % 60;
  if (HOUR_12) {
    const ap = hh < 12 ? 'AM' : 'PM';
    const h12 = (hh % 12) || 12;
    return h12 + ':' + pad2(mm) + ' ' + ap;
  }
  return pad2(hh) + ':' + pad2(mm);
}

// ── date / zone helpers ──────────────────────────────────────────────────────
function browserTz() { return DateTime.now().zoneName; }
function todayISO(tz) { return DateTime.now().setZone(tz).toISODate(); }
function isTodayISO(iso, tz) { return todayISO(tz) === iso; }
function shiftISO(iso, days) { return DateTime.fromISO(iso).plus({ days }).toISODate(); }
function prettyDate(iso) { return DateTime.fromISO(iso).toFormat('ccc, dd LLL yyyy'); }

// The instant at `axisHour` on the home-tz day. (Fractional hours via minutes,
// and startOf('day') so DST transition days are handled correctly.)
function axisInstant(axisHour, isoDate, homeTz) {
  return DateTime.fromISO(isoDate, { zone: homeTz }).startOf('day')
    .plus({ minutes: Math.round(axisHour * 60) });
}

// Current time as a position on the home-tz axis (e.g. 13.5 === 13:30).
function nowAxisHour(homeTz) {
  const n = DateTime.now().setZone(homeTz);
  return n.hour + n.minute / 60;
}

// ── projection: member's working hours → position on the home-tz axis ─────────
// A member's wall-clock hour, on their own local `isoDate`, mapped to the axis.
function memberHourToAxis(memberHour, memberTz, isoDate, homeTz) {
  const inst = DateTime.fromISO(isoDate, { zone: memberTz }).startOf('day')
    .plus({ hours: memberHour }).setZone(homeTz);
  return mod24(inst.hour + inst.minute / 60);
}

// Project the working band onto the axis. 1 interval, or 2 when it crosses the
// axis midnight. Hours fractional.
function bandToAxisIntervals(member, isoDate, homeTz) {
  if (member.always) return [{ start: 0, end: 24 }];     // available the whole day
  const dur = mod24(member.end - member.start);
  if (dur === 0) return [];
  const s = memberHourToAxis(member.start, member.tz, isoDate, homeTz);
  const e = mod24(s + dur);
  if (e > s) return [{ start: s, end: e }];
  return [{ start: s, end: 24 }, { start: 0, end: e }];   // wrapped → split
}

// Member's local clock + working flag at a given axis hour.
function localAt(axisHour, member, isoDate, homeTz) {
  const inst = axisInstant(axisHour, isoDate, homeTz).setZone(member.tz);
  const lh = inst.hour + inst.minute / 60;
  const working = member.always ? true : isWithin(lh, member.start, member.end);
  return { label: hourLabel(lh), working };
}

function memberWorkingAt(axisHour, member, isoDate, homeTz) {
  const inst = axisInstant(axisHour, isoDate, homeTz).setZone(member.tz);
  const weekend = member.weekend || [6, 7];
  if (weekend.includes(inst.weekday)) return false;       // their day off
  if (member.always) return true;                         // available any hour
  return isWithin(inst.hour + inst.minute / 60, member.start, member.end);
}

// Is `isoDate` a non-working day in the member's own local calendar?
function isMemberOff(member, isoDate) {
  const wd = DateTime.fromISO(isoDate, { zone: member.tz }).weekday;  // Mon=1..Sun=7
  return (member.weekend || [6, 7]).includes(wd);
}

// Turn overlap windows into concrete clickable start times (every 30 min) that
// fit a meeting of `durHours`. Wrapping windows handled via their length.
function generateSlots(windows, durHours, maxSlots = 12) {
  if (durHours <= 0) return [];
  const out = [];
  for (const w of windows) {
    if (w.hours + 1e-9 < durHours) continue;
    const steps = Math.floor((w.hours - durHours) / 0.5 + 1e-9);
    for (let i = 0; i <= steps && out.length < maxSlots; i++) {
      const start = mod24(w.start + i * 0.5);
      out.push({ start, end: mod24(start + durHours) });
    }
  }
  return out;
}

/*
 * Meeting planner: find axis windows where EVERY given member is working.
 * Sample the day in 15-minute slots (96/day) and AND the coverage — simple, and
 * immune to fractional offsets (e.g. +5:30). Windows are sorted longest-first.
 */
function findOverlapWindows(members, isoDate, homeTz) {
  if (members.length === 0) return [];
  const SLOTS = 96, STEP = 24 / SLOTS;             // 0.25h
  const covered = new Array(SLOTS).fill(true);
  for (const m of members) {
    for (let i = 0; i < SLOTS; i++) {
      if (!memberWorkingAt(i * STEP, m, isoDate, homeTz)) covered[i] = false;
    }
  }
  if (covered.every(Boolean)) return [{ start: 0, end: 24, hours: 24 }];
  if (covered.every(v => !v)) return [];

  const startAt = covered.indexOf(false);          // rotate so a wrap is one run
  const windows = [];
  let run = null;
  for (let k = 0; k < SLOTS; k++) {
    const idx = (startAt + k) % SLOTS;
    if (covered[idx]) {
      run = run || { startIdx: idx, len: 0 };
      run.len++;
    } else if (run) {
      windows.push(runToWindow(run, STEP));
      run = null;
    }
  }
  if (run) windows.push(runToWindow(run, STEP));
  return windows.sort((a, b) => b.hours - a.hours);
}

function runToWindow(run, step) {
  const start = run.startIdx * step;
  const hours = run.len * step;
  return { start, end: mod24(start + hours) || 24, hours };
}
