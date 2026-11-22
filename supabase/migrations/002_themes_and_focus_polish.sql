-- DayFlow Phase 2: Multi-Theme System & Focus Reflection
-- Safe, idempotent migration script for Supabase PostgreSQL.
-- Review and run this script in your Supabase Dashboard -> SQL Editor.

-- 1. Migrate legacy theme values ('light' -> 'paper', 'dark' -> 'midnight')
update public.user_preferences
set theme = case
  when theme = 'light' then 'paper'
  when theme = 'dark' then 'midnight'
  else theme
end
where theme in ('light', 'dark');

-- Update check constraint on public.user_preferences.theme
alter table public.user_preferences
  drop constraint if exists user_preferences_theme_check;

alter table public.user_preferences
  add constraint user_preferences_theme_check
  check (theme in ('midnight', 'paper', 'slate', 'sand', 'system'));

alter table public.user_preferences
  alter column theme set default 'paper';

-- 2. Add optional short reflection field to focus_sessions
alter table public.focus_sessions
  add column if not exists reflection text;
