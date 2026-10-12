'use strict';

// Sign-in is a name and a PIN. The PIN keeps people out of each other's time
// in the app; it isn't a security boundary, because anyone with access to the
// OneDrive folder can read and change the files directly.

const crypto = require('crypto');

const PIN_PATTERN = /^\d{4,8}$/;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

function pinProblem(pin) {
  return PIN_PATTERN.test(String(pin ?? '')) ? null : 'A PIN is 4 to 8 digits.';
}

function hashPin(pin, now = new Date()) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash, setAt: now.toISOString() };
}

function verifyPin(pin, record) {
  if (!record?.hash || !record?.salt) return false;
  const expected = Buffer.from(record.hash, 'hex');
  const actual = crypto.scryptSync(String(pin ?? ''), record.salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * A manager sets PINs in the shared people file, and people change their own
 * in their profile, since only they write that. Whichever was set last counts.
 */
function currentPin(person, profile) {
  const fromManager = person?.pin;
  const fromPerson = profile?.pin;
  if (!fromPerson) return fromManager ?? null;
  if (!fromManager) return fromPerson;
  return Date.parse(fromPerson.setAt) > Date.parse(fromManager.setAt) ? fromPerson : fromManager;
}

/** Slows down guessing: after five wrong PINs, that person can't sign in on this computer for a minute. */
class Lockout {
  constructor() {
    this.failures = new Map();
  }

  /** Seconds until `id` may try again, or 0. */
  wait(id, now = Date.now()) {
    const f = this.failures.get(id);
    if (!f || f.count < MAX_FAILURES) return 0;
    const left = f.at + LOCKOUT_MS - now;
    if (left <= 0) {
      this.failures.delete(id);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  fail(id, now = Date.now()) {
    const f = this.failures.get(id) ?? { count: 0, at: now };
    this.failures.set(id, { count: f.count + 1, at: now });
  }

  clear(id) {
    this.failures.delete(id);
  }
}

module.exports = { pinProblem, hashPin, verifyPin, currentPin, Lockout };
