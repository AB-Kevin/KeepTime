'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, net, safeStorage } = require('electron');
const { readJson, writeJson } = require('ab-common/jsonfile');
const { Store } = require('./store');
const abApps = require('ab-common/abapps');
const { launch } = require('ab-common/installs');
const time = require('./time');
const invoices = require('./invoices');
const { renderInvoice } = require('./invoice-html');
const presence = require('./presence');
const manage = require('./manage');
const timesheets = require('./timesheets');
const mailer = require('ab-common/mailer');
const Fmt = require('../shared/format');
// Releases are published by .github/workflows/release.yml, each with the
// latest.yml electron-builder writes beside the installer. AB Apps reads the
// same file to install and update this app.
const { RELEASES_PAGE, checkForUpdate, downloadInstaller } = require('ab-common/releases').selfUpdates({
  repo: 'AB-Kevin/KeepTime',
  installerName: (version) => `KeepTime-Setup-${version}.exe`, // package.json build.nsis.artifactName
});

// Kept from when this app was called Contractor Time: Windows and AB Apps know
// the installed copy by it, so changing it would install a second copy.
const APP_ID = 'org.anabaptistbrotherhood.contractortime';
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
// The window's color before the page paints: --surface-page in styles.css.
const WINDOW_BACKGROUND = { light: '#FFFFFF', dark: '#1E1C1D' };
const THEMES = ['system', 'light', 'dark'];
const FONT_DIR = path.join(__dirname, '..', '..', 'node_modules', '@fontsource', 'poppins', 'files');

// Lets a test run keep its settings apart from this computer's real ones.
if (process.env.KEEPTIME_PROFILE) app.setPath('userData', process.env.KEEPTIME_PROFILE);

// One copy per Windows account; on a shared remote desktop server each person has their own.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let win = null;
let store = null;
let session = null; // { personId, name, signedInAt }
let identity = null; // who AB Apps says is signed in, from the last read of identity.json
let heartbeat = null;
let quitting = false;
const savedFiles = new Set(); // PDFs saved this session, which the window may ask to open
let latestRelease = null; // from the last update check; updates are only downloaded from it
let installing = null;
let timesheetSending = null; // the timesheet email being sent
let timesheetRetryAt = 0;
const timesheetsSentHere = new Set(); // periods sent this session, in case recording one failed

const updatesDir = () => path.join(app.getPath('temp'), 'KeepTime updates');

/** A problem to show the person as-is, rather than as a failure. */
class UserError extends Error {}
const fail = (errors) => {
  if (errors.length) throw new UserError(errors.join(' '));
};

// This computer's settings: where the data folder is, the theme, and the timesheet email's password.
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const loadConfig = () => readJson(configPath(), {});
const saveConfig = (changes) => writeJson(configPath(), { ...loadConfig(), ...changes });

// Before it was renamed KeepTime, this app kept its settings in a folder named
// Contractor Time. Bringing them over saves choosing the data folder again.
function moveOldSettings() {
  const oldConfig = path.join(app.getPath('appData'), 'Contractor Time', 'config.json');
  if (process.env.KEEPTIME_PROFILE || fs.existsSync(configPath()) || !fs.existsSync(oldConfig)) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.copyFileSync(oldConfig, configPath());
  } catch {
    // Without them, the data folder is chosen again.
  }
}

function openStore() {
  const { dataDir } = loadConfig();
  store = dataDir && fs.existsSync(dataDir) ? new Store(dataDir) : null;
}

// Light, dark, or whatever Windows is set to. Each computer keeps its own; the
// window's prefers-color-scheme follows nativeTheme.themeSource.
const windowBackground = () => WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

function applyTheme() {
  const { theme } = loadConfig();
  nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'system';
}

function suggestedFolder() {
  const oneDrive = process.env.OneDriveCommercial || process.env.OneDrive;
  return oneDrive ? path.join(oneDrive, 'KeepTime') : null;
}

// Session -------------------------------------------------------------------
// Whoever is signed in to AB Apps is signed in here. KeepTime follows
// identity.json as it changes, so signing out of AB Apps, or someone else
// signing in there, signs out here too.

/** Everyone: the AB Apps folder's people with this folder's records for them. */
function people() {
  if (!identity) throw new UserError('Sign in to AB Apps first.');
  return manage.mergePeople(abApps.readDirectory(identity.dataDir), store.people());
}

/** A person with the rate and template their invoices use, which they may have set themselves. */
const withChoices = (person) => manage.withOwnChoices(person, store.profile(person.id));

function me() {
  if (!store || !session) throw new UserError('Sign in first.');
  const person = people().find((p) => p.id === session.personId);
  if (!person?.active) {
    signOut();
    throw new UserError('Your account has been turned off in AB Apps. Ask a manager if that is a mistake.');
  }
  return withChoices(person);
}

