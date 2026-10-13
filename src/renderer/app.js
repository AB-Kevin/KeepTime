'use strict';
/* global Fmt, api */
// `api` is the main process's interface, from preload.js.

// HTML built with html`...` escapes everything interpolated, except other html`...` results.
class Html {
  constructor(s) {
    this.s = s;
  }
}
const raw = (s) => new Html(s);
const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function show(value) {
  if (value instanceof Html) return value.s;
  if (Array.isArray(value)) return value.map(show).join('');
  if (value == null || value === false) return '';
  return escape(value);
}
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += show(value) + strings[i + 1];
  });
  return new Html(out);
}
/** ` name` when `on`, for boolean attributes such as selected and checked. */
const flag = (on, name) => (on ? raw(` ${name}`) : '');

const $ = (selector, root = document) => root.querySelector(selector);
const root = $('#app');
const dialogEl = $('#dialog');

let state = null; // from the main process: which screen, who's signed in, tasks, settings
let view = null;
let ticker = null; // the running clock
let poller = null; // refreshes "Who's signed in"
let toastTimer = null;
let toastAction = null;
// What each page remembers between visits: filters, the invoice preview, the template being edited.
const ui = {};

const today = () => Fmt.dayKey(new Date());
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Fmt.dayKey(d);
};
const describe = (e) => [e.taskName, e.note].filter(Boolean).join(': ') || 'No description';
const entryHours = (e) => Fmt.hoursOf(Date.parse(e.end) - Date.parse(e.start));
const sumHours = (entries) => Math.round(entries.filter((e) => e.end).reduce((sum, e) => sum + entryHours(e), 0) * 100) / 100;

function ago(iso) {
  if (!iso) return 'Never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return Fmt.date(iso);
}

function taskOptions(selectedId) {
  const tasks = state.tasks.filter((t) => t.active || t.id === selectedId);
  return html`<option value="">No task</option>${tasks.map(
    (t) => html`<option value="${t.id}"${flag(t.id === selectedId, 'selected')}>${t.name}${t.requiresNote ? ' (describe)' : ''}</option>`,
  )}`;
}

// Feedback ----------------------------------------------------------------------

function toast(message, { error = false, action = null } = {}) {
  const el = $('#toast');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = html`<span>${message}</span>${action ? html`<button class="btn btn-ghost btn-sm" data-action="toast">${action.label}</button>` : ''}`.s;
  el.hidden = false;
  toastAction = action?.run ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 10000 : 5000);
}

function openDialog(content) {
  dialogEl.innerHTML = content.s;
  dialogEl.showModal();
  dialogEl.querySelector('input:not([type=hidden]), select, textarea')?.focus();
}

const closeDialog = () => dialogEl.close();

function confirmDialog({ title, body, button }) {
  return new Promise((resolve) => {
    openDialog(html`<form data-form="confirm">
      <h2>${title}</h2>
      <p>${body}</p>
      <div class="dialog-actions">
        <button class="btn btn-primary" type="submit">${button}</button>
        <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
      </div></form>`);
    FORMS.confirm = async () => {
      closeDialog();
      resolve(true);
    };
    dialogEl.addEventListener('close', () => resolve(false), { once: true });
  });
}

// Screens before sign-in ---------------------------------------------------------

function folderScreen() {
  const missing = state.dataDir
    ? html`<div class="notice warn">The data folder <span class="path">${state.dataDir}</span> can't be found. If OneDrive is still
        setting up on this computer, wait for it to finish and try again.</div>`
    : '';
  return html`<div class="center"><div class="panel">
    <img class="logo" src="assets/logo-primary-lockup.jpg" alt="Anabaptist Brotherhood">
    <h1>KeepTime</h1>
    <p class="lead">Choose the OneDrive folder that holds KeepTime's data. Everyone uses the same shared folder, so it has to be
      synced to this computer first.</p>
    ${missing}
    ${state.suggested ? html`<p class="caption">On this computer, OneDrive is at <span class="path">${state.suggested.replace(/[\\/][^\\/]+$/, '')}</span>.</p>` : ''}
    <div class="actions">
      <button class="btn btn-primary" data-action="choose-folder">Choose folder</button>
      ${state.dataDir ? html`<button class="btn btn-secondary" data-action="reload">Try again</button>` : ''}
    </div>
  </div></div>`;
}

function setupScreen() {
  if (!state.canSetUp) {
    return html`<div class="center"><div class="panel">
      <img class="logo" src="assets/logo-primary-lockup.jpg" alt="Anabaptist Brotherhood">
      <h1>KeepTime isn't set up yet</h1>
      <p class="lead">Nothing is in this folder yet. A manager sets up KeepTime the first time; ask one to, or check that this is the
        folder that's been shared with you.</p>
      <p class="path">${state.dataDir}</p>
      <div class="actions"><button class="btn btn-secondary" data-action="reload">Try again</button></div>
      <div class="panel-foot"><button class="link small" data-action="choose-folder">Choose a different folder</button></div>
    </div></div>`;
  }
  return html`<div class="center"><div class="panel">
    <img class="logo" src="assets/logo-primary-lockup.jpg" alt="Anabaptist Brotherhood">
    <h1>Set up KeepTime</h1>
    <p class="lead">Nothing is in this folder yet. Set it up, then give contractors their hourly rates on the People page. Everyone
      signed in to AB Apps can use it.</p>
    <p class="path">${state.dataDir}</p>
    <div class="notice">If your organization already uses KeepTime, don't set it up again. Choose the folder that's been shared with you instead.</div>
    <form data-form="setup">
      <div class="form-error"></div>
      <label class="check"><input type="checkbox" name="contractor"> I also log my own time</label>
      <button class="btn btn-primary" type="submit">Set up</button>
    </form>
    <div class="panel-foot"><button class="link small" data-action="choose-folder">Choose a different folder</button></div>
  </div></div>`;
}

// KeepTime has no sign-in of its own: it uses whoever is signed in to AB Apps.
function abAppsScreen() {
  const reasons = {
    'signed-out': ['Sign in to AB Apps', 'KeepTime uses your AB Apps sign-in. Open AB Apps and sign in, and this window continues on its own.'],
    unknown: ['Not found in AB Apps', `${state.name} is signed in to AB Apps, but isn't in its list of people yet. If OneDrive is still syncing, wait a minute; otherwise ask a manager.`],
    'turned-off': ['Turned off in AB Apps', `${state.name}'s account is turned off in AB Apps. Ask a manager if that is a mistake.`],
    unreadable: ["The AB Apps folder can't be read", state.message],
    elsewhere: ['Open on another computer', state.message],
  };
  const [title, lead] = reasons[state.reason] ?? reasons['signed-out'];
  return html`<div class="center"><div class="panel">
    <img class="logo" src="assets/logo-primary-lockup.jpg" alt="Anabaptist Brotherhood">
    <h1>${title}</h1>
    <p class="lead">${lead}</p>
    <div class="actions">
      ${state.reason === 'signed-out' ? html`<button class="btn btn-primary" data-action="open-abapps">Open AB Apps</button>` : ''}
      <button class="btn btn-secondary" data-action="reload">Try again</button>
    </div>
  </div></div>`;
}

