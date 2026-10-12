'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../src/main/time');

const tasks = [
  { id: 't1', name: 'Claims review', requiresNote: false, active: true },
  { id: 't2', name: 'Other', requiresNote: true, active: true },
  { id: 't3', name: 'Old task', requiresNote: false, active: false },
];
const settings = { editWindowDays: 14 };
const at = (s) => new Date(s);
const NOW = at('2026-10-12T15:00:00');

test('starting and stopping the timer records one entry', () => {
  const entries = [];
  assert.deepEqual(time.startTimer(entries, tasks, { taskId: 't1', note: '' }, at('2026-10-12T09:00:00')), []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].end, null);
  assert.deepEqual(time.startTimer(entries, tasks, {}, at('2026-10-12T09:05:00')), ['Your timer is already running.']);

  assert.deepEqual(time.updateTimer(entries, tasks, { taskId: 't1', note: 'March batch' }, at('2026-10-12T11:30:00'), { stop: true }), []);
  assert.equal(entries[0].end, at('2026-10-12T11:30:00').toISOString());
  assert.equal(entries[0].taskName, 'Claims review');
  assert.equal(entries[0].note, 'March batch');
  assert.equal(entries[0].original.end, entries[0].end);
  assert.equal(time.running(entries), null);
});

test('stopping needs a task or a description', () => {
  const entries = [];
  time.startTimer(entries, tasks, {}, at('2026-10-12T09:00:00'));
  assert.deepEqual(time.updateTimer(entries, tasks, { note: '  ' }, NOW, { stop: true }), ['Choose a task or describe what you worked on.']);
  assert.deepEqual(time.updateTimer(entries, tasks, { taskId: 't2' }, NOW, { stop: true }), ['Describe the work when the task is "Other".']);
  assert.deepEqual(time.updateTimer(entries, tasks, { note: 'Phone calls' }, NOW, { stop: true }), []);
});

test('a retired task is refused for new time but kept on an entry that has it', () => {
  const entries = [];
  assert.deepEqual(time.startTimer(entries, tasks, { taskId: 't3' }, NOW), ['Choose a task from the list.']);
  entries.push({ id: 'e1', start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z', taskId: 't3', taskName: 'Old task', note: null });
  assert.deepEqual(time.editEntry(entries, tasks, settings, 'e1', { start: '2026-10-12T07:30', end: '2026-10-12T09:00', taskId: 't3' }, NOW), []);
});

test('manual entries are checked for order, length, overlap and the future', () => {
  const entries = [];
  const add = (start, end, note = 'Work') => time.addEntry(entries, tasks, settings, { start, end, note }, NOW);
  assert.deepEqual(add('2026-10-12T09:00', '2026-10-12T10:00'), []);
  assert.equal(entries[0].manual, true);
  assert.deepEqual(add('2026-10-12T11:00', '2026-10-12T10:00'), ['The end must be after the start.']);
  assert.match(add('2026-10-10T08:00', '2026-10-11T09:00')[0], /at most 24 hours/);
  assert.match(add('2026-10-12T09:30', '2026-10-12T11:00')[0], /overlaps your entry/);
  assert.deepEqual(add('2026-10-12T10:00', '2026-10-12T11:00'), [], 'touching end to start is not an overlap');
  assert.match(add('2026-10-12T16:00', '2026-10-12T17:00').join(' '), /future/);
  assert.match(add('2026-09-01T09:00', '2026-09-01T10:00')[0], /last 14 days/);
});

test('a running timer counts as running until now for overlaps', () => {
  const entries = [];
  time.startTimer(entries, tasks, {}, at('2026-10-12T13:00:00'));
  const errors = time.addEntry(entries, tasks, settings, { start: '2026-10-12T14:00', end: '2026-10-12T14:30', note: 'x' }, NOW);
  assert.match(errors[0], /still running/);
});

test('edits are recorded, and invoiced or old entries are locked', () => {
  const entries = [];
  time.addEntry(entries, tasks, settings, { start: '2026-10-12T09:00', end: '2026-10-12T10:00', note: 'Work' }, NOW);
  const id = entries[0].id;
  assert.deepEqual(time.editEntry(entries, tasks, settings, id, { start: '2026-10-12T08:30', end: '2026-10-12T10:00', note: 'Work' }, NOW), []);
  assert.equal(entries[0].changes.length, 1);
  assert.equal(entries[0].changes[0].before.start, at('2026-10-12T09:00').toISOString());

  // Saving with nothing changed records nothing.
  time.editEntry(entries, tasks, settings, id, { start: '2026-10-12T08:30', end: '2026-10-12T10:00', note: 'Work' }, NOW);
  assert.equal(entries[0].changes.length, 1);

  entries[0].invoiceId = 'inv1';
  assert.match(time.deleteEntry(entries, settings, id, NOW)[0], /on an invoice/);

  entries.push({ id: 'old', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z', note: 'x' });
  assert.match(time.deleteEntry(entries, settings, 'old', NOW)[0], /older than 14 days/);
  assert.deepEqual(time.deleteEntry(entries, { editWindowDays: 0 }, 'old', NOW), []);
});

test('deleting the running entry stops it', () => {
  const entries = [];
  time.startTimer(entries, tasks, {}, at('2026-10-12T13:00:00'));
  assert.deepEqual(time.deleteEntry(entries, settings, entries[0].id, NOW), []);
  assert.equal(time.running(entries), null);
  assert.deepEqual(time.startTimer(entries, tasks, {}, NOW), []);
});

test('editing the running entry without an end keeps it running', () => {
  const entries = [];
  time.startTimer(entries, tasks, {}, at('2026-10-12T13:00:00'));
  assert.deepEqual(time.editEntry(entries, tasks, settings, entries[0].id, { start: '2026-10-12T12:45', end: '' }, NOW), []);
  assert.equal(time.running(entries).start, at('2026-10-12T12:45').toISOString());
});

test('hoursBetween counts only completed, undeleted time that started in the range', () => {
  const entries = [
    { start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T14:30:00.000Z' },
    { start: '2026-10-12T15:00:00.000Z', end: '2026-10-12T16:00:00.000Z', deleted: '2026-10-12T17:00:00.000Z' },
    { start: '2026-10-12T17:00:00.000Z', end: null },
    { start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T14:00:00.000Z' },
  ];
  assert.equal(time.hoursBetween(entries, at('2026-10-12T00:00:00Z'), at('2026-10-13T00:00:00Z')), 1.5);
});