/**
 * Starts a session for the person AB Apps has signed in, if there is one and
 * they may use KeepTime on this computer. Returns why not, or null.
 */
function startSession() {
  if (session) return null;
  if (!identity) return { reason: 'signed-out' };
  let person;
  try {
    person = people().find((p) => p.id === identity.personId);
  } catch (err) {
    return { reason: 'unreadable', message: err.message };
  }
  if (!person) return { reason: 'unknown' };
  if (!person.active) return { reason: 'turned-off' };
  // Two computers saving the same person's time would make OneDrive keep two copies.
  const elsewhere = store.presence(person.id);
  if (presence.isSignedIn(elsewhere) && elsewhere.computer !== presence.computerName()) {
    const minutes = presence.minutesUntilStale(elsewhere);
    return {
      reason: 'elsewhere',
      message: `You're using KeepTime on ${elsewhere.computer}. Close it there first. If that computer is off or asleep, you can use it here in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }
  session = { personId: person.id, name: person.name, signedInAt: new Date().toISOString() };
  startHeartbeat();
  return null;
}

/** Re-reads identity.json; when someone else, or no one, is signed in to AB Apps now, signs out here and tells the window. */
function checkIdentity() {
  const next = abApps.readIdentity(app.getPath('appData'));
  const changed = (next?.personId ?? null) !== (identity?.personId ?? null) || next?.name !== identity?.name || next?.dataDir !== identity?.dataDir;
  identity = next;
  if (!changed) return;
  if (session && session.personId !== next?.personId) signOut();
  win?.webContents.send('identity-changed');
}

function asContractor() {
  const person = me();
  if (!person.contractor) throw new UserError('Only contractors can do that.');
  return person;
}

function asManager() {
  const person = me();
  if (!person.manager) throw new UserError('Only managers can do that.');
  return person;
}

/** Managers, and anyone who logs time: those who can change the tasks and invoice templates. */
function asEditor() {
  const person = me();
  if (!person.manager && !person.contractor) throw new UserError('Only managers and people who log time can do that.');
  return person;
}

function writePresence(signedOut = false) {
  if (!store || !session) return;
  store.savePresence(session.personId, {
    personId: session.personId,
    name: session.name,
    computer: presence.computerName(),
    signedInAt: session.signedInAt,
    seen: new Date().toISOString(),
    signedOut,
    appVersion: app.getVersion(),
  });
}

function signOut() {
  clearInterval(heartbeat);
  heartbeat = null;
  try {
    writePresence(true);
  } catch {
    // the folder may be gone; nothing to record
  }
  session = null;
}

// Window ----------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'KeepTime',
    icon: APP_ICON,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('focus', checkIdentity);
  win.on('close', confirmClose);
  // Invoice windows close with it.
  win.on('closed', () => {
    win = null;
    app.quit();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/** Asks before closing with the timer running, and offers to stop it. */
function confirmClose(event) {
  if (quitting || !session) return;
  let entry;
  try {
    entry = time.running(store.entries(session.personId));
  } catch {
    return;
  }
  if (!entry) return;
  event.preventDefault();
  const described = Boolean(entry.taskId || entry.note);
  const buttons = described ? ['Stop timer and quit', 'Quit, keep timer running', 'Cancel'] : ['Quit, keep timer running', 'Cancel'];
  dialog
    .showMessageBox(win, {
      type: 'question',
      title: 'KeepTime',
      message: 'Your timer is still running.',
      detail: described
        ? `It started at ${Fmt.time(entry.start)}. If you leave it running, it keeps counting until you stop it.`
        : `It started at ${Fmt.time(entry.start)}. To stop it, cancel and describe what you worked on. If you leave it running, it keeps counting until you stop it.`,
      buttons,
      cancelId: buttons.length - 1,
      defaultId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      const choice = buttons[response];
      if (choice === 'Cancel') return;
      if (choice === 'Stop timer and quit') {
        const entries = store.entries(session.personId);
        const errors = time.updateTimer(entries, store.tasks(), { taskId: entry.taskId, note: entry.note }, new Date(), { stop: true });
        if (errors.length) {
          dialog.showErrorBox('KeepTime', errors.join(' '));
          return;
        }
        store.saveEntries(session.personId, entries);
      }
      quitting = true;
      win.close();
    });
}

// Invoices on paper and PDF ------------------------------------------------------

function fontCss() {
  return [300, 400, 500, 600, 700]
    .map((weight) => {
      const url = pathToFileURL(path.join(FONT_DIR, `poppins-latin-${weight}-normal.woff2`)).href;
      return `@font-face{font-family:'Poppins';font-style:normal;font-weight:${weight};src:url('${url}') format('woff2');}`;
    })
    .join('\n');
}

async function invoicePage(invoice, show) {
  const page = new BrowserWindow({
    show,
    width: 940,
    height: 1100,
    title: invoice.number,
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
  });
  page.webContents.on('will-navigate', (event) => event.preventDefault());
  // A file, not a data: URL, so the page may load the bundled fonts.
  const file = path.join(app.getPath('temp'), `keeptime-${crypto.randomUUID()}.html`);
  fs.writeFileSync(file, renderInvoice(invoice, fontCss()));
  try {
    await page.loadFile(file);
  } finally {
    fs.rm(file, () => {});
  }
  return page;
}

async function outputInvoice(invoice, action) {
  if (action === 'view') {
    await invoicePage(invoice, true);
    return null;
  }
  if (action === 'print') {
    const page = await invoicePage(invoice, false);
    return new Promise((resolve, reject) => {
      page.webContents.print({ printBackground: true }, (ok, reason) => {
        page.destroy();
        if (ok || reason === 'cancelled' || reason === 'Print job canceled') resolve(null);
        else reject(new UserError(`The invoice didn't print: ${reason}.`));
      });
    });
  }
  if (action === 'pdf') {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save invoice as PDF',
      defaultPath: path.join(app.getPath('documents'), `${invoice.number}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return null;
    const page = await invoicePage(invoice, false);
    try {
      fs.writeFileSync(filePath, await page.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }));
    } finally {
      page.destroy();
    }
    savedFiles.add(filePath);
    return filePath;
  }
  throw new Error(`Unknown invoice action ${action}`);
}

// Updates -----------------------------------------------------------------------

/** The window's view of the last update check: { version, newer, publishedAt, hasInstaller }, or null. */
function releaseInfo() {
  if (!latestRelease) return null;
  const { version, newer, publishedAt, installer } = latestRelease;
  return { version, newer, publishedAt, hasInstaller: Boolean(installer) };
}

/** Looks for an update when the app opens, so the window can say one is waiting. Problems are left for a manual check to report. */
function checkQuietly() {
  if (!app.isPackaged) return;
  checkForUpdate(app.getVersion(), net.fetch)
    .then((release) => {
      latestRelease = release;
      if (release.newer) win?.webContents.send('update-found', releaseInfo());
    })
    .catch(() => {});
}

/** Downloads the release found by the last check, and installs it once the person agrees. */
async function installUpdate() {
  const release = latestRelease;
  if (!release?.newer || !release.installer) throw new UserError('Check for updates first.');
  if (!app.isPackaged) throw new UserError('Updates are installed from the installed app, not from a development copy.');

  let lastPercent = -1;
  const installer = await downloadInstaller(release.installer, updatesDir(), net.fetch, (received, total) => {
    const percent = Math.floor((received / total) * 100);
    if (percent !== lastPercent) win?.webContents.send('update-progress', { percent: (lastPercent = percent) });
  }).catch((err) => {
    throw new UserError(err.message);
  });

  let timerRunning = false;
  try {
    timerRunning = Boolean(session && time.running(store.entries(session.personId)));
  } catch {
    // the folder may be unavailable; the update can still go ahead
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Install update?',
    message: `Install KeepTime ${release.version} now?`,
    detail: 'KeepTime closes while the update installs. Your time and invoices are kept.'
      + (timerRunning ? '\n\nYour timer keeps running while the update installs.' : ''),
    buttons: ['Install now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { installing: false };

  // --updated: the installer waits for this app to close and keeps the
  // shortcuts as they are.
  await new Promise((resolve, reject) => {
    const child = spawn(installer, ['--updated'], { detached: true, stdio: 'ignore' });
    child.once('spawn', resolve);
    child.once('error', (err) => reject(new UserError(`The installer couldn't be started: ${err.message}`)));
    child.unref();
  });
  quitting = true; // the person already chose; don't ask about the timer again
  app.quit();
  return { installing: true };
}

