# HorseBook rebuild

A separate React/TypeScript/Vite app using the new Supabase PostgreSQL project.
The existing application's entry point and deployed website still use the old app.

## Current setup

- New project: `kdnhvunmtfqfkhcxtlqp`. Database migrations 001–015 are applied.
- Short-name login is restored: `ania` resolves to `aniafrankiewicz960@gmail.com`.
  `dawid` resolves to `dawid.fre@gmail.com` and uses that account's existing password.
  Its login details are saved locally in the ignored `private/ania-login.txt`.
  Email login also works. Aliases are case-insensitive and ignore surrounding spaces.
  For another existing Auth user, set `ADMIN_EMAIL`, `ADMIN_LOGIN_NAME`, and
  `ADMIN_DISPLAY_NAME` in the private environment file and run `npm run db:admin`.
- `dawid.fre@gmail.com` has explicit admin membership. Use its Supabase Auth
  password under **Ustawienia → Zaloguj jako administrator**.
- Imported 91 clients, 13 horses, and 5 instructors from the current old database.
  All 91 balances start at zero; no lessons, series, finances, or credit history
  were imported. Import operations are recorded in the new audit history.
- The original calendar styling, month/day navigation, lesson types, references,
  accounts, and finance screens were reused/rebuilt. The daily credit review is new.
  This is ready for workflow review; some smaller legacy conveniences such as
  reusable group presets have not been rebuilt.

Language switching is available to viewers and admins under **Settings → Language**
(**Ustawienia → Język**). Polish and English apply immediately without reloading
or clearing open forms. The choice is saved on this device and shared across tabs.
When no rebuild preference exists, the v1 language preference is reused; otherwise
Polish is the default. Existing v1 translations are reused where applicable, with
additional wording for the rebuild's credit review, events and backup features.
Dates and currency formatting follow the selected language; the schedule still uses
Warsaw time and PLN. Names, descriptions and historical records retain their saved text.

Run from this directory:

```powershell
npm ci
npm run dev -- --port 5176
```

Open `http://127.0.0.1:5176/`. This connects to the new project. Changes made after
logging in are real new-project changes. UI regression tests use a separate local
fixture database and never write to the live application tables.

`.env.local` is ignored. Public configuration is in `.env.example`. Database
passwords must never have a `VITE_` prefix or be committed. Scripts refuse to
connect to the legacy project. The Supabase publishable key is intended for the
browser; actual write permissions are checked in PostgreSQL for every request.

## How saves and credits work

New bookings start with **Tryb karnetu** off. Selecting a client turns it on only
if that client has a negative entry in their credit history (an approved lesson
charge or manual deduction), even if it was later refunded. Top-ups, pending
package lessons, and waived lessons do not qualify. This is a suggested default
for each participant, including group bookings; admins can override it. Existing
bookings retain their saved mode. Custom lessons always save as cash. Apply
`011_client_billing_default.sql` to expose this history-derived default.

The **Powielaj** switch is available on every lesson, including custom lessons.
For individual lessons it sits directly above **Tryb karnetu** and uses the same
switch styling. Enabling it reveals the typed week count on the same row. Its typed
week count defaults to 8: for a new lesson this is the total including the first;
for an existing lesson it is the number of additional weekly copies. Saving creates
independent lessons immediately, copying the current form details and resetting
attendance. There is no series relationship between them. The last created lesson
gets a stored `is_last_in_series` flag, showing an amber **Ostatnia jazda w serii**
notice only. This flag does not gate actions or affect billing, editing, movement,
cancellation, or deletion. Copying clears the source flag and marks the final new
lesson; moving or deleting lessons does not transfer the flag. Copies are atomic,
revision checked, retry safe, and leave balances unchanged. Apply the pending
migration `010_extend_series.sql` for this feature; it also detaches old series
occurrences while retaining their audit history and tagging their final lessons.

Each action sends a focused RPC: one lesson, event, reference, setting, finance record,
credit adjustment, or selected review batch. The whole operation commits in one
PostgreSQL transaction, including its audit records. A short transaction-level
writer lock serializes writes for this small application. Reads continue normally.

Every editable record has an integer revision. A stale edit fails with a conflict
instead of overwriting another admin's change. Operation IDs and the original
request/result are persisted server-side. The browser preserves request IDs for
unconfirmed writes, so retrying the same request after a lost response does not
repeat its effect. Failed saves keep the open draft. A success message requires
confirmation from the database.

