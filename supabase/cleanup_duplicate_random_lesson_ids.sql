-- Cleanup random duplicate lesson IDs created by app versions that rejected
-- deterministic migration UUIDs and regenerated lesson IDs during sync.
--
-- Run as-is first. It SELECTs candidates and rolls back.
-- If the candidates are correct, uncomment DELETE and change rollback to commit.

begin;

create temp table duplicate_random_lesson_id_candidates as
with duplicate_groups as (
  select
    date,
    start_minute,
    duration_minutes,
    lesson_type,
    title,
    horse_name,
    instructor_name,
    package_mode,
    participants,
    cancelled_dates
  from public.lessons
  group by date, start_minute, duration_minutes, lesson_type, title, horse_name, instructor_name, package_mode, participants, cancelled_dates
  having count(*) > 1
),
ranked as (
  select
    l.*,
    count(pt.id) as transaction_ref_count,
    row_number() over (
      partition by l.date, l.start_minute, l.duration_minutes, l.lesson_type, l.title, l.horse_name, l.instructor_name, l.package_mode, l.participants, l.cancelled_dates
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
   and l.package_mode = g.package_mode
   and l.participants = g.participants
   and l.cancelled_dates = g.cancelled_dates
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
  recurring,
  recurring_parent_id,
  package_mode,
  participants,
  cancelled_dates,
  created_at,
  updated_at,
  transaction_ref_count,
  keep_rank,
  case when keep_rank = 1 then 'keep' else 'delete' end as action
from ranked;

select *
from duplicate_random_lesson_id_candidates
order by date, start_minute, title, action desc, created_at;

-- delete from public.lessons l
-- using duplicate_random_lesson_id_candidates c
-- where l.id = c.id
--   and c.action = 'delete'
--   and c.transaction_ref_count = 0;

rollback;

-- After review, change rollback to commit and uncomment the DELETE.
