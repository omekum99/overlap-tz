'use strict';

/*
 * calendar.js — the bridge from a locally-saved meeting to a real calendar.
 *
 * No backend, no OAuth: we generate a standard .ics file (downloads, opens in
 * Apple/Outlook/Google Calendar) and a Google Calendar "create event" link.
 * This is how a private, local meeting gets shared with the team.
 */

const { DateTime: _DT } = luxon;

function _utc(iso) { return _DT.fromISO(iso, { zone: 'utc' }); }
function _stamp(dt) { return dt.toFormat("yyyyLLdd'T'HHmmss'Z'"); }

function _description(m) {
  let d = m.notes || '';
  if (m.attendees && m.attendees.length) d += (d ? '\n\n' : '') + 'Attendees: ' + m.attendees.join(', ');
  return d;
}

// Escape per RFC 5545 (commas, semicolons, backslashes, newlines).
function _escIcs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function meetingToIcs(m) {
  const start = _utc(m.startUTC);
  const end = start.plus({ minutes: m.durationMin });
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tzclock//timezone-visualizer//EN',
    'BEGIN:VEVENT',
    'UID:' + m.id + '@tzclock',
    'DTSTAMP:' + _stamp(start),
    'DTSTART:' + _stamp(start),
    'DTEND:' + _stamp(end),
    'SUMMARY:' + _escIcs(m.title),
    'DESCRIPTION:' + _escIcs(_description(m)),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function downloadIcs(m) {
  const blob = new Blob([meetingToIcs(m)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (m.title || 'meeting').replace(/[^\w-]+/g, '_') + '.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function googleCalUrl(m) {
  const start = _utc(m.startUTC);
  const end = start.plus({ minutes: m.durationMin });
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: m.title || 'Meeting',
    dates: _stamp(start) + '/' + _stamp(end),
    details: _description(m),
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}
