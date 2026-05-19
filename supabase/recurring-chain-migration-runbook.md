# Recurring Chain Migration Runbook

This migration is intentionally not run by the app. Apply it once in Supabase before deploying the app version that removes virtual recurring occurrences.

## Test First

1. Back up production tables, at minimum `lessons`, `packages`, `package_transactions`, and `settings`.
2. Restore or sync production data into the test Supabase project.
3. Apply `supabase/migrations/20260514_recurring_lesson_chain.sql` if it has not already been applied.
4. Review the cutoff in `supabase/migrations/20260515_migrate_recurring_series_to_chains.sql`.
   The default is `current_date`. Change the temp-table value if test needs to simulate a specific production cutover date.
5. Run `supabase/migrations/20260515_migrate_recurring_series_to_chains.sql` against test.
6. Run these checks:

```sql
select count(*) as old_virtual_series
from public.lessons
where recurring_until is not null
   or instance_overrides <> '{}'::jsonb;

select recurring_parent_id, count(*)
from public.lessons
where recurring_parent_id is not null
group by recurring_parent_id
having count(*) > 1;

select type, count(*)
from public.package_transactions
group by type
order by type;
```

Expected:

- `old_virtual_series` is `0`.
- The duplicate-child query returns no rows.
- `package_transactions` counts do not change because the recurring migration does not backfill credit rows.

## App Verification

1. Point the app at the test project and load the calendar.
2. Confirm past recurring occurrences appear as concrete non-repeating lessons.
3. Confirm the first future occurrence in each old series is a concrete lesson with `Repeat weekly` enabled.
4. Create a new repeating lesson and confirm exactly one next-week lesson appears.
5. Edit a repeating lesson and confirm only that lesson and its direct next-week child change.
6. Turn off `Repeat weekly` on a lesson and confirm its direct generated child is removed or no longer generated.
7. Delete a generated child and confirm its `recurring_parent_id` parent has `recurring = false`.
8. Cancel one lesson and confirm only that lesson is cancelled and the next-week child is not cancelled.
9. Let `processPastLessonsForCredits()` run through normal app load and confirm only post-cutoff completed lessons get automatic package reconciliation.

## Production

1. Put the app in a short maintenance window so users do not edit lessons during migration.
2. Back up production.
3. Apply `20260514_recurring_lesson_chain.sql`.
4. Apply `20260515_migrate_recurring_series_to_chains.sql` with the intended cutoff date.
5. Run the SQL checks from the test section.
6. Deploy the app code that uses concrete recurring chains.
7. Smoke test create, edit, delete, cancel, and package credit display in production.

Rollback is restoring the pre-migration backup. Do not attempt to recreate virtual `instance_overrides` from migrated concrete lessons.