// The signed-in app ----------------------------------------------------------------

const NAV = [
  { label: 'My work', role: 'contractor', items: [['timer', 'Timer'], ['time', 'My time'], ['invoices', 'My invoices']] },
  {
    label: 'Manage',
    role: 'manager',
    items: [
      ['overview', "Who's signed in"],
      ['all-invoices', 'Invoices'],
      ['team-time', 'Team time'],
      ['people', 'People'],
      ['tasks', 'Tasks'],
      ['templates', 'Invoice templates'],
      ['settings', 'Settings'],
    ],
  },
  { label: 'Account', role: null, items: [['profile', 'Profile']] },
];

const allowedGroups = () => NAV.filter((g) => !g.role || state.me[g.role]);
const allowed = (name) => allowedGroups().some((g) => g.items.some(([key]) => key === name));
const defaultView = () => (state.me.contractor ? 'timer' : 'overview');

function drawShell() {
  root.innerHTML = html`
    <header class="app-header">
      <div class="brand"><img class="logo" src="assets/logo-primary-lockup.jpg" alt="Anabaptist Brotherhood"><span class="app-name">KeepTime</span></div>
      <div class="who"><span id="update-badge"></span><span>Signed in as <strong>${state.me.name}</strong></span>
        </div>
    </header>
    <div class="app-body">
      <nav class="nav">
        ${allowedGroups().map(
          (g) => html`<div class="nav-label">${g.label}</div>${g.items.map(
            ([key, label]) => html`<button class="nav-item${key === view ? ' active' : ''}" data-action="nav" data-view="${key}">${label}</button>`,
          )}`,
        )}
      </nav>
      <main class="content" id="content"><p class="loading">Loading…</p></main>
    </div>`.s;
  drawUpdates();
}

function stopTimers() {
  clearInterval(ticker);
  clearInterval(poller);
  ticker = poller = null;
}

function render() {
  stopTimers();
  if (state.screen !== 'app') $('#toast').hidden = true; // messages belong to whoever was signed in
  if (state.screen === 'folder') root.innerHTML = folderScreen().s;
  else if (state.screen === 'setup') root.innerHTML = setupScreen().s;
  else if (state.screen === 'abapps') root.innerHTML = abAppsScreen().s;
  else return go(view && allowed(view) ? view : defaultView());
}

async function go(name) {
  stopTimers();
  state = await api.getState();
  if (state.screen !== 'app') return render();
  if (!allowed(name)) name = defaultView();
  view = name;
  drawShell();
  await drawView();
}

/** Redraws the current page's content, keeping the header and menu. */
async function drawView() {
  const name = view;
  const content = $('#content');
  try {
    const body = await VIEWS[name]();
    if (view !== name) return;
    const scroll = content.scrollTop;
    content.innerHTML = body.s;
    content.scrollTop = scroll;
    AFTER[name]?.();
  } catch (err) {
    if (/Sign in first|turned off/.test(err.message)) {
      state = await api.getState();
      render();
      toast(err.message, { error: true });
      return;
    }
    content.innerHTML = html`<div class="page"><div class="notice warn">${err.message}</div>
      <button class="btn btn-secondary" data-action="reload">Try again</button></div>`.s;
  }
}

// Timer -----------------------------------------------------------------------------

async function timerView() {
  const t = await api.timer();
  ui.running = t.running;
  const r = t.running;
  return html`<div class="page">
    <div class="page-head"><div><h1>Timer</h1><p class="sub">${Fmt.date(new Date())}</p></div></div>
    <div class="timer-layout">
      <form class="timer-panel${r ? ' is-running' : ''}" data-form="timer">
        <p class="timer-status">${r ? `Running since ${Fmt.time(r.start)}` : 'Not running'}</p>
        <div class="timer-clock${r ? '' : ' is-idle'}" id="clock">${r ? Fmt.clock(Date.now() - Date.parse(r.start)) : '0:00:00'}</div>
        <div class="form-error"></div>
        <div class="field"><label for="t-task">Task</label><select id="t-task" name="taskId">${taskOptions(r?.taskId ?? null)}</select></div>
        <div class="field"><label for="t-note">Description</label>
          <input type="text" id="t-note" name="note" maxlength="1000" value="${r?.note ?? ''}" placeholder="What you're working on">
          <span class="hint">Choose a task, describe the work, or both. You can fill this in before you stop.</span></div>
        <div class="actions">
          ${r
            ? html`<button class="btn btn-primary btn-lg" type="submit" name="op" value="stop">Stop</button>
                   <button class="btn btn-secondary" type="submit" name="op" value="describe">Save description</button>`
            : html`<button class="btn btn-primary btn-lg" type="submit" name="op" value="start">Start</button>`}
        </div>
      </form>
      <div>
        <div class="card">
          <div class="stats">
            <div class="stat"><div class="label">Today</div><div class="value">${Fmt.hours(t.todayHours)}</div></div>
            <div class="stat"><div class="label">This week</div><div class="value">${Fmt.hours(t.weekHours)}</div></div>
          </div>
          <p class="caption">Hours of completed time. Weeks start on Monday.</p>
        </div>
        <div class="section"><h2>Today</h2>
          ${t.today.length
            ? html`<ul class="history">${t.today.map(
                (e) => html`<li><span>${describe(e)}</span><span class="num">${e.end ? Fmt.hours(entryHours(e)) : 'Running'}</span>
                  <span class="when">${Fmt.time(e.start)} to ${e.end ? Fmt.time(e.end) : 'now'}</span></li>`,
              )}</ul>`
            : html`<div class="empty">No time yet today.</div>`}
          <p class="small" style="margin-top: 12px"><button class="link" data-action="nav" data-view="time">Change or add time</button></p>
        </div>
      </div>
    </div></div>`;
}

function tickClock() {
  const clock = $('#clock');
  if (clock && ui.running) clock.textContent = Fmt.clock(Date.now() - Date.parse(ui.running.start));
}

// My time -------------------------------------------------------------------------------

function editWindowText() {
  const days = state.settings.editWindowDays;
  return days
    ? `You can add, change or delete time from the last ${days} days, until it's on an invoice.`
    : "You can change any time until it's on an invoice.";
}

function entryTags(e) {
  const edited = (e.changes ?? []).some((c) => c.action === 'edited');
  const original = e.original?.end ? `Recorded as ${Fmt.date(e.original.start)}, ${Fmt.time(e.original.start)} to ${Fmt.time(e.original.end)}` : '';
  return html`${!e.end ? html`<span class="tag tag-mint">Running</span>` : ''}${e.invoiceId ? html`<span class="tag tag-gray">Invoiced</span>` : ''}${
    e.manual ? html`<span class="tag tag-outline" title="Added by hand rather than with the timer">Added</span>` : ''
  }${edited ? html`<span class="tag tag-outline" title="${original}">Edited</span>` : ''}`;
}

