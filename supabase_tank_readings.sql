-- Run once in the Supabase SQL editor.
-- Sugar & syrup room tank levels, sent from the plant PC by tank_sync.py
-- through the plc-ingest Edge Function.
--
-- ACCESS (deliberately stricter than the older tables):
--   signed-in users   read only
--   anonymous         nothing, not even read
--   writes            only the plc-ingest Edge Function (service role); there is
--                     no insert/update/delete policy, so the browser cannot write

-- A row is written only when a tank has moved 100 gal or more since the last
-- row, so a tank that sits still produces no rows.
create table if not exists public.tank_readings (
  tank         text        not null
                 check (tank in ('CT1', 'CT2', 'SR tank 1', 'SR tank 2', 'SR tank 3')),
  ts           timestamptz not null,
  gallons      real        not null check (gallons between -500 and 10400),
  inches       real                 check (inches between -10 and 400),
  received_at  timestamptz not null default now(),
  primary key (tank, ts)
);

-- One row, refreshed hourly: proves the plant PC is alive even when no tank
-- moves, and carries the current level of every tank.
create table if not exists public.plc_heartbeat (
  source        text        primary key check (source = 'plant-pc'),
  last_seen     timestamptz not null,   -- set by the server, not the plant PC
  last_reading  timestamptz,            -- newest level cip2.py recorded
  levels        jsonb       not null default '{}'::jsonb
);

-- added later: current inches per tank, next to gallons
alter table public.plc_heartbeat
  add column if not exists inches jsonb not null default '{}'::jsonb;

-- added later: batch tanks BT1-BT4
alter table public.tank_readings drop constraint if exists tank_readings_tank_check;
alter table public.tank_readings add constraint tank_readings_tank_check
  check (tank in ('CT1', 'CT2', 'SR tank 1', 'SR tank 2', 'SR tank 3',
                  'BT1', 'BT2', 'BT3', 'BT4'));

-- added later: one row per batch-tank batch, from the PLC's own stage bits
-- (BTn_Batching / _QC_Hold / _Approved / _Draining / _Empty), recorded by
-- line2.py and sent by tank_sync.py. The row is updated as the batch moves on.
create table if not exists public.tank_batches (
  tank         text        not null check (tank in ('BT1', 'BT2', 'BT3', 'BT4')),
  started_at   timestamptz not null,   -- started filling
  full_at      timestamptz,            -- filling finished
  approved_at  timestamptz,            -- QC approved
  drain_start  timestamptz,
  drain_end    timestamptz,
  empty_at     timestamptz,
  peak         real        check (peak between -500 and 10000),
  recipe       text        check (char_length(recipe) <= 100),
  updated_at   timestamptz not null default now(),
  primary key (tank, started_at)
);

alter table public.tank_batches enable row level security;
revoke all on table public.tank_batches from anon, authenticated;
grant select on table public.tank_batches to authenticated;
drop policy if exists "tank_batches read (signed in)" on public.tank_batches;
create policy "tank_batches read (signed in)"
  on public.tank_batches for select to authenticated using (true);

-- added 2026-11-12: the batch was cut off by an outage; this is the last time
-- line2.py saw the tank. Run this BEFORE deploying the updated plc-ingest.
alter table public.tank_batches add column if not exists lost_at timestamptz;

alter table public.tank_readings enable row level security;
alter table public.plc_heartbeat enable row level security;

-- Supabase grants everything to anon/authenticated on new tables by default.
-- Take it all back, then give signed-in users read and nothing else.
revoke all on table public.tank_readings from anon, authenticated;
revoke all on table public.plc_heartbeat from anon, authenticated;
grant select on table public.tank_readings to authenticated;
grant select on table public.plc_heartbeat to authenticated;

drop policy if exists "tank_readings read (signed in)" on public.tank_readings;
drop policy if exists "plc_heartbeat read (signed in)" on public.plc_heartbeat;

create policy "tank_readings read (signed in)"
  on public.tank_readings for select to authenticated using (true);

create policy "plc_heartbeat read (signed in)"
  on public.plc_heartbeat for select to authenticated using (true);
