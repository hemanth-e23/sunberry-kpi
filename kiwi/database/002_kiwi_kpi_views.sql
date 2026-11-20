-- =====================================================================
-- KIWI - read-only views over the tables the KPI app already has.
-- Run after 001_kiwi_shift_reports.sql. Safe to re-run.
-- Columns are listed explicitly so nothing new (e.g. a user id) leaks in
-- if a table later gains columns.
-- =====================================================================

-- Daily production per line, as entered/synced in the KPI app.
create or replace view kiwi.daily_production as
select entry_date, product,
       line1_produced, line1_target, line1_capacity, line1_filler_start, line1_filler_target,
       line2_produced, line2_target, line2_capacity, line2_filler_start, line2_filler_target,
       notes
from public.production_entries;

-- Downtime logged in the KPI app's Downtime box. Author is left out on purpose.
create or replace view kiwi.downtime_log as
select entry_date,
       line_number,          -- '1', '2', 'both' or null
       category,             -- mechanical | production | quality | staffing | other
       sub_reason,           -- machine (mechanical) or what held us up (production)
       other_specify,
       downtime_minutes,
       text as comment,
       created_at
from public.comments;

create or replace view kiwi.monthly_targets as
select month, line1_target, line2_target
from public.monthly_targets;

create or replace view kiwi.non_working_days as
select entry_date, reason
from public.non_working_days;

-- Batch tank history recorded from the PLCs (BT1-BT4).
create or replace view kiwi.tank_batches as
select tank, started_at, full_at, approved_at, drain_start, drain_end, empty_at,
       peak, recipe, lost_at
from public.tank_batches;

-- Tank level readings recorded from the PLCs.
create or replace view kiwi.tank_readings as
select tank, ts, gallons
from public.tank_readings;

grant select on all tables in schema kiwi to kiwi_reader, kiwi_manager_reader;
revoke select on kiwi.shift_people from kiwi_reader;
