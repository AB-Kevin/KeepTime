'use strict';

// The timesheet email: every week, two weeks or four, a CSV of each employee's
// and manager's time (contractors invoice instead) goes to the addresses a
// manager chose. KeepTime has no server, so whichever manager's app is open
// sends it (see main.js). This file holds the rules: when it's due, which
// period it covers, who's in it, and what the files say.
//
// The schedule is kept in shared/settings.json (managers write it):
//   timesheets: { enabled, recipients: [], everyWeeks, firstSend: 'YYYY-MM-DD',
//                 sendTime: 'HH:MM', changedAt }
//   smtp: { host, port, secure, user, fromEmail, fromName }
// The SMTP password is kept apart, on each sending computer (see main.js), since
// everyone who logs time can read the shared folder.
//
// Each send covers the `everyWeeks` weeks before the day it's sent, so an
// email sent on a Monday covers through the Sunday before. Times are in the
// sending computer's time zone.

const Fmt = require('../shared/format');

const DAY_MS = 24 * 60 * 60 * 1000;
const FREQUENCIES = [1, 2, 4];
const MAX_RECIPIENTS = 20;
const EMAIL = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;

const DEFAULT_SCHEDULE = { enabled: false, recipients: [], everyWeeks: 2, firstSend: null, sendTime: '08:00', changedAt: null };
const DEFAULT_SMTP = { host: '', port: 587, secure: false, user: '', fromEmail: '', fromName: 'KeepTime' };

const pad = (n) => String(n).padStart(2, '0');

/** Days since 1970 for a 'YYYY-MM-DD', counted by calendar, so daylight saving doesn't shift it. */
const dayNumber = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

const addDays = (day, days) => {
  const d = Fmt.toDate(day);
  d.setDate(d.getDate() + days);
  return Fmt.dayKey(d);
};

/**
 * The k-th send after the first (k may be negative): when it goes, and the
 * period it covers. `key` names the period in the record of what's been sent.
 */
function occurrence(schedule, k) {
  const periodDays = schedule.everyWeeks * 7;
  const sendDay = addDays(schedule.firstSend, k * periodDays);
  const [hours, minutes] = schedule.sendTime.split(':').map(Number);
  const sendAt = Fmt.toDate(sendDay);
  sendAt.setHours(hours, minutes, 0, 0);
  const from = addDays(sendDay, -periodDays);
  return { k, sendAt, from, to: addDays(sendDay, -1), key: from };
}

/** The most recent send at or before `now`, whether or not it's been sent. */
function latest(schedule, now) {
  let k = Math.floor((dayNumber(Fmt.dayKey(now)) - dayNumber(schedule.firstSend)) / (schedule.everyWeeks * 7));
  while (occurrence(schedule, k + 1).sendAt <= now) k++;
  while (occurrence(schedule, k).sendAt > now) k--;
  return occurrence(schedule, k);
}

/**
 * The send that should go out now, or null. Only the most recent one: if the
 * apps were closed through a few, one email for the latest period is sent.
 * Sends from before the schedule was last changed aren't, so setting the first
 * send in the past doesn't email an old period right away.
 */
function due(schedule, now) {
  if (!schedule.enabled || !schedule.firstSend) return null;
  const occ = latest(schedule, now);
  if (occ.k < 0 || (schedule.changedAt && occ.sendAt <= new Date(schedule.changedAt))) return null;
  return occ;
}

/** The next send after `now` that will go out, or null when sending is off. */
function next(schedule, now) {
  if (!schedule.enabled || !schedule.firstSend) return null;
  const changedAt = schedule.changedAt ? new Date(schedule.changedAt) : null;
  return occurrence(schedule, latest(schedule, changedAt > now ? changedAt : now).k + 1);
}

/** Who gets a CSV: employees and managers who log time. Turned-off people only if they logged time in the period. */
const included = (person) => !person.removed && person.class !== 'contractor' && person.contractor;

/** Completed time that started in the period, oldest first, and any timer still running in it. */
function entriesIn(entries, from, to) {
  const start = Fmt.toDate(from).getTime();
  const end = Fmt.toDate(addDays(to, 1)).getTime();
  const inPeriod = entries.filter((e) => !e.deleted && Date.parse(e.start) >= start && Date.parse(e.start) < end);
  return {
    done: inPeriod.filter((e) => e.end).sort((a, b) => a.start.localeCompare(b.start)),
    running: inPeriod.some((e) => !e.end),
  };
}

