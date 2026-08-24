-- De Caelo — shared transit data
-- build_transits.py's output depends only on the calendar, never on birth data,
-- so it is identical for every user. Store it once instead of duplicating it
-- into every user's charts row.

create table public.sky_snapshots (
  id            int primary key default 1,
  transit_json  jsonb not null,
  window_start  date not null,
  window_end    date not null,
  computed_at   timestamptz not null default now(),
  constraint sky_snapshots_singleton check (id = 1)
);

alter table public.sky_snapshots enable row level security;

-- readable by anyone with a valid session (not privacy-sensitive: planetary positions only)
create policy "authenticated users read the shared sky snapshot"
  on public.sky_snapshots for select
  to authenticated
  using (true);

-- no insert/update/delete policy for authenticated/anon: only the service role
-- (held by the ephemeris service, never shipped to a client) can write this table.

alter table public.charts
  drop column transit_json,
  drop column window_end;
