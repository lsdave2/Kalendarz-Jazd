-- Cleanup for duplicate lessons inserted by a stale client cache after the
-- recurring-chain migration.
--
-- Review the SELECT output first. Run the DELETE only when the rows marked
-- delete are exactly the random UUID rows created by the client after the
-- migration, and not legitimate separately-booked lessons.

begin;

create temp table duplicate_lesson_cleanup_candidates as
with duplicate_groups as (
  select
    date,
    start_minute,
    duration_minutes,
    lesson_type,
    title,
    horse_name,
    instructor_name,
    participants
  from public.lessons
  group by date, start_minute, duration_minutes, lesson_type, title, horse_name, instructor_name, participants
  having count(*) > 1
),
ranked as (
  select
    l.*,
    count(pt.id) as transaction_ref_count,
    row_number() over (
      partition by l.date, l.start_minute, l.duration_minutes, l.lesson_type, l.title, l.horse_name, l.instructor_name, l.participants
      order by
        count(pt.id) desc,
        l.created_at asc,
        l.id asc
    ) as keep_rank
  from public.lessons l
  join duplicate_groups g
    on l.date = g.date
   and l.start_minute = g.start_minute
   and l.duration_minutes = g.duration_minutes
   and l.lesson_type = g.lesson_type
   and l.title = g.title
   and l.horse_name is not distinct from g.horse_name
   and l.instructor_name is not distinct from g.instructor_name
   and l.participants = g.participants
  left join public.package_transactions pt
    on pt.lesson_id = l.id
  group by l.id
)
select
  id,
  date,
  start_minute,
  duration_minutes,
  lesson_type,
  title,
  horse_name,
  instructor_name,
  participants,
  recurring,
  recurring_parent_id,
  cancelled_dates,
  created_at,
  updated_at,
  transaction_ref_count,
  keep_rank,
  case when keep_rank = 1 then 'keep' else 'delete' end as action
from ranked;

select *
from duplicate_lesson_cleanup_candidates
order by date, start_minute, title, action desc, created_at;

-- Uncomment after reviewing the SELECT above.
-- delete from public.lessons l
-- using duplicate_lesson_cleanup_candidates c
-- where l.id = c.id
--   and c.action = 'delete'
--   and c.transaction_ref_count = 0;

rollback;

-- After review, change rollback to commit and uncomment the DELETE.