// Timesheet email -----------------------------------------------------------------
// KeepTime has no server, so any manager's app sends it: each checks every
// minute while a manager is signed in, and sends when it's due and no manager
// has recorded sending it. Their apps take turns, a few minutes apart, so the
// first one's record has time to sync before the next would send; OneDrive
// running slow can still mean two copies. An app closed at the time sends as
// soon as it's opened. What each sent is in their people/<id>/timesheets.json.
//
// The mail server's password is kept on each computer that sends, encrypted for
// its Windows account, since everyone who logs time can read the shared folder.

const TIMESHEET_TURN_MS = 10 * 60 * 1000;
const TIMESHEET_RETRY_MS = 15 * 60 * 1000;

/** The mail server password saved on this computer, or ''. */
function smtpPassword() {
  const { smtpPassword: saved } = loadConfig();
  if (!saved) return '';
  try {
    return safeStorage.decryptString(Buffer.from(saved, 'base64'));
  } catch {
    return ''; // saved by another Windows account, or Windows' keys changed: enter it again
  }
}

function saveSmtpPassword(password) {
  if (!safeStorage.isEncryptionAvailable()) throw new UserError("Windows can't keep the password safe on this computer, so it wasn't saved.");
  saveConfig({ smtpPassword: safeStorage.encryptString(password).toString('base64') });
}

