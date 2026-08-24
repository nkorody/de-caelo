# De Caelo — Master Build Reference

This document is the single source of truth for building De Caelo into an invite-only, multi-tenant platform. It consolidates everything decided across the planning process into one place. Where earlier working documents exist alongside this one, this document supersedes them.

**How to use this document:** read section 2 first, it settles the "from scratch or not" question. Then section 3 tells you which files in this folder are reference implementation versus which are being superseded. The rest is the actual spec.

---

## 1. What this is

A personal astrology platform, originally built for one person (Nicholas), now being extended to an invite-only group of friends, each with their own fully private portal. The differentiator from Co-Star/Pattern/etc. is real technique: Swiss Ephemeris precision, essential dignities, fixed stars, harmonics, solar arc, a glossary deep enough to teach the terms rather than hide them, and an AI oracle grounded in the person's actual chart and the actual current sky rather than generic copy. No engagement-optimized notifications, no anxiety-bait push alerts. Dry, direct, declarative tone throughout, in the writing and in the AI's voice both.

---

## 2. Is this a from-scratch build?

**No.** Treat this as an extension and re-architecture of existing, working software, not a greenfield project.

What stays, essentially unchanged in substance:
- The entire client-side rendering engine: chart wheel, placements, aspects, dignities, dispositors, fixed stars, Arabic parts, harmonics, progressions, the horoscope generator, the interpretive prose engine.
- The Swiss Ephemeris computation pipeline (Python, `pyswisseph`).
- The visual/aesthetic system: brutalist black-and-white, as built in `dc.html`.
- The glossary/hover-notation mechanism.
- The Cloudflare Worker pattern for proxying to the Claude API.

What's genuinely new:
- Accounts, auth, and a real database (none of this exists today, everything currently lives in one static HTML file with no backend).
- Multi-tenancy and the data-isolation guarantees that come with it.
- The invite/onboarding flow.
- The two-tier navigation (Home dashboard vs. deep reference pages) — this exists only as a mockup so far, not in the real app.
- Turning the Python ephemeris scripts from "run by hand once" into an on-demand service.

So: **reuse the frontend and the ephemeris logic wholesale, build the backend and auth layer from scratch, restructure navigation per §6.**

---

## 3. Reference files in this folder

| File | What it is | How to use it |
|---|---|---|
| `dc.html` | The current, working, single-portal build. Brutalist black-and-white redesign, built via Claude Code from an earlier version. | **This is the real app.** Its embedded `<style>` block is the aesthetic system, use those tokens and component classes as-is. Its embedded `<script>` blocks (astro engine, wheel renderer, horoscope generator, interpretation content, UI logic) are the rendering engine, port this logic to fetch its `NATAL_DATA`/`TRANSIT_DATA`/`PROGRESSIONS_DATA` from an API call instead of from an inline `<script type="application/json">` block, but do not rewrite the rendering logic itself. |
| `home_dashboard_mockup_v2.html` | A standalone, non-production mockup exploring three things: (1) the two-tier navigation structure described in §6, (2) a deeper glossary (~70 terms) with a first-occurrence-only tagging rule to avoid visual clutter, (3) 3D monochrome sphere rendering for the Moon and Sun via SVG radial gradients. Sample data throughout, not wired to anything real. | Use as the spec for the Home dashboard layout and navigation shell. Port the expanded `GLOSSARY` object and the `annotateTerms()` first-occurrence logic into the real app, replacing the current ~35-term version. Port the `sphereSVG()` function for the Moon/Sun treatment. Do not port its content data, that was illustrative. |
| `chat-worker.js`, `wrangler.toml`, `README.md` (in `worker/`) | The existing Cloudflare Worker that proxies chat questions to the Claude API, plus its deployment instructions. | This needs the auth changes in §4.6: it currently trusts a client-supplied chart context, it needs to instead verify the requester's identity and load their chart itself. Everything else about it (the system prompt, the tone instructions, the CORS handling) carries over unchanged. |

