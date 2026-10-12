'use strict';

// The printable invoice: one self-contained HTML page, used for printing,
// saving as PDF, and the template preview. Letter size, brand green for the
// heading and rules, mint for the totals card.

const Fmt = require('../shared/format');

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const lines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');

function section(title, body) {
  if (!String(body ?? '').trim()) return '';
  return `<section><h3>${esc(title)}</h3>${lines(body)}</section>`;
}

/** `fontCss`: @font-face rules for Poppins, since a print window has no stylesheet of its own. */
function renderInvoice(inv, fontCss = '') {
  const t = inv.template;
  const from = inv.from;
  const fromName = from.businessName || from.name;
  const rows = inv.lines
    .map((l) => `<tr><td class="date">${esc(l.date)}</td><td>${esc(l.description)}</td><td class="num">${Fmt.hours(l.hours)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(inv.number)}</title>
<style>
${fontCss}
@page { size: Letter; margin: 0.75in; }
* { box-sizing: border-box; }
html { background: #fff; }
body { margin: 0; font-family: 'Poppins', 'Segoe UI', sans-serif; font-size: 10pt; line-height: 1.45; color: #231F20; }
@media screen { body { max-width: 8.5in; margin: 0 auto; padding: 0.75in; } }
.head { display: flex; justify-content: space-between; gap: 24pt; padding-bottom: 12pt; border-bottom: 2.5pt solid #006D46; }
.from-name { font-size: 15pt; font-weight: 700; }
.muted { color: #58595B; }
.title { text-align: right; }
.title h1 { margin: 0; font-size: 24pt; font-weight: 300; color: #006D46; line-height: 1.1; }
.title .number { font-weight: 600; }
.void { margin-top: 14pt; padding: 8pt 12pt; border-left: 4pt solid #864855; background: #F4F8F6; font-weight: 600; }
.bill-to { margin-top: 18pt; }
h3 { margin: 0 0 2pt; font-size: 10pt; font-weight: 600; color: #006D46; }
table { width: 100%; border-collapse: collapse; margin-top: 18pt; }
th { text-align: left; font-weight: 600; padding: 5pt 4pt; border-bottom: 1pt solid #006D46; }
td { padding: 5pt 4pt; border-bottom: 0.5pt solid #D5D6D7; vertical-align: top; }
tr { break-inside: avoid; }
td.date { width: 2.6in; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.totals { margin: 18pt 0 0 auto; width: 3.6in; background: #E8F1EC; border-radius: 6pt; padding: 12pt 14pt; break-inside: avoid; }
.totals div { display: flex; justify-content: space-between; }
.totals .due { margin-top: 6pt; padding-top: 6pt; border-top: 1pt solid #006D46; font-weight: 700; }
.totals .due span:last-child { font-size: 13pt; }
section { margin-top: 16pt; break-inside: avoid; }
.footer { margin-top: 28pt; padding-top: 8pt; border-top: 0.5pt solid #D5D6D7; font-size: 8.5pt; color: #58595B; text-align: center; }
</style>
</head>
<body>
<div class="head">
  <div>
    <div class="from-name">${esc(fromName)}</div>
    ${from.businessName && from.businessName !== from.name ? `<div class="muted">${esc(from.name)}</div>` : ''}
    <div class="muted">${lines(from.address)}</div>
    ${from.email ? `<div class="muted">${esc(from.email)}</div>` : ''}
    ${from.phone ? `<div class="muted">${esc(from.phone)}</div>` : ''}
  </div>
  <div class="title">
    <h1>${esc(t.title)}</h1>
    <div class="number">${esc(inv.number)}</div>
    <div class="muted">Issued ${Fmt.date(inv.issued)}</div>
    <div class="muted">Period ${Fmt.date(inv.periodStart)} to ${Fmt.date(inv.periodEnd)}</div>
  </div>
</div>
${inv.voided ? `<div class="void">Void. ${esc(inv.voided.reason)}</div>` : ''}
<div class="bill-to">
  <h3>Bill to</h3>
  <div><strong>${esc(t.billToName)}</strong></div>
  ${lines(t.billToAddress)}
</div>
<table>
  <thead><tr><th>Date</th><th>Description</th><th class="num">Hours</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="totals">
  <div><span>Total hours</span><span class="num">${Fmt.hours(inv.hours)}</span></div>
  <div><span>Hourly rate</span><span class="num">${Fmt.money(inv.rate)}</span></div>
  <div class="due"><span>Amount due</span><span class="num">${Fmt.money(inv.amount)}</span></div>
</div>
${section('Terms', t.paymentTerms)}
${section('Payment instructions', from.paymentInstructions)}
${section('Notes', t.notes)}
${String(t.footer ?? '').trim() ? `<div class="footer">${lines(t.footer)}</div>` : ''}
</body>
</html>`;
}

module.exports = { renderInvoice };
