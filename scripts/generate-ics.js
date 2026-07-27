#!/usr/bin/env node
// Fetches shared/events from the Home Base Firebase Realtime Database and
// writes them out as calendar.ics (RFC 5545) for calendar subscriptions.

const fs = require('fs');
const path = require('path');

const DB = process.env.HOMEBASE_DB_URL || 'https://homebase-c7dfa-default-rtdb.firebaseio.com';
const UID_DOMAIN = 'homebase-c7dfa';
const OUTPUT_PATH = path.join(__dirname, '..', 'calendar.ics');

// Firebase RTDB serializes arrays with gaps as objects keyed by index.
function ensureArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return Object.keys(val).sort((a, b) => Number(a) - Number(b)).map(k => val[k]);
}

function escapeText(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Fold lines longer than 75 octets per RFC 5545 §3.1.
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    chunks.push(bytes.slice(offset, offset + limit).toString('utf8'));
    offset += limit;
    limit = 74; // continuation lines start with a space, which counts toward the 75
  }
  return chunks.join('\r\n ');
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toDateStamp(dateStr) {
  return dateStr.replace(/-/g, '');
}

function toDateTimeStamp(dateStr, timeStr) {
  return `${toDateStamp(dateStr)}T${timeStr.replace(':', '')}00`;
}

// Determines the end date/time for an event based on the same
// date <= x <= endDate inclusive-day convention the frontend uses.
function computeEnd(ev) {
  if (!ev.time) {
    const lastDay = ev.endDate || ev.date;
    return { date: addDays(lastDay, 1), allDay: true };
  }
  if (ev.endDate) {
    return { date: ev.endDate, time: ev.endTime || ev.time, allDay: false };
  }
  if (ev.endTime) {
    return { date: ev.date, time: ev.endTime, allDay: false };
  }
  const start = new Date(`${ev.date}T${ev.time}:00Z`);
  start.setUTCHours(start.getUTCHours() + 1);
  return {
    date: start.toISOString().slice(0, 10),
    time: start.toISOString().slice(11, 16),
    allDay: false,
  };
}

function eventToVEvent(ev, now) {
  const lines = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${ev.id}@${UID_DOMAIN}`);
  lines.push(`DTSTAMP:${now}`);

  if (!ev.time) {
    const end = computeEnd(ev);
    lines.push(`DTSTART;VALUE=DATE:${toDateStamp(ev.date)}`);
    lines.push(`DTEND;VALUE=DATE:${toDateStamp(end.date)}`);
  } else {
    const end = computeEnd(ev);
    lines.push(`DTSTART:${toDateTimeStamp(ev.date, ev.time)}`);
    lines.push(`DTEND:${toDateTimeStamp(end.date, end.time)}`);
  }

  lines.push(`SUMMARY:${escapeText(ev.title || 'Untitled Event')}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.who) lines.push(`DESCRIPTION:${escapeText(`For: ${ev.who}`)}`);
  lines.push('END:VEVENT');
  return lines;
}

function buildCalendar(events) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Home Base//Shared Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Home Base',
  ];

  for (const ev of events) {
    if (!ev || !ev.id || !ev.date) continue;
    lines.push(...eventToVEvent(ev, now));
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

async function main() {
  const res = await fetch(`${DB}/shared/events.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch events: ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();
  const events = ensureArr(raw);

  const ics = buildCalendar(events);
  fs.writeFileSync(OUTPUT_PATH, ics);
  console.log(`Wrote ${events.length} event(s) to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
