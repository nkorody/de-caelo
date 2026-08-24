-- Fix: "admins see all profiles" policy queried profiles from within its own
-- USING clause, which is itself subject to RLS on profiles -- including that
-- same policy -- so Postgres detected genuine infinite recursion (42P17) on
-- any select against profiles. Confirmed live: every request to
-- /rest/v1/profiles was failing with a 500. Standard fix: move the admin
-- check into a SECURITY DEFINER function, which runs as the function's
-- owner (bypasses RLS for its own internal query) rather than as the
-- querying user, breaking the self-reference.

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

drop policy "admins see all profiles" on public.profiles;

create policy "admins see all profiles"
  on public.profiles for select
  using (public.is_admin());
