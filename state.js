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
// Two version layers, both load-bearing:
//   • ENVELOPE  — the on-the-wire encoding format (lz-string + this blob shape).
//                 Written as a `v<N>:` marker. Read on decode so a *newer* format
//                 fails closed (empty board) instead of being mis-parsed.
//   • SCHEMA    — the shape of the decoded object. Stored as `v` inside the blob
//                 and run through MIGRATIONS on the way in so old links keep working.
const ENVELOPE_VERSION = 1;
const ENVELOPE_PREFIX = 'v' + ENVELOPE_VERSION + ':';
const SCHEMA_VERSION = 2;
const DEFAULT_WEEKEND = [6, 7];  // Sat, Sun (Luxon weekday numbering)
const EMPTY_STATE = { org: '', wid: '', teams: [], members: [] };

// Schema migrations: MIGRATIONS[n] upgrades a wire object from version n → n+1.
// Add an entry whenever SCHEMA_VERSION is bumped; old URLs then upgrade on load.
const MIGRATIONS = {
  // 1: wire => { /* v1 → v2 transform */ return wire; },
};
function migrateWire(wire) {
  let v = Number.isInteger(wire.v) ? wire.v : 1;   // pre-versioned links were v1
  while (v < SCHEMA_VERSION && MIGRATIONS[v]) { wire = MIGRATIONS[v](wire); v++; }
  wire.v = v;
  return wire;
}

// Valid IANA zones — powers both validation and the form autocomplete.
const VALID_ZONES = (() => {
  try { return new Set(Intl.supportedValuesOf('timeZone')); }
  catch { return null; }          // very old browsers: fall back to Luxon checks
})();

// Validate an IANA zone. The `Intl.supportedValuesOf` set only lists each zone's
// *canonical* id for the host's ICU build, which varies: many engines still
// canonicalize India to `Asia/Calcutta` and omit `Asia/Kolkata`, Ukraine to
// `Europe/Kiev` and omit `Europe/Kyiv`, etc. So the set is a fast-path allowlist
// only — on a miss we fall through to Luxon, which resolves these aliases the
// same way the browser's Intl.DateTimeFormat does. Without this, picking India
// (and ~6 other curated zones) fails validation and shared links silently drop
// those teammates on load.
function isValidZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (VALID_ZONES && VALID_ZONES.has(tz)) return true;   // fast path
  return luxon.DateTime.now().setZone(tz).isValid;        // alias-tolerant fallback
}

// A work hour: 0–23.5 on the half hour (so 9, 9.5, 17 are all valid).
function isWorkHour(n) { return typeof n === 'number' && n >= 0 && n < 24 && (n * 2) % 1 === 0; }

function sameWeekend(a) {
  return Array.isArray(a) && a.length === 2 && a.includes(6) && a.includes(7);
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function shortId() { return Math.random().toString(36).slice(2, 8); }

// Deterministic id derived from a link's content. Used only to back-fill the
// workspace id for legacy links that predate `wid`: a random id would re-key (and
// orphan) this device's saved meetings on every reload, whereas a content hash is
// stable across reloads — and the very next save writes a real `w` into the URL,
// so this fallback only matters for that first render.
function stableWid(wire) {
  const basis = JSON.stringify([wire.o || '', wire.tm || [], wire.mb || []]);
  let h = 0x811c9dc5;                                  // FNV-1a (32-bit)
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'g' + (h >>> 0).toString(36);                 // 'g' = generated, avoids leading-digit issues
}

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
  return ENVELOPE_PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify(wire));
}

// ── deserialize (never throws — corrupt/truncated URLs yield an empty board) ─
function decodeState(encoded) {
  try {
    if (!encoded) return clone(EMPTY_STATE);
    // Envelope: a `v<N>:` marker frames the encoding format. A newer N than we
    // know means a forward-incompatible link — fail closed rather than mis-read.
    const env = /^v(\d+):/.exec(encoded);
    let raw;
    if (env) {
      if (+env[1] > ENVELOPE_VERSION) {
        console.warn('This link uses a newer Overlap format than this version can read.');
        return clone(EMPTY_STATE);
      }
      raw = encoded.slice(env[0].length);
    } else {
      raw = encoded;            // legacy: links from before the envelope existed
    }
    const json = LZString.decompressFromEncodedURIComponent(raw);
    if (!json) return clone(EMPTY_STATE);
    let wire = JSON.parse(json);
    if (!wire || typeof wire !== 'object') return clone(EMPTY_STATE);
    wire = migrateWire(wire);   // bring any older schema up to current shape

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
      wid: typeof wire.w === 'string' && wire.w ? wire.w : stableWid(wire),  // back-fill old links deterministically
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
