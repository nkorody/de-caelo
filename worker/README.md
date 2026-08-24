# De Caelo — chat backend

This is the only piece of the whole system that touches your Anthropic API
key. It's a single Cloudflare Worker: no server to run, no framework, free
for anything short of heavy daily use (Cloudflare's free tier is 100,000
requests/day).

## What it does

The HTML page computes your real natal chart and the real current transits,
progressions, and solar arc client-side (it already has Swiss Ephemeris data
through 2034 embedded). When you ask a question in the Ask tab, it sends
your question plus a compact summary of that real data to this Worker. The
Worker adds a system prompt (tone, grounding rules, the instruction to say
"nothing relevant" when that's true) and calls Claude with your API key.
Nothing about your chart is stored anywhere except in your own browser's
local storage, for conversation history.

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
   That's your `CHAT_ENDPOINT`.

   If you'd rather not install anything: create a Worker in the Cloudflare
   dashboard (Workers & Pages → Create → Create Worker), paste the contents
   of `chat-worker.js` into the editor, and deploy from there instead.

4. **Set your API key as a secret** (never plain text in the file):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste your key when prompted. Or in the dashboard: your Worker → Settings
   → Variables → add an encrypted variable named `ANTHROPIC_API_KEY`.

5. **Optional — set an access key.** The Worker URL is callable by anyone who
   finds it, since it has to be reachable from a plain static HTML page with
   no login. Setting `CHAT_ACCESS_KEY` raises the bar from "anyone who finds
   the URL" to "anyone who reads your page source," which is not real
   security but stops casual scraping:
   ```
   wrangler secret put CHAT_ACCESS_KEY
   ```
   If you set this, put the exact same value in the `CHAT_ACCESS_KEY`
   constant near the top of `natal_chart.html`. If you don't set it on the
   Worker, leave the HTML constant blank too and the check is skipped
   entirely.

6. **Point the HTML at your Worker.** Open `natal_chart.html`, find:
   ```js
   window.CHAT_ENDPOINT = "";
   window.CHAT_ACCESS_KEY = "";
   ```
   near the top, fill in your Worker URL (and access key if you set one),
   save, and re-upload it to wherever you're hosting it. The Ask tab will
   show setup instructions instead of the chat until this is filled in.

## Cost control

`max_tokens` is capped at 700 per reply and the model is Claude Sonnet,
which keeps this cheap for personal use. If you want it cheaper still,
change `model: 'claude-sonnet-5'` to `'claude-haiku-4-5-20251001'` in
`chat-worker.js` and redeploy; answers will be faster and less nuanced.

## If you want to lock it down further

The access-key approach above is a deterrent, not real auth. If this ever
becomes a problem (someone actually hammering your Worker), real options
include: Cloudflare Access in front of the Worker route (free for a
handful of users, adds an actual login), or IP allowlisting if you only
ever use this from known networks. Neither is set up here, both are
straightforward to add later if needed.