Known issue to fix while porting, not a new requirement, just a bug worth catching in the port: on the wheel diagram specifically, hard and soft aspect lines are currently differentiated only by a sub-pixel stroke-width difference (both are white in the brutalist palette), which is invisible in practice. Differentiate by line style instead, e.g. solid for hard aspects, dashed for soft, dotted for minor, the way the aspect *pills* elsewhere in the app already correctly do by fill-state rather than color.

---

## 4. Multi-tenant architecture

### 4.1 Components

```
                          +--------------------------+
   Friend receives   -->  |   Supabase Auth          |  invite email, magic link,
   invite email           |   (users, sessions)      |  password set on first login
                          +-----------+--------------+
                                      | JWT (who is this, verified)
                                      v
   +---------------+        +--------------------------+        +-----------------------+
   |  Frontend      |------>|  Supabase Postgres +      |        |  Ephemeris service     |
   |  (existing UI  |  RLS- |  Row Level Security       |<------>|  (Python, pyswisseph)  |
   |  engine, now   | scoped|  charts, sky_snapshots,   |        |  computes a user's     |
   |  fetch-based)  | query |  journal, chat_history,   |        |  natal + progressions  |
   +-------+-------+        |  invites, comparison_     |        |  JSON (once per user,  |
           |                |  people                   |        |  at signup) and the    |
           |                +--------------------------+        |  shared transit window |
           |                                                     |  (periodically, once   |
           |                                                     |  for every user)       |
           |                                                     +-----------------------+
           | question + user's own JWT
           v
   +------------------------+
   |  Cloudflare Worker      |  verifies JWT -> loads only that user's chart via
   |  (chat proxy, holds     |  RLS-scoped query -> calls Claude -> writes reply back
   |  the Anthropic key)     |  to that user's own chat_history rows
   +------------------------+
```

1. **Supabase** — auth, database, and the mechanism that enforces isolation (Row Level Security, §4.3). Chosen specifically because RLS makes "one user can never see another's data" a database-level guarantee rather than a promise kept by application code.
2. **Ephemeris service** — the existing `build_natal.py` / `build_transits.py` / `build_progressions.py` pipeline, wrapped behind one endpoint instead of run as one-off scripts. Has to stay Python: `pyswisseph` is a C extension and does not run in Cloudflare Workers or Supabase Edge Functions (both are JS/Deno sandboxes). This is the one piece of infrastructure that's new in kind, not just repackaged.
3. **Cloudflare Worker** — already built. One real change: currently trusts whatever chart context the client sends; needs to verify the caller's Supabase session and load their chart itself instead, so a modified client request can't impersonate another user.
4. **Frontend** — see §2 and §3. Unchanged in substance, changed in how it gets its data.

### 4.2 Data model

```
profiles                          (one row per user, extends Supabase's built-in auth.users)
  id            uuid  PK, = auth.users.id
  display_name  text
  role          text  'member' | 'admin'
  created_at    timestamptz

birth_data                        (one row per user, their own chart's source data)
  user_id       uuid  PK/FK -> profiles.id
  year, month, day, hour, minute  int
  utc_offset    numeric
  lat, lon      numeric
  place         text
  submitted_at  timestamptz

charts                            (one row per user, the computed output)
  user_id       uuid  PK/FK -> profiles.id
  natal_json    jsonb    -- output of build_natal.py (current_snapshot dropped, see note below)
  prog_json     jsonb    -- output of build_progressions.py
  computed_at   timestamptz

sky_snapshots                     (singleton, one row total, shared by every user)
  id            int   PK, always 1
  transit_json  jsonb    -- output of build_transits.py (rolling calendar window)
  window_start  date
  window_end    date     -- when the transit window needs refreshing
  computed_at   timestamptz

comparison_people                 (private to each user, the "add anyone's data" feature)
  id            uuid  PK
  owner_id      uuid  FK -> profiles.id
  name          text
  year, month, day, hour, minute, utc_offset, lat, lon, place  -- same shape as birth_data
  natal_json    jsonb    -- computed once, cached
  created_at    timestamptz

journal_entries
  id            uuid  PK
  user_id       uuid  FK -> profiles.id
  entry_date    date
  body          text
  created_at    timestamptz

chat_messages
  id            uuid  PK
  user_id       uuid  FK -> profiles.id
  role          text  'user' | 'assistant'
  content       text
  created_at    timestamptz
```

