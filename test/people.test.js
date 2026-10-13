'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manage = require('../src/main/manage');
const abApps = require('../src/main/abapps');

const NOW = new Date('2026-10-12T15:00:00Z');

const ids = { ann: '0dbc309a-4814-4490-a9ca-0691c9092199', ben: 'da1fa1a5-6c0e-4352-80d2-6597e463052d', cy: '7f0c3d2e-1b2a-4c5d-8e9f-000000000003' };

// What abapps.readDirectory returns for the AB Apps folder.
const directory = [
  { id: ids.ann, name: 'Ann Miller', class: 'manager', active: true },
  { id: ids.ben, name: 'Ben Yoder', class: 'contractor', active: true },
  { id: ids.cy, name: 'Cy Lapp', class: 'employee', active: false },
];

test('people come from AB Apps; employees and contractors log time, managers only if set to', () => {
  const people = manage.mergePeople(directory, []);
  assert.deepEqual(people.map((p) => [p.name, p.manager, p.contractor, p.active, p.hourlyRate, p.number]), [
    ['Ann Miller', true, false, true, 0, null],
    ['Ben Yoder', false, true, true, 0, null],
    ['Cy Lapp', false, true, false, 0, null],
  ]);
});

test('managers set whether someone logs time, their rate and template; the first save numbers them', () => {
  const records = [];
  let people = manage.mergePeople(directory, records);
  assert.deepEqual(manage.saveContractor(records, people, { id: ids.ben, contractor: true, hourlyRate: '32.5', templateId: 't1' }, NOW), []);
  assert.deepEqual(manage.saveContractor(records, people, { id: ids.ann, contractor: true, hourlyRate: '' }, NOW), []);
  people = manage.mergePeople(directory, records);
  const ben = people.find((p) => p.id === ids.ben);
  const ann = people.find((p) => p.id === ids.ann);
  assert.deepEqual([ben.hourlyRate, ben.templateId, ben.number], [32.5, 't1', 1]);
  assert.deepEqual([ann.contractor, ann.manager, ann.number], [true, true, 2]);

  // Saving again keeps the number.
  manage.saveContractor(records, people, { id: ids.ben, contractor: false, hourlyRate: '30' }, NOW);
  assert.deepEqual(records.find((r) => r.id === ids.ben), { id: ids.ben, number: 1, created: NOW.toISOString(), name: 'Ben Yoder', contractor: false, hourlyRate: 30, templateId: null });

  assert.match(manage.saveContractor(records, people, { id: ids.ben, hourlyRate: '-1' }, NOW)[0], /hourly rate/);
  assert.match(manage.saveContractor(records, people, { id: 'nobody', hourlyRate: '1' }, NOW)[0], /isn't in AB Apps/);
});

test('records from before AB Apps lose their own name, role, status and PIN fields when saved', () => {
  const records = [{ id: ids.ben, number: 4, name: 'Ben', contractor: true, manager: false, active: true, hourlyRate: 25, templateId: null, pin: { hash: 'x' } }];
  const people = manage.mergePeople(directory, records);
  assert.equal(people.find((p) => p.id === ids.ben).name, 'Ben Yoder', 'AB Apps has the name');
  manage.saveContractor(records, people, { id: ids.ben, contractor: true, hourlyRate: 25 }, NOW);
  assert.deepEqual(Object.keys(records[0]).sort(), ['contractor', 'hourlyRate', 'id', 'name', 'number', 'templateId']);
});

test('someone removed from AB Apps is kept, turned off, with their invoices', () => {
  const people = manage.mergePeople(directory.slice(0, 1), [{ id: ids.ben, number: 1, name: 'Ben Yoder', contractor: true, hourlyRate: 30 }]);
  const ben = people.find((p) => p.id === ids.ben);
  assert.deepEqual([ben.name, ben.active, ben.contractor, ben.removed], ['Ben Yoder', false, true, true]);
  assert.match(manage.saveContractor([], people, { id: ids.ben, hourlyRate: 1 }, NOW)[0], /isn't in AB Apps/);
});

test('identity.json from AB Apps is read only when complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-identity-'));
  process.env.AB_APPS_PROFILE = dir;
  try {
    const file = abApps.identityPath('unused');
    assert.equal(file, path.join(dir, 'identity.json'));
    assert.equal(abApps.readIdentity('unused'), null);
    const good = { version: 1, personId: ids.ben, name: ' Ben Yoder ', class: 'contractor', signedInAt: NOW.toISOString(), dataDir: 'D:\\AB Apps' };
    fs.writeFileSync(file, JSON.stringify(good));
    assert.deepEqual(abApps.readIdentity('unused'), { personId: ids.ben, name: 'Ben Yoder', class: 'contractor', signedInAt: NOW.toISOString(), dataDir: 'D:\\AB Apps' });
    for (const bad of [{ ...good, version: 2 }, { ...good, class: 'admin' }, { ...good, name: '' }, { ...good, personId: '../x' }, { ...good, dataDir: null }]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.equal(abApps.readIdentity('unused'), null);
    }
    fs.writeFileSync(file, '{"version": 1, "perso'); // caught mid-write
    assert.equal(abApps.readIdentity('unused'), null);
  } finally {
    delete process.env.AB_APPS_PROFILE;
  }
});

test("the AB Apps folder's people are read without their PINs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-directory-'));
  assert.throws(() => abApps.readDirectory(dir), /can't be found/);
  fs.mkdirSync(path.join(dir, 'shared'));
  fs.writeFileSync(path.join(dir, 'shared', 'people.json'), JSON.stringify({ people: [
    { id: ids.ann, name: 'Ann Miller', class: 'manager', active: true, pin: { hash: 'secret' } },
    { id: 'not-an-id', name: 'Odd' },
  ] }));
  assert.deepEqual(abApps.readDirectory(dir), [{ id: ids.ann, name: 'Ann Miller', class: 'manager', active: true }]);
});

test('AB Apps is found under the registry key electron-builder makes from its appId', () => {
  assert.equal(abApps.appGuid('org.anabaptistbrotherhood.duplicatechecker'), '34d9e267-78ef-5071-b58d-029b778197d1');
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
