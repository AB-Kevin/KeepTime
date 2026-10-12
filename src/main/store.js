'use strict';

// The data folder, usually a folder in OneDrive that everyone has synced.
// OneDrive can't merge two computers' changes to the same file, so every file
// has exactly one kind of writer:
//
//   shared/people.json       managers: names, roles, rates, PINs they set
//   shared/tasks.json        managers: the "what were you working on" list
//   shared/templates.json    managers: invoice templates
//   shared/settings.json     managers: policies and the default template
//   people/<id>/*.json       only that person, signed in on one computer at a
//                            time: their time, invoices, profile and presence
//
// Managers' saves re-read the file and change only the record being saved, so
// two managers editing different people a minute apart don't undo each other.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./jsonfile');

const DEFAULT_SETTINGS = {
  editWindowDays: 14, // how far back people can add, change or delete their own time; 0 for no limit
  longTimerHours: 10, // running timers older than this are flagged as possibly forgotten
  defaultTemplateId: null,
};

const PERSONAL_FILES = new Set(['profile.json', 'entries.json', 'invoices.json', 'presence.json']);
const SHARED_FILES = new Set(['people.json', 'tasks.json', 'templates.json', 'settings.json']);

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  shared(name) {
    return path.join(this.dataDir, 'shared', name);
  }

  personal(personId, name) {
    if (!/^[0-9a-f-]{36}$/i.test(personId)) throw new Error('Unknown person.');
    return path.join(this.dataDir, 'people', personId, name);
  }

  isDataFolder() {
    return fs.existsSync(this.shared('people.json'));
  }

  people() {
    return readJson(this.shared('people.json'), { people: [] }).people;
  }

  savePeople(people) {
    writeJson(this.shared('people.json'), { people });
  }

  tasks() {
    return readJson(this.shared('tasks.json'), { tasks: [] }).tasks;
  }

  saveTasks(tasks) {
    writeJson(this.shared('tasks.json'), { tasks });
  }

  templates() {
    return readJson(this.shared('templates.json'), { templates: [] }).templates;
  }

  saveTemplates(templates) {
    writeJson(this.shared('templates.json'), { templates });
  }

  settings() {
    return { ...DEFAULT_SETTINGS, ...readJson(this.shared('settings.json'), {}) };
  }

  saveSettings(settings) {
    writeJson(this.shared('settings.json'), settings);
  }

  profile(personId) {
    return readJson(this.personal(personId, 'profile.json'), {});
  }

  saveProfile(personId, profile) {
    writeJson(this.personal(personId, 'profile.json'), profile);
  }

  entries(personId) {
    return readJson(this.personal(personId, 'entries.json'), { entries: [] }).entries;
  }

  saveEntries(personId, entries) {
    writeJson(this.personal(personId, 'entries.json'), { entries });
  }

  invoices(personId) {
    return readJson(this.personal(personId, 'invoices.json'), { invoices: [] }).invoices;
  }

  saveInvoices(personId, invoices) {
    writeJson(this.personal(personId, 'invoices.json'), { invoices });
  }

  presence(personId) {
    try {
      return readJson(this.personal(personId, 'presence.json'), null);
    } catch {
      return null; // a damaged presence file only means we don't know who's signed in
    }
  }

  savePresence(personId, presence) {
    writeJson(this.personal(personId, 'presence.json'), presence);
  }

  /**
   * Files OneDrive set aside because two computers changed them at once
   * ("entries-LAPTOP.json"), or that nothing here wrote. Each needs a person to
   * look at it, since its changes aren't in the app.
   */
  strayFiles() {
    const found = [];
    const scan = (dir, known) => {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.endsWith('.json') && !known.has(name)) found.push(path.join(dir, name));
      }
    };
    scan(path.join(this.dataDir, 'shared'), SHARED_FILES);
    let ids = [];
    try {
      ids = fs.readdirSync(path.join(this.dataDir, 'people'));
    } catch {
      // no one has saved anything yet
    }
    for (const id of ids) scan(path.join(this.dataDir, 'people', id), PERSONAL_FILES);
    return found;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