Drag a lesson vertically to change its start time, snapping to 15-minute intervals.
On touch devices, hold for half a second before dragging; a quick vertical gesture
scrolls, and horizontal swipes change days. Cancelled lessons cannot be dragged.
The preview preserves neighboring tiles' positions until the database confirms.
A drag sends only the occurrence ID, expected revision and start minute to
`hb_move_lesson_time`; participants, removed bookings, notes and series templates
are preserved. The move and any necessary review invalidation are audited in the
same transaction. Credits are unchanged. Failed moves return the tile to its
confirmed position; repeating an unconfirmed move retries the same operation ID.

The creation sheet's title is a selector: **Nowa jazda** is the default;
**Nowe wydarzenie** adds a calendar event with start time, end time, and description.
Switching the selector replaces the form inside the same popup without replaying
the opening animation or moving focus away from the selector.
Times use 24-hour, 15-minute choices within the configured calendar hours.
Events have amber dashed tiles marked **Wydarzenie**, and overlapping lessons and
events use separate columns. Click to edit or delete, or drag with the same mouse
and touch gestures as lessons; moving an event preserves its duration. Events are
stored separately, never affect credits or reviews, and have transactional saves,
revision checks, retry protection, immutable audit history, and snapshot coverage.

The day view's **Przejrzyj kredyty** includes ended lessons through that date,
including earlier pending decisions. Each entry shows the actual lesson type.
Choose **Odejmij** / **Nie odejmuj** for each participant, then approve the selection.
An approved package lesson costs one credit per participant; the database rejects
higher unit amounts. Review entries preview balances before and after the decision.
For multiple selected lessons for one client, previews include preceding selected
decisions in queue order. Posted credit totals appear only for corrective reviews.
An admin can explicitly charge or waive cancelled lessons and no-shows.
Group participants are independent.
Negative balances are allowed. Cash bookings never consume package credits.

Historical date, start-time, and duration corrections retain approved credit
decisions. A time edit or drag requires a corrective review only when an ended
lesson is moved to an end time in the future, using Warsaw time. Cancellation,
attendance, billing, and participant changes still require correction after a
prior decision. Revisions still reject stale reviews. Existing correction flags
are retained because they may originate from these other changes.

Creating, editing, opening, cancelling, or deleting a lesson never changes a balance.
Billing-relevant edits after review reopen the decision. Corrections require a
reason; refunds append a credit reversal and retain the original charge and
decision. Adding package credits is an explicit admin action with a reason.