function entryTable(entries, { editable }) {
  if (!entries.length) return html`<div class="empty">No time in this period.</div>`;
  return html`<div class="table-wrap"><table class="data">
    <thead><tr><th>Date</th><th>Start</th><th>End</th><th class="num">Hours</th><th>Description</th><th></th>${editable ? html`<th></th>` : ''}</tr></thead>
    <tbody>${entries.map(
      (e) => html`<tr>
        <td class="nowrap">${Fmt.shortDate(e.start)}</td>
        <td class="nowrap">${Fmt.time(e.start)}</td>
        <td class="nowrap">${e.end ? Fmt.time(e.end) : ''}</td>
        <td class="num">${e.end ? Fmt.hours(entryHours(e)) : ''}</td>
        <td class="desc">${describe(e)}</td>
        <td>${entryTags(e)}</td>
        ${editable
          ? html`<td><div class="row-actions">${e.blockedReason
              ? html`<span class="caption" title="${e.blockedReason}">Locked</span>`
              : html`<button class="btn btn-ghost btn-sm" data-action="edit-entry" data-id="${e.id}">Change</button>
                     <button class="btn btn-ghost btn-sm" data-action="delete-entry" data-id="${e.id}">Delete</button>`}</div></td>`
          : ''}
      </tr>`,
    )}</tbody>
    <tfoot><tr><td colspan="3">Total</td><td class="num">${Fmt.hours(sumHours(entries))}</td><td colspan="${editable ? 3 : 2}"></td></tr></tfoot>
  </table></div>`;
}

function periodFilter(form, from, to, { extra = '', button = 'Show' } = {}) {
  return html`<form class="filters" data-form="${form}">
    ${extra}
    <div class="field"><label>From</label><input type="date" name="from" value="${from}" required></div>
    <div class="field"><label>To</label><input type="date" name="to" value="${to}" required></div>
    <button class="btn btn-secondary" type="submit">${button}</button>
  </form>`;
}

async function timeView() {
  ui.timeFrom ??= daysAgo(13);
  ui.timeTo ??= today();
  ui.entries = await api.entries(ui.timeFrom, ui.timeTo);
  return html`<div class="page">
    <div class="page-head"><div><h1>My time</h1><p class="sub">${editWindowText()}</p></div>
      <button class="btn btn-primary" data-action="add-entry">Add time</button></div>
    ${periodFilter('time-filter', ui.timeFrom, ui.timeTo)}
    ${entryTable(ui.entries, { editable: true })}
  </div>`;
}

function roundedNow(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0);
  return d;
}

function entryDialog(entry) {
  const running = entry && !entry.end;
  openDialog(html`<form data-form="entry">
    <input type="hidden" name="id" value="${entry?.id ?? ''}">
    <h2>${entry ? 'Change time' : 'Add time'}</h2>
    <div class="form-error"></div>
    <div class="field-row">
      <div class="field"><label for="e-start">Start</label>
        <input type="datetime-local" id="e-start" name="start" required value="${Fmt.inputDateTime(entry?.start ?? roundedNow(-60))}"></div>
      <div class="field"><label for="e-end">End</label>
        <input type="datetime-local" id="e-end" name="end"${flag(!running, 'required')} value="${entry?.end ? Fmt.inputDateTime(entry.end) : running ? '' : Fmt.inputDateTime(roundedNow())}">
        ${running ? html`<span class="hint">Leave blank to keep the timer running.</span>` : ''}</div>
    </div>
    <div class="field"><label for="e-task">Task</label><select id="e-task" name="taskId">${taskOptions(entry?.taskId ?? null)}</select></div>
    <div class="field"><label for="e-note">Description</label><textarea id="e-note" name="note" maxlength="1000">${entry?.note ?? ''}</textarea></div>
    <div class="dialog-actions">
      <button class="btn btn-primary" type="submit">Save</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div></form>`);
}

// My invoices ------------------------------------------------------------------------------

function invoiceActions(inv, personId, { canVoid }) {
  return html`<div class="row-actions">
    <button class="btn btn-ghost btn-sm" data-action="invoice" data-op="view" data-person="${personId}" data-id="${inv.id}">View</button>
    <button class="btn btn-ghost btn-sm" data-action="invoice" data-op="print" data-person="${personId}" data-id="${inv.id}">Print</button>
    <button class="btn btn-ghost btn-sm" data-action="invoice" data-op="pdf" data-person="${personId}" data-id="${inv.id}">Save PDF</button>
    ${canVoid && !inv.voided ? html`<button class="btn btn-ghost btn-sm" data-action="void-invoice" data-id="${inv.id}" data-number="${inv.number}">Void</button>` : ''}
  </div>`;
}

const invoiceStatus = (inv) =>
  inv.voided ? html`<span class="tag tag-gray" title="${inv.voided.reason}">Void</span>` : html`<span class="tag tag-mint">Issued</span>`;

async function invoicesView() {
  const data = await api.myInvoices();
  ui.invoiceFrom ??= data.suggested.from;
  ui.invoiceTo ??= data.suggested.to;
  const p = ui.preview;
  const noRate = !(data.rate > 0);

  const preview = p
    ? html`<div class="section">
        <h2>Preview: ${Fmt.date(p.from)} to ${Fmt.date(p.to)}</h2>
        ${p.count
          ? html`<div class="table-wrap"><table class="data">
              <thead><tr><th>Date</th><th>Description</th><th class="num">Hours</th></tr></thead>
              <tbody>${p.lines.map((l) => html`<tr><td class="nowrap">${l.date}</td><td class="desc">${l.description}</td><td class="num">${Fmt.hours(l.hours)}</td></tr>`)}</tbody>
              <tfoot>
                <tr><td colspan="2">Total hours</td><td class="num">${Fmt.hours(p.hours)}</td></tr>
                <tr><td colspan="2">At ${Fmt.money(p.rate)} an hour</td><td class="num">${Fmt.money(p.amount)}</td></tr>
              </tfoot></table></div>
            <p class="small muted" style="margin-top: 12px">Creating the invoice locks these ${p.count} entries so they can't be billed twice.
              If something is wrong afterward, void the invoice, correct the time and create a new one.</p>
            <div class="actions"><button class="btn btn-primary" data-action="issue-invoice"${flag(noRate, 'disabled')}>Create invoice</button>
              <button class="btn btn-ghost" data-action="clear-preview">Cancel</button></div>`
          : html`<div class="empty">There is no completed, uninvoiced time in this period.</div>`}
      </div>`
    : '';

  return html`<div class="page">
    <div class="page-head"><div><h1>My invoices</h1>
      <p class="sub">Invoices use the ${data.template ? `"${data.template}"` : 'default'} template${data.rate > 0 ? ` and your rate of ${Fmt.money(data.rate)} an hour` : ''}.</p></div></div>
    ${noRate ? html`<div class="notice warn">Your hourly rate hasn't been set, so you can't create invoices yet. Ask a manager to set it.</div>` : ''}
    <h2>New invoice</h2>
    <p class="small muted" style="margin-top: 4px">Choose the period to bill. Only completed time that isn't already on an invoice is included.</p>
    ${periodFilter('invoice-preview', ui.invoiceFrom, ui.invoiceTo, { button: 'Preview' })}
    ${preview}
    <div class="section"><h2>Issued</h2>
      ${data.invoices.length
        ? html`<div class="table-wrap"><table class="data">
            <thead><tr><th>Number</th><th>Period</th><th>Issued</th><th class="num">Hours</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>${data.invoices.map(
              (inv) => html`<tr class="${inv.voided ? 'is-void' : ''}">
                <td class="nowrap">${inv.number}</td>
                <td class="nowrap">${Fmt.date(inv.periodStart)} to ${Fmt.date(inv.periodEnd)}</td>
                <td class="nowrap">${Fmt.date(inv.issued)}</td>
                <td class="num">${Fmt.hours(inv.hours)}</td>
                <td class="num">${Fmt.money(inv.amount)}</td>
                <td>${invoiceStatus(inv)}</td>
                <td>${invoiceActions(inv, state.me.id, { canVoid: true })}</td></tr>`,
            )}</tbody></table></div>`
        : html`<div class="empty">No invoices yet.</div>`}
    </div>
  </div>`;
}

