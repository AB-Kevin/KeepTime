'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Calls the main process and unwraps { ok, value, error }. */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  chooseFolder: () => call('folder:choose'),
  openFolder: () => call('folder:open'),
  setTheme: (theme) => call('theme:set', theme),
  checkForUpdate: () => call('update:check'),
  installUpdate: () => call('update:install'),
  openReleasePage: () => call('update:page'),
  onUpdateFound: (callback) => ipcRenderer.on('update-found', (_event, release) => callback(release)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_event, progress) => callback(progress)),
  setup: (input) => call('setup:create', input),
  openABApps: () => call('abapps:open'),
  onIdentityChanged: (callback) => ipcRenderer.on('identity-changed', () => callback()),

  timer: () => call('timer:get'),
  startTimer: (input) => call('timer:start', input),
  describeTimer: (input) => call('timer:describe', input),
  stopTimer: (input) => call('timer:stop', input),
  entries: (from, to) => call('entries:list', { from, to }),
  addEntry: (input) => call('entries:add', input),
  editEntry: (id, input) => call('entries:edit', id, input),
  deleteEntry: (id) => call('entries:delete', id),

  myInvoices: () => call('invoices:mine'),
  previewInvoice: (from, to) => call('invoices:preview', { from, to }),
  issueInvoice: (from, to) => call('invoices:issue', { from, to }),
  voidInvoice: (id, reason) => call('invoices:void', { id, reason }),
  invoiceOutput: (personId, id, action) => call('invoice:output', { personId, id, action }),
  openFile: (filePath) => call('open:file', filePath),

  profile: () => call('profile:get'),
  saveProfile: (input) => call('profile:save', input),

  overview: () => call('mgr:overview'),
  people: () => call('mgr:people'),
  savePerson: (input) => call('mgr:person:save', input),
  saveTask: (input) => call('mgr:tasks:save', input),
  moveTask: (id, direction) => call('mgr:tasks:move', { id, direction }),
  templates: () => call('mgr:templates'),
  newTemplate: () => call('mgr:template:new'),
  saveTemplate: (input) => call('mgr:template:save', input),
  setDefaultTemplate: (id) => call('mgr:template:default', id),
  deleteTemplate: (id) => call('mgr:template:delete', id),
  previewTemplate: (input) => call('mgr:template:preview', input),
  saveSettings: (input) => call('mgr:settings:save', input),
  allInvoices: () => call('mgr:invoices'),
  personEntries: (personId, from, to) => call('mgr:entries', { personId, from, to }),
});
