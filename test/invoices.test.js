'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const invoices = require('../src/main/invoices');
const { renderInvoice } = require('../src/main/invoice-html');

const NOW = new Date('2026-10-12T15:00:00');
const entry = (id, start, end, extra = {}) => ({
  id,
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  taskName: 'Claims review',
  note: null,
  invoiceId: null,
  deleted: null,
  ...extra,
});

function sample() {
  return [
    entry('a', '2026-10-01T09:00', '2026-10-01T10:20'), // 1.33
    entry('b', '2026-10-01T13:00', '2026-10-01T13:20', { taskName: null, note: 'Calls' }), // 0.33
    entry('c', '2026-10-02T09:00', '2026-10-02T11:00', { note: 'April' }), // 2
    entry('d', '2026-10-03T09:00', '2026-10-03T10:00', { deleted: '2026-10-03T12:00:00Z' }),
    entry('e', '2026-10-04T09:00', '2026-10-04T10:00', { invoiceId: 'old' }),
    { ...entry('f', '2026-10-05T09:00', '2026-10-05T10:00'), end: null },
    entry('g', '2026-10-09T09:00', '2026-10-09T10:00'), // outside the period
  ];
}

const person = { id: 'p1', number: 7, name: 'Ann Miller', hourlyRate: 30 };
const template = invoices.newTemplate({ prefix: 'AB' });

test('only completed, uninvoiced, undeleted time in the period is billable', () => {
  const ids = invoices.billableEntries(sample(), '2026-10-01', '2026-10-05').map((e) => e.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('totals add up the rounded lines', () => {
  const p = invoices.preview(sample(), '2026-10-01', '2026-10-05', 30, 'entry');
  assert.deepEqual(p.lines.map((l) => l.hours), [1.33, 0.33, 2]);
  assert.equal(p.hours, 3.66);
  assert.equal(p.amount, 109.8);
  assert.equal(p.lines[1].description, 'Calls');
  assert.equal(p.lines[2].description, 'Claims review: April');
});

test('lines can be grouped per day or per task', () => {
  const byDay = invoices.preview(sample(), '2026-10-01', '2026-10-05', 30, 'day');
  assert.equal(byDay.lines.length, 2);
  assert.equal(byDay.lines[0].hours, 1.67);
  assert.equal(byDay.lines[0].description, 'Claims review; Calls');

  const byTask = invoices.preview(sample(), '2026-10-01', '2026-10-05', 30, 'task');
  assert.deepEqual(byTask.lines.map((l) => l.description), ['Claims review: April', 'Other work: Calls']);
  assert.equal(byTask.lines[0].date, 'Oct 1, 2026 to Oct 2, 2026');
});

test('issuing numbers the invoice, keeps a copy of what it prints and locks its time', () => {
  const entries = sample();
  const list = [{ id: 'x', seq: 3, voided: null }];
  const { errors, invoice } = invoices.issue({
    entries, invoices: list, person, profile: { businessName: 'Miller Books' }, template, from: '2026-10-01', to: '2026-10-05', now: NOW,
  });
  assert.deepEqual(errors, []);
  assert.equal(invoice.number, 'AB-007-0004');
  assert.equal(invoice.from.businessName, 'Miller Books');
  assert.equal(invoice.template.prefix, 'AB');
  assert.deepEqual(entries.filter((e) => e.invoiceId === invoice.id).map((e) => e.id), ['a', 'b', 'c']);

  const again = invoices.issue({ entries, invoices: list, person, profile: {}, template, from: '2026-10-01', to: '2026-10-05', now: NOW });
  assert.deepEqual(again.errors, ['There is no completed, uninvoiced time in this period.']);
});

test('issuing needs a rate, a template and a sensible period', () => {
  const base = { entries: sample(), invoices: [], person, profile: {}, template, now: NOW };
  assert.match(invoices.issue({ ...base, person: { ...person, hourlyRate: 0 }, from: '2026-10-01', to: '2026-10-05' }).errors[0], /rate/);
  assert.match(invoices.issue({ ...base, template: null, from: '2026-10-01', to: '2026-10-05' }).errors[0], /template/);
  assert.match(invoices.issue({ ...base, from: '2026-10-05', to: '2026-10-01' }).errors[0], /on or after/);
});

test('voiding releases the time so it can be invoiced again', () => {
  const entries = sample();
  const list = [];
  const { invoice } = invoices.issue({ entries, invoices: list, person, profile: {}, template, from: '2026-10-01', to: '2026-10-05', now: NOW });
  assert.deepEqual(invoices.voidInvoice({ entries, invoices: list, id: invoice.id, reason: ' ', now: NOW }), ['Give a reason for voiding the invoice.']);
  assert.deepEqual(invoices.voidInvoice({ entries, invoices: list, id: invoice.id, reason: 'Wrong week', now: NOW }), []);
  assert.equal(entries.filter((e) => e.invoiceId === invoice.id).length, 0);
  assert.equal(list[0].voided.reason, 'Wrong week');
  const next = invoices.issue({ entries, invoices: list, person, profile: {}, template, from: '2026-10-01', to: '2026-10-05', now: NOW });
  assert.equal(next.invoice.number, 'AB-007-0002', 'void numbers are not reused');
});

test('templates are validated', () => {
  const others = [invoices.newTemplate({ name: 'Standard' })];
  assert.deepEqual(invoices.templateProblems(invoices.newTemplate({ name: 'Monthly' }), others), []);
  const bad = invoices.newTemplate({ name: 'standard', prefix: 'IN V', billToName: '', detail: 'week', title: '' });
  assert.equal(invoices.templateProblems(bad, others).length, 5);
});

test('the printed invoice escapes what people typed', () => {
  const inv = invoices.sampleInvoice(invoices.newTemplate({ notes: '<script>alert(1)</script>' }), NOW);
  const page = renderInvoice(inv);
  assert.ok(!page.includes('<script>'));
  assert.ok(page.includes('&lt;script&gt;'));
  assert.ok(page.includes(inv.number));
});
