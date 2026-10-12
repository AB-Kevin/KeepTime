'use strict';

// Who's signed in. While someone is signed in, their copy of the app rewrites
// people/<id>/presence.json every minute; managers read everyone's. A file
// that stops changing means the app was closed without signing out (or the
// computer went to sleep), so after a few minutes that person counts as gone.
// OneDrive usually syncs within a minute, so this view lags by about that much.

const os = require('os');

const HEARTBEAT_MS = 60 * 1000;
const ACTIVE_MS = 3 * 60 * 1000;

/** Names the computer and Windows account, since several people can share one remote desktop server. */
function computerName() {
  return `${os.hostname()} (${os.userInfo().username})`;
}

function isSignedIn(presence, now = Date.now()) {
  return Boolean(presence && !presence.signedOut && now - Date.parse(presence.seen) < ACTIVE_MS);
}

/** Minutes until a presence record stops counting, rounded up. */
function minutesUntilStale(presence, now = Date.now()) {
  return Math.max(1, Math.ceil((Date.parse(presence.seen) + ACTIVE_MS - now) / 60000));
}

module.exports = { HEARTBEAT_MS, ACTIVE_MS, computerName, isSignedIn, minutesUntilStale };
