-- Adds storage for per-user generated chart readings (§ "Replace hardcoded
-- INTERP with per-user generated readings"). Until now the interpretive
-- prose shown throughout the app (Overview reading, every placement
-- reading, aspect/dignity/dispositor/fixed-star/Arabic-parts/harmonic
-- commentary) was a single hardcoded object in frontend/app.html, written
-- for one specific chart and shown unconditionally to every account --
-- confirmed live on a second real user, whose readings described someone
-- else's placements verbatim. This column holds that content generated
-- per-user instead, once at onboarding (worker/chat-worker.js's new
-- /generate-readings route), in the same shape the frontend already reads.
--
-- No new RLS policy needed: the existing "users see only their own chart"
-- policy on public.charts (migration 1) is `for all`, so it already covers
-- this column for its owner.

alter table public.charts add column interp_json jsonb;