/**
 * The server the timesheet email goes through: the one a manager set in AB
 * Apps, which takes mail without signing in, or else KeepTime's own.
 */
function mailServer(settings) {
  const shared = session && identity ? abApps.readServices(identity.dataDir).mail : null;
  return shared ? { ...shared, user: '', shared: true } : timesheets.smtpOf(settings);
}

/** Whether this computer can send: it has the password, unless the server takes mail without one. */
const canSendHere = (smtp) => Boolean(smtp.host) && (!smtp.user || Boolean(smtpPassword()));

/** Emails the timesheets for the period `occ` covers to `to`. Returns how many files were attached. */
async function sendTimesheets(occ, to, { test = false } = {}) {
  const settings = store.settings();
  const included = people()
    .filter(timesheets.included)
    .map((p) => ({ name: p.name, active: p.active, entries: store.entries(p.id) }));
  const email = timesheets.buildEmail({ from: occ.from, to: occ.to, people: included, test });
  try {
    await mailer.sendMail({ ...mailServer(settings), password: smtpPassword() }, { to, ...email });
  } catch (err) {
    throw new UserError(`The timesheet email couldn't be sent: ${err.message}`);
  }
  return email.attachments.length;
}

function checkTimesheets() {
  if (timesheetSending || !store || !session || Date.now() < timesheetRetryAt) return;
  timesheetSending = sendTimesheetsIfDue()
    .catch((err) => console.error('timesheets', err))
    .finally(() => {
      timesheetSending = null;
    });
}

async function sendTimesheetsIfDue() {
  const now = new Date();
  const everyone = people();
  const person = everyone.find((p) => p.id === session?.personId);
  if (!person?.manager || !person.active) return;
  const settings = store.settings();
  const schedule = timesheets.scheduleOf(settings);
  const occ = timesheets.due(schedule, now);
  if (!occ || timesheetsSentHere.has(occ.key) || !canSendHere(mailServer(settings))) return;
  const managers = everyone.filter((p) => p.manager && p.active).sort((a, b) => a.id.localeCompare(b.id));
  if (managers.some((m) => timesheets.wasSent(store.timesheetLog(m.id), occ.key))) return;
  const turn = managers.findIndex((m) => m.id === person.id);
  if (now.getTime() < occ.sendAt.getTime() + turn * TIMESHEET_TURN_MS) return;

  let files;
  try {
    files = await sendTimesheets(occ, schedule.recipients);
  } catch (err) {
    timesheetRetryAt = Date.now() + TIMESHEET_RETRY_MS;
    const problem = { key: occ.key, from: occ.from, to: occ.to, at: new Date().toISOString(), message: err.message };
    store.saveTimesheetLog(person.id, { ...store.timesheetLog(person.id), problem });
    return;
  }
  timesheetsSentHere.add(occ.key);
  const record = { key: occ.key, from: occ.from, to: occ.to, sentAt: new Date().toISOString(), recipients: schedule.recipients, files, computer: presence.computerName() };
  store.saveTimesheetLog(person.id, timesheets.recordSent(store.timesheetLog(person.id), record));
}

/** The timesheet email's settings and what's happened with it, for the Settings page. */
function timesheetStatus() {
  const settings = store.settings();
  const schedule = timesheets.scheduleOf(settings);
  const smtp = mailServer(settings);
  const now = new Date();
  const sent = people()
    .filter((p) => p.manager)
    .flatMap((p) => (store.timesheetLog(p.id).sent ?? []).map((s) => ({ ...s, by: p.name })))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const { problem } = store.timesheetLog(session.personId);
  const due = timesheets.due(schedule, now);
  const waiting = due && !sent.some((s) => s.key === due.key) ? due : null;
  const period = (occ) => occ && { sendAt: occ.sendAt.toISOString(), from: occ.from, to: occ.to };
  return {
    schedule,
    smtp,
    ownSmtp: timesheets.smtpOf(settings),
    hasPassword: Boolean(smtpPassword()),
    canSendHere: canSendHere(smtp),
    testAddress: loadConfig().timesheetTestAddress ?? '',
    waiting: period(waiting),
    next: period(timesheets.next(schedule, now)),
    last: sent[0] ?? null,
    // This app's last failure, while that period is still waiting to go.
    problem: problem && problem.key === waiting?.key ? problem : null,
  };
}

// Data the window shows ---------------------------------------------------------

function appState() {
  return { ...screenState(), theme: nativeTheme.themeSource, version: app.getVersion(), release: releaseInfo() };
}

