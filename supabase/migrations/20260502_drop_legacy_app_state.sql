-- Drop the legacy app_state table that is no longer used.
-- This ensures that any old cached web clients attempting to read from it
-- will get an error rather than silently displaying stale data.
drop table if exists public.app_state;
