-- Adds the Whole Sign / Placidus house-system toggle (§ "Whole Sign toggle
-- with alternative readings"). Two pieces:
--
-- 1. profiles.house_system -- the user's chosen system, persisted so it
--    follows them across sessions/devices (mirrors display_name: a
--    per-user display preference, not chart data).
-- 2. charts.interp_json_whole_sign -- the Whole Sign counterpart to
--    interp_json (migration 4). Generated lazily, the first time a user
--    flips the toggle (worker/chat-worker.js's /generate-readings route,
--    called again with houseSystem: 'whole_sign'), not eagerly at
--    onboarding -- most users may never touch the toggle, and onboarding
--    already runs one full generation call.
--
-- No new RLS policies needed: the existing "users update only their own
-- profile" policy (migration 1) covers the new profiles column, and the
-- existing "users see only their own chart" `for all` policy covers the
-- new charts column, for their respective owners.

alter table public.profiles add column house_system text not null default 'placidus'
  check (house_system in ('placidus', 'whole_sign'));

alter table public.charts add column interp_json_whole_sign jsonb;
