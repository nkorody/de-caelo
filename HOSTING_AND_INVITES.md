# Hosting on cPanel (GoDaddy) & Generating Invitations

Two separate runbooks: putting the static frontend on a GoDaddy cPanel plan,
and inviting people once it's live. Neither touches code — both are things
an admin does from a browser.

---

## 0. Before you invite anyone: the one setting that matters

The invite-only design (§4 of `de_caelo_master_reference.md`) depends on a
single Supabase Auth toggle, and it lives in the dashboard, not in this
repo — nothing in the codebase can verify it's set correctly, so check it
by hand before this goes anywhere near a public URL:

**Supabase Dashboard → Authentication → Sign In / Providers → Email →
turn off "Allow new users to sign up."**

If that's left on, `login.html`'s "invite-only" text is just a suggestion —
anyone who finds the URL can create their own account, bypassing the invite
system entirely regardless of anything else in this doc.

Two more dashboard items worth doing at the same time, not code changes:

- **Authentication → URL Configuration** — set *Site URL* to your real
  domain (e.g. `https://your-domain.com/app.html`) once you have one, and
  add it under *Redirect URLs* too. Invite and password-reset emails embed
  a redirect back to whatever's configured here; leaving it at
  `127.0.0.1:3000` (the local-dev default) sends real invite emails to a
  dead link.
- **Project Settings → General → pause behavior** — free Supabase projects
  pause after 7 days with no traffic. Fine while building; before actually
  sending invites, move to the Pro plan ($25/mo) so an invited friend
  doesn't land on a paused project on their first visit.

---

## Part A — Hosting the frontend on GoDaddy cPanel

### What you're deploying

Everything under `frontend/` — that's the whole app:

```
app.html   login.html   onboarding.html
config.js  login.js     onboarding.js   oracle.js
style.css
cities.json  constellation-lines.json  stars.json
```

No build step. No `npm install`, no bundler — these files are served
exactly as they sit in the repo. `app.html`/`login.html`/`onboarding.html`
are static HTML that call out (via `fetch` and the Supabase JS SDK, loaded
from a CDN `<script>` tag) straight to Supabase, the Render ephemeris
service, and the Cloudflare Worker — all three already point at their real
production URLs in `config.js`, not localhost, so nothing there needs to
change for a move off your dev machine.

### Steps

1. **Log into GoDaddy → My Products → the hosting plan → cPanel.**
2. **Decide where the app lives**: your GoDaddy domain's document root
   (`public_html/`, so the app is at `your-domain.com/`), or a subdomain
   (e.g. `app.your-domain.com`, via cPanel → **Domains → Subdomains**,
   which creates its own folder under `public_html/`, e.g.
   `public_html/app/`). A subdomain keeps the root free for something else
   later; either works identically for this app.
3. **Upload the files** — cPanel → **File Manager**, navigate to whichever
   folder you picked, then either:
   - **Upload** button → select all files from `frontend/` on your machine
     (drag-and-drop works in most cPanel File Manager builds), or
   - zip `frontend/`'s contents locally, upload the single zip, then use
     File Manager's **Extract** — faster for `cities.json` (~2MB) than
     uploading it alone over a slow connection.

   FTP works too if you'd rather: cPanel → **FTP Accounts**, create one
   scoped to that folder, connect with any FTP client (FileZilla, Cyberduck)
   and drag the same files over. Same result either way.
4. **Set the landing page.** `login.html` is the actual entry point (it
   redirects to `app.html` if you're already signed in, or to
   `onboarding.html` on first login) — if you want `your-domain.com/` to
   land there directly rather than `your-domain.com/login.html`, rename
   `login.html` to `index.html` on the server (File Manager → right-click →
   Rename). Don't rename it in the repo/locally — the other files reference
   it as `login.html` by name (redirects on session expiry, etc.), so only
   rename the uploaded copy, or add a one-line `index.html` that just
   redirects to `login.html` if you'd rather leave the filenames alone.
5. **SSL.** GoDaddy cPanel plans include AutoSSL (Let's Encrypt) — cPanel →
   **Security → SSL/TLS Status** → run AutoSSL for the domain if it isn't
   already issued. Required: Supabase Auth and the browser's own security
   model won't cooperate over plain HTTP for a real domain.
6. **Point Supabase and the ephemeris service at the new domain** (see §0
   above for the Supabase side). On the ephemeris service (Render dashboard
   → the service → **Environment**), set `ALLOWED_ORIGINS` to your real
   domain, e.g. `https://your-domain.com` (comma-separate if you're serving
   from more than one origin). It defaults to `*` (wide open) when unset —
   harmless at friend-group scale since the endpoint holds no per-user
   data, but tightening it once a real domain exists is a five-minute,
   zero-risk change (`ephemeris-service/app.py:22`).

### Verifying it worked

- Visit the domain, confirm `login.html` (or `index.html`) loads over
  `https://`.
- Log in with an existing account (or invite yourself — see Part B) and
  confirm the chart loads, the sky visualizer renders, and **Ask** returns
  a response (that last one round-trips through the Cloudflare Worker, so
  it's the one step that exercises everything at once).
- Open the browser console while doing that — no red errors should appear.
  If Supabase calls fail with a CORS or redirect error, it's almost always
  the Site URL/Redirect URLs step in §0.

---

## Part B — Generating invitations

There's no separate invite-code table or generator in this app — by design
(`de_caelo_master_reference.md:138`): Supabase Auth's own
`inviteUserByEmail` already does the whole job — creates the pending
account, generates the one-time link, sends the email. "Generating an
invitation" here means calling that, either by hand per-person or scripted
for a batch.

### Method 1 — one person, by hand (no setup)

1. **Supabase Dashboard → Authentication → Users → Invite user.**
2. Enter their email, confirm.
3. Supabase emails them a link. They click it, land on your `login.html`
   with a "set a password" form (this is the `#type=invite...` hash
   `login.js` looks for), set one, and land on `onboarding.html` to enter
   their birth data and compute their chart.

That's the entire flow — nothing else to configure for a single invite.

### Method 2 — several at once, scripted

For inviting a handful of friends in one go rather than repeating Method 1.
This needs the Supabase **service-role key** (Project Settings → API →
`service_role` secret) — treat that key like a root password: it bypasses
every RLS policy in the database. Run this only from your own machine,
never in a browser or in any file that gets committed:

```js
// invite.js — run locally: node invite.js
// npm install @supabase/supabase-js first if you don't have it.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://kpqbqawkcgxqrydudyay.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY   // paste the key when running, don't hardcode it here
);

const emails = [
  'friend1@example.com',
  'friend2@example.com',
];

for (const email of emails) {
  const { error } = await supabase.auth.admin.inviteUserByEmail(email);
  console.log(email, error ? `FAILED: ${error.message}` : 'invited');
}
```

Run it as:

```
SUPABASE_SERVICE_ROLE_KEY=eyJ...paste-the-real-key... node invite.js
```

Passing the key as an environment variable on the command line (rather than
pasting it into the file) keeps it out of shell history files that persist
across sessions in some setups, and out of git entirely — delete `invite.js`
after use, or keep it locally with the key line left blank; either way, it
must never be committed with a real key in it.

### Customizing the invite email (optional)

Supabase's default invite email is generic ("You have been invited..."). To
match the app's own dry, direct tone: **Dashboard → Authentication → Email
Templates → Invite user**. It's plain HTML with a few template variables
(`{{ .ConfirmationURL }}` is the one that matters — leave it in place,
that's the actual invite link). Optional, doesn't affect whether invites
work.
