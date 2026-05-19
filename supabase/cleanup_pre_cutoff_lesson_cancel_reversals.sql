-- Cleanup bad automatic +1 reversals created by app reconciliation before it
-- filtered historical transactions by credit_tracking_migrated_at.
--
-- Run the SELECT first. It should show only automatic lesson_cancel rows with
-- lesson_date before the credit cutoff and created after the recurring-chain
-- migration/test run. Historical legitimate cancellations before migration
-- must be preserved.

begin;

create temp table bad_pre_cutoff_lesson_cancel_reversals as
select pt.*
from public.package_transactions pt
cross join lateral (
  select (value #>> '{}')::date as cutoff_date
  from public.settings
  where key = 'credit_tracking_migrated_at'
) cutoff
cross join lateral (
  select coalesce(
    (select (value #>> '{}')::date from public.settings where key = 'recurring_chain_migrated_at'),
    cutoff.cutoff_date
  ) as recurring_migrated_date
) migration
where pt.type = 'lesson_cancel'
  and pt.amount = 1
  and pt.lesson_date < cutoff.cutoff_date
  and pt.created_at >= migration.recurring_migrated_date::timestamptz
  and pt.source_key like 'lesson_cancel|%'
  and pt.note = 'Reverse deduction for removed or cancelled lesson';

select
  pt.id,
  p.name as package_name,
  pt.lesson_id,
  pt.lesson_date,
  pt.lesson_start_minute,
  pt.amount,
  pt.note,
  pt.created_at,
  pt.source_key
from bad_pre_cutoff_lesson_cancel_reversals pt
left join public.packages p on p.id = pt.package_id
order by p.name, pt.lesson_date, pt.lesson_start_minute, pt.created_at;

-- Uncomment after reviewing the SELECT above.
-- delete from public.package_transactions pt
-- using bad_pre_cutoff_lesson_cancel_reversals bad
-- where pt.id = bad.id;

rollback;

-- After review, change rollback to commit and uncomment the DELETE.