const hoursOf = (e) => Fmt.hoursOf(Date.parse(e.end) - Date.parse(e.start));
const clockTime = (value) => {
  const d = Fmt.toDate(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const cell = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One person's time as CSV: a row per entry and a total. Hours are each
 * entry's, to two places, so the column adds up to the total. The byte-order
 * mark lets Excel read names with accents.
 */
function csv(name, entries) {
  const rows = [['Name', 'Date', 'Start', 'End', 'Hours', 'Task', 'Description']];
  for (const e of entries) {
    rows.push([name, Fmt.dayKey(e.start), clockTime(e.start), clockTime(e.end), Fmt.hours(hoursOf(e)), e.taskName ?? '', e.note ?? '']);
  }
  rows.push([name, 'Total', '', '', Fmt.hours(totalHours(entries)), '', '']);
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

const totalHours = (entries) => Math.round(entries.reduce((sum, e) => sum + hoursOf(e), 0) * 100) / 100;

/** "2026-10-05 to 2026-10-18 - Ann Miller.csv", without characters Windows doesn't allow in file names. */
const fileName = (from, to, name) => `${from} to ${to} - ${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Unnamed'}.csv`;

const periodText = (from, to) => `${Fmt.date(from)} to ${Fmt.date(to)}`;

/**
 * The email for one period. `people` is [{ name, entries }] for everyone
 * included, with all their entries. Returns { subject, text, attachments }.
 */
function buildEmail({ from, to, people, test = false }) {
  const withTime = [];
  const without = [];
  const running = [];
  for (const p of [...people].sort((a, b) => a.name.localeCompare(b.name))) {
    const { done, running: isRunning } = entriesIn(p.entries, from, to);
    if (isRunning) running.push(p.name);
    if (done.length) withTime.push({ name: p.name, entries: done });
    else if (p.active) without.push(p.name);
  }
  const lines = [
    `Timesheets for ${periodText(from, to)}, one CSV file per person.`,
    '',
    ...(withTime.length ? withTime.map((p) => `${p.name}: ${Fmt.hours(totalHours(p.entries))} hours`) : ['No one logged time in this period.']),
  ];
  if (without.length) lines.push('', `No time logged: ${without.join(', ')}.`);
  if (running.length) {
    lines.push('', `Timer still running, so not included until it's stopped: ${running.join(', ')}.`);
  }
  lines.push('', 'Times are in the sending computer\'s time zone. Sent by KeepTime.');
  if (test) lines.unshift('This is a test. The scheduled email looks like this.', '');
  return {
    subject: `${test ? 'Test: ' : ''}Timesheets for ${periodText(from, to)}`,
    text: lines.join('\n'),
    attachments: withTime.map((p) => ({ filename: fileName(from, to, p.name), content: csv(p.name, p.entries), contentType: 'text/csv; charset=utf-8' })),
  };
}

// Settings --------------------------------------------------------------------------

/** Addresses as typed, separated by commas, semicolons or spaces. */
const parseRecipients = (text) => [...new Set(String(text ?? '').split(/[\s,;]+/).filter(Boolean))];

const scheduleOf = (settings) => ({ ...DEFAULT_SCHEDULE, ...settings.timesheets });
const smtpOf = (settings) => ({ ...DEFAULT_SMTP, ...settings.smtp });

/**
 * Checks the timesheet email settings as typed. Returns { errors, schedule, smtp,
 * testAddress } ready to save. `previous` is the saved schedule: changing when it sends
 * marks it changed, so earlier sends aren't made up (see `due`).
 */
function readSettings(input, previous, now) {
  const errors = [];
  const recipients = parseRecipients(input.recipients);
  const everyWeeks = Number(input.everyWeeks);
  const firstSend = String(input.firstSend ?? '');
  const sendTime = String(input.sendTime ?? '');
  const enabled = Boolean(input.enabled);

  const bad = recipients.filter((r) => !EMAIL.test(r));
  if (bad.length) errors.push(`${bad.join(', ')} ${bad.length === 1 ? "isn't an email address" : "aren't email addresses"}.`);
  else if (recipients.length > MAX_RECIPIENTS) errors.push(`Send to at most ${MAX_RECIPIENTS} addresses.`);
  else if (enabled && !recipients.length) errors.push('Enter who gets the timesheets.');
  if (!FREQUENCIES.includes(everyWeeks)) errors.push('Choose how often to send.');
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(firstSend) && Fmt.dayKey(firstSend) === firstSend;
  if (firstSend ? !validDay : enabled) errors.push('Enter the date of the first send.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) errors.push('Enter the time to send, such as 8:00 AM.');

  const port = Number(input.port || 587);
  const smtp = {
    host: String(input.host ?? '').trim(),
    port,
    secure: Boolean(input.secure),
    user: String(input.user ?? '').trim(),
    fromEmail: String(input.fromEmail ?? '').trim(),
    fromName: String(input.fromName ?? '').trim().replace(/["<>\r\n]/g, ''),
  };
  if (enabled && !smtp.host) errors.push('Enter the mail server.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('The port is a number such as 587 or 465.');
  if (smtp.fromEmail ? !EMAIL.test(smtp.fromEmail) : enabled && !EMAIL.test(smtp.user)) {
    errors.push('Enter the address the email comes from.');
  }
  if (smtp.fromName.length > 100 || smtp.host.length > 200 || smtp.user.length > 200) errors.push('Keep each field under 100 characters.');
  const testAddress = String(input.testAddress ?? '').trim();
  if (testAddress && !EMAIL.test(testAddress)) errors.push(`${testAddress} isn't an email address.`);

  const schedule = { enabled, recipients, everyWeeks, firstSend: firstSend || null, sendTime };
  const prev = { ...DEFAULT_SCHEDULE, ...previous };
  const changed = ['enabled', 'everyWeeks', 'firstSend', 'sendTime'].some((k) => schedule[k] !== prev[k]);
  schedule.changedAt = changed ? now.toISOString() : prev.changedAt;
  return { errors, schedule, smtp, testAddress };
}

/** Whether `log` (someone's people/<id>/timesheets.json) records sending this period. */
const wasSent = (log, key) => Boolean(log?.sent?.some((s) => s.key === key));

/** Adds a send to someone's log, keeping the most recent ones. */
function recordSent(log, record) {
  return { ...log, sent: [record, ...(log?.sent ?? [])].slice(0, 26), problem: null };
}

module.exports = {
  FREQUENCIES,
  DEFAULT_SCHEDULE,
  DEFAULT_SMTP,
  occurrence,
  latest,
  due,
  next,
  included,
  entriesIn,
  csv,
  fileName,
  buildEmail,
  parseRecipients,
  scheduleOf,
  smtpOf,
  readSettings,
  wasSent,
  recordSent,
};