// Profile -------------------------------------------------------------------------------------

async function profileView() {
  const profile = await api.profile();
  const me = state.me;
  const roles = [me.manager && 'Manager', me.contractor && 'Contractor'].filter(Boolean).join(' and ');
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Profile</h1><p class="sub">${me.name}, ${roles}${me.contractor ? `, ${me.hourlyRate > 0 ? Fmt.money(me.hourlyRate) + ' an hour' : 'no hourly rate set yet'}` : ''}</p></div></div>
    ${me.contractor
      ? html`<h2>Your details on invoices</h2>
        <p class="small muted" style="margin: 4px 0 16px">Printed in the "from" block of new invoices. Invoices you've already created keep the details they were made with.</p>
        <form data-form="profile">
          <div class="form-error"></div>
          <div class="field"><label for="p-business">Business name</label><input type="text" id="p-business" name="businessName" maxlength="200" value="${profile.businessName ?? ''}">
            <span class="hint">Leave blank to show your name.</span></div>
          <div class="field"><label for="p-address">Address</label><textarea id="p-address" name="address" maxlength="500">${profile.address ?? ''}</textarea></div>
          <div class="field-row">
            <div class="field"><label for="p-email">Email</label><input type="email" id="p-email" name="email" maxlength="200" value="${profile.email ?? ''}"></div>
            <div class="field"><label for="p-phone">Phone</label><input type="tel" id="p-phone" name="phone" maxlength="50" value="${profile.phone ?? ''}"></div>
          </div>
          <div class="field"><label for="p-pay">Payment instructions</label><textarea id="p-pay" name="paymentInstructions" maxlength="1000">${profile.paymentInstructions ?? ''}</textarea>
            <span class="hint">For example, who to make checks payable to.</span></div>
          <button class="btn btn-primary" type="submit">Save details</button>
        </form>`
      : ''}
    <div class="section"><h2>Signing in</h2>
      <p class="small muted" style="margin-top: 4px">KeepTime uses your AB Apps sign-in. Your name, and whether you're a manager,
        come from AB Apps; to sign out, sign out there.</p>
    </div>
    ${me.manager ? '' : [appearanceSection(), updatesSection()]}
  </div>`;
}

// Manager: who's signed in ---------------------------------------------------------------------

async function overviewView() {
  const o = await api.overview();
  const signedIn = o.rows.filter((r) => r.signedIn).length;
  const running = o.rows.filter((r) => r.running).length;
  const week = Math.round(o.rows.reduce((sum, r) => sum + r.weekHours, 0) * 100) / 100;
  return html`<div class="page">
    <div class="page-head"><div><h1>Who's signed in</h1>
      <p class="sub">Updates every 20 seconds, as fast as OneDrive syncs, usually within a minute or two.</p></div>
      <button class="btn btn-secondary" data-action="reload">Refresh</button></div>
    ${o.strayFiles.length
      ? html`<div class="notice warn"><strong>OneDrive kept extra copies of ${o.strayFiles.length} file${o.strayFiles.length === 1 ? '' : 's'}.</strong>
          This happens when two computers change the same file before syncing. Changes in these copies aren't in the app;
          compare each with the file it's named after, then delete it.
          <ul>${o.strayFiles.map((f) => html`<li class="path">${f}</li>`)}</ul>
          <button class="link small" data-action="open-folder">Open the data folder</button></div>`
      : ''}
    <div class="card"><div class="stats">
      <div class="stat"><div class="label">Signed in</div><div class="value">${signedIn}</div></div>
      <div class="stat"><div class="label">Timers running</div><div class="value">${running}</div></div>
      <div class="stat"><div class="label">Hours this week</div><div class="value">${Fmt.hours(week)}</div></div>
    </div></div>
    <div class="section"><div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Status</th><th>Last seen</th><th>Timer</th><th class="num">This week</th><th class="num">Not invoiced</th></tr></thead>
      <tbody>${o.rows.map(
        (r) => html`<tr>
          <td><strong>${r.name}</strong>${r.manager ? html` <span class="tag tag-outline">Manager</span>` : ''}</td>
          <td>${r.signedIn ? html`<span class="tag tag-green">Signed in</span>` : html`<span class="tag tag-gray">Signed out</span>`}
            ${r.signedIn && r.computer ? html`<div class="caption">${r.computer}</div>` : ''}</td>
          <td class="nowrap">${ago(r.seen)}</td>
          <td>${r.problem
            ? html`<span class="caption">${r.problem}</span>`
            : r.running
              ? html`<div class="nowrap">Since ${Fmt.time(r.running.start)}${Date.now() - Date.parse(r.running.start) > 864e5 ? `, ${Fmt.shortDate(r.running.start)}` : ''}
                  (${Fmt.clock(Date.now() - Date.parse(r.running.start)).replace(/:\d\d$/, '')})</div>
                  <div class="caption">${r.running.description ?? 'No description yet'}</div>
                  ${r.running.long ? html`<span class="tag tag-maroon">Over ${o.longTimerHours} hours</span>` : ''}`
              : r.contractor
                ? html`<span class="muted">Stopped</span>`
                : ''}</td>
          <td class="num">${r.contractor ? Fmt.hours(r.weekHours) : ''}</td>
          <td class="num">${r.contractor ? Fmt.hours(r.uninvoicedHours) : ''}</td></tr>`,
      )}</tbody></table></div>
      <p class="caption" style="margin-top: 12px">Someone counts as signed out a few minutes after their computer stops checking in, for example if it went to sleep.
        A long-running timer is often one that was forgotten; the contractor can correct the time on their My time page.</p>
    </div>
  </div>`;
}

// Manager: invoices and team time --------------------------------------------------------------

async function allInvoicesView() {
  const list = await api.allInvoices();
  ui.invFilter ??= { personId: '', status: 'issued' };
  const f = ui.invFilter;
  const people = [...new Map(list.map((i) => [i.personId, i.personName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const shown = list.filter(
    (i) => (!f.personId || i.personId === f.personId) && (f.status === 'all' || (f.status === 'void') === Boolean(i.voided)),
  );
  const total = shown.filter((i) => !i.voided).reduce((sum, i) => sum + i.amount, 0);
  return html`<div class="page">
    <div class="page-head"><div><h1>Invoices</h1><p class="sub">Every contractor's invoices. Contractors create their own; you can view, print or save any of them.</p></div></div>
    <form class="filters" data-form="inv-filter">
      <div class="field"><label>Contractor</label><select name="personId"><option value="">Everyone</option>
        ${people.map(([id, name]) => html`<option value="${id}"${flag(id === f.personId, 'selected')}>${name}</option>`)}</select></div>
      <div class="field"><label>Status</label><select name="status">
        ${[['issued', 'Issued'], ['void', 'Void'], ['all', 'All']].map(([v, l]) => html`<option value="${v}"${flag(v === f.status, 'selected')}>${l}</option>`)}</select></div>
      <button class="btn btn-secondary" type="submit">Show</button>
    </form>
    ${shown.length
      ? html`<div class="table-wrap"><table class="data">
          <thead><tr><th>Number</th><th>Contractor</th><th>Period</th><th>Issued</th><th class="num">Hours</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>${shown.map(
            (inv) => html`<tr class="${inv.voided ? 'is-void' : ''}">
              <td class="nowrap">${inv.number}</td><td>${inv.personName}</td>
              <td class="nowrap">${Fmt.date(inv.periodStart)} to ${Fmt.date(inv.periodEnd)}</td>
              <td class="nowrap">${Fmt.date(inv.issued)}</td>
              <td class="num">${Fmt.hours(inv.hours)}</td><td class="num">${Fmt.money(inv.amount)}</td>
              <td>${invoiceStatus(inv)}</td>
              <td>${invoiceActions(inv, inv.personId, { canVoid: false })}</td></tr>`,
          )}</tbody>
          <tfoot><tr><td colspan="5">Total, not counting void invoices</td><td class="num">${Fmt.money(total)}</td><td colspan="2"></td></tr></tfoot>
        </table></div>`
      : html`<div class="empty">No invoices match.</div>`}
  </div>`;
}

async function teamTimeView() {
  const { people } = await api.people();
  const contractors = people.filter((p) => p.contractor);
  ui.teamFrom ??= daysAgo(13);
  ui.teamTo ??= today();
  if (!contractors.some((p) => p.id === ui.teamPerson)) ui.teamPerson = contractors.find((p) => p.active)?.id ?? contractors[0]?.id ?? '';
  const entries = ui.teamPerson ? await api.personEntries(ui.teamPerson, ui.teamFrom, ui.teamTo) : [];
  const picker = html`<div class="field"><label>Contractor</label><select name="personId">
    ${contractors.map((p) => html`<option value="${p.id}"${flag(p.id === ui.teamPerson, 'selected')}>${p.name}${p.active ? '' : ' (turned off)'}</option>`)}</select></div>`;
  return html`<div class="page">
    <div class="page-head"><div><h1>Team time</h1><p class="sub">Read only. Contractors add and correct their own time.</p></div></div>
    ${contractors.length ? html`${periodFilter('team-filter', ui.teamFrom, ui.teamTo, { extra: picker })}${entryTable(entries, { editable: false })}` : html`<div class="empty">No contractors yet.</div>`}
  </div>`;
}

// Manager: people and tasks ---------------------------------------------------------------------

async function peopleView() {
  const data = await api.people();
  ui.peopleData = data;
  const templateName = (id) => data.templates.find((t) => t.id === id)?.name ?? 'Default';
  const className = { manager: 'Manager', employee: 'Employee', contractor: 'Contractor' };
  return html`<div class="page">
    <div class="page-head"><div><h1>People</h1><p class="sub">People come from AB Apps, which is where to add someone, change a
      name, or turn an account off. Here, set who logs time and their hourly rate and invoice template.</p></div></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>In AB Apps</th><th>Logs time</th><th class="num">Hourly rate</th><th>Invoice template</th><th></th></tr></thead>
      <tbody>${data.people.map(
        (p) => html`<tr class="${p.active ? '' : 'is-off'}">
          <td><strong>${p.name}</strong></td>
          <td>${p.removed ? 'Removed' : html`${className[p.class]}${p.active ? '' : ', turned off'}`}</td>
          <td>${p.contractor ? 'Yes' : 'No'}</td>
          <td class="num">${p.contractor ? (p.hourlyRate > 0 ? Fmt.money(p.hourlyRate) : 'Not set') : ''}</td>
          <td>${p.contractor ? templateName(p.templateId) : ''}</td>
          <td><div class="row-actions">${p.removed ? '' : html`<button class="btn btn-ghost btn-sm" data-action="edit-person" data-id="${p.id}">Change</button>`}</div></td></tr>`,
      )}</tbody></table></div>
  </div>`;
}

function personDialog(person) {
  const { templates } = ui.peopleData;
  const def = templates.find((t) => t.isDefault);
  openDialog(html`<form data-form="person">
    <input type="hidden" name="id" value="${person.id}">
    <h2>${person.name}</h2>
    <div class="form-error"></div>
    <label class="check"><input type="checkbox" name="contractor"${flag(person.contractor, 'checked')}> Logs time and creates invoices</label>
    <div class="field-row">
      <div class="field"><label for="pp-rate">Hourly rate ($)</label><input type="number" id="pp-rate" name="hourlyRate" min="0" step="0.01" value="${person.hourlyRate || ''}">
        <span class="hint">Used for new invoices.</span></div>
      <div class="field"><label for="pp-template">Invoice template</label><select id="pp-template" name="templateId">
        <option value="">Default${def ? ` (${def.name})` : ''}</option>
        ${templates.map((t) => html`<option value="${t.id}"${flag(t.id === person.templateId, 'selected')}>${t.name}</option>`)}</select></div>
    </div>
    <p class="small muted">Their name, and whether they're a manager or can sign in, are changed in AB Apps.</p>
    <div class="dialog-actions">
      <button class="btn btn-primary" type="submit">Save</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div></form>`);
}

async function tasksView() {
  state = await api.getState();
  const tasks = state.tasks;
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Tasks</h1><p class="sub">The list contractors choose from when they log time. They can also type their own description.</p></div>
      <button class="btn btn-primary" data-action="add-task">Add task</button></div>
    ${tasks.length
      ? html`<div class="table-wrap"><table class="data">
          <thead><tr><th>Task</th><th>Description</th><th>Status</th><th></th></tr></thead>
          <tbody>${tasks.map(
            (t, i) => html`<tr class="${t.active ? '' : 'is-off'}">
              <td><strong>${t.name}</strong></td>
              <td>${t.requiresNote ? 'Required' : 'Optional'}</td>
              <td>${t.active ? 'In the list' : 'Retired'}</td>
              <td><div class="row-actions">
                <button class="btn btn-ghost btn-sm" data-action="move-task" data-id="${t.id}" data-direction="-1"${flag(i === 0, 'disabled')} title="Move up">Up</button>
                <button class="btn btn-ghost btn-sm" data-action="move-task" data-id="${t.id}" data-direction="1"${flag(i === tasks.length - 1, 'disabled')} title="Move down">Down</button>
                <button class="btn btn-ghost btn-sm" data-action="edit-task" data-id="${t.id}">Change</button></div></td></tr>`,
          )}</tbody></table></div>
        <p class="caption" style="margin-top: 12px">Retiring a task takes it off the list. Time already logged against it keeps its name.</p>`
      : html`<div class="empty">No tasks yet. Until you add some, contractors describe their work in their own words.</div>`}
  </div>`;
}