function screenState() {
  const config = loadConfig();
  if (!identity) return { screen: 'abapps', reason: 'signed-out' };
  if (!store) return { screen: 'folder', dataDir: config.dataDir ?? null, suggested: suggestedFolder() };
  if (!store.isDataFolder()) return { screen: 'setup', dataDir: store.dataDir, canSetUp: identity.class === 'manager', name: identity.name };
  const problem = startSession();
  if (problem) return { screen: 'abapps', name: identity.name, ...problem };
  return {
    screen: 'app',
    dataDir: store.dataDir,
    computer: presence.computerName(),
    me: me(),
    settings: store.settings(),
    tasks: store.tasks(),
  };
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const startOfWeek = () => {
  const d = startOfToday();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
};

function withBlockedReasons(entries, settings, now) {
  return entries.map((e) => ({ ...e, blockedReason: time.editBlockedReason(e, settings, now) }));
}

function entriesBetween(entries, from, to) {
  const start = Fmt.toDate(from);
  const end = Fmt.toDate(to);
  end.setDate(end.getDate() + 1);
  return entries
    .filter((e) => !e.deleted)
    .filter((e) => {
      const t = Date.parse(e.start);
      return t >= start.getTime() && t < end.getTime();
    })
    .sort((a, b) => b.start.localeCompare(a.start));
}

/**
 * The template a person's invoices use: the one chosen for them if it's still
 * there, else the default, else the first. `person` is from withChoices.
 */
function templateFor(person) {
  const templates = store.templates();
  const { defaultTemplateId } = store.settings();
  return (
    templates.find((t) => t.id === person.templateId) ??
    templates.find((t) => t.id === defaultTemplateId) ??
    templates[0] ??
    null
  );
}

/** The templates someone's invoices can use, with which is the default. */
function templateChoices() {
  const { defaultTemplateId } = store.settings();
  return store.templates().map(({ id, name }) => ({ id, name, isDefault: id === defaultTemplateId }));
}

function findInvoice(personId, id) {
  const invoice = store.invoices(personId).find((i) => i.id === id);
  if (!invoice) throw new UserError("That invoice doesn't exist.");
  return invoice;
}

function overview() {
  const now = Date.now();
  const settings = store.settings();
  const week = startOfWeek();
  const tomorrow = startOfToday();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Everyone in AB Apps is listed there; here, only those who have used KeepTime or been set up in it.
  const rows = people()
    .filter((p) => p.active)
    .map((p) => ({ p, seen: store.presence(p.id) }))
    .filter(({ p, seen }) => seen || p.number)
    .map(({ p, seen }) => {
      const row = {
        id: p.id,
        name: p.name,
        contractor: p.contractor,
        manager: p.manager,
        signedIn: presence.isSignedIn(seen, now),
        computer: seen?.computer ?? null,
        seen: seen?.seen ?? null,
        signedOut: seen?.signedOut ?? null,
        running: null,
        weekHours: 0,
        uninvoicedHours: 0,
        problem: null,
      };
      if (!p.contractor) return row;
      try {
        const entries = store.entries(p.id);
        const run = time.running(entries);
        if (run) {
          row.running = {
            start: run.start,
            description: run.taskId || run.note ? time.describe(run) : null,
            long: now - Date.parse(run.start) > settings.longTimerHours * 3600e3,
          };
        }
        row.weekHours = time.hoursBetween(entries, week, tomorrow);
        row.uninvoicedHours = Fmt.hoursOf(
          entries.filter((e) => !e.deleted && e.end && !e.invoiceId).reduce((ms, e) => ms + Date.parse(e.end) - Date.parse(e.start), 0),
        );
      } catch (err) {
        row.problem = err.message;
      }
      return row;
    })
    .sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || a.name.localeCompare(b.name));
  return { rows, strayFiles: store.strayFiles(), longTimerHours: settings.longTimerHours };
}

// IPC -----------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      if (!(err instanceof UserError)) console.error(channel, err);
      return { ok: false, error: err instanceof UserError ? err.message : `Something went wrong: ${err.message}` };
    }
  });
}

