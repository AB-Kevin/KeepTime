'use strict';

// Display formatting, shared by the main process (invoices) and the window.
// Times are shown in this computer's time zone.

(function (root) {
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const shortDateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  const pad = (n) => String(n).padStart(2, '0');

  /** A Date or ISO string; a bare 'YYYY-MM-DD' is that day here, not UTC midnight. */
  function toDate(value) {
    if (value instanceof Date) return value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(value);
  }

  const Fmt = {
    date: (value) => dateFmt.format(toDate(value)),
    shortDate: (value) => shortDateFmt.format(toDate(value)),
    time: (value) => timeFmt.format(toDate(value)),
    money: (amount) => moneyFmt.format(amount),
    hours: (hours) => Number(hours).toFixed(2),

    /** Hours to two decimal places, the precision invoices bill in. */
    hoursOf: (ms) => Math.round(ms / 36e3) / 100,

    /** "1:05:09", for a running clock. */
    clock(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    },

    /** 'YYYY-MM-DD' for the day `value` falls on here. */
    dayKey(value) {
      const d = toDate(value);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    /** 'YYYY-MM-DDTHH:mm' for a datetime-local input. */
    inputDateTime(value) {
      const d = toDate(value);
      return `${Fmt.dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    toDate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Fmt;
  else root.Fmt = Fmt;
})(this);
