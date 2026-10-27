'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('../src/main/timesheets');

// Local times, as the schedule is kept: Monday Oct 12 2026 at 8:00 is a send.
const at = (day, time = '00:00') => new Date(`${day}T${time}:00`);
const schedule = { ...ts.DEFAULT_SCHEDULE, enabled: true, recipients: ['payroll@example.org'], everyWeeks: 2, firstSend: '2026-10-12', sendTime: '08:00' };

const entry = (start, end, fields = {}) => ({ id: start, start: at(...start.split(' ')).toISOString(), end: end && at(...end.split(' ')).toISOString(), ...fields });

test('each send covers the weeks before the day it goes', () => {
  assert.deepEqual(ts.occurrence(schedule, 0), { k: 0, sendAt: at('2026-10-12', '08:00'), from: '2026-09-28', to: '2026-10-11', key: '2026-09-28' });
  assert.equal(ts.occurrence(schedule, 1).from, '2026-10-12');
  assert.equal(ts.occurrence(schedule, 1).to, '2026-10-25');
  assert.equal(ts.occurrence({ ...schedule, everyWeeks: 1 }, -1).from, '2026-09-28');
  // Across the change from daylight saving time, still 8:00 on a Monday.
  assert.deepEqual(ts.occurrence(schedule, 2).sendAt, at('2026-11-09', '08:00'));
});

test("it's due from its time until the next, and only the latest is sent", () => {
  assert.equal(ts.due(schedule, at('2026-10-12', '07:59')), null, 'before the first send');
  assert.equal(ts.due(schedule, at('2026-10-12', '08:00')).key, '2026-09-28');
  assert.equal(ts.due(schedule, at('2026-10-25', '23:00')).key, '2026-09-28');
  assert.equal(ts.due(schedule, at('2026-10-26', '08:00')).key, '2026-10-12');
  assert.equal(ts.due(schedule, at('2026-12-01', '12:00')).key, '2026-11-09', 'apps closed through a few: just the latest');
  assert.equal(ts.due({ ...schedule, enabled: false }, at('2026-10-12', '09:00')), null);
});

test("changing the schedule doesn't send a period that was already due", () => {
  const changed = { ...schedule, firstSend: '2026-09-28', changedAt: at('2026-10-14', '10:00').toISOString() };
  assert.equal(ts.due(changed, at('2026-10-14', '10:01')), null);
  assert.deepEqual(ts.next(changed, at('2026-10-14', '10:01')).sendAt, at('2026-10-26', '08:00'));
  assert.equal(ts.due(changed, at('2026-10-26', '08:00')).key, '2026-10-12');
  assert.deepEqual(ts.next(schedule, at('2026-10-01')).sendAt, at('2026-10-12', '08:00'));
  assert.equal(ts.next({ ...schedule, enabled: false }, at('2026-10-01')), null);
});

test('employees and managers who log time get a CSV; contractors and people set not to log time do not', () => {
  const people = [
    { name: 'Ann', class: 'manager', contractor: true, active: true },
    { name: 'Ben', class: 'contractor', contractor: true, active: true },
    { name: 'Cy', class: 'employee', contractor: true, active: false },
    { name: 'Di', class: 'employee', contractor: false, active: true },
    { name: 'Ed', class: null, contractor: true, active: false, removed: true },
  ];
  assert.deepEqual(people.filter(ts.included).map((p) => p.name), ['Ann', 'Cy']);
});

