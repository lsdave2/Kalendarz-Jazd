alter table public.lessons
  add column if not exists recurring_parent_id uuid references public.lessons(id) on delete set null;

create index if not exists lessons_recurring_parent_id_idx
  on public.lessons(recurring_parent_id);

create unique index if not exists lessons_one_recurring_child_per_parent_idx
  on public.lessons(recurring_parent_id)
  where recurring_parent_id is not null;
