# KeepTime (desktop)

A Windows desktop app for remote contractors to log time and create invoices. Its data is kept in a shared OneDrive folder. It used to be called Contractor Time.

- **Contractors** start and stop a timer, choose a task from a list or describe the work in their own words, and correct their own time. They set their own hourly rate and choose their invoice template, create invoices from their completed time, and print them or save them as PDFs. They can also add and change tasks and invoice templates, which everyone shares, except the default template.
- **Managers** see who's signed in and whose timer is running. They can also set anyone's hourly rate and invoice template. Only managers change the default template, which new contractors use. They can view, print or save any contractor's invoice. They can have employees' and managers' timesheets emailed every week, two weeks or four (see [Timesheet email](#timesheet-email)).

There is no separate sign-in: KeepTime uses whoever is signed in to [AB Apps](https://github.com/AB-Kevin/ab-apps), and follows along when someone signs in or out there. People are added, renamed and turned off in AB Apps. Managers in AB Apps are managers here. Everyone logs time unless a manager sets them not to, on Manage › People.

## Setting it up

1. Set up AB Apps, and add everyone there. Then make a folder in OneDrive or SharePoint, for example `KeepTime`. Share it with every manager and contractor, with edit access.
2. Everyone syncs it to their computer. For a OneDrive folder shared with you, use **Add shortcut to My files**; for a SharePoint library, use **Sync**. Then right-click the folder and choose **Always keep on this device**.
3. Install and open the app. Choose the synced folder.
4. A manager opens the empty folder first and sets it up. Then they add tasks (Shared › Tasks) and check the invoice template's bill-to address (Shared › Invoice templates). Contractors set their own hourly rates on their Profile, or a manager can on Manage › People. A contractor can log time before their rate is set, but can't create invoices until it is.
5. To have timesheets emailed, a manager fills in **Timesheet email** on Settings and sends a test.

Each computer chooses the folder only once.

### Moving from the old sign-in

Before version 0.2, this app kept its own people and PINs. AB Apps 0.1.0 to 0.1.2 moved them across with **Import from Contractor Time** on the People page, keeping everyone's id so their time and invoices stayed theirs. AB Apps 0.1.3 removed that import once the move was done. Someone added on AB Apps' People page now gets a new id, so a folder from before 0.2 that was never imported doesn't link to them: import it with AB Apps 0.1.2 first. Rates, templates and invoice numbers stay in this folder.

## How the data is stored

OneDrive can't merge two computers' changes to one file. When that happens it keeps both copies, as `entries-LAPTOP.json`. To avoid that, each person's own files are written only by them, and a save to a shared file changes only one record:

| File | Written by |
| --- | --- |
| `shared/people.json` | managers: for each person (by their AB Apps id), whether they log time, the hourly rate and invoice template a manager set for them, and their invoice number |
| `shared/tasks.json` | managers and anyone who logs time |
| `shared/templates.json` | managers and anyone who logs time; only managers change the default template |
| `shared/settings.json` | managers: the time rules, the default template, and the timesheet email's schedule, recipients and mail server (not its password) |
| `people/<id>/entries.json` | that person: their time, with a history of edits |
| `people/<id>/invoices.json` | that person: each invoice with a copy of everything printed on it |
| `people/<id>/profile.json` | that person: their invoice details, and the hourly rate and invoice template they set for themselves (if a manager also set one, the later change is used) |
| `people/<id>/presence.json` | that person's app, every minute while signed in |
| `people/<id>/timesheets.json` | a manager's app: the timesheet emails it sent, and its last problem sending one |

Related rules:

- A person can be signed in on only one computer at a time.
- A save to a shared file re-reads it and changes only the record being saved. Two people saving the same shared file within OneDrive's sync time can still leave a conflict copy. That's more likely for tasks and templates, since anyone who logs time can change them.
- If OneDrive does keep a conflict copy, **Who's signed in** lists it so someone can sort it out.
- Issued invoices keep their own copy of the template, rate and contractor details, so they print the same later.

Because each person's files are written only by that person, managers can see contractors' time but can't change it. Contractors also void their own invoices; the reason is recorded and managers see it.

## Timesheet email

On a schedule, KeepTime emails a CSV file of each employee's and manager's time to the addresses on Settings › Timesheet email. Contractors aren't included, since they invoice. Each file is named for the period and person, such as `2026-10-05 to 2026-10-18 - Ann Miller.csv`. It has a row per completed entry (date, start, end, hours, task, description) and a total. The email lists everyone's hours, names anyone who logged no time, and notes timers still running, which aren't included until they're stopped.

- **The period** is the week, two weeks or four weeks before the day it's sent, through the day before. Sent on a Monday, it covers through the Sunday just past. Setting the first send date lines it up with your pay periods.
- **Who sends it:** KeepTime has no server, so any manager's KeepTime sends it, if it's open at the time, or as soon as one is opened afterward. Each manager's app records what it sent in their own folder, and the others skip a period someone has sent. Managers' apps wait their turn, ten minutes apart, so the first one's record has time to sync. If OneDrive is slower than that, two copies can still go out. If the apps were closed through several sends, only the latest period is sent.
- **The mail server** is any SMTP server, as in FormTracker. Its settings are shared, but **its password is kept on each computer**, encrypted for that Windows account, because everyone who logs time can read the shared folder. Each manager whose KeepTime should send enters it once on their own computer. Leave the username blank for a relay that accepts mail without signing in.
- **Microsoft 365:** `smtp.office365.com`, port 587, works only while the account is allowed to use SMTP AUTH with a password. Microsoft plans to turn that off for existing tenants at the end of December 2026, though an admin can turn it back on until a final retirement date Microsoft hasn't set yet. A Gmail account with an app password, or a sending service such as SMTP2GO, avoids that.
- If sending fails, Settings shows why, and KeepTime tries again every 15 minutes. **Save and send a test** sends the latest period to the test address only.

## Limits worth knowing

- **Signing in is not security.** Anyone with access to the OneDrive folders can open and change the files directly, and anyone using a Windows account can change who AB Apps says is signed in. Sign-in keeps people out of each other's time in the app, nothing more. If that isn't acceptable, the data needs a server, as in the ASP.NET version in `../timetrack`.
- **"Who's signed in" lags by OneDrive's sync time**, usually under a minute or two. Someone whose computer went to sleep counts as signed out three minutes later.
- **Times are shown in each computer's own time zone.**

## Development

```
npm install
npm start      # run the app
npm test       # unit tests for the time, invoice, people and storage rules
npm run dist   # build the Windows installer into dist/
```

Set `KEEPTIME_PROFILE` to a folder to run with settings kept apart from this computer's real ones, and `AB_APPS_PROFILE` to the folder holding a test `identity.json` (AB Apps uses the same variable for its own settings, so running both with it set ties them together).

### Releasing

Pushing a version tag builds the Windows installer on GitHub and publishes it as a release (`.github/workflows/release.yml`). Once your changes are committed:

```
npm version patch       # or minor / major: runs the tests, bumps the version, commits, and tags vX.Y.Z
git push --follow-tags  # or run `git config push.followTags true` once, then plain `git push`
```

The release appears on the repository's **Releases** page a few minutes later as `KeepTime-Setup-X.Y.Z.exe`, with a `latest.yml` beside it and notes listing the changes since the previous release. Follow the build under the **Actions** tab. The build stops without publishing if the tag doesn't match the version in package.json or a test fails.

- `latest.yml` lists the installer's version, size and SHA-512 digest. electron-builder writes it because package.json's `build.publish` names this repository. Keep the tag as `vX.Y.Z` and leave `artifactName` as it is.
- The app reads `latest.yml` from the latest release (`src/main/updates.js`) when it opens and when someone chooses **Check for updates** (Settings for managers, Profile for everyone else). A waiting update shows as **Update available** in the header. **Download and install** checks the installer against the digest, asks, then closes the app and installs over it, keeping the install folder and shortcuts. It uses the release's download link, not the GitHub API, so many computers on one network can check without hitting GitHub's limit. AB Apps reads the same file. Downloads and installs only run in the installed app, not under `npm start`.
- The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time it runs. Choose **More info**, then **Run anyway**.

| Path | What's there |
| --- | --- |
| `src/main/main.js` | windows, sign-in, and the handlers the window calls; checks roles |
| `src/main/time.js` | timer and time-entry rules: overlaps, 24-hour limit, edit window, edit history |
| `src/main/invoices.js` | invoice lines, totals, numbering, voiding, templates |
| `src/main/invoice-html.js` | the printed invoice (also used for PDFs and the template preview) |
| `src/main/store.js` | data folder layout and file access |
| `src/main/abapps.js` | reading who is signed in to AB Apps, and its list of people |
| `src/main/timesheets.js`, `mailer.js` | the timesheet email: schedule, who's included, the CSV files; sending over SMTP |
| `src/main/manage.js`, `presence.js` | people, task and settings rules; who's signed in |
| `src/main/updates.js` | checking GitHub for a newer release and downloading its installer |
| `.github/workflows/release.yml` | builds and publishes a release when a version tag is pushed |
| `src/renderer/` | the window: `app.js` and `styles.css` (Anabaptist Brotherhood brand tokens, light and dark) |
