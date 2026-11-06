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
