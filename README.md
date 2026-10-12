# Contractor Time (desktop)

A Windows desktop app for remote contractors to log time and create invoices. Its data is kept in a shared OneDrive folder.

- **Contractors** start and stop a timer, choose a task from a list or describe the work in their own words, and correct their own time. They create invoices from their completed time and print them or save them as PDFs.
- **Managers** see who's signed in and whose timer is running. They manage people, hourly rates, PINs, the task list and invoice templates, and they can view, print or save any contractor's invoice.

Sign-in is a name picked from a list plus a 4–8 digit PIN.

## Setting it up

1. Make a folder in OneDrive or SharePoint, for example `Contractor Time`. Share it with every manager and contractor, with edit access.
2. Everyone syncs it to their computer. For a OneDrive folder shared with you, use **Add shortcut to My files**; for a SharePoint library, use **Sync**. Then right-click the folder and choose **Always keep on this device**.
3. Install and open the app. Choose the synced folder.
4. The first person to open an empty folder sets it up and becomes the first manager. Then they add people (Manage › People), tasks (Manage › Tasks), and check the invoice template's bill-to address (Manage › Invoice templates).

Each computer chooses the folder only once. People added on one computer can sign in elsewhere after OneDrive has synced, usually within a minute.

## How the data is stored

OneDrive can't merge two computers' changes to one file. When that happens it keeps both copies, as `entries-LAPTOP.json`. To avoid that, every file has exactly one kind of writer:

| File | Written by |
| --- | --- |
| `shared/people.json` | managers: names, roles, rates, PINs they set |
| `shared/tasks.json` | managers |
| `shared/templates.json` | managers |
| `shared/settings.json` | managers |
| `people/<id>/entries.json` | that person: their time, with a history of edits |
| `people/<id>/invoices.json` | that person: each invoice with a copy of everything printed on it |
| `people/<id>/profile.json` | that person: their invoice details and any PIN they chose |
| `people/<id>/presence.json` | that person's app, every minute while signed in |

Related rules:

- A person can be signed in on only one computer at a time.
- A manager's save re-reads the shared file and changes only the record being saved.
- If OneDrive does keep a conflict copy, **Who's signed in** lists it so someone can sort it out.
- Issued invoices keep their own copy of the template, rate and contractor details, so they print the same later.

Because each person's files are written only by that person, managers can see contractors' time but can't change it. Contractors also void their own invoices; the reason is recorded and managers see it.

## Limits worth knowing

- **The PIN is not security.** Anyone with access to the OneDrive folder can open and change the files directly. The PIN keeps people out of each other's time in the app, nothing more. If that isn't acceptable, the data needs a server, as in the ASP.NET version in `../timetrack`.
- **"Who's signed in" lags by OneDrive's sync time**, usually under a minute or two. Someone whose computer went to sleep counts as signed out three minutes later.
- **Times are shown in each computer's own time zone.**

## Development

```
npm install
npm start      # run the app
npm test       # unit tests for the time, invoice, PIN and storage rules
npm run dist   # build the Windows installer into dist/
```

Set `CONTRACTOR_TIME_PROFILE` to a folder to run with settings kept apart from this computer's real ones.

### Releasing

Pushing a version tag builds the Windows installer on GitHub and publishes it as a release (`.github/workflows/release.yml`). Once your changes are committed:

```
npm version patch       # or minor / major: runs the tests, bumps the version, commits, and tags vX.Y.Z
git push --follow-tags  # or run `git config push.followTags true` once, then plain `git push`
```

The release appears on the repository's **Releases** page a few minutes later as `ContractorTime-Setup-X.Y.Z.exe`, with a `latest.yml` beside it and notes listing the changes since the previous release. Follow the build under the **Actions** tab. The build stops without publishing if the tag doesn't match the version in package.json or a test fails.

- `latest.yml` lists the installer's version, size and SHA-512 digest. AB Apps reads it from the latest release to install and update this app. electron-builder writes it because package.json's `build.publish` names this repository. Keep the tag as `vX.Y.Z` and leave `artifactName` as it is.
- The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time it runs. Choose **More info**, then **Run anyway**.

| Path | What's there |
| --- | --- |
| `src/main/main.js` | windows, sign-in, and the handlers the window calls; checks roles |
| `src/main/time.js` | timer and time-entry rules: overlaps, 24-hour limit, edit window, edit history |
| `src/main/invoices.js` | invoice lines, totals, numbering, voiding, templates |
| `src/main/invoice-html.js` | the printed invoice (also used for PDFs and the template preview) |
| `src/main/store.js` | data folder layout and file access |
| `src/main/auth.js`, `manage.js`, `presence.js` | PINs and lockout; people, task and settings rules; who's signed in |
| `src/renderer/` | the window: `app.js` and `styles.css` (Anabaptist Brotherhood brand tokens, light and dark) |
