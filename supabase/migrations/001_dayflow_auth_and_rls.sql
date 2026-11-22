-- DayFlow Phase 1: Authentication, Profiles & User-Owned Row Level Security Schema
-- Safe, idempotent migration script for Supabase PostgreSQL.
-- Review and run this script in your Supabase Dashboard -> SQL Editor.

-- 1. PROFILES TABLE (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
  on public.profiles for delete
  to authenticated
  using (auth.uid() = id);

-- Automatically provision a profile row whenever a new user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- 2. USER PREFERENCES
create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  user_name text not null default 'Alex',
  theme text not null default 'light' check (theme in ('light', 'dark', 'system')),
  time_format text not null default '12h' check (time_format in ('12h', '24h')),
  week_start text not null default 'monday' check (week_start in ('monday', 'sunday')),
  default_focus_minutes integer not null default 25 check (default_focus_minutes between 5 and 180),
  short_break_minutes integer not null default 5 check (short_break_minutes between 1 and 60),
  long_break_minutes integer not null default 15 check (long_break_minutes between 5 and 90),
  sound_alerts boolean not null default true,
  notifications_enabled boolean not null default false,
  reminder_lead_minutes integer not null default 10 check (reminder_lead_minutes in (0, 5, 10, 15)),
  daily_capacity_hours integer not null default 8 check (daily_capacity_hours between 2 and 16),
  preferred_music_url text,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences_select_own" on public.user_preferences;
create policy "user_preferences_select_own"
  on public.user_preferences for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_preferences_insert_own" on public.user_preferences;
create policy "user_preferences_insert_own"
  on public.user_preferences for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_preferences_update_own" on public.user_preferences;
create policy "user_preferences_update_own"
  on public.user_preferences for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_preferences_delete_own" on public.user_preferences;
create policy "user_preferences_delete_own"
  on public.user_preferences for delete
  to authenticated
  using (auth.uid() = user_id);


-- 3. TASKS
create table if not exists public.tasks (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  due_date text,
  category text not null default 'Work',
  completed boolean not null default false,
  completed_at text,
  estimated_minutes integer not null default 30,
  scheduled_activity_id text,
  created_at text not null,
  updated_at text not null,
  primary key (user_id, id)
);

create index if not exists idx_tasks_user_due on public.tasks(user_id, due_date);
alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own"
  on public.tasks for select to authenticated using (auth.uid() = user_id);

drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own"
  on public.tasks for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own"
  on public.tasks for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own"
  on public.tasks for delete to authenticated using (auth.uid() = user_id);


-- 4. SCHEDULE ACTIVITIES
create table if not exists public.activities (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  date text not null,
  start_time text not null,
  end_time text not null,
  category text not null default 'Work',
  color text not null default 'indigo',
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'skipped')),
  linked_task_id text,
  recurrence jsonb not null default '{"frequency": "none", "endDate": null}'::jsonb,
  excluded_dates jsonb not null default '[]'::jsonb,
  occurrence_overrides jsonb not null default '{}'::jsonb,
  created_at text not null,
  updated_at text not null,
  primary key (user_id, id)
);

create index if not exists idx_activities_user_date on public.activities(user_id, date);
alter table public.activities enable row level security;

drop policy if exists "activities_select_own" on public.activities;
create policy "activities_select_own"
  on public.activities for select to authenticated using (auth.uid() = user_id);

drop policy if exists "activities_insert_own" on public.activities;
create policy "activities_insert_own"
  on public.activities for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "activities_update_own" on public.activities;
create policy "activities_update_own"
  on public.activities for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "activities_delete_own" on public.activities;
create policy "activities_delete_own"
  on public.activities for delete to authenticated using (auth.uid() = user_id);


-- 5. FOCUS SESSIONS
create table if not exists public.focus_sessions (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id text,
  activity_title text,
  category text not null default 'Deep Focus',
  mode text not null default 'focus' check (mode in ('focus', 'short_break', 'long_break')),
  planned_minutes integer not null default 25,
  actual_minutes integer not null default 25,
  started_at text not null,
  ended_at text not null,
  date text not null,
  completed boolean not null default true,
  primary key (user_id, id)
);

create index if not exists idx_focus_sessions_user_date on public.focus_sessions(user_id, date);
alter table public.focus_sessions enable row level security;

drop policy if exists "focus_sessions_select_own" on public.focus_sessions;
create policy "focus_sessions_select_own"
  on public.focus_sessions for select to authenticated using (auth.uid() = user_id);

drop policy if exists "focus_sessions_insert_own" on public.focus_sessions;
create policy "focus_sessions_insert_own"
  on public.focus_sessions for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "focus_sessions_update_own" on public.focus_sessions;
create policy "focus_sessions_update_own"
  on public.focus_sessions for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "focus_sessions_delete_own" on public.focus_sessions;
