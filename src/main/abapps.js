'use strict';

// Sign-in comes from AB Apps. People sign in once there, and AB Apps keeps
// who is signed in on this computer in this Windows account's AppData:
//
//   %APPDATA%\AB Apps\identity.json
//   { "version": 1, "personId", "name", "class", "signedInAt", "dataDir" }
//
// The file exists only while someone is signed in. `dataDir` is the shared AB
// Apps folder, whose shared/people.json lists everyone: their names, classes
// (manager, employee or contractor) and whether they can sign in. Contractor
// Time reads that list rather than keeping its own, and keeps only what's
// particular to it (hourly rates, templates, invoice numbers) in its own
// folder, under the same person ids.
//
// Like the PIN AB Apps asks for, this is a convenience and not a security
// boundary: anyone with access to the shared folders can change the files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { readJson } = require('./jsonfile');

const CLASSES = ['manager', 'employee', 'contractor'];
const AB_APPS_APP_ID = 'org.anabaptistbrotherhood.abapps';
// electron-builder's namespace for the registry GUIDs it makes from appIds.
const BUILDER_NAMESPACE = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

/** AB Apps' folder in AppData, or AB_APPS_PROFILE, which AB Apps also honors, for test runs. */
const identityDir = (appDataDir) => process.env.AB_APPS_PROFILE || path.join(appDataDir, 'AB Apps');
const identityPath = (appDataDir) => path.join(identityDir(appDataDir), 'identity.json');

/** Who is signed in to AB Apps: { personId, name, class, signedInAt, dataDir }, or null. */
function readIdentity(appDataDir) {
  let identity;
  try {
    identity = readJson(identityPath(appDataDir), null);
  } catch {
    return null; // mid-write, or damaged: the same as signed out until AB Apps writes it again
  }
  if (identity?.version !== 1) return null;
  const { personId, name, class: personClass, signedInAt, dataDir } = identity;
  if (!/^[0-9a-f-]{36}$/i.test(personId ?? '') || typeof name !== 'string' || !name.trim()) return null;
  if (!CLASSES.includes(personClass) || typeof dataDir !== 'string' || !dataDir) return null;
  return { personId, name: name.trim(), class: personClass, signedInAt: signedInAt ?? null, dataDir };
}

/** Everyone in the AB Apps folder, as { id, name, class, active }. Throws if the folder can't be read. */
function readDirectory(dataDir) {
  const file = path.join(dataDir, 'shared', 'people.json');
  if (!fs.existsSync(file)) throw new Error(`The AB Apps folder ${dataDir} can't be found. If OneDrive is still setting up, wait for it to finish.`);
  return readJson(file, { people: [] }).people
    .filter((p) => /^[0-9a-f-]{36}$/i.test(p?.id ?? '') && typeof p.name === 'string')
    .map((p) => ({ id: p.id, name: p.name, class: CLASSES.includes(p.class) ? p.class : 'contractor', active: Boolean(p.active) }));
}

function appGuid(appId) {
  const namespace = Buffer.from(BUILDER_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([namespace, Buffer.from(appId, 'utf8')])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Where AB Apps is installed on this computer, from the registry, or null. */
async function findABApps() {
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appGuid(AB_APPS_APP_ID)}`;
  for (const hive of ['HKCU', 'HKLM']) {
    const output = await new Promise((resolve) => {
      execFile('reg', ['query', `${hive}\\${key}`, '/v', 'UninstallString'], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
    });
    const uninstaller = /UninstallString\s+REG_\w+\s+"([^"]+)"/.exec(output)?.[1];
    const exe = uninstaller && path.join(path.dirname(uninstaller), 'AB Apps.exe');
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

function openABApps(exe) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

module.exports = { CLASSES, identityPath, readIdentity, readDirectory, appGuid, findABApps, openABApps };
