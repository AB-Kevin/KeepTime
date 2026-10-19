'use strict';

// Sending email over SMTP, as FormTracker does.

const nodemailer = require('nodemailer');

/** `smtp` is the shared settings' smtp with this computer's `password`. */
function createTransport(smtp) {
  const options = {
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: Boolean(smtp.secure),
    connectionTimeout: 30000,
  };
  // No username means a relay that trusts this computer's address instead of a
  // sign-in. Such relays can reject even an empty sign-in, so don't send one.
  if (smtp.user) options.auth = { user: smtp.user, pass: smtp.password };
  return nodemailer.createTransport(options);
}

async function sendMail(smtp, { to, subject, text, attachments }) {
  const address = smtp.fromEmail || smtp.user;
  const from = smtp.fromName ? { name: smtp.fromName, address } : address;
  return createTransport(smtp).sendMail({ from, to, subject, text, attachments });
}

module.exports = { sendMail };
