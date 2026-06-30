-- Run once in the Supabase SQL editor.
-- Stores days the plant did not run (public holidays, shutdowns). Weekends are
-- detected automatically in the app and do NOT need rows here.

create table if not exists public.non_working_days (
  entry_date  date primary key,
  reason      text,
  created_at  timestamptz not null default now()
);

alter table public.non_working_days enable row level security;

-- Mirror the permissive access the dashboard uses for its other tables.
-- Tighten these to match your auth model if your other tables are stricter.
drop policy if exists "non_working_days read"  on public.non_working_days;
drop policy if exists "non_working_days write" on public.non_working_days;

create policy "non_working_days read"
  on public.non_working_days for select using (true);

create policy "non_working_days write"
  on public.non_working_days for all using (true) with check (true);
