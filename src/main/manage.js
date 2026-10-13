'use strict';

// Rules for what managers keep in the shared folder: what Contractor Time
// needs to know about people, tasks and settings. Each save function changes
// the list it's given and returns problems to show; an empty list means the
// caller should save.
//
// Names, classes and who can sign in come from AB Apps (see abapps.js).
// shared/people.json here keeps only what's particular to Contractor Time,
// one record per person id: whether they log time, their hourly rate,
// invoice template and the number in their invoice numbers.

const crypto = require('crypto');

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Everyone Contractor Time knows: the people in AB Apps with what managers set
 * here. Managers are managers here too. Employees and contractors log time
 * unless a manager says otherwise; managers don't unless a manager says they
 * do. Someone removed from AB Apps who has a record here is kept, turned off,
 * so their time and invoices stay visible.
 */
function mergePeople(directory, records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const fromRecord = (r, fallbackLogsTime) => ({
    contractor: typeof r?.contractor === 'boolean' ? r.contractor : fallbackLogsTime,
    hourlyRate: r?.hourlyRate ?? 0,
    templateId: r?.templateId ?? null,
    number: r?.number ?? null,
  });
  const people = directory.map((d) => ({
    id: d.id,
    name: d.name,
    class: d.class,
    active: d.active,
    manager: d.class === 'manager',
    ...fromRecord(byId.get(d.id), d.class !== 'manager'),
  }));
  for (const r of records) {
    if (people.some((p) => p.id === r.id)) continue;
    people.push({ id: r.id, name: r.name || 'Removed from AB Apps', class: null, active: false, manager: false, removed: true, ...fromRecord(r, false) });
  }
  return people;
}

/** Sets what Contractor Time needs for one person: whether they log time, their rate and template. */
function saveContractor(records, people, input, now) {
  const person = people.find((p) => p.id === input.id);
  if (!person || person.removed) return ["That person isn't in AB Apps any more."];
  const rate = input.hourlyRate === '' || input.hourlyRate == null ? 0 : Number(input.hourlyRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 10000) return ['Enter the hourly rate in dollars, such as 25 or 32.50.'];

  let record = records.find((r) => r.id === person.id);
  if (!record) {
    record = {
      id: person.id,
      number: records.reduce((max, r) => Math.max(max, r.number ?? 0), 0) + 1,
      created: now.toISOString(),
    };
    records.push(record);
  }
  // Left from before people moved to AB Apps; AB Apps has these now.
  delete record.pin;
  delete record.manager;
  delete record.active;
  Object.assign(record, {
    name: person.name, // shown if they're ever removed from AB Apps
    contractor: Boolean(input.contractor),
    hourlyRate: Math.round(rate * 100) / 100,
    templateId: input.templateId || null,
  });
  return [];
}

function saveTask(list, input) {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const existing = input.id ? list.find((t) => t.id === input.id) : null;
  if (input.id && !existing) return ['That task no longer exists.'];
  if (!name) return ['Enter a name for the task.'];
  if (name.length > 80) return ['Keep the task name under 80 characters.'];
  if (list.some((t) => t.id !== input.id && sameName(t.name, name))) return ['There is already a task with that name.'];

  const task = existing ?? { id: crypto.randomUUID() };
  Object.assign(task, {
    name,
    requiresNote: Boolean(input.requiresNote),
    active: existing ? Boolean(input.active) : true,
  });
  if (!existing) list.push(task);
  return [];
}

/** Moves a task up (-1) or down (+1) the list people choose from. */
function moveTask(list, id, direction) {
  const i = list.findIndex((t) => t.id === id);
  const j = i + Math.sign(direction);
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

function settingsProblems(input) {
  const errors = [];
  const days = Number(input.editWindowDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) errors.push('The edit window is a whole number of days from 0 to 365.');
  const hours = Number(input.longTimerHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) errors.push('The long-timer warning is a whole number of hours from 1 to 24.');
  return errors;
}

module.exports = { mergePeople, saveContractor, saveTask, moveTask, settingsProblems };
