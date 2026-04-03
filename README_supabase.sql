-- 1. First, clear the old policies
drop policy if exists "Only authenticated users can update app_state" on app_state;
drop policy if exists "Only authenticated users can insert app_state" on app_state;
drop policy if exists "Anyone can read app_state" on app_state;

-- 2. Create a unified policy for All operations (Reading, Inserting, Updating)
-- This ensures authenticated users have full control over the state row.
create policy "Authenticated users have full access"
on app_state
for all
to authenticated
using (true)
with check (true);

-- 3. Allow public (unlogged users) to still Read the calendar
create policy "Public can read state"
on app_state
for select
to public
using (true);
