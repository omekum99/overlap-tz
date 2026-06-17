'use strict';

/*
 * timeutil.js — all the timezone math, kept pure and small.
 *
 * The board is a fixed 24-hour axis in UTC (0 → 24). Every member's local
 * working hours are projected onto that axis. We use Luxon only to ask "what is
 * this zone's offset from UTC right now?" — everything else is plain arithmetic,
 * so it's easy to read and reason about.
 */

const { DateTime } = luxon;

// Offset of a zone from UTC, in fractional hours. India (IST) → 5.5.
function zoneOffsetHours(tz) {
  return DateTime.now().setZone(tz).offset / 60;
}

// Current UTC time as a fractional hour on the axis (13.5 === 13:30).
function nowUtcHour() {
  const u = DateTime.utc();
  return u.hour + u.minute / 60;
}

function mod24(h) { return ((h % 24) + 24) % 24; }

// Is local hour `h` inside the working band [start, end)? Handles overnight.
function isWithin(h, start, end) {
  if (start === end) return false;
  if (end > start) return h >= start && h < end;
  return h >= start || h < end;            // wraps past midnight
}

// "13:30" from a fractional hour.
function hourLabel(h) {
  h = mod24(h);
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60) % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// Project a member's local working band onto the UTC axis.
// Returns 1 interval, or 2 when it crosses midnight UTC. Hours are fractional.
function bandToUtcIntervals(start, end, tz) {
  if (start === end) return [];
  const off = zoneOffsetHours(tz);
  const s = mod24(start - off);
  const e = mod24(end - off);
  if (e > s) return [{ start: s, end: e }];
  return [{ start: s, end: 24 }, { start: 0, end: e }];   // wrapped → split
}

// Member's local clock + working flag at a given UTC hour on the axis.
function localAtUtc(utcHour, member) {
  const off = zoneOffsetHours(member.tz);
  const local = mod24(utcHour + off);
  return { label: hourLabel(local), working: isWithin(local, member.start, member.end) };
}

// Is this member working at the given UTC hour?
function memberWorkingAtUtc(utcHour, member) {
  const off = zoneOffsetHours(member.tz);
  return isWithin(mod24(utcHour + off), member.start, member.end);
}

/*
 * Meeting planner: find UTC windows where EVERY given member is working.
 * We sample the day in 15-minute slots (96/day) and AND the coverage together —
 * dead simple, and immune to the fractional offsets (e.g. +5:30) that trip up
 * interval-intersection code. Returns windows sorted longest-first.
 */
function findOverlapWindows(members) {
  if (members.length === 0) return [];
  const SLOTS = 96, STEP = 24 / SLOTS;             // 0.25h
  const covered = new Array(SLOTS).fill(true);
  for (const m of members) {
    for (let i = 0; i < SLOTS; i++) {
      if (!memberWorkingAtUtc(i * STEP, m)) covered[i] = false;
    }
  }
  if (covered.every(Boolean)) return [{ start: 0, end: 24, hours: 24 }];
  if (covered.every(v => !v)) return [];

  // Rotate so we begin on an uncovered slot — then any wrap becomes one clean run.
  const startAt = covered.indexOf(false);
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