create policy "focus_sessions_delete_own"
  on public.focus_sessions for delete to authenticated using (auth.uid() = user_id);


-- 6. HABITS & HABIT LOGS
create table if not exists public.habits (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text not null default '',
  frequency text not null default 'daily' check (frequency in ('daily', 'weekly')),
  target_per_week integer not null default 7,
  category text not null default 'Personal',
  color text not null default 'emerald',
  created_at text not null,
  primary key (user_id, id)
);

alter table public.habits enable row level security;

drop policy if exists "habits_select_own" on public.habits;
create policy "habits_select_own"
  on public.habits for select to authenticated using (auth.uid() = user_id);

drop policy if exists "habits_insert_own" on public.habits;
create policy "habits_insert_own"
  on public.habits for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "habits_update_own" on public.habits;
create policy "habits_update_own"
  on public.habits for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "habits_delete_own" on public.habits;
create policy "habits_delete_own"
  on public.habits for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.habit_logs (
  user_id uuid not null references auth.users(id) on delete cascade,
  habit_id text not null,
  log_date text not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, habit_id, log_date)
);

alter table public.habit_logs enable row level security;

drop policy if exists "habit_logs_select_own" on public.habit_logs;
create policy "habit_logs_select_own"
  on public.habit_logs for select to authenticated using (auth.uid() = user_id);

drop policy if exists "habit_logs_insert_own" on public.habit_logs;
create policy "habit_logs_insert_own"
  on public.habit_logs for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "habit_logs_update_own" on public.habit_logs;
create policy "habit_logs_update_own"
  on public.habit_logs for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "habit_logs_delete_own" on public.habit_logs;
create policy "habit_logs_delete_own"
  on public.habit_logs for delete to authenticated using (auth.uid() = user_id);


-- 7. QUICK NOTES
create table if not exists public.quick_notes (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  category text not null default 'Study',
  linked_task_id text,
  linked_activity_id text,
  linked_focus_session_id text,
  source_quotation_id text,
  created_at text not null,
  updated_at text not null,
  primary key (user_id, id)
);

create index if not exists idx_quick_notes_user_updated on public.quick_notes(user_id, updated_at desc);
alter table public.quick_notes enable row level security;

drop policy if exists "quick_notes_select_own" on public.quick_notes;
create policy "quick_notes_select_own"
  on public.quick_notes for select to authenticated using (auth.uid() = user_id);

drop policy if exists "quick_notes_insert_own" on public.quick_notes;
create policy "quick_notes_insert_own"
  on public.quick_notes for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "quick_notes_update_own" on public.quick_notes;
create policy "quick_notes_update_own"
  on public.quick_notes for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "quick_notes_delete_own" on public.quick_notes;
create policy "quick_notes_delete_own"
  on public.quick_notes for delete to authenticated using (auth.uid() = user_id);


-- 8. STUDY QUOTATIONS
create table if not exists public.study_quotations (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  source_file text not null default 'Imported PDF',
  page_number integer,
  category text not null default 'Study',
  date_captured text not null,
  created_at text not null,
  primary key (user_id, id)
);

create index if not exists idx_study_quotations_user on public.study_quotations(user_id, created_at desc);
alter table public.study_quotations enable row level security;

drop policy if exists "study_quotations_select_own" on public.study_quotations;
create policy "study_quotations_select_own"
  on public.study_quotations for select to authenticated using (auth.uid() = user_id);

drop policy if exists "study_quotations_insert_own" on public.study_quotations;
create policy "study_quotations_insert_own"
  on public.study_quotations for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "study_quotations_update_own" on public.study_quotations;
create policy "study_quotations_update_own"
  on public.study_quotations for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "study_quotations_delete_own" on public.study_quotations;
create policy "study_quotations_delete_own"
  on public.study_quotations for delete to authenticated using (auth.uid() = user_id);


-- 9. IMPORTED PDF FINGERPRINTS (prevents duplicate PDF imports per user)
create table if not exists public.imported_fingerprints (
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, fingerprint)
);

alter table public.imported_fingerprints enable row level security;

drop policy if exists "imported_fingerprints_select_own" on public.imported_fingerprints;
create policy "imported_fingerprints_select_own"
  on public.imported_fingerprints for select to authenticated using (auth.uid() = user_id);

drop policy if exists "imported_fingerprints_insert_own" on public.imported_fingerprints;
create policy "imported_fingerprints_insert_own"
  on public.imported_fingerprints for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "imported_fingerprints_update_own" on public.imported_fingerprints;
create policy "imported_fingerprints_update_own"
  on public.imported_fingerprints for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "imported_fingerprints_delete_own" on public.imported_fingerprints;
create policy "imported_fingerprints_delete_own"
  on public.imported_fingerprints for delete to authenticated using (auth.uid() = user_id);
