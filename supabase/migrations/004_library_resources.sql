-- EKAGRA Smart Digital Library schema & Row-Level Security policies
-- Safe, idempotent migration script for Supabase PostgreSQL.

create table if not exists public.library_resources (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  subtitle text not null default '',
  subject text not null default 'General Studies',
  description text not null default '',
  resource_type text not null check (resource_type in ('pdf', 'external_url')),
  original_file_reference text,
  original_file_name text,
  original_file_size bigint,
  original_url text,
  generated_cover_reference text,
  cover_template text not null default 'charcoal_tech',
  total_pages integer,
  topics jsonb not null default '[]'::jsonb,
  last_read_page integer not null default 1 check (last_read_page >= 0),
  analysis_status text not null default 'complete',
  analysis_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, id)
);

create index if not exists idx_library_resources_user_updated
  on public.library_resources(user_id, updated_at desc);

alter table public.library_resources enable row level security;

drop policy if exists "library_resources_select_own" on public.library_resources;
create policy "library_resources_select_own"
  on public.library_resources for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "library_resources_insert_own" on public.library_resources;
create policy "library_resources_insert_own"
  on public.library_resources for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "library_resources_update_own" on public.library_resources;
create policy "library_resources_update_own"
  on public.library_resources for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "library_resources_delete_own" on public.library_resources;
create policy "library_resources_delete_own"
  on public.library_resources for delete
  to authenticated
  using (auth.uid() = user_id);