function taskDialog(task) {
  openDialog(html`<form data-form="task">
    <input type="hidden" name="id" value="${task?.id ?? ''}">
    <h2>${task ? 'Change task' : 'Add task'}</h2>
    <div class="form-error"></div>
    <div class="field"><label for="tk-name">Name</label><input type="text" id="tk-name" name="name" maxlength="80" required value="${task?.name ?? ''}"></div>
    <label class="check"><input type="checkbox" name="requiresNote"${flag(task?.requiresNote, 'checked')}> Require a description, for catch-alls such as "Other"</label>
    ${task ? html`<label class="check"><input type="checkbox" name="active"${flag(task.active, 'checked')}> In the list</label>` : ''}
    <div class="dialog-actions">
      <button class="btn btn-primary" type="submit">Save</button>
      <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
    </div></form>`);
}

// Manager: invoice templates ----------------------------------------------------------------------

async function templatesView() {
  const data = await api.templates();
  ui.templateData = data;
  if (!ui.templateDraft || (ui.templateDraft.saved && !data.templates.some((t) => t.id === ui.templateDraft.id))) {
    const first = data.templates.find((t) => t.isDefault) ?? data.templates[0];
    ui.templateDraft = first ? { ...first, saved: true } : { ...(await api.newTemplate()), saved: false };
  }
  const t = ui.templateDraft;
  const field = (name, label, { area = false, hint = '', max = 200 } = {}) =>
    html`<div class="field"><label for="tp-${name}">${label}</label>${area
      ? html`<textarea id="tp-${name}" name="${name}" maxlength="${max}">${t[name] ?? ''}</textarea>`
      : html`<input type="text" id="tp-${name}" name="${name}" maxlength="${max}" value="${t[name] ?? ''}">`}${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;

  return html`<div class="page" style="max-width: 1500px">
    <div class="page-head"><div><h1>Invoice templates</h1>
      <p class="sub">What invoices say and how much detail they show. Changes apply to invoices created afterward; issued invoices keep the template they were made with.</p></div></div>
    <div class="template-layout">
      <div>
        <ul class="template-list">${data.templates.map(
          (x) => html`<li><button class="${x.id === t.id ? 'selected' : ''}" data-action="pick-template" data-id="${x.id}">
            <strong>${x.name}</strong>${x.isDefault ? html` <span class="tag tag-mint">Default</span>` : ''}
            <span class="caption">${x.users.length ? `Used by ${x.users.join(', ')}` : x.isDefault ? 'Used by everyone else' : 'Not assigned'}</span></button></li>`,
        )}${t.saved ? '' : html`<li><button class="selected"><strong>New template</strong><span class="caption">Not saved yet</span></button></li>`}</ul>
        <button class="btn btn-secondary btn-sm" data-action="new-template" style="margin-top: 12px">New template</button>
      </div>
      <form data-form="template" id="template-form">
        <input type="hidden" name="id" value="${t.id}">
        <div class="form-error"></div>
        ${field('name', 'Template name', { hint: 'Only managers see this.', max: 80 })}
        <div class="field-row">
          ${field('title', 'Heading', { hint: 'Such as "Invoice" or "Statement of hours".', max: 60 })}
          ${field('prefix', 'Number prefix', { hint: 'Invoice numbers look like INV-007-0012.', max: 10 })}
        </div>
        ${field('billToName', 'Bill to')}
        ${field('billToAddress', 'Bill-to address', { area: true, max: 500 })}
        <div class="field"><label for="tp-detail">Line items</label><select id="tp-detail" name="detail">
          ${Object.entries(data.detailOptions).map(([v, l]) => html`<option value="${v}"${flag(v === t.detail, 'selected')}>${l}</option>`)}</select></div>
        ${field('paymentTerms', 'Payment terms', { area: true, max: 500 })}
        ${field('notes', 'Notes', { area: true, max: 1000, hint: 'Printed on every invoice that uses this template.' })}
        ${field('footer', 'Footer', { area: true, max: 500, hint: 'Small print at the bottom, such as a tax ID or contact line.' })}
        <div class="actions">
          <button class="btn btn-primary" type="submit">Save template</button>
          ${t.saved && !t.isDefault ? html`<button class="btn btn-secondary" type="button" data-action="default-template" data-id="${t.id}">Make default</button>` : ''}
          ${t.saved && !t.isDefault ? html`<button class="btn btn-danger" type="button" data-action="delete-template" data-id="${t.id}">Delete</button>` : ''}
          ${t.saved ? '' : html`<button class="btn btn-ghost" type="button" data-action="discard-template">Discard</button>`}
        </div>
      </form>
      <div>
        <p class="field-label" style="margin-bottom: 4px">Preview, with sample time</p>
        <div id="preview-wrap" style="overflow: hidden; border: 1px solid var(--border-hairline)">
          <iframe id="preview" class="preview-frame" sandbox="allow-same-origin" title="Invoice preview"
            style="width: 816px; height: 1056px; border: 0; transform-origin: 0 0"></iframe></div>
      </div>
    </div>
  </div>`;
}

let previewTimer = null;
function templateValues() {
  const form = $('#template-form');
  return form ? Object.fromEntries(new FormData(form)) : null;
}

async function updatePreview() {
  const values = templateValues();
  if (!values) return;
  ui.templateDraft = { ...ui.templateDraft, ...values };
  try {
    $('#preview').srcdoc = await api.previewTemplate(values);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function fitPreview() {
  const wrap = $('#preview-wrap');
  const frame = $('#preview');
  if (!wrap || !frame) return;
  const scale = wrap.clientWidth / 816;
  frame.style.transform = `scale(${scale})`;
  wrap.style.height = `${1056 * scale}px`;
}
window.addEventListener('resize', fitPreview);

// Appearance: kept per computer, so it's on Settings for managers and on Profile for everyone else.
function appearanceSection() {
  const options = [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']];
  return html`<div class="section"><h2>Appearance</h2>
    <p class="small muted" style="margin: 4px 0 12px">Applies on this computer only.</p>
    <div class="choices" role="radiogroup" aria-label="Theme">
      ${options.map(([value, label]) => html`<label class="check"><input type="radio" name="theme" value="${value}"${flag(state.theme === value, 'checked')}> ${label}</label>`)}
    </div></div>`;
}

document.addEventListener('change', async (event) => {
  if (event.target.name !== 'theme' || event.target.type !== 'radio') return;
  try {
    state.theme = await api.setTheme(event.target.value);
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// Updates: on Settings for managers and on Profile for everyone else, like Appearance.
// state.release is the last check's result, { version, newer, publishedAt, hasInstaller }.
// percent: how much of the installer has downloaded, while it downloads.
const update = { checking: false, checked: false, installing: false, percent: null };
const updatesView = () => (state.me.manager ? 'settings' : 'profile');

function updatesSection() {
  const { checking, checked, installing, percent } = update;
  const release = state.release;
  const status = checking ? 'Checking for updates…' : checked && release && !release.newer ? 'You have the latest version.' : '';
  return html`<div class="section" id="updates"><h2>Updates</h2>
    <p class="small muted" style="margin: 4px 0 12px">This is version ${state.version}. ${status}</p>
    ${release?.newer
      ? html`<div class="notice" style="margin-bottom: 12px"><strong>Version ${release.version} is available.</strong>
          ${release.publishedAt ? `Released ${Fmt.date(release.publishedAt)}. ` : ''}${release.hasInstaller
            ? 'KeepTime closes while the update installs. Your time and invoices are kept.'
            : "Its installer isn't ready yet. Try again in a few minutes."}</div>`
      : ''}
    <div class="actions">
      ${release?.newer && release.hasInstaller
        ? html`<button class="btn btn-primary" data-action="install-update"${flag(installing, 'disabled')}>${!installing
            ? 'Download and install'
            : percent === 100 ? 'Downloaded' : `Downloading…${percent === null ? '' : ` ${percent}%`}`}</button>`
        : ''}
      <button class="btn btn-secondary" data-action="check-update"${flag(checking || installing, 'disabled')}>Check for updates</button>
      <button class="btn btn-ghost" data-action="release-page">What's new</button>
    </div></div>`;
}

/** Redraws the Updates section, if it's showing, and the header's note that an update is waiting. */
function drawUpdates() {
  const section = $('#updates');
  if (section) section.outerHTML = updatesSection().s;
  const badge = $('#update-badge');
  if (badge) {
    badge.innerHTML = state.release?.newer
      ? html`<button class="btn btn-secondary btn-sm" data-action="nav" data-view="${updatesView()}">Update available</button>`.s
      : '';
  }
}

api.onUpdateFound((release) => {
  if (!state) return;
  state.release = release;
  drawUpdates();
});

api.onUpdateProgress(({ percent }) => {
  update.percent = percent;
  drawUpdates();
});

// Manager: settings ---------------------------------------------------------------------------------

async function settingsView() {
  state = await api.getState();
  const s = state.settings;
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Settings</h1><p class="sub">The time rules apply to everyone. The data folder and appearance are for this computer only.</p></div></div>
    <form data-form="settings">
      <div class="form-error"></div>
      <div class="field"><label for="st-window">Contractors can add, change or delete time from the last</label>
        <div class="actions"><input type="number" id="st-window" name="editWindowDays" min="0" max="365" step="1" value="${s.editWindowDays}" style="width: 110px"> days</div>
        <span class="hint">0 means no limit. Time on an invoice is always locked until the invoice is voided.</span></div>
      <div class="field"><label for="st-long">Flag timers running longer than</label>
        <div class="actions"><input type="number" id="st-long" name="longTimerHours" min="1" max="24" step="1" value="${s.longTimerHours}" style="width: 110px"> hours</div>
        <span class="hint">Shown on Who's signed in, since a long timer is often a forgotten one.</span></div>
      <button class="btn btn-primary" type="submit">Save settings</button>
    </form>
    <div class="section"><h2>Data folder</h2>
      <p class="small muted" style="margin-top: 4px">Where this computer finds KeepTime's data. Each computer chooses it once.</p>
      <p class="path">${state.dataDir}</p>
      <div class="actions"><button class="btn btn-secondary" data-action="open-folder">Open folder</button>
        <button class="btn btn-ghost" data-action="change-folder">Use a different folder on this computer</button></div>
    </div>
    ${appearanceSection()}
    ${updatesSection()}
  </div>`;
}