Invites don't need their own table. Supabase Auth's `inviteUserByEmail` already tracks the invited-but-not-yet-accepted state. An admin-only action (an internal page, or the Supabase dashboard directly at this scale) calls that with an email address; Supabase sends the email and creates the pending user.

**Why `sky_snapshots` is a separate, shared table, not a per-user column (deviation from earlier planning, added during build):** `build_transits.py`'s output depends only on the calendar, never on birth data, so it is byte-for-byte identical for every user. An earlier version of this doc put it on `charts` as a per-user `transit_json` column; that would mean recomputing and storing the same ~11-year daily ephemeris table for every friend individually, which is pure duplication with no isolation benefit (this data isn't private, it's just where the planets are). `sky_snapshots` is a one-row table, computed once by the ephemeris service's `POST /refresh-transits`, readable by any authenticated user (RLS: `select` allowed `to authenticated using (true)`, no insert/update/delete policy for `anon`/`authenticated` at all, so only the service-role key the ephemeris service holds can write it).

**`natal_json` no longer includes a `current_snapshot` field.** The original `build_natal.py` had a block computing progressions/solar-arc "as of" a hardcoded date and stashing it under `current_snapshot`. Checked against the actual frontend before porting: `dc.html`'s `AstroData.progressedPositions(dateStr)` / `.solarArc(dateStr)` already interpolate for any date, including today, entirely client-side from the age-indexed table in `prog_json`. `current_snapshot` was write-only, dead weight even in the original single-portal build. Dropped rather than ported.

**Full data flow, onboarding through render:** the frontend makes two calls, not one, and merges the results into the shape `astro-lib.js` already expects.
1. `POST /compute-chart` (birth data in) → `{ natal, progressions }`. Written to `charts.natal_json` / `charts.prog_json` under the user's own RLS-scoped session.
2. A plain Supabase `select` on `sky_snapshots` (RLS-scoped to the same session, read-only) → `{ transit_json, window_start, window_end }`. Nothing computed here, just read.
3. Frontend sets `window.NATAL_DATA = natal`, `window.TRANSIT_DATA = sky_snapshot.transit_json`, `window.PROGRESSIONS_DATA = progressions`, then constructs `new AstroData(NATAL_DATA, TRANSIT_DATA, PROGRESSIONS_DATA)` exactly as `initApp()` in `dc.html` already does. No changes needed to `AstroData` or anything downstream of it: the class was already built to take these three objects as separate constructor arguments, it never assumed they came from the same fetch.

Step 1 happens once, at onboarding (§4.5) and again only if birth data is ever corrected. Step 2 happens on every page load (cheap: one row, RLS-scoped read, no computation). Step 3 is pure client-side wiring, already-existing code.

### 4.3 How isolation is enforced

Every table above has Row Level Security on, with a policy shaped like:

```sql
create policy "users see only their own rows"
  on chat_messages for all
  using (auth.uid() = user_id);
```

That, repeated per table, means it is not possible for one user's query to return another user's rows, regardless of what the application code does. Not "the app is written not to leak it," the database refuses. If a bug ships in the Worker tomorrow that forgets to filter by user, Postgres filters it anyway.

Chat flow specifically:

1. Friend logs in, gets a Supabase-issued JWT.
2. Frontend computes their chart context (the existing `buildChartContext()` logic) from data it fetched under its own RLS-scoped session.
3. Frontend sends the question to the Worker with that JWT attached.
4. Worker verifies the JWT, extracts the user id, and re-fetches that user's chart and recent chat history *itself*, using a Supabase client scoped to that same JWT, not a client-supplied blob. RLS applies here too, so even the Worker can't accidentally pull the wrong user's data.
5. Worker calls Claude with that user's own context, writes the reply back into `chat_messages` under that user's id.

No shared cache, no global conversation state. Two friends asking the same question at the same moment share no code path.

### 4.4 Security and encryption posture — CONFIRMED: baseline

