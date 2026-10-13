'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const presence = require('../src/main/presence');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeptime-'));
  return new Store(dir);
}

const ID = '0b6c1f5e-8a4d-4d1e-9a51-6f0c2b7f9e10';

test('a new folder is empty, and saving people marks it as set up', () => {
  const store = tempStore();
  assert.equal(store.isDataFolder(), false);
  assert.deepEqual(store.people(), []);
  assert.deepEqual(store.entries(ID), []);
  assert.equal(store.settings().editWindowDays, 14);
  store.savePeople([{ id: ID, name: 'Ann' }]);
  assert.equal(store.isDataFolder(), true);
  assert.equal(store.people()[0].name, 'Ann');
});

test("a damaged file is reported, not treated as empty and overwritten", () => {
  const store = tempStore();
  store.saveEntries(ID, [{ id: 'e1' }]);
  fs.writeFileSync(store.personal(ID, 'entries.json'), '{"entries": [');
  assert.throws(() => store.entries(ID), /damaged/);
});

test('a damaged presence file only means "not signed in"', () => {
  const store = tempStore();
  fs.mkdirSync(path.dirname(store.personal(ID, 'presence.json')), { recursive: true });
  fs.writeFileSync(store.personal(ID, 'presence.json'), 'nope');
  assert.equal(store.presence(ID), null);
});

test('person ids are checked before they become paths', () => {
  const store = tempStore();
  assert.throws(() => store.entries('..\\..\\Windows'), /Unknown person/);
});

test("OneDrive's conflict copies are found", () => {
  const store = tempStore();
  store.saveEntries(ID, []);
  store.saveTasks([]);
  fs.writeFileSync(path.join(path.dirname(store.personal(ID, 'entries.json')), 'entries-LAPTOP.json'), '{}');
  fs.writeFileSync(path.join(store.dataDir, 'shared', 'tasks-DESKTOP-1.json'), '{}');
  const found = store.strayFiles().map((f) => path.basename(f)).sort();
  assert.deepEqual(found, ['entries-LAPTOP.json', 'tasks-DESKTOP-1.json']);
});

test('someone counts as signed in until they sign out or stop checking in', () => {
  const now = Date.parse('2026-10-12T15:00:00Z');
  const seen = (minutesAgo, signedOut = false) => ({ seen: new Date(now - minutesAgo * 60000).toISOString(), signedOut });
  assert.equal(presence.isSignedIn(seen(1), now), true);
  assert.equal(presence.isSignedIn(seen(1, true), now), false);
  assert.equal(presence.isSignedIn(seen(4), now), false);
  assert.equal(presence.isSignedIn(null, now), false);
  assert.equal(presence.minutesUntilStale(seen(1), now), 2);
});
