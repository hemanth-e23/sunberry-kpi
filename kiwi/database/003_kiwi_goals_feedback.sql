-- =====================================================================
-- KIWI part C: daily/monthly goals (capacity) and answer feedback.
-- Run in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Goals, worked out exactly like the KPI app:
--    - the Default Targets row with the newest effective_from on/before the day
--    - a per-day edit in the app (production_entries) overrides it for that day
--    - working day = Monday-Friday and not marked off in non_working_days
--    The plant's goal is CAPACITY; target is kept alongside for reference.
-- ---------------------------------------------------------------------
create or replace view kiwi.daily_goals as
with days as (
    select gs::date as day
    from generate_series(
        (select min(effective_from)::date from public.production_targets),
        (date_trunc('month', current_date) + interval '2 months' - interval '1 day')::date,
        interval '1 day') gs
), defaults as (
    select d.day, pt.line1_target, pt.line1_capacity, pt.line2_target, pt.line2_capacity
    from days d
    left join lateral (
        select p.line1_target, p.line1_capacity, p.line2_target, p.line2_capacity
        from public.production_targets p
        where p.effective_from::date <= d.day
        order by p.effective_from::date desc
        limit 1
    ) pt on true
)
select f.day,
       (extract(isodow from f.day) < 6
        and not exists (select 1 from public.non_working_days n where n.entry_date::date = f.day)) as working_day,
       coalesce(nullif(e.line1_capacity, 0), f.line1_capacity) as line1_goal,
       coalesce(nullif(e.line2_capacity, 0), f.line2_capacity) as line2_goal,
       coalesce(nullif(e.line1_target, 0),   f.line1_target)   as line1_target,
       coalesce(nullif(e.line2_target, 0),   f.line2_target)   as line2_target
from defaults f
left join public.production_entries e on e.entry_date::date = f.day;

-- Monthly goal = sum of daily goals over working days (= working days x daily capacity).
create or replace view kiwi.monthly_goals as
select to_char(day, 'YYYY-MM') as month,
       count(*) filter (where working_day)                     as working_days,
       sum(line1_goal) filter (where working_day)              as line1_goal,
       sum(line2_goal) filter (where working_day)              as line2_goal,
       sum(line1_target) filter (where working_day)            as line1_target,
       sum(line2_target) filter (where working_day)            as line2_target
from kiwi.daily_goals
group by 1;

grant select on kiwi.daily_goals, kiwi.monthly_goals to kiwi_reader, kiwi_manager_reader;

-- ---------------------------------------------------------------------
-- 2) Feedback on KIWI answers (thumbs up / down + optional comment).
--    Signed-in users may ADD their own feedback; nobody can read it through
--    the app. You review it in Supabase -> Table Editor -> kiwi_feedback.
-- ---------------------------------------------------------------------
create table if not exists public.kiwi_feedback (
    id         bigserial primary key,
    created_at timestamptz not null default now(),
    user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    rating     smallint not null check (rating in (-1, 1)),
    question   text check (char_length(question) <= 2000),
    answer     text check (char_length(answer) <= 8000),
    comment    text check (char_length(comment) <= 1000),
    context    jsonb check (octet_length(context::text) <= 20000)
);
alter table public.kiwi_feedback enable row level security;

revoke all on public.kiwi_feedback from anon, authenticated;
grant insert on public.kiwi_feedback to authenticated;
grant usage on sequence public.kiwi_feedback_id_seq to authenticated;

drop policy if exists "kiwi feedback: add your own" on public.kiwi_feedback;
create policy "kiwi feedback: add your own" on public.kiwi_feedback
    for insert to authenticated
    with check (user_id = auth.uid());
-- No select/update/delete policies: users can't read or change anyone's feedback.
