-- Fix uq_package_lesson_use to allow multiple null lesson_ids

drop index if exists public.uq_package_lesson_use;
create unique index if not exists uq_package_lesson_use
  on public.package_transactions (
    package_id,
    lesson_id,
    coalesce(lesson_date, '1970-01-01'::date),
    coalesce(lesson_start_minute, -1)
  )
  where type = 'lesson_use' and lesson_id is not null;