function registerHandlers() {
  handle('state:get', () => appState());

  handle('folder:choose', async () => {
    const suggested = suggestedFolder();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose the KeepTime data folder',
      defaultPath: store?.dataDir ?? (suggested && fs.existsSync(path.dirname(suggested)) ? path.dirname(suggested) : undefined),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return appState();
    if (session) signOut();
    saveConfig({ dataDir: filePaths[0] });
    openStore();
    return appState();
  });

  handle('theme:set', (theme) => {
    if (!THEMES.includes(theme)) throw new UserError('Choose a theme.');
    saveConfig({ theme });
    applyTheme();
    return theme;
  });

  handle('update:check', async () => {
    try {
      latestRelease = await checkForUpdate(app.getVersion(), net.fetch);
    } catch (err) {
      throw new UserError(err.message);
    }
    return releaseInfo();
  });

  handle('update:install', () => {
    installing ??= installUpdate().finally(() => {
      installing = null;
    });
    return installing;
  });

  handle('update:page', () => shell.openExternal(latestRelease?.pageUrl ?? RELEASES_PAGE));

  handle('folder:open', () => {
    if (store) shell.openPath(store.dataDir);
  });

  handle('setup:create', ({ contractor }) => {
    if (!store || store.isDataFolder()) throw new UserError('This folder is already set up.');
    if (identity?.class !== 'manager') throw new UserError('Only a manager in AB Apps can set up KeepTime.');
    const records = [];
    // Everyone logs time unless a manager says otherwise, so this is saved only when they don't.
    if (!contractor) fail(manage.saveContractor(records, people(), { id: identity.personId, contractor: false, hourlyRate: 0 }, new Date()));
    const template = invoices.newTemplate();
    store.saveTemplates([template]);
    store.saveTasks([]);
    store.saveSettings({ ...store.settings(), defaultTemplateId: template.id });
    store.savePeople(records); // last, since its presence marks the folder as set up
    return appState();
  });

  handle('abapps:open', async () => {
    const exe = await abApps.findABApps();
    if (!exe) throw new UserError("AB Apps isn't installed on this computer. Ask a manager for its installer.");
    try {
      await launch(exe);
    } catch (err) {
      throw new UserError(`AB Apps couldn't be opened: ${err.message}`);
    }
  });

  // Contractor: timer and time ------------------------------------------------------

  handle('timer:get', () => {
    const person = asContractor();
    const entries = store.entries(person.id);
    const today = startOfToday();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      running: time.running(entries),
      today: entries
        .filter((e) => !e.deleted && Date.parse(e.start) >= today.getTime())
        .sort((a, b) => b.start.localeCompare(a.start)),
      todayHours: time.hoursBetween(entries, today, tomorrow),
      weekHours: time.hoursBetween(entries, startOfWeek(), tomorrow),
    };
  });

  const changeEntries = (change) => {
    const person = asContractor();
    const entries = store.entries(person.id);
    fail(change(entries, store.tasks(), store.settings(), new Date()));
    store.saveEntries(person.id, entries);
    writePresence();
  };

  handle('timer:start', (input) => changeEntries((entries, tasks, _s, now) => time.startTimer(entries, tasks, input, now)));
  handle('timer:describe', (input) => changeEntries((entries, tasks, _s, now) => time.updateTimer(entries, tasks, input, now, { stop: false })));
  handle('timer:stop', (input) => changeEntries((entries, tasks, _s, now) => time.updateTimer(entries, tasks, input, now, { stop: true })));
  handle('entries:add', (input) => changeEntries((entries, tasks, s, now) => time.addEntry(entries, tasks, s, input, now)));
  handle('entries:edit', (id, input) => changeEntries((entries, tasks, s, now) => time.editEntry(entries, tasks, s, id, input, now)));
  handle('entries:delete', (id) => changeEntries((entries, _t, s, now) => time.deleteEntry(entries, s, id, now)));

  handle('entries:list', ({ from, to }) => {
    const person = asContractor();
    const list = entriesBetween(store.entries(person.id), from, to);
    return withBlockedReasons(list, store.settings(), new Date());
  });

  // Contractor: invoices and profile ---------------------------------------------------

  handle('invoices:mine', () => {
    const person = asContractor();
    const list = store.invoices(person.id).sort((a, b) => b.issued.localeCompare(a.issued));
    const entries = store.entries(person.id).filter((e) => !e.deleted && e.end && !e.invoiceId);
    const first = entries.reduce((min, e) => (!min || e.start < min ? e.start : min), null);
    return {
      invoices: list,
      suggested: { from: first ? Fmt.dayKey(first) : Fmt.dayKey(new Date()), to: Fmt.dayKey(new Date()) },
      template: templateFor(person)?.name ?? null,
      templateId: person.templateId,
      templates: templateChoices(),
      rate: person.hourlyRate,
    };
  });

  // Kept in their own profile.json, since only managers write shared/people.json.
  handle('invoices:template', (id) => {
    const person = asContractor();
    if (id && !store.templates().some((t) => t.id === id)) throw new UserError("That template doesn't exist any more.");
    store.saveProfile(person.id, { ...store.profile(person.id), templateId: id || null, templateChosenAt: new Date().toISOString() });
  });

  handle('invoices:preview', ({ from, to }) => {
    const person = asContractor();
    const template = templateFor(person);
    if (!template) throw new UserError('No invoice template is set up yet. Add one on the Invoice templates page.');
    const p = invoices.preview(store.entries(person.id), from, to, person.hourlyRate, template.detail);
    return { lines: p.lines, hours: p.hours, rate: p.rate, amount: p.amount, count: p.entries.length };
  });

  handle('invoices:issue', ({ from, to }) => {
    const person = asContractor();
    const entries = store.entries(person.id);
    const list = store.invoices(person.id);
    const result = invoices.issue({
      entries,
      invoices: list,
      person,
      profile: store.profile(person.id),
      template: templateFor(person),
      from,
      to,
      now: new Date(),
    });
    fail(result.errors);
    // The invoice first: if saving the entries then fails, nothing is billed twice.
    store.saveInvoices(person.id, list);
    store.saveEntries(person.id, entries);
    return result.invoice;
  });

  handle('invoices:void', ({ id, reason }) => {
    const person = asContractor();
    const entries = store.entries(person.id);
    const list = store.invoices(person.id);
    fail(invoices.voidInvoice({ entries, invoices: list, id, reason, now: new Date() }));
    store.saveInvoices(person.id, list);
    store.saveEntries(person.id, entries);
  });

  handle('invoice:output', ({ personId, id, action }) => {
    const person = me();
    if (personId !== person.id && !person.manager) throw new UserError("You can only open your own invoices.");
    return outputInvoice(findInvoice(personId, id), action);
  });

  handle('profile:get', () => {
    const person = me();
    const { pin, ...profile } = store.profile(person.id);
    return profile;
  });

  handle('profile:save', (input) => {
    const person = me();
    const fields = ['businessName', 'address', 'email', 'phone', 'paymentInstructions'];
    const profile = store.profile(person.id);
    for (const field of fields) {
      const value = String(input[field] ?? '').trim();
      if (value.length > 1000) throw new UserError('Keep each field under 1,000 characters.');
      profile[field] = value;
    }
    // Their own rate is kept here, since only managers write shared/people.json. It's dated only
    // when changed, so saving other details doesn't undo a rate a manager set since.
    if (person.contractor && 'hourlyRate' in input) {
      const rate = manage.parseRate(input.hourlyRate);
      if (rate == null) throw new UserError(manage.RATE_PROBLEM);
      if (rate !== person.hourlyRate) Object.assign(profile, { hourlyRate: rate, rateChosenAt: new Date().toISOString() });
    }
    store.saveProfile(person.id, profile);
  });

  handle('open:file', (filePath) => {
    if (!savedFiles.has(filePath)) throw new UserError("That file wasn't saved here.");
    shell.openPath(filePath);
  });

  // Tasks and invoice templates: managers and anyone who logs time ---------------------
  // Saves re-read the file and change only the record being saved, as managers' do.

  handle('tasks:save', (input) => {
    asEditor();
    const tasks = store.tasks();
    fail(manage.saveTask(tasks, input));
    store.saveTasks(tasks);
    return tasks;
  });

  handle('tasks:move', ({ id, direction }) => {
    asEditor();
    const tasks = store.tasks();
    manage.moveTask(tasks, id, direction);
    store.saveTasks(tasks);
    return tasks;
  });

  handle('templates:list', () => {
    const person = asEditor();
    const settings = store.settings();
    const users = people().filter((p) => p.active && p.contractor).map(withChoices);
    return {
      templates: store.templates().map((t) => {
        const isDefault = t.id === settings.defaultTemplateId;
        return { ...t, isDefault, locked: isDefault && !person.manager, users: users.filter((u) => u.templateId === t.id).map((u) => u.name) };
      }),
      detailOptions: invoices.DETAIL,
    };
  });

  handle('template:new', () => {
    asEditor();
    return invoices.newTemplate({ name: '' });
  });

  handle('template:save', (input) => {
    const person = asEditor();
    const templates = store.templates();
    const settings = store.settings();
    // Everyone uses the default unless they choose another, so changing it changes everyone's invoices.
    if (input.id && input.id === settings.defaultTemplateId && !person.manager) {
      throw new UserError('Only managers can change the default template. To change your own invoices, make a copy and choose it on My invoices.');
    }
    const fields = ['name', 'title', 'prefix', 'billToName', 'billToAddress', 'detail', 'paymentTerms', 'notes', 'footer'];
    const clean = Object.fromEntries(fields.map((f) => [f, String(input[f] ?? '').trim()]));
    clean.prefix = clean.prefix.toUpperCase();
    const existing = templates.find((t) => t.id === input.id);
    const template = { ...(existing ?? { id: input.id || crypto.randomUUID() }), ...clean };
    fail(invoices.templateProblems(template, templates));
    if (existing) Object.assign(existing, template);
    else templates.push(template);
    store.saveTemplates(templates);
    if (!settings.defaultTemplateId && person.manager) store.saveSettings({ ...settings, defaultTemplateId: template.id });
    return template;
  });

  handle('template:delete', (id) => {
    asEditor();
    if (store.settings().defaultTemplateId === id) throw new UserError("The default template can't be deleted. A manager can make another one the default first.");
    const users = people().filter((p) => p.active && p.contractor).map(withChoices).filter((p) => p.templateId === id);
    if (users.length) {
      throw new UserError(
        `${users.map((p) => p.name).join(', ')} ${users.length === 1 ? 'uses' : 'use'} this template. ` +
          'Each person can choose another on My invoices, or a manager can on the People page.',
      );
    }
    store.saveTemplates(store.templates().filter((t) => t.id !== id));
  });

  // Issued invoices keep their own copy of the template, so these previews are the only HTML built from unsaved input.
  handle('template:preview', (input) => {
    asEditor();
    return renderInvoice(invoices.sampleInvoice({ ...invoices.newTemplate(), ...input }), fontCss());
  });

  // Manager ---------------------------------------------------------------------------

  handle('mgr:overview', () => {
    asManager();
    return overview();
  });

  handle('mgr:people', () => {
    asManager();
    return {
      people: people()
        .filter((p) => p.active || p.contractor)
        .map((p) => (p.contractor ? withChoices(p) : p))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
      templates: templateChoices(),
    };
  });

  handle('mgr:template:default', (id) => {
    asManager();
    if (!store.templates().some((t) => t.id === id)) throw new UserError("That template doesn't exist.");
    store.saveSettings({ ...store.settings(), defaultTemplateId: id });
  });

  handle('mgr:person:save', (input) => {
    asManager();
    const records = store.people();
    fail(manage.saveContractor(records, people(), input, new Date()));
    store.savePeople(records);
  });

  handle('mgr:settings:save', (input) => {
    asManager();
    fail(manage.settingsProblems(input));
    store.saveSettings({
      ...store.settings(),
      editWindowDays: Number(input.editWindowDays),
      longTimerHours: Number(input.longTimerHours),
    });
  });

  handle('mgr:timesheets', () => {
    asManager();
    return timesheetStatus();
  });

  handle('mgr:timesheets:save', (input) => {
    asManager();
    const { errors, schedule, smtp, testAddress } = timesheets.readSettings(input, store.settings().timesheets, new Date(), {
      ownServer: !mailServer(store.settings()).shared,
    });
    fail(errors);
    if (input.password) saveSmtpPassword(String(input.password));
    saveConfig({ timesheetTestAddress: testAddress });
    store.saveSettings({ ...store.settings(), timesheets: schedule, smtp });
    timesheetRetryAt = 0; // a failed send may work with the new settings
  });

  // Sends the period the latest scheduled email covered, as it's saved, to the test address only.
  handle('mgr:timesheets:test', async () => {
    asManager();
    const settings = store.settings();
    const smtp = mailServer(settings);
    const address = loadConfig().timesheetTestAddress;
    if (!address) throw new UserError('Enter an address to send the test to.');
    if (!smtp.host) throw new UserError('Enter the mail server.');
    if (!canSendHere(smtp)) throw new UserError('Enter the mail server password.');
    const schedule = timesheets.scheduleOf(settings);
    const occ = timesheets.latest({ ...schedule, firstSend: schedule.firstSend ?? Fmt.dayKey(new Date()) }, new Date());
    await sendTimesheets(occ, address, { test: true });
    return address;
  });

  handle('mgr:invoices', () => {
    asManager();
    const list = [];
    for (const p of people().filter((x) => x.contractor)) {
      for (const inv of store.invoices(p.id)) {
        const { lines, template, entryIds, ...summary } = inv;
        list.push({ ...summary, personId: p.id, personName: p.name, active: p.active });
      }
    }
    return list.sort((a, b) => b.issued.localeCompare(a.issued));
  });

  handle('mgr:entries', ({ personId, from, to }) => {
    asManager();
    const person = people().find((p) => p.id === personId);
    if (!person) throw new UserError('Choose a contractor.');
    return entriesBetween(store.entries(person.id), from, to);
  });
}

function startHeartbeat() {
  clearInterval(heartbeat);
  writePresence();
  heartbeat = setInterval(() => {
    try {
      writePresence();
    } catch (err) {
      console.error('presence', err);
    }
    checkTimesheets();
  }, presence.HEARTBEAT_MS);
  setTimeout(checkTimesheets, 5000); // after the window has what it needs to draw
}

app.setAppUserModelId(APP_ID);

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]),
  );
  moveOldSettings();
  applyTheme();
  nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()));
  try {
    fs.rmSync(updatesDir(), { recursive: true, force: true });
  } catch {
    // The installer that just ran may still be closing; it is removed next time.
  }
  openStore();
  identity = abApps.readIdentity(app.getPath('appData'));
  // AB Apps rewrites or removes the file as people sign in and out there.
  fs.watchFile(abApps.identityPath(app.getPath('appData')), { interval: 2000 }, checkIdentity);
  registerHandlers();
  createWindow();
  checkQuietly();
});

app.on('will-quit', () => signOut());

app.on('window-all-closed', () => app.quit());
