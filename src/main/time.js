'use strict';

// Rules for one person's time entries. Each operation changes the `entries`
// array in place and returns a list of problems to show; an empty list means
// the caller should save.
//
// An entry: { id, start, end (null while running), taskId, taskName, note,
//   manual, original: { start, end }, invoiceId, deleted, created, changes: [] }
// taskName is copied in so renaming or retiring a task doesn't change old time.

const crypto = require('crypto');
const Fmt = require('../shared/format');

const MAX_ENTRY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTE = 1000;
const FUTURE_SLACK_MS = 60 * 1000;

const live = (entries) => entries.filter((e) => !e.deleted);
const running = (entries) => entries.find((e) => !e.deleted && !e.end) ?? null;

function describe(entry) {
  return [entry.taskName, entry.note].filter(Boolean).join(': ') || 'No description';
}

/** Checks a task choice and description. Returns { errors, task, note }. */
function resolveDescription(tasks, input, { required, currentTaskId = null }) {
  const errors = [];
  let task = null;
  if (input.taskId) {
    task = tasks.find((t) => t.id === input.taskId) ?? null;
    // A retired task stays valid on an entry that already has it.
    if (!task || (!task.active && task.id !== currentTaskId)) {
      errors.push('Choose a task from the list.');
      task = null;
    }
  }
  const note = String(input.note ?? '').trim();
  if (note.length > MAX_NOTE) errors.push(`Keep the description under ${MAX_NOTE} characters.`);
  if (task?.requiresNote && !note) errors.push(`Describe the work when the task is "${task.name}".`);
  if (required && !task && !note) errors.push('Choose a task or describe what you worked on.');
  return { errors, task, note: note || null };
}

function withinEditWindow(start, settings, now) {
  if (!settings.editWindowDays) return true;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - settings.editWindowDays);
  return Date.parse(start) >= cutoff.getTime();
}

function editBlockedReason(entry, settings, now) {
  if (entry.deleted) return 'This entry was deleted.';
  if (entry.invoiceId) return "This entry is on an invoice, so it can't be changed. Void the invoice first if it needs correcting.";
  if (!withinEditWindow(entry.start, settings, now)) {
    return `Entries older than ${settings.editWindowDays} days are locked. A manager can lengthen this in Settings.`;
  }
  return null;
}

function parseTime(value, label, errors) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    errors.push(`Enter the ${label} time.`);
    return null;
  }
  return date;
}

/** Problems with an entry running from `start` to `end` (null: still running). */
function timeProblems(entries, start, end, excludeId, now) {
  const errors = [];
  if (start > new Date(now.getTime() + FUTURE_SLACK_MS)) errors.push("The start can't be in the future.");
  if (end) {
    if (end <= start) errors.push('The end must be after the start.');
    else if (end - start > MAX_ENTRY_MS) errors.push('An entry can be at most 24 hours. Split longer work into separate entries.');
    if (end > new Date(now.getTime() + FUTURE_SLACK_MS)) errors.push("The end can't be in the future.");
  }
  if (errors.length) return errors;

  const until = end ?? now;
  for (const other of live(entries)) {
    if (other.id === excludeId) continue;
    const oStart = new Date(other.start);
    const oEnd = other.end ? new Date(other.end) : now;
    if (oStart < until && oEnd > start) {
      const span = other.end ? `${Fmt.time(oStart)} to ${Fmt.time(oEnd)}` : `${Fmt.time(oStart)}, still running`;
      errors.push(`This overlaps your entry on ${Fmt.date(oStart)}, ${span}.`);
      break;
    }
  }
  return errors;
}

function snapshot(entry) {
  return { start: entry.start, end: entry.end, taskName: entry.taskName, note: entry.note };
}

function record(entry, action, before, now) {
  entry.changes = [...(entry.changes ?? []), { at: now.toISOString(), action, before, after: snapshot(entry) }];
}

function startTimer(entries, tasks, input, now) {
  if (running(entries)) return ['Your timer is already running.'];
  const d = resolveDescription(tasks, input, { required: false });
  if (d.errors.length) return d.errors;
  const errors = timeProblems(entries, now, null, null, now);
  if (errors.length) return errors;
  const at = now.toISOString();
  entries.push({
    id: crypto.randomUUID(),
    start: at,
    end: null,
    taskId: d.task?.id ?? null,
    taskName: d.task?.name ?? null,
    note: d.note,
    manual: false,
    original: { start: at, end: null },
    invoiceId: null,
    deleted: null,
    created: at,
    changes: [],
  });
  return [];
}