**Usuń lekcję** in the lesson editor removes an erroneous, unreviewed lesson and
all its bookings after confirmation. It disappears from both calendars and the
pending review queue. The complete deleted rows, administrator, timestamp, and
operation ID remain in immutable audit history and snapshots. Any recorded
decision (including a waiver or a removed participant's decision) blocks deletion
on the server. Use cancellation and corrective review for those lessons. Deleting
a recurring occurrence leaves the other occurrences unchanged. Revision conflicts
and retries use the same protections as other business operations.

Accounts store their current balances. Reads do not replay lesson history.
Immutable credit entries are the accounting record; decisions preserve the facts
that were reviewed. **Historia zmian** shows before/after records and actors.
**Sprawdź spójność sald** reports problems without modifying data.

## Manual device snapshots

V2 does not automatically save backups to a PC, browser storage, or any other destination.
After a successful credit review, a popup offers **Save snapshot to device** or **Skip**.
Only Save fetches and exports the complete application snapshot. Closing, skipping,
or cancelling the picker does not undo the applied credit review. Export failures
can be retried without applying the credit review again.

Where supported, the save picker suggests Documents and a timestamped JSON filename.
The popup suggests choosing a dedicated HorseBook Backups folder. The picker uses
a stable ID so supporting browsers can remember the user's last chosen location.
The app cannot create or force an arbitrary subfolder through a standard download.
Otherwise the browser handles a standard download using its own download settings;
the app cannot force a folder or guarantee that a location prompt is displayed.
The browser also offers **Pobierz kopię danych** in Settings.
A download notification means the download was prepared, not that disk storage was verified.
Snapshots include all application tables, balances, ledger entries, decisions,
operations, audit records, and schema metadata, with a SHA-256 checksum and table counts.
They are application snapshots, not pg_dump files. Browser storage is not used as a backup.

The former daily PC backup installer and scheduled runtime scripts have been removed.
A task installed earlier on another PC runs from its independent runtime and must
be removed on that PC. Run the following from rebuild on the previously configured PC:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/remove-local-backup.ps1
```

This stops and unregisters only the HorseBook daily snapshot task. Existing backup
files and private runtime credentials are retained. The migration defining the
restricted export role is retained as database history; it does not schedule backups.
Manual CLI snapshot creation and verification remain available for recovery work.

## Recovery rehearsal and restore

Verify any exported snapshot without touching a server:

```powershell
npm run backup:verify -- "C:\Users\dawid\Documents\HorseBook Backups\horsebook-TIMESTAMP.json"
```

This checks the SHA-256 checksum, restores every application table into a fresh
in-memory PGlite PostgreSQL database, verifies foreign keys and accounting
integrity, and compares the restored records. A modified file with a recomputed
checksum must still pass relational/accounting checks. A checksum detects
corruption; it is not proof of who created the file.

`npm run db:restore -- path/to/snapshot.json` is an owner-only tool that accepts
only a separate **empty local/test PostgreSQL database**, configured through
`RESTORE_DATABASE_URL`. Apply the SQL migrations there first and provide the local
`anon`, `authenticated`, and `auth.uid()` test equivalents (see the verification
script). The tool refuses hosted/production targets and nonempty app tables.
It restores in one transaction and checks integrity before commit.

For an actual production recovery, preserve the live state first and pause writes.
Rehearse the chosen snapshot, create an empty replacement Supabase project, apply
the matching migrations, and perform a reviewed owner restore there. The supplied
CLI deliberately does not overwrite the live project. Verify counts, balances,
audit history, and calendar before changing the app's project configuration.
Keep the displaced database for inspection. No restoration should merge an old
snapshot into the active application as an ordinary save.

Auth users, passwords, sessions, admin memberships, infrastructure configuration,
and database secrets are **excluded**. Recreate login users separately and grant
admin membership to their new Auth IDs; historical actor IDs/names remain in the
audit. Migrations rebuild functions, constraints, triggers, indexes, and permissions.
Keep this source repository and configuration recovery information separately.

## Validation and release

```powershell
npm test                     # 25 local PostgreSQL behavior checks
npm run test:ui              # 25 browser checks against local fixtures
npm run build               # TypeScript + production build
$env:HB_REAL_POSTGRES='true'
npm test                     # isolated schemas on the configured NEW project
npm run test:concurrency     # two real independent PostgreSQL sessions
```

Database checks cover atomic rollback, duplicate requests, concurrent/stale
decisions, negative balances, cancellations, removed participants, recurring
generation across DST, private data access, immutable history, shared settings,
audited deletion, and snapshot restoration. Browser checks cover charge/waive review, corrective
refund, a lost response after commit, full snapshot download/audit inspection,
audited deletion after a lost response, and preventing a refreshed dirty form from overwriting another admin's save.
The daily calendar checks compare geometry and styling directly with the original
rendering at mobile and desktop widths, and verify the moving clock line, status
toggle, month navigation, instructor focus, and the review icon beside the day
status toggle. Its pending count includes earlier unresolved reviews through the
selected date, uses the same database eligibility query as the review panel, and
refreshes after saves and every 30 seconds. Counts above 99 display as `99+`, with
the full count in the tooltip. An unavailable count is shown as an error state.
The lesson editor restores the original time/duration row, instructor field,
package and repeat switches, compact group/custom participant rows, and icon
footer. Client selectors retain stable database identities. The editor contains
only the main controls; existing values for fields removed from the interface
remain in the lesson draft and save. The **Przenieś** dialog changes date/time
using the same transactional lesson save.
Editor geometry is compared with the original modal for all three lesson types
at mobile and desktop widths, and custom billing/move values are checked on save.
All popups share the original pull-down handle gesture: pulls above 100 pixels
close with the existing slide-down animation, and shorter pulls snap back. Saving
blocks dismissal. Daily-calendar horizontal swipes above 50 pixels move to the
next day (left) or previous day (right), including swipes over lesson tiles.
Mouse and native touch checks cover these gestures, normal tile taps, vertical
scrolling, short drags, and dismissal while a save is pending. Lesson dragging
checks cover snapping, scroll/swipe separation, rejected moves, drag cancellation,
visible bounds, and a lost committed response retried without duplicate audit rows.
The separate `rebuild-checks.yml` CI workflow repeats local behavior tests, the
build, and browser tests; it does not deploy or require database owner secrets.

Before replacing the public site, review the new app with the real admin login.
Then build/deploy `rebuild/dist` using the new **public** project configuration.
The existing deployment workflow still targets the original app. Database-owner
and backup credentials do not belong in frontend deployment configuration.

Design record: `../docs/rebuild-plan.md`. Backend reference:
[Supabase PostgreSQL roles](https://supabase.com/docs/guides/database/postgres/roles).

Client records support an optional phone number in Add/Edit Client. Saved numbers
appear in the client list and are included in snapshots. Apply
`014_client_phone_number.sql` before using this field.