const VIEWS = {
  timer: timerView,
  time: timeView,
  invoices: invoicesView,
  profile: profileView,
  overview: overviewView,
  'all-invoices': allInvoicesView,
  'team-time': teamTimeView,
  people: peopleView,
  tasks: tasksView,
  templates: templatesView,
  settings: settingsView,
};

// Set up after a page is drawn.
const AFTER = {
  timer() {
    if (ui.running) ticker = setInterval(tickClock, 1000);
  },
  overview() {
    poller = setInterval(() => view === 'overview' && !dialogEl.open && drawView(), 20000);
  },
  templates() {
    const form = $('#template-form');
    form.addEventListener('input', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 300);
    });
    fitPreview();
    updatePreview();
  },
};

// Forms ----------------------------------------------------------------------------------------------

const after = async (message) => {
  if (dialogEl.open) closeDialog();
  await drawView();
  if (message) toast(message);
};

const FORMS = {
  async setup(v) {
    state = await api.setup({ contractor: v.contractor });
    view = null;
    render();
    toast('KeepTime is set up. Next, set hourly rates on the People page, add tasks, and check the invoice template.');
  },

  async timer(v) {
    const input = { taskId: v.taskId || null, note: v.note };
    if (v.op === 'start') await api.startTimer(input);
    else if (v.op === 'stop') await api.stopTimer(input);
    else await api.describeTimer(input);
    stopTimers();
    await after(v.op === 'describe' ? 'Description saved.' : null);
  },

  async 'time-filter'(v) {
    if (v.to < v.from) throw new Error('The end must be on or after the start.');
    ui.timeFrom = v.from;
    ui.timeTo = v.to;
    await drawView();
  },

  async entry(v) {
    const input = { start: v.start, end: v.end || null, taskId: v.taskId || null, note: v.note };
    if (v.id) await api.editEntry(v.id, input);
    else await api.addEntry(input);
    await after(v.id ? 'Time changed.' : 'Time added.');
  },

  async 'invoice-preview'(v) {
    if (v.to < v.from) throw new Error('The end must be on or after the start.');
    ui.invoiceFrom = v.from;
    ui.invoiceTo = v.to;
    ui.preview = { from: v.from, to: v.to, ...(await api.previewInvoice(v.from, v.to)) };
    await drawView();
  },

  async void(v) {
    await api.voidInvoice(v.id, v.reason);
    ui.preview = null;
    ui.invoiceFrom = ui.invoiceTo = null;
    await after('Invoice voided. Its time can be corrected and invoiced again.');
  },

  async profile(v) {
    await api.saveProfile(v);
    toast('Details saved.');
  },

  async 'inv-filter'(v) {
    ui.invFilter = { personId: v.personId, status: v.status };
    await drawView();
  },

  async 'team-filter'(v) {
    if (v.to < v.from) throw new Error('The end must be on or after the start.');
    ui.teamPerson = v.personId;
    ui.teamFrom = v.from;
    ui.teamTo = v.to;
    await drawView();
  },

  async person(v) {
    await api.savePerson(v);
    await after('Saved.');
  },

  async task(v) {
    await api.saveTask(v);
    await after(v.id ? 'Task saved.' : 'Task added.');
  },

  async template(v) {
    const saved = await api.saveTemplate(v);
    ui.templateDraft = { ...saved, saved: true };
    await after('Template saved.');
  },

  async settings(v) {
    await api.saveSettings(v);
    state = await api.getState();
    toast('Settings saved.');
  },
};