/** Sets the task and description of the running timer, and stops it if `stop`. */
function updateTimer(entries, tasks, input, now, { stop }) {
  const entry = running(entries);
  if (!entry) return ["Your timer isn't running."];
  const d = resolveDescription(tasks, input, { required: stop, currentTaskId: entry.taskId });
  if (d.errors.length) return d.errors;
  entry.taskId = d.task?.id ?? null;
  entry.taskName = d.task?.name ?? null;
  entry.note = d.note;
  if (stop) {
    entry.end = now.toISOString();
    entry.original = { ...entry.original, end: entry.end };
  }
  return [];
}

function addEntry(entries, tasks, settings, input, now) {
  const errors = [];
  const start = parseTime(input.start, 'start', errors);
  const end = parseTime(input.end, 'end', errors);
  if (errors.length) return errors;
  if (!withinEditWindow(start, settings, now)) {
    errors.push(`You can only add time from the last ${settings.editWindowDays} days. Ask a manager to lengthen this in Settings.`);
  }
  errors.push(...timeProblems(entries, start, end, null, now));
  const d = resolveDescription(tasks, input, { required: true });
  errors.push(...d.errors);
  if (errors.length) return errors;
  const at = now.toISOString();
  entries.push({
    id: crypto.randomUUID(),
    start: start.toISOString(),
    end: end.toISOString(),
    taskId: d.task?.id ?? null,
    taskName: d.task?.name ?? null,
    note: d.note,
    manual: true,
    original: { start: start.toISOString(), end: end.toISOString() },
    invoiceId: null,
    deleted: null,
    created: at,
    changes: [],
  });
  return [];
}

/** Edits an entry. For the running entry, an end time stops it; leaving it blank keeps it running. */
function editEntry(entries, tasks, settings, id, input, now) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return ['That entry no longer exists.'];
  const blocked = editBlockedReason(entry, settings, now);
  if (blocked) return [blocked];

  const errors = [];
  const start = parseTime(input.start, 'start', errors);
  const end = !entry.end && !input.end ? null : parseTime(input.end, 'end', errors);
  if (errors.length) return errors;
  if (!withinEditWindow(start, settings, now)) {
    errors.push(`You can only move time to within the last ${settings.editWindowDays} days.`);
  }
  errors.push(...timeProblems(entries, start, end, entry.id, now));
  const d = resolveDescription(tasks, input, { required: Boolean(end), currentTaskId: entry.taskId });
  errors.push(...d.errors);
  if (errors.length) return errors;

  const before = snapshot(entry);
  entry.start = start.toISOString();
  entry.end = end ? end.toISOString() : null;
  entry.taskId = d.task?.id ?? null;
  entry.taskName = d.task?.name ?? null;
  entry.note = d.note;
  if (JSON.stringify(before) !== JSON.stringify(snapshot(entry))) record(entry, 'edited', before, now);
  return [];
}

function deleteEntry(entries, settings, id, now) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return ['That entry no longer exists.'];
  const blocked = editBlockedReason(entry, settings, now);
  if (blocked) return [blocked];
  const before = snapshot(entry);
  entry.deleted = now.toISOString();
  if (!entry.end) entry.end = entry.deleted; // a deleted timer isn't running any more
  record(entry, 'deleted', before, now);
  return [];
}

/** Completed hours in [from, to). */
function hoursBetween(entries, from, to) {
  let ms = 0;
  for (const e of live(entries)) {
    if (!e.end) continue;
    const start = Date.parse(e.start);
    if (start >= from.getTime() && start < to.getTime()) ms += Date.parse(e.end) - start;
  }
  return Fmt.hoursOf(ms);
}

module.exports = {
  MAX_NOTE,
  describe,
  running,
  resolveDescription,
  editBlockedReason,
  startTimer,
  updateTimer,
  addEntry,
  editEntry,
  deleteEntry,
  hoursBetween,
};
