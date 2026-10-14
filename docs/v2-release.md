# HorseBook v2 release preparation

Prepared on 13 October 2026. Publishing remains a separate step.

Validation: 32 database tests passed and the production build passed. The full
browser run passed 36 of 37 checks; the remaining stale-settings check referenced
a removed refresh button. It was updated to trigger the existing window-focus
refresh and passed on a focused rerun. Browser checks used isolated local
fixtures on alternate ports because the default test port was already occupied.
The live v2 database's post-reset integrity and anonymous-access checks passed.

## Site and database

Keep the existing `lsdave2/Kalendarz-Jazd` repository, GitHub Pages site, and
Pages domain settings. Publish the contents of `rebuild/dist` as the site's root
artifact, not as a `/rebuild/` subdirectory. This replaces v1 at the same URL.
Vite's relative asset base supports the existing repository URL.

The prepared `.github/workflows/deploy.yml` uses Node 22, the rebuild lockfile,
database behavior tests, browser tests, and the v2 build. It uploads only
`rebuild/dist`. Browser configuration explicitly targets v2's Supabase project
`kdnhvunmtfqfkhcxtlqp`; the legacy deployment secrets are not reused. Database
owner credentials and backup files must never be published.

## Completed test-data reset

The owner requested zero starting credit balances and removal of all v2 test
lessons, calendar events, finance records, and credit activity.

Before the reset, the database had 10 lessons, 12 bookings, 5 review decisions,
2 credit entries, 1 event, no finance records, and 2 nonzero balances.
All of these activity tables are now empty; all 91 accounts have balance zero.
Clients, horses, instructors, settings, Auth users, admin memberships, and login
aliases were preserved. Historical audit records and operation receipts remain;
a prelaunch reset receipt records the cleanup and backup checksum. The original
test credit ledger is available in the private backup, not the active ledger.

The backup is `rebuild/private/backups/prelaunch-2026-10-13T07-37-06-882Z.json`.
It passed checksum, full local restore, relational and balance checks before the
reset committed. This private directory is ignored by Git. The legacy database
was not reset. Refresh all open v2 tabs before creating new records; additional
testing should use local fixtures rather than the cleaned launch database.

The reset tool defaults to a read-only preview:

```powershell
cd rebuild
node scripts/prepare-release.mjs
```

The explicit apply command is destructive and was already executed for this
prelaunch cleanup; do not rerun after real bookings or credits begin. It guards
the new project, holds the application writer lock, creates and rehearses a
snapshot, verifies the snapshot is current, clears only the named activity
tables without cascading, resets accounts, records the reset, and checks
preserved references and accounting integrity in one transaction.

## Before publishing

Instructor payments now require migration `015_instructor_rates.sql` (after
`014_client_phone_number.sql`). Apply pending migrations before publishing the
updated frontend. Each instructor has a single hourly lesson rate in
their Settings editor, using one flat hourly lesson rate for every lesson type.
Existing and new instructors default to 60 PLN/hour. Finances pays each assigned
instructor once per eligible group lesson, prorated by duration, and reports group
hours rather than participant counts.
The shared finance rate settings now contain only revenue rates.

Validation for this change: all 36 database tests, the production build, and the
focused finance and instructor-rate browser checks passed against isolated local
fixtures. Migration 015 is applied to the live v2 database. A save and reference reload
with a non-default instructor rate passed in a rolled-back transaction; live
accounting integrity passed. Frontend publication remains pending.

1. Verify the final source includes any parallel admin-login changes, and that
   database migrations match the app. Database status is currently version 15.
2. Confirm the local/database tests, production build, and browser checks pass.
3. Review v2 with the real admin login without adding development test data.
4. Save the current v1 source/deployment revision and preserve its database as
   the rollback target. The existing v1 workflow is still live on GitHub.
5. Sync the reviewed source and prepared workflow to the existing repository.
   This folder's `.git` file points to a checkout on another computer; use a
   valid checkout or verified GitHub API changes rather than that broken path.
6. Publish the reviewed release on `main`. This triggers the existing site's
   Pages deployment; do not create a second Pages repository or change domains.
7. Check the existing URL on desktop and mobile: v2 loads, calendar is empty,
   clients/references are present, anonymous access behaves correctly, and admin
   login works. Check saving with an intended real booking or use a separate
   test environment, rather than adding test records to the clean launch DB.

## Rollback

Restore the recorded v1 deployment/source and its original workflow, then
redeploy through the same GitHub Pages site. A frontend rollback does not merge
or undo database changes. Any real v2 activity after launch needs preservation
and reconciliation before switching people back to the separate v1 database.
Use the private snapshot and rehearsed owner recovery procedure for database
recovery; the ordinary restore CLI intentionally refuses hosted production.