test('the email has a CSV per person with time in the period, named by period and person', () => {
  const email = ts.buildEmail({
    from: '2026-09-28',
    to: '2026-10-11',
    people: [
      {
        name: 'Zoe "Z" Lapp',
        active: true,
        entries: [
          entry('2026-10-01 13:00', '2026-10-01 14:20', { taskName: 'Office', note: 'Filing, mail' }),
          entry('2026-09-28 08:00', '2026-09-28 09:30', { note: 'Line one\nline two' }),
          entry('2026-09-27 08:00', '2026-09-27 09:00', { note: 'Before the period' }),
          entry('2026-10-12 08:00', '2026-10-12 09:00', { note: 'After it' }),
          entry('2026-10-02 08:00', '2026-10-02 09:00', { deleted: true }),
        ],
      },
      { name: 'Ann Miller', active: true, entries: [entry('2026-10-11 08:00', null)] },
      { name: 'Cy Lapp', active: false, entries: [] },
    ],
  });
  assert.equal(email.subject, 'Timesheets for Sep 28, 2026 to Oct 11, 2026');
  assert.deepEqual(email.attachments.map((a) => a.filename), ['2026-09-28 to 2026-10-11 - Zoe Z Lapp.csv']);
  assert.equal(
    email.attachments[0].content,
    '﻿Name,Date,Start,End,Hours,Task,Description\r\n' +
      '"Zoe ""Z"" Lapp",2026-09-28,08:00,09:30,1.50,,"Line one\nline two"\r\n' +
      '"Zoe ""Z"" Lapp",2026-10-01,13:00,14:20,1.33,Office,"Filing, mail"\r\n' +
      '"Zoe ""Z"" Lapp",Total,,,2.83,,\r\n',
  );
  assert.match(email.text, /Zoe "Z" Lapp: 2\.83 hours/);
  assert.match(email.text, /No time logged: Ann Miller\./, "turned-off people without time aren't listed");
  assert.match(email.text, /Timer still running.*: Ann Miller\./);
  assert.match(ts.buildEmail({ from: '2026-09-28', to: '2026-10-11', people: [], test: true }).subject, /^Test: /);
});

test('settings are checked as typed, and changing when it sends is dated', () => {
  const now = at('2026-10-14', '10:00');
  const input = {
    enabled: true,
    recipients: 'payroll@example.org; boss@example.org, payroll@example.org',
    everyWeeks: '2',
    firstSend: '2026-10-26',
    sendTime: '08:00',
    host: ' smtp.example.org ',
    port: '587',
    user: 'keeptime@example.org',
    fromEmail: '',
    fromName: 'KeepTime',
  };
  const ok = ts.readSettings(input, null, now);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.schedule, { enabled: true, recipients: ['payroll@example.org', 'boss@example.org'], everyWeeks: 2, firstSend: '2026-10-26', sendTime: '08:00', changedAt: now.toISOString() });
  assert.deepEqual(ok.smtp, { host: 'smtp.example.org', port: 587, secure: false, user: 'keeptime@example.org', fromEmail: '', fromName: 'KeepTime' });

  // Saving again with only the recipients changed keeps the date it was changed.
  const later = new Date(now.getTime() + 60000);
  assert.equal(ts.readSettings({ ...input, recipients: 'boss@example.org' }, ok.schedule, later).schedule.changedAt, now.toISOString());
  assert.equal(ts.readSettings({ ...input, sendTime: '09:00' }, ok.schedule, later).schedule.changedAt, later.toISOString());

  const errors = (changes) => ts.readSettings({ ...input, ...changes }, null, now).errors.join(' ');
  assert.match(errors({ recipients: 'payroll, x@y.org' }), /payroll isn't an email address/);
  assert.match(errors({ recipients: '' }), /who gets/);
  assert.match(errors({ everyWeeks: '3' }), /how often/);
  assert.match(errors({ firstSend: '2026-02-30' }), /first send/);
  assert.match(errors({ sendTime: '25:00' }), /time to send/);
  assert.match(errors({ host: '' }), /mail server/);
  assert.match(errors({ port: '70000' }), /port/);
  assert.match(errors({ user: '', fromEmail: '' }), /comes from/);
  assert.match(errors({ testAddress: 'me' }), /me isn't an email address/);
  assert.equal(errors({ enabled: false, recipients: '', host: '', firstSend: '', user: '' }), '', 'turned off, it can be left blank');
  const shared = ts.readSettings({ ...input, host: '', user: '', fromEmail: '' }, null, now, { ownServer: false });
  assert.deepEqual(shared.errors, [], "AB Apps sets the server, so KeepTime's own can be blank");
});

test('the log records what was sent', () => {
  const log = ts.recordSent({ problem: { key: 'a' } }, { key: '2026-09-28' });
  assert.equal(log.problem, null);
  assert.equal(ts.wasSent(log, '2026-09-28'), true);
  assert.equal(ts.wasSent({}, '2026-09-28'), false);
});
