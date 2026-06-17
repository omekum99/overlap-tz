'use strict';

/*
 * state.js — the shared WORKSPACE CONFIG lives in the URL hash.
 *
 * Design split:
 *   • URL hash    → the team config (small, shareable, stateless). This file.
 *   • localStorage → each user's private rich data: saved meetings + MOM notes,
 *                    keyed by the workspace id `wid`. See store.js.
 *
 * There is no server and no database. When you change the team we minify the
 * keys, compress the JSON with lz-string, and write it to `location.hash`.
 *
 *   wire (minified, compressed)      in memory (readable)
 *   ─────────────────────────        ─────────────────────
 *   v   schema version               (used for migrations)
 *   w   workspace id                 wid     (stable; keys localStorage)
 *   o   org name                     org
 *   tm  teams  [{i,n,c}]             teams   [{id, name, color}]
 *   mb  members[{n,t,s,e,g,wk?}]     members [{name, tz, start, end, teamId, weekend}]
 *
 *   member  n=name t=IANA-tz s=startHour e=endHour (0–23.5, half-hours ok)
 *           g=teamId  wk=days-off [1..7] (Mon=1..Sun=7; omitted when Sat/Sun)
 *   team    i=id n=name c=colorIndex
 */

const HASH_PREFIX = 'w=';        // hash looks like  #w=<compressed>
const SCHEMA_VERSION = 2;
const DEFAULT_WEEKEND = [6, 7];  // Sat, Sun (Luxon weekday numbering)
const EMPTY_STATE = { org: '', wid: '', teams: [], members: [] };

// Valid IANA zones — powers both validation and the form autocomplete.
const VALID_ZONES = (() => {
  try { return new Set(Intl.supportedValuesOf('timeZone')); }
  catch { return null; }          // very old browsers: fall back to Luxon checks
})();

function isValidZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (VALID_ZONES) return VALID_ZONES.has(tz);
  return luxon.DateTime.now().setZone(tz).isValid;
}

// A work hour: 0–23.5 on the half hour (so 9, 9.5, 17 are all valid).
function isWorkHour(n) { return typeof n === 'number' && n >= 0 && n < 24 && (n * 2) % 1 === 0; }

function sameWeekend(a) {
  return Array.isArray(a) && a.length === 2 && a.includes(6) && a.includes(7);
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function shortId() { return Math.random().toString(36).slice(2, 8); }

// ── serialize ─────────────────────────────────────────────────────────────
function encodeState(state) {
  const wire = {
    v: SCHEMA_VERSION,
    w: state.wid || '',
    o: state.org || '',
    tm: state.teams.map(t => ({ i: t.id, n: t.name, c: t.color })),
    mb: state.members.map(m => {
      const out = { n: m.name, t: m.tz, s: m.start, e: m.end, g: m.teamId || '' };
      if (!sameWeekend(m.weekend)) out.wk = m.weekend;   // only store when non-default
      return out;
    }),
  };
  return LZString.compressToEncodedURIComponent(JSON.stringify(wire));
}

// ── deserialize (never throws — corrupt/truncated URLs yield an empty board) ─
function decodeState(encoded) {
  try {
    if (!encoded) return clone(EMPTY_STATE);
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return clone(EMPTY_STATE);
    const wire = JSON.parse(json);
    if (!wire || typeof wire !== 'object') return clone(EMPTY_STATE);

    const teams = (Array.isArray(wire.tm) ? wire.tm : [])
      .filter(t => t && typeof t.i === 'string' && typeof t.n === 'string')
      .map(t => ({ id: t.i, name: t.n, color: Number.isInteger(t.c) ? t.c : 0 }));

    const teamIds = new Set(teams.map(t => t.id));

    const members = (Array.isArray(wire.mb) ? wire.mb : [])
      .filter(m => m && typeof m.n === 'string' && isValidZone(m.t)
                && isWorkHour(m.s) && isWorkHour(m.e))
      .map(m => ({
        name: m.n, tz: m.t, start: m.s, end: m.e,
        teamId: teamIds.has(m.g) ? m.g : '',
        weekend: Array.isArray(m.wk) ? m.wk.filter(d => d >= 1 && d <= 7) : DEFAULT_WEEKEND.slice(),
      }));

    return {
      org: typeof wire.o === 'string' ? wire.o : '',
      wid: typeof wire.w === 'string' && wire.w ? wire.w : shortId(),  // back-fill old links
      teams,
      members,
    };
  } catch (err) {
    console.warn('Could not read workspace from the URL (truncated or corrupt). Starting fresh.', err);
    return clone(EMPTY_STATE);
  }
}

// ── URL read/write ──────────────────────────────────────────────────────────
function readHash() {
  const h = window.location.hash.replace(/^#/, '');
  return h.startsWith(HASH_PREFIX) ? h.slice(HASH_PREFIX.length) : '';
}

let _saveTimer = null;
// Debounced so typing doesn't write the URL on every keystroke. replaceState
// keeps the back button usable (one entry, not hundreds).
function saveStateDebounced(state, onLength) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const encoded = encodeState(state);
    history.replaceState(null, '', '#' + HASH_PREFIX + encoded);
    if (onLength) onLength(encoded.length);
  }, 300);
}
