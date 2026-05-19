-- Review and optionally remove automatic lesson_use rows that were backfilled
-- for lessons on or before the recurring-chain migration date.
--
-- This is intentionally narrow:
-- - only automatic lesson_use deductions
-- - only rows created after the recurring migration marker
-- - only lessons dated on/before the recurring migration date
-- - only rows whose lesson still exists and confirms that lesson date
--
-- Run the SELECT first. Only change `rollback;` to `commit;` after review.

begin;

with settings_cutoff as (
  select (value #>> '{}')::date as migrated_on
  from public.settings
  where key = 'recurring_chain_migrated_at'
),
suspect_transactions as (
  select
    pt.id,
    pt.package_id,
    p.name as package_name,
    pt.lesson_id,
    l.date as lesson_date,
    l.start_minute,
    l.title,
    pt.created_at,
    pt.type,
    pt.amount,
    pt.note,
    pt.source_key
  from public.package_transactions pt
  join settings_cutoff sc on true
  join public.lessons l on l.id = pt.lesson_id
  left join public.packages p on p.id = pt.package_id
  where pt.type = 'lesson_use'
    and pt.amount = -1
    and pt.created_at >= sc.migrated_on::timestamptz
    and l.date <= sc.migrated_on
    and coalesce(pt.source_key, '') like 'lesson_use|%'
    and coalesce(pt.note, '') ilike 'Automatic deduction for completed lesson%'
)
select *
from suspect_transactions
order by lesson_date, start_minute, package_name, id;

-- Uncomment only after reviewing the rows above.
-- with settings_cutoff as (
--   select (value #>> '{}')::date as migrated_on
--   from public.settings
--   where key = 'recurring_chain_migrated_at'
-- ),
-- suspect_transactions as (
--   select pt.id
--   from public.package_transactions pt
--   join settings_cutoff sc on true
--   join public.lessons l on l.id = pt.lesson_id
--   where pt.type = 'lesson_use'
--     and pt.amount = -1
--     and pt.created_at >= sc.migrated_on::timestamptz
--     and l.date <= sc.migrated_on
--     and coalesce(pt.source_key, '') like 'lesson_use|%'
--     and coalesce(pt.note, '') ilike 'Automatic deduction for completed lesson%'
-- )
-- delete from public.package_transactions pt
-- using suspect_transactions st
-- where pt.id = st.id;

rollback;
