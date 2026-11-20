-- =====================================================================
-- KIWI - shift report tables, the views KIWI may read, and its roles.
-- Run once in the Supabase SQL editor (or psql). Safe to re-run.
--
-- Layout:
--   schema plant  - the real tables. NOT exposed through the Supabase REST API
--                   (only schemas listed in API settings are, by default public).
--   schema kiwi   - read-only views. The only thing KIWI's database login can see.
-- =====================================================================

create schema if not exists plant;
revoke all on schema plant from public;

create table if not exists plant.shift_production (
    id              bigserial primary key,
    report_date     date      not null,
    shift           smallint  not null check (shift in (1, 2)),
    supervisor      text,
    line            smallint,
    sku             text,
    product         text,
    lot             text,
    planned_batches numeric,
    filler_start    time,
    first_bottle    time,
    last_bottle     time,
    batches_made    numeric,
    total_gallons   numeric,
    cases_produced  numeric,
    pct_loss        numeric,
    cases_reworked  numeric,
    bottles_loaded  numeric,
    caps_loaded     numeric,
    bottle_loss     numeric,
    source_file     text,
    sheet           text,
    row_no          int
);
create index if not exists shift_production_date on plant.shift_production (report_date);

create table if not exists plant.shift_downtime (
    id           bigserial primary key,
    report_date  date     not null,
    shift        smallint not null,
    line         smallint not null,
    minutes      numeric,           -- parsed from duration_raw ("295 min" -> 295); null if not given
    duration_raw text,              -- exactly as typed
    equipment    text,
    reason       text,
    source_file  text,
    sheet        text,
    row_no       int
);
create index if not exists shift_downtime_date on plant.shift_downtime (report_date);

create table if not exists plant.shift_people (
    id          bigserial primary key,
    report_date date     not null,
    shift       smallint not null,
    kind        text     not null check (kind in ('absence', 'part_day')),
    name        text     not null,
    source_file text,
    sheet       text,
    row_no      int
);
create index if not exists shift_people_date on plant.shift_people (report_date);

create table if not exists plant.shift_notes (
    id               bigserial primary key,
    report_date      date     not null,
    shift            smallint not null,
    important_info   text,
    supervisor_notes text,
    source_file      text,
    sheet            text
);
create index if not exists shift_notes_date on plant.shift_notes (report_date);

create table if not exists plant.import_log (
    id           bigserial primary key,
    imported_at  timestamptz not null default now(),
    source_file  text,
    month_start  date,
    month_end    date,
    production   int,
    downtime     int,
    people       int,
    notes        int,
    warnings     text
);

-- ---------------------------------------------------------------------
-- Views KIWI reads. Views run with their owner's rights, so KIWI's login
-- needs no access to the plant tables themselves.
-- ---------------------------------------------------------------------
create schema if not exists kiwi;
revoke all on schema kiwi from public;

create or replace view kiwi.shift_production as
select report_date, shift, supervisor, line, sku, product, lot,
       planned_batches, batches_made, filler_start, first_bottle, last_bottle,
       total_gallons, cases_produced, pct_loss, cases_reworked,
       bottles_loaded, caps_loaded, bottle_loss
from plant.shift_production;

create or replace view kiwi.shift_downtime as
select report_date, shift, line, minutes, duration_raw, equipment, reason
from plant.shift_downtime;

create or replace view kiwi.shift_people as
select report_date, shift, kind, name
from plant.shift_people;

create or replace view kiwi.shift_notes as
select report_date, shift, important_info, supervisor_notes
from plant.shift_notes;

-- One row per date / shift / line: what ran, how much, and reported downtime.
create or replace view kiwi.shift_line_summary as
with p as (
    select report_date, shift, line,
           string_agg(distinct product, ', ')   as products,
           string_agg(distinct supervisor, ', ') as supervisors,
           sum(cases_produced) as cases_produced,
           sum(total_gallons)  as total_gallons,
           sum(batches_made)   as batches_made,
           min(filler_start)   as first_filler_start
    from plant.shift_production
    where line is not null
    group by 1, 2, 3
), d as (
    select report_date, shift, line,
           sum(minutes) as downtime_minutes,
           count(*)     as downtime_entries
    from plant.shift_downtime
    group by 1, 2, 3
)
select coalesce(p.report_date, d.report_date) as report_date,
       coalesce(p.shift, d.shift)             as shift,
       coalesce(p.line, d.line)               as line,
       p.products, p.supervisors, p.cases_produced, p.total_gallons,
       p.batches_made, p.first_filler_start,
       coalesce(d.downtime_minutes, 0) as reported_downtime_minutes,
       coalesce(d.downtime_entries, 0) as downtime_entries
from p full join d using (report_date, shift, line);

create or replace view kiwi.data_freshness as
select max(imported_at) as last_import,
       (select max(report_date) from plant.shift_production) as latest_report_date
from plant.import_log;

-- ---------------------------------------------------------------------
-- Logins for KIWI. Created without a password (cannot log in) - see README.
--   kiwi_reader          everyone's questions: all kiwi views EXCEPT names
--   kiwi_manager_reader  managers' questions: all kiwi views incl. shift_people
-- Neither is a member of the other, so a query can't switch between them.
-- ---------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'kiwi_reader') then
        create role kiwi_reader nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'kiwi_manager_reader') then
        create role kiwi_manager_reader nologin noinherit;
    end if;
