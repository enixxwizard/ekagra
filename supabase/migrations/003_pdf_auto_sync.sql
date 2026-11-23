-- Ekagra Phase 3: PDF-to-Calendar Auto Sync Preference
-- Safe, idempotent migration script for Supabase PostgreSQL.
-- Review and run this script in your Supabase Dashboard -> SQL Editor.

alter table public.user_preferences
  add column if not exists auto_sync_pdf_schedule boolean not null default false;