- HTTPS everywhere (default on both Supabase and Cloudflare).
- Encryption at rest on Supabase's underlying Postgres (platform-level, AES-256).
- Row Level Security as the actual access-control mechanism, not a client-side password screen (the current `#gate` in `dc.html` is not real security, it's JS anyone can read in the page source, and should be retired once real auth exists).
- The Anthropic API key lives only in the Worker's environment.

Explicitly **not** doing application-level/zero-knowledge encryption (where even the platform operator couldn't read raw data without the user's own key) for v1. Real option, real added complexity (can't query/index encrypted fields, password reset gets harder), not justified by the actual threat model of a friend group's astrology app. Revisit if this ever grows past people personally known and trusted.

### 4.5 Onboarding flow — CONFIRMED: self-reported, pre-fill optional

1. Admin (Nicholas) invites someone by email, optionally pre-filling their birth data if already known.
2. Supabase sends the invite email, they click through, set a password.
3. If birth data wasn't pre-filled, they enter it themselves here: date, time, place. Self-reported is the default because it's their sensitive data and they should be the one to enter and correct it; pre-fill remains available as an option when the admin already has it.
4. On submit, frontend calls the ephemeris service once, gets back the full natal/transit/progressions JSON, writes it to `charts`. This is the one real wait in the system, likely 10–30 seconds depending on hosting tier (§4.7) — needs a clear "computing your chart" state, not a bare spinner.
5. From then on the portal loads instantly: fetch precomputed JSON, render with the existing engine.

### 4.6 Build order

1. Supabase project: schema, RLS policies, auth set to invite-only (disable public signup entirely; only `inviteUserByEmail` creates accounts).
2. Ephemeris service: wrap the three existing Python scripts into two separate pieces, not two endpoints on the same service. `POST /compute-chart` (birth data in, `{natal, progressions}` out) is the only public HTTP surface, deployed as a web service, runs at signup once per user. Recomputing the shared calendar-only transit window and writing it to `sky_snapshots` is deliberately *not* an HTTP endpoint at all: it holds a service-role key that bypasses Row Level Security entirely, so it runs as `refresh_transits.py`, a standalone script invoked by a scheduled GitHub Actions workflow (`.github/workflows/refresh-transits.yml`) with no public ingress whatsoever (considered Render Cron Jobs first; ruled out because Render gates that service type on having billing info on file even at trivial cost, and a free scheduler with zero public surface is strictly better here anyway). Deploy the web service somewhere that tolerates a cold start, it's called on signup only, not a hot path.
3. Onboarding flow end to end.
4. Frontend: swap "data embedded at build time" for "fetch after auth." Smallest-risk change, the rendering code barely moves.
5. Worker: add JWT verification and self-fetch.
6. Comparison people / synastry, on the new relational model.
7. Home dashboard + two-tier navigation (§6), using the mockup as spec.
8. Later: Vedic module (§9), the rest of the function roadmap (§8), group features (§10).

### 4.7 Cost, at friends-and-family scale — CONFIRMED: acceptable

- **Supabase**: free tier (500 MB db, 50,000 MAUs, unlimited API requests) covers this scale many times over. Free projects pause after 7 days of inactivity though, a bad look for an invited friend hitting a sleeping app — stay on free through build/test, move to Pro ($25/month) once actually sending invites, specifically to buy always-on.
- **Ephemeris service**: only runs on signups, so a tier that sleeps when idle is fine here (unlike Supabase). Render's free tier (cold start after 15 min idle) is reasonable; $7/month buys always-warm if the cold start bothers onboarding. The transit-window refresh (`refresh_transits.py`) runs on GitHub Actions instead of on Render, monthly, well inside GitHub's free-tier minutes for a private repo — $0.
- **Cloudflare Worker**: free tier (100k requests/day) is far beyond a friend group's usage. ~$0.
- **Anthropic API**: usage-based, likely single-digit dollars/month at this scale, bounded further by the Worker's existing `max_tokens` cap. **Confirmed: staying on Claude, not switching to DeepSeek** — DeepSeek's API is real money too (not free, roughly $0.14–0.28 per million tokens on their fast tier as of mid-2026, cheaper than Claude but the absolute-dollar difference is trivial at this scale), and it wasn't validated against the tone/grounding instructions the way Claude was.

Realistic total: **$0 to ~$32/month**, plus API usage, until well past friend-group scale.

---

## 5. Confirmed decisions (quick reference)

- Birth data: self-reported by the friend during onboarding, with pre-fill as an admin option.
- Encryption: baseline (RLS + platform encryption + HTTPS), not zero-knowledge, for v1.
- Supabase: Free during build, Pro at real launch.
- Chat model: Claude (Anthropic), not DeepSeek.
- Group dynamics: deprioritized, see §10, everything else in §8 is in scope.
- Transit data: computed once as a shared `sky_snapshots` table, not duplicated per-user (§4.2). Added during build once it became clear `build_transits.py`'s output never depends on birth data; not in the original data-model draft.

---

## 6. Information architecture

Current state (`dc.html`): eleven flat, equally-weighted tabs. Confirmed problem: no hierarchy between "glance at this daily" and "dive into this occasionally."

Target structure, two navigation levels instead of one (see `home_dashboard_mockup_v2.html` for the worked example):

- **Home** — daily-use dashboard: today's transits, notable days ahead, Moon phase, a teaser into deeper content. What's currently the "Horoscope" tab, promoted to the front door.
- **Chart** — the existing deep-reference instrument (Wheel, Placements, Aspects, Dignities, Dispositors, Fixed Stars, Arabic Parts, Harmonics, Progressions) as one section with its own internal sub-navigation, not top-level tabs.
- **Relational** — synastry, composite, Davison, the add-anyone's-data comparison tool (§8).
- **Vedic** (later, §9) — own section, mirrors Chart's internal structure.
- **Journal** — the empirical logging feature (§8), persistent, not reset by navigation.
- **Oracle/Ask** — not a page. A persistent drawer reachable from anywhere (mocked as a corner button + slide-out panel), since asking a question cuts across every section rather than living in one.

The glossary/hover-notation system operates at a different, orthogonal level, depth-on-demand within any given page, not which pages exist. Both should be true at once: dense, notated content *and* a clear hierarchy of what's shown by default versus navigated to on purpose.

---

## 7. Aesthetic direction

Baseline is `dc.html` as built: pure black/white, no color (hard/soft/etc. differentiated by fill-state, border-style, and weight instead, not hue, per the pill component), Helvetica Neue for display/body, IBM Plex Mono for labels/data, thick hard-edged borders, all-caps structural labels, zero border-radius.

Two confirmed additions on top of that baseline:

1. **Glossary depth**: expand from ~35 to ~70+ terms (all ten planets, all twelve signs, all twelve houses, the six major aspects, plus existing dignity/technique vocabulary), sourced from `home_dashboard_mockup_v2.html`'s `GLOSSARY` object. Apply the same file's first-occurrence-only tagging rule: track tagged terms per page view, only the first mention gets the dotted-underline treatment, repeats render plain. This is a deliberate readability decision, not a limitation, tagging every instance of "Moon" on a page makes it unreadable.
2. **3D monochrome spheres**: the Moon (and Sun) render as SVG radial-gradient spheres with an accurate phase terminator, not flat icons, per `sphereSVG()` in the same mockup file. Confirmed scope for now: Moon and Sun only. Do not extend to planet glyphs on the wheel, sign glyphs, or other icons without a further explicit decision, hold there until the two current instances are reviewed in a real browser.

Aesthetic exploration beyond this is deprioritized relative to function work, per direct instruction, but should still be treated as a live, ongoing collaboration (mockups in both directions, Claude Code shows real output, Claude reviews for both look and functional regressions like the wheel aspect-line issue in §3) rather than a closed decision.

---

## 8. Function roadmap

In rough build-order priority, all confirmed in scope except §10:

- **Empirical journal** — let each person log real events against dates; when a similar transit recurs, surface what they wrote last time. Highest-value single feature: no other astrology app has real usage history to draw on, this one will.
- **Notable-days digest** — forward-looking summary (stations, ingresses, exact hits) rather than only reactive on-demand horoscopes. Already partly designed into the Home dashboard.
- **Synastry / composite / Davison** — the "add anyone's data" comparison feature. Offer synastry (planet-to-planet grid), composite (midpoint chart), and Davison (true time/space midpoint) as distinct tools, they answer different questions. Relationship-type-aware framing: romantic synastry weighs Venus/Mars/7th house, a friendship comparison weighs Mercury/11th house/Sun-Moon, a business comparison weighs Saturn/10th/2nd. One generic "compatibility score" is the failure mode being deliberately avoided.
- **Solar and lunar returns** — the chart for the moment the Sun (or Moon) returns to its exact natal degree. More genuinely predictive than daily horoscopes; currently entirely absent from the app.
- **Progressed lunation cycle** — the ~27-year cycle of the progressed Moon through the chart, tells you what multi-year chapter someone is in. Rare in consumer apps, fits the existing depth-first ethos.
- **Astrocartography / local space** — where a given planet's line runs strongest for a person, genuinely useful for real travel/relocation decisions.

---

## 9. Other astrological systems

**Vedic (Jyotiṣa) — next system after the multi-tenant migration and function roadmap above.** The astronomy is nearly free: Swiss Ephemeris has sidereal mode built in (`swe.set_sid_mode()`), set an ayanamsha (Lahiri is standard) and recompute the same positions already being computed. The real work is everything Vedic astrology actually consists of beyond shifted signs: Nakshatras (27 lunar mansions, their own rulers and meanings, no Western analog), Vimshottari Dasha (a 120-year cycle keyed to birth Nakshatra, the central predictive technique in the system, more load-bearing than transits are in the West), Varga/divisional charts (a cousin of the harmonics already built, computed by different rules), and Shadbala (a six-part planetary-strength system, same spirit as the existing dignity scoring, more moving parts). Build order once started: sidereal positions → Nakshatras → Vargas (structurally closest to existing harmonics code) → Shadbala (closest to existing dignity code) → Dashas (the genuinely new predictive layer).

**Chinese astrology — after Vedic, and specifically real Bazi (Four Pillars), not the pop-culture zodiac-animal version.** The shallow version (12-year animal cycle) is a lookup table with no connection to planets/houses/aspects and would undercut an app built on real technical depth. Real Bazi is a near-second-engine: four stem-branch pairs from a precise solar-term-based Chinese calendar (not simple lunar new year), Five Element interaction theory, hidden stems, the Day Master as core self, Da Yun luck pillars as the timing layer. Treat as its own module alongside the Western/Vedic engine, not an extension of it.

---

## 10. Group dynamics — explicitly deprioritized, kept in mind structurally

Not in scope for the current build phase. Worth designing the schema so it isn't foreclosed: a future `groups` table with a join table (`group_members`) and its own RLS policies (members can see a *limited, explicitly-shared* slice of each other's data, never the default) would layer on top of the existing per-user isolation model without requiring it to be rebuilt. Candidate features for whenever this gets picked back up: a synastry network graph across a friend group, "group weather" (whose chart is under the most pressure this week), a group composite chart, electional features for picking dates as a group. None of this needs to be built now, just not architected against.

---

## 11. Suggested repository structure

```
de-caelo/
├── frontend/              # the existing rendering engine, ported to fetch-based data loading
│   ├── astro-lib.js
│   ├── wheel.js
│   ├── horoscope.js
│   ├── interpretations.js
│   ├── illustrations.js
│   ├── ui.js
│   ├── glossary.js        # expanded ~70-term version, extracted from the mockup
│   └── style.css           # the dc.html token/component system
├── ephemeris-service/       # new: Python, wraps build_natal / build_transits / build_progressions
│   ├── astro_engine.py
│   ├── app.py               # new: the POST /compute-chart endpoint
│   └── requirements.txt
├── worker/                  # existing, gets the auth changes from §4.6
│   ├── chat-worker.js
│   ├── wrangler.toml
│   └── README.md
└── supabase/
    ├── migrations/          # new: schema + RLS policies from §4.2 / §4.3
    └── seed.sql
```

---

## 12. What's still open

Nothing structural. Remaining decisions are implementation-level and reasonable to leave to Claude Code's judgment during the build: exact onboarding form UX, specific copy for empty/error states, precise sizing of the ephemeris service's cold-start loading indicator. Surface anything that turns out to be a real fork in the road rather than guessing silently.
