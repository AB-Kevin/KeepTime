'use strict';

// Invoices. An issued invoice keeps a copy of everything printed on it (the
// lines, the template, the contractor's details), so it prints the same way
// later even after the template, rate or profile changes.

const crypto = require('crypto');
const Fmt = require('../shared/format');
const { describe } = require('./time');

const DETAIL = {
  entry: 'One line per entry',
  day: 'One line per day',
  task: 'One line per task',
};

function newTemplate(fields = {}) {
  return {
    id: crypto.randomUUID(),
    name: 'Standard',
    title: 'Invoice',
    prefix: 'INV',
    billToName: 'Anabaptist Brotherhood',
    billToAddress: '',
    detail: 'entry',
    paymentTerms: 'Payment due within 30 days of receipt.',
    notes: '',
    footer: '',
    ...fields,
  };
}

function templateProblems(t, others) {
  const errors = [];
  if (!String(t.name ?? '').trim()) errors.push('Give the template a name.');
  else if (others.some((o) => o.id !== t.id && o.name.trim().toLowerCase() === t.name.trim().toLowerCase())) {
    errors.push('Another template already has that name.');
  }
  if (!String(t.title ?? '').trim()) errors.push('Enter the heading printed on the invoice.');
  if (!/^[A-Za-z0-9]{1,10}$/.test(String(t.prefix ?? ''))) errors.push('The invoice number prefix is 1 to 10 letters or numbers.');
  if (!String(t.billToName ?? '').trim()) errors.push('Enter who the invoice is billed to.');
  if (!DETAIL[t.detail]) errors.push('Choose how much detail the lines show.');
  return errors;
}

