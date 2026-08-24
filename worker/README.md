# De Caelo — chat backend

This is the only piece of the whole system that touches your Anthropic API
key. It's a single Cloudflare Worker: no server to run, no framework, free
for anything short of heavy daily use (Cloudflare's free tier is 100,000
requests/day).

## What it does

The frontend sends a question plus the user's own Supabase session (JWT) —
nothing else. The Worker verifies that JWT against Supabase, then uses it
(not a service-role key, not anything the client claims about its own chart)
to re-fetch that user's `charts` row and the shared `sky_snapshots` row
itself. Row Level Security applies to the Worker's request exactly as it
does to the browser's, so this isn't the Worker trusting the client — it's
Postgres enforcing that the Worker literally cannot pull another user's
chart, even if it wanted to. The Worker builds the natal/transit/progression
summary from that data server-side, adds a system prompt (tone, grounding
rules, the instruction to say "nothing relevant" when that's true), calls
Claude with your API key, and writes both the question and the reply into
that user's own `chat_messages` rows (again, via the user's JWT — RLS-scoped
the same way).

## Setup

1. **Get an Anthropic API key**, if you don't have one: console.anthropic.com
   → Get API Keys. This is billed separately from any Claude.ai subscription,
   pay-as-you-go by usage. A few hundred short questions will cost cents to
   low dollars depending on model.

2. **Install Wrangler** (Cloudflare's CLI), if you don't have it:
   ```
   npm install -g wrangler
   wrangler login
   ```

3. **Deploy from this folder:**
   ```
   cd worker
   wrangler deploy
   ```
   This prints a URL like `https://de-caelo-chat.YOUR-SUBDOMAIN.workers.dev`.
   That's your `EPHEMERIS_URL`-style endpoint — put it in `frontend/config.js`
   as `CHAT_ENDPOINT`.

   If you'd rather not install anything: create a Worker in the Cloudflare
   dashboard (Workers & Pages → Create → Create Worker), paste the contents
   of `chat-worker.js` into the editor, and deploy from there instead.

4. **Set secrets** (never plain text in the file):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put SUPABASE_URL
   wrangler secret put SUPABASE_ANON_KEY
   ```
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` aren't secret in the sense of
   needing to be hidden — the frontend embeds the anon key too, since RLS is
   the real access boundary, not secrecy of this key — but `wrangler secret
   put` is the simplest way to set any Worker env var without editing this
   file, so they're set the same way.

5. **Optional — set an access key.** The Worker URL is callable by anyone who
   finds it. Setting `CHAT_ACCESS_KEY` raises the bar from "anyone who finds
   the URL" to "anyone who reads your page source," which is not real
   security but stops casual scraping:
   ```
   wrangler secret put CHAT_ACCESS_KEY
   ```
   If you set this, put the exact same value in `frontend/config.js` and
   send it as the `X-Chat-Key` header. If you don't set it on the Worker,
   skip the header entirely and the check is skipped.

6. **Point the frontend at your Worker.** In `frontend/config.js`, set
   `CHAT_ENDPOINT` to your Worker URL. The Ask drawer sends `{question,
   history}` in the body, `Authorization: Bearer <the user's Supabase
   access token>` as a header (get it from `supabase.auth.getSession()`),
   and `X-Chat-Key` only if you set `CHAT_ACCESS_KEY` above.

## Cost control

`max_tokens` is capped at 700 per reply and the model is Claude Sonnet,
which keeps this cheap for personal use. If you want it cheaper still,
change `model: 'claude-sonnet-5'` to `'claude-haiku-4-5-20251001'` in
`chat-worker.js` and redeploy; answers will be faster and less nuanced.

## If you want to lock it down further

The access-key approach above is a deterrent, not real auth — the real auth
is the JWT verification described above. If the access key ever becomes a
problem (someone actually hammering your Worker), real options include:
Cloudflare Access in front of the Worker route (free for a handful of
users, adds an actual login), or IP allowlisting if you only ever use this
from known networks. Neither is set up here, both are straightforward to
add later if needed.
