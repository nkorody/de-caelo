/**
 * De Caelo — chat backend
 *
 * Deploy this as a Cloudflare Worker. It is the ONLY piece of this system that
 * touches your Anthropic API key. The HTML page never sees it.
 *
 * §4.3 of the reference doc: this Worker does NOT trust a client-supplied
 * chart context. The client sends only a question and its own Supabase JWT.
 * The Worker verifies that JWT against Supabase itself, then uses it (not
 * the service-role key) to re-fetch that user's own chart and recent chat
 * history — RLS applies to the Worker exactly as it does to the browser, so
 * even a compromised or malicious Worker request can't pull another user's
 * data. The context sent to Claude is built here, server-side, from what
 * that fetch actually returns.
 *
 * Setup:
 *   1. npx wrangler init de-caelo-chat   (or paste this file into a Worker
 *      created in the Cloudflare dashboard — no build step needed)
 *   2. Set secrets, never as plain text in this file:
 *        npx wrangler secret put ANTHROPIC_API_KEY
 *        npx wrangler secret put SUPABASE_URL
 *        npx wrangler secret put SUPABASE_ANON_KEY
 *      (SUPABASE_URL/SUPABASE_ANON_KEY aren't secret in the sense of needing
 *      to be hidden — the frontend embeds the anon key too — but wrangler
 *      secrets are the simplest way to set any Worker env var without
 *      editing this file, so they're set the same way.)
 *   3. Optional: set CHAT_ACCESS_KEY the same way. If you set it, the
 *      frontend must send the same value in the X-Chat-Key header. This is
 *      a mild deterrent against a stranger who finds the Worker URL and
 *      starts sending it requests, not real security — the key is visible
 *      to anyone who reads the frontend's page source. Leave unset if you
 *      don't want the check.
 *   4. npx wrangler deploy
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Chat-Key, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, origin){
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ---------- astro helpers (mirrors astro-lib.js's pure-math functions) ----------
const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
const MAJOR_ASPECTS = [
  { name: 'Conjunction', angle: 0, orb: 6 }, { name: 'Opposition', angle: 180, orb: 6 },
  { name: 'Trine', angle: 120, orb: 5 }, { name: 'Square', angle: 90, orb: 5 },
  { name: 'Sextile', angle: 60, orb: 4 }, { name: 'Quincunx', angle: 150, orb: 3 },
];
const TRANSIT_ORB = 3; // tighter orb for "currently active" transits worth mentioning

function norm360(x){ x = x % 360; return x < 0 ? x + 360 : x; }
function angularSep(a, b){ const d = Math.abs(norm360(a) - norm360(b)); return Math.min(d, 360 - d); }
function degToSign(lon){
  lon = norm360(lon);
  const idx = Math.floor(lon / 30);
  const pos = lon % 30;
  return { sign: SIGNS[idx], deg: Math.floor(pos), min: Math.floor((pos - Math.floor(pos)) * 60) };
}
function fmtDeg(lon){ const p = degToSign(lon); return `${p.deg}°${String(p.min).padStart(2,'0')}' ${p.sign}`; }
function houseOf(lon, cusps){
  lon = norm360(lon);
  const c = cusps.map(norm360);
  for(let i = 0; i < 12; i++){
    const start = c[i], end = c[(i+1) % 12];
    if(start < end){ if(start <= lon && lon < end) return i + 1; }
    else { if(lon >= start || lon < end) return i + 1; }
  }
  return 12;
}
function findAspects(points){
  const names = Object.keys(points);
  const out = [];
  for(let i = 0; i < names.length; i++){
    for(let j = i + 1; j < names.length; j++){
      const sep = angularSep(points[names[i]], points[names[j]]);
      for(const a of MAJOR_ASPECTS){
        const delta = Math.abs(sep - a.angle);
        if(delta <= a.orb){ out.push({ p1: names[i], p2: names[j], aspect: a.name, orb: delta }); break; }
      }
    }
  }
  return out.sort((a, b) => a.orb - b.orb);
}

function buildChartContext(natal, prog, transits){
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const lines = [];

  lines.push(`BIRTH: ${natal.birth.place}, ${natal.birth.month}/${natal.birth.day}/${natal.birth.year} ${natal.birth.hour}:${String(natal.birth.minute).padStart(2,'0')}`);
  const sun = natal.points['Sun'], moon = natal.points['Moon'], asc = natal.points['Ascendant'];
  lines.push(`BIG THREE: Sun ${fmtDeg(sun.lon)} (house ${sun.house_placidus}), Moon ${fmtDeg(moon.lon)} (house ${moon.house_placidus}), Ascendant ${fmtDeg(asc.lon)}`);
  lines.push(`CHART RULER: Ascendant in ${natal.chart_ruler.asc_sign}, ruled by ${natal.chart_ruler.modern}`);
  lines.push(`SECT: ${natal.sect.is_day ? 'day' : 'night'} chart, sect light ${natal.sect.light}`);

  lines.push('\nNATAL PLACEMENTS:');
  for(const [name, p] of Object.entries(natal.points)){
    if(['Descendant','Imum Coeli','Vertex'].includes(name)) continue;
    const houseStr = p.house_placidus ? `, house ${p.house_placidus}` : '';
    lines.push(`${name} ${fmtDeg(p.lon)}${houseStr}${p.retrograde ? ', retrograde' : ''}`);
  }

  lines.push('\nNATAL ASPECTS (tightest 12):');
  const natalAspects = [...natal.aspects].sort((a, b) => a.orb - b.orb).slice(0, 12);
  for(const a of natalAspects) lines.push(`${a.p1} ${a.aspect} ${a.p2}, orb ${a.orb.toFixed(2)}°`);

  // current transiting positions
  const dateIdx = transits.dates.indexOf(todayStr);
  const idx = dateIdx >= 0 ? dateIdx : transits.dates.length - 1;
  const transitLons = {};
  for(const b of transits.bodies) transitLons[b] = transits.lon[b][idx];

  lines.push(`\nTODAY'S SKY (${transits.dates[idx]}):`);
  for(const b of transits.bodies) lines.push(`${b} ${fmtDeg(transitLons[b])}`);

  lines.push('\nTRANSITS TO NATAL CHART (orb < 3°):');
  const cusps = natal.houses_placidus.cusps;
  for(const b of transits.bodies){
    for(const [nname, np] of Object.entries(natal.points)){
      if(['Descendant','Imum Coeli','Vertex'].includes(nname)) continue;
      const sep = angularSep(transitLons[b], np.lon);
      for(const asp of MAJOR_ASPECTS){
        const delta = Math.abs(sep - asp.angle);
        if(delta <= Math.min(asp.orb, TRANSIT_ORB)){
          const house = houseOf(transitLons[b], cusps);
          lines.push(`Transiting ${b} ${asp.name} natal ${nname}, orb ${delta.toFixed(2)}° (transiting ${b} currently in your house ${house})`);
          break;
        }
      }
    }
  }

  // stations and ingresses in the surrounding two weeks
  lines.push('\nSTATIONS & INGRESSES (next 14 days):');
  const startIdx = idx, endIdx = Math.min(transits.dates.length - 1, idx + 14);
  let foundEvent = false;
  for(const b of transits.bodies){
    for(let i = Math.max(1, startIdx); i <= endIdx; i++){
      if(b !== 'Moon' && b !== 'Sun' && b !== 'North Node'){
        const sp0 = transits.speed[b][i-1], sp1 = transits.speed[b][i];
        if(Math.sign(sp0) !== Math.sign(sp1) && sp0 !== 0){
          lines.push(`${transits.dates[i]}: ${b} turns ${sp1 < 0 ? 'retrograde' : 'direct'}`);
          foundEvent = true;
        }
      }
      const s0 = Math.floor(norm360(transits.lon[b][i-1]) / 30);
      const s1 = Math.floor(norm360(transits.lon[b][i]) / 30);
      if(s0 !== s1){ lines.push(`${transits.dates[i]}: ${b} enters ${SIGNS[s1]}`); foundEvent = true; }
    }
  }
  if(!foundEvent) lines.push('None.');

  // secondary progressions / solar arc, interpolated for today from the age-indexed table
  const birthDate = new Date(Date.UTC(natal.birth.year, natal.birth.month - 1, natal.birth.day));
  const ageYears = Math.max(0, Math.min(prog.max_age, (today - birthDate) / (1000 * 3600 * 24 * 365.2425)));
  const lo = Math.floor(ageYears), hi = Math.min(prog.max_age, lo + 1), frac = ageYears - lo;
  const lerp = (arr) => arr[lo] + (arr[hi] - arr[lo]) * frac;
  const progLons = {};
  for(const b of Object.keys(prog.lon)) progLons[b] = norm360(lerp(prog.lon[b]));
  const progAsc = norm360(lerp(prog.ascendant)), progMc = norm360(lerp(prog.midheaven));
  const arc = norm360(progLons['Sun'] - natal.points['Sun'].lon);

  lines.push(`\nPROGRESSIONS (secondary, age ${ageYears.toFixed(1)}):`);
  lines.push(`Progressed Sun ${fmtDeg(progLons['Sun'])}, Moon ${fmtDeg(progLons['Moon'])}, Ascendant ${fmtDeg(progAsc)}, Midheaven ${fmtDeg(progMc)}`);
  lines.push(`Solar arc: ${arc.toFixed(2)}° directed`);

  return lines.join('\n');
}

// ---------- Supabase-backed request handling ----------
async function verifyUser(request, env){
  const auth = request.headers.get('Authorization');
  if(!auth) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  if(!res.ok) return null;
  const user = await res.json();
  return user && user.id ? { id: user.id, jwt: auth } : null;
}

async function supaSelect(env, jwt, path){
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { Authorization: jwt, apikey: env.SUPABASE_ANON_KEY },
  });
  if(!res.ok) return null;
  return res.json();
}

async function supaInsert(env, jwt, table, row){
  await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { Authorization: jwt, apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
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
      if (provided !== env.CHAT_ACCESS_KEY) return jsonResponse({ error: 'unauthorized' }, 401, origin);
    }
    if (!env.ANTHROPIC_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return jsonResponse({ error: 'server misconfigured: missing ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_ANON_KEY' }, 500, origin);
    }

    const user = await verifyUser(request, env);
    if (!user) return jsonResponse({ error: 'unauthorized: invalid or missing session' }, 401, origin);

    let body;
    try { body = await request.json(); }
    catch (e) { return jsonResponse({ error: 'invalid JSON body' }, 400, origin); }

    const question = String(body.question || '').slice(0, 2000);
    if (!question.trim()) return jsonResponse({ error: 'empty question' }, 400, origin);

    try {
      const [chartRows, skyRows, historyRows] = await Promise.all([
        supaSelect(env, user.jwt, `charts?select=natal_json,prog_json&user_id=eq.${user.id}`),
        supaSelect(env, user.jwt, `sky_snapshots?select=transit_json&id=eq.1`),
        supaSelect(env, user.jwt, `chat_messages?select=role,content&user_id=eq.${user.id}&order=created_at.desc&limit=10`),
      ]);

      const chart = chartRows && chartRows[0];
      const sky = skyRows && skyRows[0];
      if (!chart || !sky) return jsonResponse({ error: 'no chart computed yet for this user' }, 409, origin);

      const chartContext = buildChartContext(chart.natal_json, chart.prog_json, sky.transit_json);
      const history = (historyRows || []).reverse().map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 2000),
      }));
      const messages = [...history, { role: 'user', content: question }];

      // Occasionally the API returns 200 with no text content block. Rare and not
      // reproducible against identical input on retry, so treat it as transient:
      // one retry before giving up rather than surfacing a bare "(no response)".
      let text = '';
      let lastErrText = '';
      for (let attempt = 0; attempt < 2 && !text; attempt++) {
        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            // Confirmed via live Worker logs: this model does extended thinking by
            // default, and a "thinking" content block counts against max_tokens.
            // At 700, thinking alone could consume the whole budget before any
            // visible text was produced (stop_reason: max_tokens, empty thinking
            // block, zero text blocks) -- not rare, reproduced on back-to-back
            // requests. Raised well past a plausible thinking-pass length.
            max_tokens: 4096,
            system: SYSTEM_PROMPT + '\n\n--- CHART AND CURRENT SKY DATA ---\n\n' + chartContext,
            messages,
          }),
        });

        if (!apiRes.ok) {
          lastErrText = await apiRes.text();
          console.error(`Anthropic API error, attempt ${attempt + 1}, status ${apiRes.status}:`, lastErrText.slice(0, 1000));
          continue;
        }

        const data = await apiRes.json();
        text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (!text) {
          console.error(`Empty text content, attempt ${attempt + 1}. stop_reason=${data.stop_reason}, content=`, JSON.stringify(data.content).slice(0, 500));
        }
      }

      if (!text) {
        return jsonResponse({ error: 'Anthropic API error', detail: (lastErrText || 'empty response after retry').slice(0, 500) }, 502, origin);
      }
      const reply = text;

      // Sequential, not Promise.all: created_at ordering has to match conversation
      // order, since history is later reconstructed by sorting on it. Concurrent
      // inserts don't guarantee which one the database timestamps first -- confirmed
      // this really happens (assistant rows landing a few ms before the user row
      // that prompted them), which corrupts history ordering and breaks Anthropic's
      // strict user/assistant alternation requirement on the next question.
      await supaInsert(env, user.jwt, 'chat_messages', { user_id: user.id, role: 'user', content: question });
      await supaInsert(env, user.jwt, 'chat_messages', { user_id: user.id, role: 'assistant', content: reply });

      return jsonResponse({ reply }, 200, origin);
    } catch (e) {
      return jsonResponse({ error: 'worker exception', detail: String(e).slice(0, 500) }, 500, origin);
    }
  },
};