/** Midnight at the start of `from` to midnight after `to`, here. */
function periodRange(from, to) {
  const start = Fmt.toDate(from);
  const end = Fmt.toDate(to);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

/** Completed, uninvoiced entries that started in the period, oldest first. */
function billableEntries(entries, from, to) {
  const [start, end] = periodRange(from, to);
  return entries
    .filter((e) => !e.deleted && e.end && !e.invoiceId)
    .filter((e) => {
      const t = Date.parse(e.start);
      return t >= start.getTime() && t < end.getTime();
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

const msOf = (es) => es.reduce((sum, e) => sum + (Date.parse(e.end) - Date.parse(e.start)), 0);

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()];
}

function buildLines(entries, detail) {
  if (detail === 'day') {
    return groupBy(entries, (e) => Fmt.dayKey(e.start)).map(([day, es]) => ({
      date: Fmt.date(day),
      description: [...new Set(es.map(describe))].join('; '),
      hours: Fmt.hoursOf(msOf(es)),
    }));
  }
  if (detail === 'task') {
    return groupBy(entries, (e) => e.taskName ?? 'Other work').map(([task, es]) => {
      const first = Fmt.date(es[0].start);
      const last = Fmt.date(es[es.length - 1].start);
      const notes = [...new Set(es.map((e) => e.note).filter(Boolean))];
      return {
        date: first === last ? first : `${first} to ${last}`,
        description: notes.length ? `${task}: ${notes.join('; ')}` : task,
        hours: Fmt.hoursOf(msOf(es)),
      };
    });
  }
  return entries.map((e) => ({
    date: `${Fmt.date(e.start)}, ${Fmt.time(e.start)} to ${Fmt.time(e.end)}`,
    description: describe(e),
    hours: Fmt.hoursOf(msOf([e])),
  }));
}

/** What an invoice for the period would contain. Totals add up the rounded lines, so the printout adds up exactly. */
function preview(entries, from, to, rate, detail) {
  const billable = billableEntries(entries, from, to);
  const lines = buildLines(billable, detail);
  const hours = Math.round(lines.reduce((sum, l) => sum + l.hours, 0) * 100) / 100;
  return { entries: billable, lines, hours, rate, amount: Math.round(hours * rate * 100) / 100 };
}

function invoiceNumber(prefix, personNumber, seq) {
  return `${prefix}-${String(personNumber).padStart(3, '0')}-${String(seq).padStart(4, '0')}`;
}

/** The contractor's details as printed in the "from" block. */
function fromDetails(person, profile) {
  return {
    name: person.name,
    businessName: profile.businessName || '',
    address: profile.address || '',
    email: profile.email || '',
    phone: profile.phone || '',
    paymentInstructions: profile.paymentInstructions || '',
  };
}

/**
 * Issues an invoice for the period: numbers it, keeps a copy of what it
 * prints, and locks the entries on it. Changes `entries` and `invoices` in place.
 */
function issue({ entries, invoices, person, profile, template, from, to, now }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
    return { errors: ['Choose the first and last day of the period.'] };
  }
  if (to < from) return { errors: ['The end of the period must be on or after the start.'] };
  if (!(person.hourlyRate > 0)) return { errors: ["Your hourly rate hasn't been set. Set it on your Profile before invoicing."] };
  if (!template) return { errors: ['No invoice template is set up yet. Ask a manager to add one.'] };

  const p = preview(entries, from, to, person.hourlyRate, template.detail);
  if (!p.entries.length) return { errors: ['There is no completed, uninvoiced time in this period.'] };

  const seq = invoices.reduce((max, i) => Math.max(max, i.seq), 0) + 1;
  const invoice = {
    id: crypto.randomUUID(),
    number: invoiceNumber(template.prefix, person.number, seq),
    seq,
    periodStart: from,
    periodEnd: to,
    issued: now.toISOString(),
    rate: p.rate,
    hours: p.hours,
    amount: p.amount,
    lines: p.lines,
    entryIds: p.entries.map((e) => e.id),
    template: { ...template },
    from: fromDetails(person, profile),
    voided: null,
  };
  invoices.push(invoice);
  for (const e of p.entries) e.invoiceId = invoice.id;
  return { errors: [], invoice };
}

/** Voids an invoice and releases its time so it can be corrected and invoiced again. */
function voidInvoice({ entries, invoices, id, reason, now }) {
  const invoice = invoices.find((i) => i.id === id);
  if (!invoice) return ["That invoice doesn't exist."];
  if (invoice.voided) return ['That invoice is already void.'];
  if (!String(reason ?? '').trim()) return ['Give a reason for voiding the invoice.'];
  invoice.voided = { at: now.toISOString(), reason: String(reason).trim() };
  for (const e of entries) if (e.invoiceId === id) e.invoiceId = null;
  return [];
}

/** A made-up invoice for previewing a template. */
function sampleInvoice(template, now = new Date()) {
  const day = (offset, hour, minutes) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, 0, 0, 0);
    const end = new Date(d.getTime() + minutes * 60000);
    return { start: d.toISOString(), end: end.toISOString() };
  };
  const entries = [
    { ...day(-3, 9, 150), taskName: 'Claims review', note: 'March batch' },
    { ...day(-3, 13, 90), taskName: 'Correspondence', note: null },
    { ...day(-2, 8, 240), taskName: 'Claims review', note: 'April batch' },
    { ...day(-1, 10, 75), taskName: null, note: 'Phone calls with members' },
  ];
  const rate = 30;
  const lines = buildLines(entries, template.detail);
  const hours = Math.round(lines.reduce((sum, l) => sum + l.hours, 0) * 100) / 100;
  return {
    number: invoiceNumber(template.prefix || 'INV', 7, 12),
    periodStart: Fmt.dayKey(entries[0].start),
    periodEnd: Fmt.dayKey(entries[entries.length - 1].start),
    issued: now.toISOString(),
    rate,
    hours,
    amount: Math.round(hours * rate * 100) / 100,
    lines,
    template,
    from: {
      name: 'Sample Contractor',
      businessName: 'Sample Bookkeeping LLC',
      address: '100 Main Street\nSugarcreek, OH 44681',
      email: 'sample@example.com',
      phone: '(330) 555-0100',
      paymentInstructions: 'Check payable to Sample Bookkeeping LLC.',
    },
    voided: null,
  };
}

module.exports = {
  DETAIL,
  newTemplate,
  templateProblems,
  billableEntries,
  preview,
  issue,
  voidInvoice,
  sampleInvoice,
};
