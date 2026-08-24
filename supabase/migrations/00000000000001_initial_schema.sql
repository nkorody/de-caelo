-- De Caelo — initial schema + Row Level Security
-- Ref: de_caelo_master_reference.md §4.2 (data model), §4.3 (isolation)

-- ============================================================
-- profiles — one row per user, extends auth.users
-- ============================================================
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  role          text not null default 'member' check (role in ('member', 'admin')),
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "users see only their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "users update only their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- profile row is created by the handle_new_user trigger below, not by direct insert from clients
create policy "users cannot insert their own profile directly"
  on public.profiles for insert
  with check (false);

-- admins can see every profile (needed for an internal invite/admin page)
create policy "admins see all profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- auto-create a profile row when a new auth.users row appears (invite acceptance / first login)
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- birth_data — one row per user, their own chart's source data
-- ============================================================
create table public.birth_data (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  year          int not null,
  month         int not null,
  day           int not null,
  hour          int not null,
  minute        int not null,
  utc_offset    numeric not null,
  lat           numeric not null,
  lon           numeric not null,
  place         text not null,
  submitted_at  timestamptz not null default now()
);

alter table public.birth_data enable row level security;

create policy "users see only their own birth data"
  on public.birth_data for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- charts — one row per user, the computed output
-- ============================================================
create table public.charts (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  natal_json    jsonb,
  transit_json  jsonb,
  prog_json     jsonb,
  computed_at   timestamptz,
  window_end    date
);

alter table public.charts enable row level security;

create policy "users see only their own chart"
  on public.charts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- comparison_people — private to each user, "add anyone's data"
-- ============================================================
create table public.comparison_people (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  year          int not null,
  month         int not null,
  day           int not null,
  hour          int not null,
  minute        int not null,
  utc_offset    numeric not null,
  lat           numeric not null,
  lon           numeric not null,
  place         text not null,
  natal_json    jsonb,
  created_at    timestamptz not null default now()
);

alter table public.comparison_people enable row level security;

create policy "users see only their own comparison people"
  on public.comparison_people for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- ============================================================
-- journal_entries
-- ============================================================
create table public.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  entry_date  date not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

alter table public.journal_entries enable row level security;

create policy "users see only their own journal entries"
  on public.journal_entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- chat_messages
-- ============================================================
create table public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

create policy "users see only their own chat messages"
  on public.chat_messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- indexes
-- ============================================================
create index journal_entries_user_date_idx on public.journal_entries (user_id, entry_date);
create index chat_messages_user_created_idx on public.chat_messages (user_id, created_at);
create index comparison_people_owner_idx on public.comparison_people (owner_id);
