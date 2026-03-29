-- Create the table
create table app_state (
  id integer primary key,
  state jsonb not null
);

-- Insert the default state into row ID 1
insert into app_state (id, state) values (1, '{}');

-- Enable Row Level Security (RLS)
alter table app_state enable row level security;

-- Create policy for anyone to read (SELECT) the state
create policy "Anyone can read app_state"
on app_state for select
to public
using ( true );

-- Create policy for only AUTHENTICATED users to update the state
create policy "Only authenticated users can update app_state"
on app_state for update
to authenticated
using ( true );

-- (Optional) Policy to allow inserting just in case row 1 gets deleted
create policy "Only authenticated users can insert app_state"
on app_state for insert
to authenticated
with check ( true );

-- Enable Realtime for the table so connected clients get pushed updates instantly
alter publication supabase_realtime add table app_state;
