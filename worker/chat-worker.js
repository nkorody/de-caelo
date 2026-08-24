/**
 * De Caelo — chat backend
 *
 * Deploy this as a Cloudflare Worker. It is the ONLY piece of this system that
 * touches your Anthropic API key. The HTML page never sees it.
 *
 * Setup:
 *   1. npx wrangler init de-caelo-chat   (or paste this file into a Worker
 *      created in the Cloudflare dashboard — no build step needed)
 *   2. Set your API key as a secret, never as plain text in this file:
 *        npx wrangler secret put ANTHROPIC_API_KEY
 *      (or Dashboard -> your Worker -> Settings -> Variables -> add an
 *      encrypted variable named ANTHROPIC_API_KEY)
 *   3. Optional: set CHAT_ACCESS_KEY the same way. If you set it, the HTML
 *      page must send the same value in the CHAT_ACCESS_KEY constant near
 *      the top of natal_chart.html. This is a mild deterrent against a
 *      stranger who finds the Worker URL and starts sending it requests,
 *      not real security — the key is visible to anyone who views the page
 *      source, same as your chart data already is. Leave both blank if you
 *      don't want the check.
 *   4. npx wrangler deploy
 *   5. Copy the resulting workers.dev URL into CHAT_ENDPOINT in
 *      natal_chart.html.
 */

const SYSTEM_PROMPT = `You are answering practical questions using a specific person's real natal chart and the actual current positions of the planets, both computed with the Swiss Ephemeris and supplied to you below. This is not a generic horoscope generator. Every reply must be grounded in the specific data given: name the actual planet, sign, house, and orb driving your answer.

Tone: dry, direct, declarative. Write the way a technically literate astrologer would write a private note, not the way a horoscope app copywriter would. No em dashes. No "not X but Y" constructions. No mystical filler ("the universe is asking you to..."), no stacked qualifiers, no forced optimism. Short paragraphs. A reply is often two to four sentences; go longer only if the question genuinely needs it.

If nothing in the chart or the current sky is specifically relevant to the question, say so plainly and briefly rather than manufacturing a reading. A true "nothing notable right now" is a legitimate and useful answer.

This is a personal reflective tool, not licensed legal, financial, or medical advice. For questions that touch real decisions (contracts, money, health, travel), you can and should still give a grounded astrological read, since that is what this tool is for, but do not present the astrology as a substitute for actually reading the contract or consulting whoever that decision really requires. Keep this in the background of how you write rather than repeating it as a disclaimer every reply.

You will be given the natal chart, current transiting positions, transits to the natal chart, any stations or sign changes in the surrounding two weeks, and the current secondary progressions and solar arc directions. Use whatever is actually relevant to the question and ignore the rest.`;

function corsHeaders(origin){
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Chat-Key',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
    }

    if (env.CHAT_ACCESS_KEY) {
      const provided = request.headers.get('X-Chat-Key');
      if (provided !== env.CHAT_ACCESS_KEY) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const question = String(body.question || '').slice(0, 2000);
    const chartContext = String(body.chartContext || '').slice(0, 20000);
    let history = Array.isArray(body.history) ? body.history : [];
    // keep payload and cost bounded: last 10 turns, short messages only
    history = history.slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 2000),
    }));

    if (!question.trim()) {
      return new Response(JSON.stringify({ error: 'empty question' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'server misconfigured: ANTHROPIC_API_KEY not set' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const messages = [...history, { role: 'user', content: question }];

    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 700,
          system: SYSTEM_PROMPT + '\n\n--- CHART AND CURRENT SKY DATA ---\n\n' + chartContext,
          messages,
        }),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        return new Response(JSON.stringify({ error: 'Anthropic API error', detail: errText.slice(0, 500) }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }

      const data = await apiRes.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

      return new Response(JSON.stringify({ reply: text || '(no response)' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'worker exception', detail: String(e).slice(0, 500) }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  },
};