document.addEventListener('submit', async (event) => {
  const form = event.target;
  const handler = FORMS[form.dataset.form];
  if (!handler) return;
  event.preventDefault();
  const data = event.submitter ? new FormData(form, event.submitter) : new FormData(form);
  const values = Object.fromEntries(data);
  for (const box of form.querySelectorAll('input[type=checkbox][name]')) {
    if (!box.disabled) values[box.name] = box.checked;
  }
  for (const key of Object.keys(values)) if (values[key] === 'on') values[key] = true;
  const errorBox = form.querySelector('.form-error');
  if (errorBox) errorBox.textContent = '';
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await handler(values, form);
  } catch (err) {
    if (errorBox && form.isConnected) errorBox.textContent = err.message;
    else toast(err.message, { error: true });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// Buttons ----------------------------------------------------------------------------------------------

const ACTIONS = {
  nav: (d) => go(d.view),
  reload: () => (state.screen === 'app' ? drawView() : api.getState().then((s) => ((state = s), render()))),
  'close-dialog': () => closeDialog(),
  toast: () => {
    $('#toast').hidden = true;
    return toastAction?.();
  },

  async 'choose-folder'() {
    state = await api.chooseFolder();
    view = null;
    render();
  },

  async 'change-folder'() {
    const ok = await confirmDialog({
      title: 'Use a different folder?',
      body: "This signs you out and points this computer at another data folder. Nothing in the current folder is changed or moved.",
      button: 'Choose folder',
    });
    if (!ok) return;
    state = await api.chooseFolder();
    view = null;
    render();
  },

  'open-folder': () => api.openFolder(),

  async 'check-update'() {
    update.checking = true;
    drawUpdates();
    try {
      state.release = await api.checkForUpdate();
      update.checked = true;
    } finally {
      update.checking = false;
      drawUpdates();
    }
  },

  // Asks first, and closes the app if the update is installed.
  async 'install-update'() {
    update.installing = true;
    drawUpdates();
    try {
      await api.installUpdate();
    } finally {
      update.installing = false;
      update.percent = null;
      drawUpdates();
    }
  },

  'release-page': () => api.openReleasePage(),

  'open-abapps': () => api.openABApps(),

  'add-entry': () => entryDialog(null),
  'edit-entry': (d) => entryDialog(ui.entries.find((e) => e.id === d.id)),

  async 'delete-entry'(d) {
    const e = ui.entries.find((x) => x.id === d.id);
    const ok = await confirmDialog({
      title: 'Delete this time?',
      body: `${Fmt.date(e.start)}, ${Fmt.time(e.start)} to ${e.end ? Fmt.time(e.end) : 'now'}: ${describe(e)}.${e.end ? '' : ' This also stops the timer.'}`,
      button: 'Delete',
    });
    if (!ok) return;
    await api.deleteEntry(d.id);
    await after('Time deleted.');
  },

  async 'issue-invoice'() {
    const p = ui.preview;
    const invoice = await api.issueInvoice(p.from, p.to);
    ui.preview = null;
    ui.invoiceFrom = ui.invoiceTo = null;
    await drawView();
    toast(`Invoice ${invoice.number} created for ${Fmt.money(invoice.amount)}.`, {
      action: { label: 'Save PDF', run: () => ACTIONS.invoice({ op: 'pdf', person: state.me.id, id: invoice.id }) },
    });
  },

  'clear-preview': () => {
    ui.preview = null;
    return drawView();
  },

  async invoice(d) {
    const saved = await api.invoiceOutput(d.person, d.id, d.op);
    if (saved) toast(`Saved ${saved.split(/[\\/]/).pop()}.`, { action: { label: 'Open', run: () => api.openFile(saved) } });
  },

  'void-invoice': (d) =>
    openDialog(html`<form data-form="void">
      <input type="hidden" name="id" value="${d.id}">
      <h2>Void ${d.number}?</h2>
      <p>The invoice stays on record marked void, and its time is unlocked so you can correct it and invoice it again.
        Let your manager know if you've already sent it.</p>
      <div class="form-error"></div>
      <div class="field"><label for="v-reason">Reason</label><textarea id="v-reason" name="reason" maxlength="500" required></textarea></div>
      <div class="dialog-actions">
        <button class="btn btn-primary" type="submit">Void invoice</button>
        <button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>
      </div></form>`),

  'edit-person': (d) => personDialog(ui.peopleData.people.find((p) => p.id === d.id)),

  'add-task': () => taskDialog(null),
  'edit-task': (d) => taskDialog(state.tasks.find((t) => t.id === d.id)),
  async 'move-task'(d) {
    await api.moveTask(d.id, Number(d.direction));
    await drawView();
  },

  async 'pick-template'(d) {
    const t = ui.templateData.templates.find((x) => x.id === d.id);
    ui.templateDraft = { ...t, saved: true };
    await drawView();
  },
  async 'new-template'() {
    ui.templateDraft = { ...(await api.newTemplate()), saved: false };
    await drawView();
  },
  async 'discard-template'() {
    ui.templateDraft = null;
    await drawView();
  },
  async 'default-template'(d) {
    await api.setDefaultTemplate(d.id);
    ui.templateDraft = { ...ui.templateDraft, isDefault: true };
    await after('Default template changed. Contractors without their own template use it from now on.');
  },
  async 'delete-template'(d) {
    const ok = await confirmDialog({
      title: 'Delete this template?',
      body: 'Invoices already created with it are kept as they are.',
      button: 'Delete',
    });
    if (!ok) return;
    await api.deleteTemplate(d.id);
    ui.templateDraft = null;
    await after('Template deleted.');
  },
};

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const action = ACTIONS[el.dataset.action];
  if (!action) return;
  event.preventDefault();
  try {
    await action(el.dataset, el);
  } catch (err) {
    if (dialogEl.open && dialogEl.querySelector('.form-error')) dialogEl.querySelector('.form-error').textContent = err.message;
    else toast(err.message, { error: true });
  }
});

// Someone signed in to or out of AB Apps: start over as whoever is signed in now.
api.onIdentityChanged(async () => {
  const before = state?.me?.id ?? null;
  state = await api.getState();
  if ((state.me?.id ?? null) !== before) {
    view = null;
    Object.keys(ui).forEach((k) => delete ui[k]);
    if (dialogEl.open) closeDialog();
  }
  render();
});

api.getState().then((s) => {
  state = s;
  render();
});