end $$;

-- Supabase's browser roles must never see these schemas (belt and braces:
-- neither schema is exposed through the API anyway).
do $$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format('revoke all on schema plant, kiwi from %I', r);
            execute format('revoke all on all tables in schema plant, kiwi from %I', r);
        end if;
    end loop;
end $$;

grant usage on schema kiwi to kiwi_reader, kiwi_manager_reader;
grant select on all tables in schema kiwi to kiwi_reader, kiwi_manager_reader;
revoke select on kiwi.shift_people from kiwi_reader;

alter role kiwi_reader         set default_transaction_read_only = on;
alter role kiwi_reader         set statement_timeout = '8s';
alter role kiwi_reader         set search_path = kiwi;
alter role kiwi_manager_reader set default_transaction_read_only = on;
alter role kiwi_manager_reader set statement_timeout = '8s';
alter role kiwi_manager_reader set search_path = kiwi;

-- ---------------------------------------------------------------------
-- Upload: replace one month of shift report rows in a single transaction.
-- Called only by the kiwi-ingest function (service role). Nobody else may run it.
-- ---------------------------------------------------------------------
create or replace function public.kiwi_replace_month(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = plant, pg_temp
as $$
declare
    m_start date := (p->>'month_start')::date;
    m_end   date := (p->>'month_end')::date;
    n_prod int; n_dt int; n_ppl int; n_notes int;
begin
    -- Refuse anything that isn't exactly one calendar month, so a bad upload
    -- can never wipe more than the month it is about.
    if m_start is null or m_end is null
       or extract(day from m_start) <> 1
       or m_end <> (m_start + interval '1 month' - interval '1 day')::date then
        raise exception 'month_start/month_end must cover exactly one calendar month';
    end if;
    if exists (
        select 1 from (
            select (x->>'report_date')::date d from jsonb_array_elements(coalesce(p->'production','[]')) x
            union all select (x->>'report_date')::date from jsonb_array_elements(coalesce(p->'downtime','[]')) x
            union all select (x->>'report_date')::date from jsonb_array_elements(coalesce(p->'people','[]')) x
            union all select (x->>'report_date')::date from jsonb_array_elements(coalesce(p->'notes','[]')) x
        ) s where d is null or d not between m_start and m_end
    ) then
        raise exception 'every row must have a report_date inside the month';
    end if;

    delete from plant.shift_production where report_date between m_start and m_end;
    delete from plant.shift_downtime   where report_date between m_start and m_end;
    delete from plant.shift_people     where report_date between m_start and m_end;
    delete from plant.shift_notes      where report_date between m_start and m_end;

    insert into plant.shift_production (report_date, shift, supervisor, line, sku, product, lot,
        planned_batches, filler_start, first_bottle, last_bottle, batches_made, total_gallons,
        cases_produced, pct_loss, cases_reworked, bottles_loaded, caps_loaded, bottle_loss,
        source_file, sheet, row_no)
    select report_date, shift, supervisor, line, sku, product, lot,
        planned_batches, filler_start, first_bottle, last_bottle, batches_made, total_gallons,
        cases_produced, pct_loss, cases_reworked, bottles_loaded, caps_loaded, bottle_loss,
        source_file, sheet, row_no
    from jsonb_populate_recordset(null::plant.shift_production, coalesce(p->'production', '[]'));
    get diagnostics n_prod = row_count;

    insert into plant.shift_downtime (report_date, shift, line, minutes, duration_raw, equipment,
        reason, source_file, sheet, row_no)
    select report_date, shift, line, minutes, duration_raw, equipment, reason, source_file, sheet, row_no
    from jsonb_populate_recordset(null::plant.shift_downtime, coalesce(p->'downtime', '[]'));
    get diagnostics n_dt = row_count;

    insert into plant.shift_people (report_date, shift, kind, name, source_file, sheet, row_no)
    select report_date, shift, kind, name, source_file, sheet, row_no
    from jsonb_populate_recordset(null::plant.shift_people, coalesce(p->'people', '[]'));
    get diagnostics n_ppl = row_count;

    insert into plant.shift_notes (report_date, shift, important_info, supervisor_notes, source_file, sheet)
    select report_date, shift, important_info, supervisor_notes, source_file, sheet
    from jsonb_populate_recordset(null::plant.shift_notes, coalesce(p->'notes', '[]'));
    get diagnostics n_notes = row_count;

    insert into plant.import_log (source_file, month_start, month_end, production, downtime, people, notes, warnings)
    values (left(p->>'source_file', 300), m_start, m_end, n_prod, n_dt, n_ppl, n_notes, left(p->>'warnings', 5000));

    return jsonb_build_object('production', n_prod, 'downtime', n_dt, 'people', n_ppl, 'notes', n_notes);
end $$;

revoke all on function public.kiwi_replace_month(jsonb) from public;
do $$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format('revoke all on function public.kiwi_replace_month(jsonb) from %I', r);
        end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function public.kiwi_replace_month(jsonb) to service_role;
    end if;
end $$;
