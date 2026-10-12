'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/main/auth');
const manage = require('../src/main/manage');

const NOW = new Date('2026-10-12T15:00:00Z');

test('PINs are 4 to 8 digits and stored hashed', () => {
  assert.equal(auth.pinProblem('123'), 'A PIN is 4 to 8 digits.');
  assert.equal(auth.pinProblem('12a4'), 'A PIN is 4 to 8 digits.');
  assert.equal(auth.pinProblem('1234'), null);
  const record = auth.hashPin('4821', NOW);
  assert.ok(!JSON.stringify(record).includes('4821'));
  assert.ok(auth.verifyPin('4821', record));
  assert.ok(!auth.verifyPin('4822', record));
  assert.ok(!auth.verifyPin('4821', null));
});

test('the PIN set last counts, whether a manager or the person set it', () => {
  const managerSet = { ...auth.hashPin('1111', new Date('2026-10-01T00:00:00Z')) };
  const personSet = { ...auth.hashPin('2222', new Date('2026-10-05T00:00:00Z')) };
  assert.equal(auth.currentPin({ pin: managerSet }, { pin: personSet }), personSet);
  const reset = auth.hashPin('3333', new Date('2026-10-06T00:00:00Z'));
  assert.equal(auth.currentPin({ pin: reset }, { pin: personSet }), reset);
  assert.equal(auth.currentPin({ pin: managerSet }, {}), managerSet);
});

test('five wrong PINs lock that person out for a minute', () => {
  const lockout = new auth.Lockout();
  const t = 1_000_000;
  for (let i = 0; i < 4; i++) lockout.fail('p', t);
  assert.equal(lockout.wait('p', t), 0);
  lockout.fail('p', t);
  assert.equal(lockout.wait('p', t + 1000), 59);
  assert.equal(lockout.wait('p', t + 61_000), 0);
  assert.equal(lockout.wait('q', t), 0);
});

test('people need a unique name, a role and a PIN to start', () => {
  const list = [];
  let r = manage.savePerson(list, { name: 'Ann  Miller', manager: true, pin: '1234' }, null, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.person.name, 'Ann Miller');
  assert.equal(r.person.number, 1);

  r = manage.savePerson(list, { name: 'ann miller', contractor: true, pin: '1234' }, null, NOW);
  assert.match(r.errors[0], /Someone else is listed/);
  r = manage.savePerson(list, { name: 'Ben Yoder' }, null, NOW);
  assert.deepEqual(r.errors, ['Choose at least one role.', 'Set a PIN for the new person.']);
  r = manage.savePerson(list, { name: 'Ben Yoder', contractor: true, pin: '5678', hourlyRate: '32.5' }, null, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.person.hourlyRate, 32.5);
  assert.equal(r.person.number, 2);
});

test('a manager cannot lock themselves or everyone out', () => {
  const list = [];
  const ann = manage.savePerson(list, { name: 'Ann', manager: true, pin: '1234' }, null, NOW).person;
  const ben = manage.savePerson(list, { name: 'Ben', contractor: true, pin: '1234' }, null, NOW).person;

  // What the People form sends.
  const form = (p, changes) => ({ id: p.id, name: p.name, contractor: p.contractor, manager: p.manager, active: p.active, hourlyRate: p.hourlyRate, pin: '', ...changes });

  let r = manage.savePerson(list, form(ann, { manager: false, contractor: true }), ann.id, NOW);
  assert.deepEqual(r.errors, ["You can't remove your own manager role."]);

  // Someone else can't take away the last manager either.
  r = manage.savePerson(list, form(ann, { active: false }), ben.id, NOW);
  assert.deepEqual(r.errors, ['At least one active manager is needed.']);

  r = manage.savePerson(list, form(ben, { active: false }), ann.id, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(list.find((p) => p.id === ben.id).active, false);
  assert.ok(list.find((p) => p.id === ben.id).pin, 'a blank PIN keeps the old one');
});

test('tasks have unique names and can be retired and reordered', () => {
  const list = [];
  assert.deepEqual(manage.saveTask(list, { name: 'Claims' }), []);
  assert.deepEqual(manage.saveTask(list, { name: 'Other', requiresNote: true }), []);
  assert.deepEqual(manage.saveTask(list, { name: 'claims' }), ['There is already a task with that name.']);
  assert.deepEqual(manage.saveTask(list, { id: list[0].id, name: 'Claims', active: false }), []);
  assert.equal(list[0].active, false);
  manage.moveTask(list, list[1].id, -1);
  assert.deepEqual(list.map((t) => t.name), ['Other', 'Claims']);
  manage.moveTask(list, list[0].id, -1);
  assert.deepEqual(list.map((t) => t.name), ['Other', 'Claims']);
});

test('settings are checked', () => {
  assert.deepEqual(manage.settingsProblems({ editWindowDays: '14', longTimerHours: '10' }), []);
  assert.equal(manage.settingsProblems({ editWindowDays: '-1', longTimerHours: '0' }).length, 2);
});
