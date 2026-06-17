'use strict';

/*
 * store.js — each user's PRIVATE rich data, kept in localStorage.
 *
 * The shared URL only carries the team config (see state.js). Heavier, personal
 * data — saved/booked meetings and their MOM (minutes) notes — lives here, on
 * this device, keyed by the workspace id so it stays attached to the right team
 * even as the config URL changes. It is NOT shared; to share a meeting, export
 * it to a calendar (see calendar.js).
 */

function meetingsKey(wid) { return 'tzclock.mtg.' + wid; }

function loadMeetings(wid) {
  if (!wid) return [];
  try { return JSON.parse(localStorage.getItem(meetingsKey(wid))) || []; }
  catch { return []; }
}

function saveMeetings(wid, list) {
  if (!wid) return;
  try { localStorage.setItem(meetingsKey(wid), JSON.stringify(list)); }
  catch (err) { console.warn('Could not save meetings locally:', err); }
}

// A meeting stores an absolute instant (UTC ISO) so it renders correctly in any
// timezone later — plus duration, attendees, MOM notes and a status.
function makeMeeting({ title, startUTC, durationMin, attendees, notes }) {
  return {
    id: shortId(),
    title: title || 'Meeting',
    startUTC,
    durationMin,
    attendees: attendees || [],
    notes: notes || '',
    status: 'proposed',           // 'proposed' | 'booked'
  };
}
