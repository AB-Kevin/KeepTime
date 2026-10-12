'use strict';

// Rules for what managers keep in the shared folder: people, tasks and
// settings. Each function changes the list it's given and returns problems
// to show; an empty list means the caller should save.

const crypto = require('crypto');
const { pinProblem, hashPin } = require('./auth');

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Adds or updates a person. `actorId` is the manager making the change. */
function savePerson(list, input, actorId, now) {
  const isNew = !input.id;
  const existing = isNew ? null : list.find((p) => p.id === input.id);
  if (!isNew && !existing) return { errors: ['That person no longer exists.'] };

  const errors = [];
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const active = isNew ? true : Boolean(input.active);
  const contractor = Boolean(input.contractor);
  const manager = Boolean(input.manager);

  if (!name) errors.push('Enter a name.');
  else if (name.length > 80) errors.push('Keep the name under 80 characters.');
  else if (active && list.some((p) => p.id !== input.id && p.active && sameName(p.name, name))) {
    errors.push('Someone else is listed with that name. Add a last name or initial so people can tell them apart at sign-in.');
  }
  if (!contractor && !manager) errors.push('Choose at least one role.');

  const rate = input.hourlyRate === '' || input.hourlyRate == null ? 0 : Number(input.hourlyRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 10000) errors.push('Enter the hourly rate in dollars, such as 25 or 32.50.');

  const pin = String(input.pin ?? '').trim();
  if (isNew && !pin) errors.push('Set a PIN for the new person.');
  if (pin && pinProblem(pin)) errors.push(pinProblem(pin));

  if (existing && existing.id === actorId) {
    if (!manager) errors.push("You can't remove your own manager role.");
    if (!active) errors.push("You can't turn off your own account.");
  } else if (existing && existing.manager && existing.active && !(manager && active)) {
    const others = list.some((p) => p.id !== existing.id && p.manager && p.active);
    if (!others) errors.push('At least one active manager is needed.');
  }
  if (errors.length) return { errors };

  const person = existing ?? {
    id: crypto.randomUUID(),
    number: list.reduce((max, p) => Math.max(max, p.number ?? 0), 0) + 1,
    created: now.toISOString(),
  };
  Object.assign(person, {
    name,
    contractor,
    manager,
    active,
    hourlyRate: Math.round(rate * 100) / 100,
    templateId: input.templateId || null,
  });
  if (pin) person.pin = hashPin(pin, now);
  if (isNew) list.push(person);
  return { errors: [], person };
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

module.exports = { savePerson, saveTask, moveTask, settingsProblems };
