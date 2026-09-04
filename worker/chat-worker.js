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

// Full-reading generation (§ "Replace hardcoded INTERP with per-user generated
// readings") — this used to be a single hardcoded object in frontend/app.html,
// written for one person's chart and shown unconditionally to every account.
// This prompt/schema pair replaces it with one real per-user LLM call, run
// once at onboarding, producing content in the exact shape the frontend
// already reads.
export const GENERATE_SYSTEM_PROMPT = `You are writing the full natal-chart reading for a specific person, using their real chart computed with the Swiss Ephemeris and supplied to you below. This is not a generic horoscope generator: every paragraph must be grounded in the specific data given -- name the actual sign, house, degree, dignity, or aspect driving what you write, not generic sign-trait copy.

Tone: dry, direct, declarative. Write the way a technically literate astrologer would write a private reference document, not the way a horoscope app copywriter would. No em dashes. No "not X but Y" constructions. No mystical filler ("the universe is asking you to..."), no stacked qualifiers, no forced optimism. Each piece of text is two to five sentences.

You are producing many separate pieces of text in one response, matching the exact structure requested: one overview paragraph synthesizing the whole chart, one paragraph per placement (planet/point) listed, one paragraph synthesizing essential dignities across the traditional seven, one paragraph for the modern dispositor chain and one for the traditional dispositor chain, one paragraph per fixed-star conjunction listed, one paragraph per Arabic Part listed, one paragraph per harmonic chart (5th, 7th, 9th), and one paragraph per natal aspect listed, in the exact order each list is given. Each piece stands alone -- assume the reader is looking at just that one paragraph next to that one placement or aspect, not reading start to finish, so never refer back to "as mentioned above" or forward to "as we'll see."`;

// All ~20 points the frontend's INTERP.placements has always covered (§ same).
// Filtered against natal.points at call time so a chart missing a point (it
// shouldn't happen, but compute.py is the source of truth, not this list)
// degrades to fewer paragraphs rather than a bad prompt.
const PLACEMENT_NAMES = [
  'Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
  'Chiron', 'North Node', 'South Node', 'Black Moon Lilith', 'Ascendant', 'Midheaven',
  'Ceres', 'Pallas', 'Juno', 'Vesta',
];

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

// Builds the prompt context for a full readings generation, purely from
// natal_json's already-computed structures (compute.py's compute_natal — no
// new ephemeris math needed here). Returns the enumerated lists alongside the
// prompt text because the Worker needs the exact same order again afterward,
// to zip the model's positional arrays back into the frontend's keyed shapes.
//
// houseSystem picks which of compute.py's two parallel house computations
// (§ "Whole Sign toggle with alternative readings") feeds every house-number
// mention below -- 'placidus' (default, matches the original onboarding
// generation) or 'whole_sign'. Everything else in the chart (signs, aspects,
// dignities, dispositors) is house-system-invariant, so only the house
// numbers threaded into PLACEMENTS and ARABIC PARTS below actually change;
// the rest of the prompt, and the whole schema, stays identical either way.
export function buildReadingsContext(natal, houseSystem = 'placidus'){
  const houseField = houseSystem === 'whole_sign' ? 'house_whole_sign' : 'house_placidus';
  const lines = [];
  lines.push(`BIRTH: ${natal.birth.place}, ${natal.birth.month}/${natal.birth.day}/${natal.birth.year} ${natal.birth.hour}:${String(natal.birth.minute).padStart(2,'0')}`);
  lines.push(`CHART RULER: Ascendant in ${natal.chart_ruler.asc_sign}, ruled by ${natal.chart_ruler.modern} (modern), ${natal.chart_ruler.traditional} (traditional)`);
  lines.push(`SECT: ${natal.sect.is_day ? 'day' : 'night'} chart, sect light ${natal.sect.light}`);
  lines.push(`HOUSE SYSTEM: ${houseSystem === 'whole_sign' ? 'Whole Sign' : 'Placidus'}`);

  const placementNames = PLACEMENT_NAMES.filter(name => natal.points[name]);
  lines.push('\nPLACEMENTS (one paragraph per entry, in this order):');
  for(const name of placementNames){
    const p = natal.points[name];
    const houseStr = p[houseField] ? `, house ${p[houseField]}` : '';
    lines.push(`${name}: ${fmtDeg(p.lon)}${houseStr}${p.retrograde ? ', retrograde' : ''}`);
  }

  lines.push('\nESSENTIAL DIGNITIES (traditional seven; synthesize into one paragraph):');
  for(const [name, d] of Object.entries(natal.dignities || {})){
    lines.push(`${name}: score ${d.score >= 0 ? '+' : ''}${d.score}, ${(d.tags || []).join(', ') || 'peregrine'}`);
  }

  lines.push('\nDISPOSITOR CHAIN, modern rulership (one paragraph):');
  for(const [p, chain] of Object.entries(natal.dispositors?.modern?.chains || {})) lines.push(`${p} -> ${chain.join(' -> ')}`);
  lines.push('\nDISPOSITOR CHAIN, traditional rulership (one paragraph):');
  for(const [p, chain] of Object.entries(natal.dispositors?.traditional?.chains || {})) lines.push(`${p} -> ${chain.join(' -> ')}`);

  const aspects = [...(natal.aspects || [])].sort((a, b) => a.orb - b.orb).slice(0, 20);
  lines.push(`\nNATAL ASPECTS (${aspects.length}, one paragraph per entry, in this order):`);
  aspects.forEach((a, i) => lines.push(`${i + 1}. ${a.p1} ${a.aspect} ${a.p2}, orb ${a.orb.toFixed(2)}°`));

  const stars = natal.fixed_stars || [];
  lines.push(`\nFIXED STAR CONJUNCTIONS (${stars.length}, one paragraph per entry, in this order):`);
  stars.forEach((h, i) => lines.push(`${i + 1}. ${h.point} conjunct ${h.star}, orb ${h.orb.toFixed(2)}°`));

  const partNames = Object.keys(natal.arabic_parts || {});
  lines.push('\nARABIC PARTS (one paragraph per entry, in this order):');
  for(const name of partNames){
    const p = natal.arabic_parts[name];
    // p.house is a pre-split-schema fallback (compute.py started emitting
    // house_placidus/house_whole_sign together, see compute_natal) for any
    // chart row computed before that change.
    const houseNum = p[houseField] ?? p.house;
    lines.push(`${name}: ${p.deg}°${String(p.min).padStart(2,'0')}' ${p.sign}, house ${houseNum}`);
  }

  lines.push('\nHARMONICS (one paragraph each for the 5th, 7th, and 9th harmonic chart):');
  for(const h of [5, 7, 9]){
    const hd = natal.harmonics?.[String(h)];
    if(!hd){ lines.push(`${h}H: no data`); continue; }
    const posStr = Object.entries(hd.positions || {}).map(([n, pp]) => `${n} ${pp.deg}°${String(pp.min).padStart(2,'0')}' ${pp.sign}`).join(', ');
    const aspStr = (hd.aspects || []).slice(0, 8).map(a => `${a.p1} ${a.aspect} ${a.p2} (${a.orb.toFixed(2)}°)`).join(', ');
    lines.push(`${h}H positions: ${posStr}`);
    lines.push(`${h}H tightest aspects: ${aspStr || 'none within orb'}`);
  }

  return { text: lines.join('\n'), placementNames, aspects, stars, partNames };
}

// Structured-output schema for the call above. output_config.format requires
// additionalProperties:false on every object, so it's built per-request from
// the placement/part names actually present on this chart rather than
// hardcoded (arabic_parts is a fixed 8 lots in practice, but derived here
// rather than assumed).
export function buildReadingsSchema(placementNames, partNames){
  const str = { type: 'string' };
  const placementProps = {}; for(const name of placementNames) placementProps[name] = str;
  const partProps = {}; for(const name of partNames) partProps[name] = str;

  return {
    type: 'object',
    additionalProperties: false,
    required: ['overview', 'placements', 'dignitySynthesis', 'dispositorsModern', 'dispositorsTraditional', 'fixedStars', 'arabicParts', 'harmonic5', 'harmonic7', 'harmonic9', 'aspects'],
    properties: {
      overview: str,
      placements: { type: 'object', additionalProperties: false, required: placementNames, properties: placementProps },
      dignitySynthesis: str,
      dispositorsModern: str,
      dispositorsTraditional: str,
      fixedStars: { type: 'array', items: str },
      arabicParts: { type: 'object', additionalProperties: false, required: partNames, properties: partProps },
      harmonic5: str,
      harmonic7: str,
      harmonic9: str,
      aspects: { type: 'array', items: str },
    },
  };
}

// Mirrors app.html's aspectKey() exactly — the reassembled interp_json has to
// use the identical key shape or findAspectInterp's lookups silently miss.
export function aspectKey(p1, p2, aspect){ return [p1, p2].sort().join('|') + '|' + aspect; }

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

// Shared by the /generate-readings route below and the local backfill script
// (imported directly from there) so the two can't drift into two different
// bugs, the way max_tokens already did once. Throws on any failure; callers
// decide how to surface that (HTTP response here, a logged "FAILED" line in
// the backfill script).
export async function generateReadings(natal, apiKey, houseSystem = 'placidus') {
  const { text: chartContext, placementNames, aspects, stars, partNames } = buildReadingsContext(natal, houseSystem);
  const schema = buildReadingsSchema(placementNames, partNames);

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      // 8192 truncated a real response mid-string (adaptive thinking plus a
      // ~10-section, ~50-field structured JSON output can run past that) --
      // reproduced live, not hypothetical. 16000 matches the ceiling already
      // used for the (much shorter) chat endpoint elsewhere in this file.
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system: GENERATE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'CHART DATA:\n\n' + chartContext }],
    }),
  });

  if (!apiRes.ok) {
    throw new Error(`Anthropic API error ${apiRes.status}: ${(await apiRes.text()).slice(0, 500)}`);
  }

  const data = await apiRes.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error(`empty structured response, stop_reason=${data.stop_reason}`);
  }

  let parsed;
  try { parsed = JSON.parse(textBlock.text); }
  catch (e) {
    // A parse failure here almost always means the response was truncated
    // mid-string -- stop_reason distinguishes that from a genuinely malformed
    // response, which output_config.format's schema enforcement should
    // otherwise rule out.
    throw new Error(`unparseable structured response (stop_reason=${data.stop_reason}): ${e.message}`);
  }

  // Reassemble the two positionally-ordered arrays into the exact
  // `${point}|${star}` / aspectKey() shapes app.html's INTERP.fixedStars
  // and INTERP.aspects already use — see file header comment on why the
  // model isn't asked to produce these compound keys itself.
  const fixedStars = {};
  stars.forEach((h, i) => { if (parsed.fixedStars[i] !== undefined) fixedStars[`${h.point}|${h.star}`] = parsed.fixedStars[i]; });
  const aspectsOut = {};
  aspects.forEach((a, i) => { if (parsed.aspects[i] !== undefined) aspectsOut[aspectKey(a.p1, a.p2, a.aspect)] = parsed.aspects[i]; });

  return {
    overview: parsed.overview,
    placements: parsed.placements,
    dignitySynthesis: parsed.dignitySynthesis,
    dispositors: { modern: parsed.dispositorsModern, traditional: parsed.dispositorsTraditional },
    fixedStars,
    arabicParts: parsed.arabicParts,
    harmonics: { '5': parsed.harmonic5, '7': parsed.harmonic7, '9': parsed.harmonic9 },
    aspects: aspectsOut,
  };
}

// /generate-readings — full-chart reading generation. Called once from
// onboarding.js right after /compute-chart resolves (Placidus, the default),
// and again later from app.html's house-system toggle the first time a user
// switches to Whole Sign (§ "Whole Sign toggle with alternative readings") --
// same route, same shape, just a second houseSystem value and a different
// caller. Same key-holder, same JWT-verified-user gate as chat; the
// difference is the request carries the natal chart directly (both callers
// already have it in memory — no round trip through Supabase needed) and the
// response is meant to be merged into a `charts` row by the caller, not
// stored here.
async function handleGenerateReadings(request, env, origin, user) {
  let body;
  try { body = await request.json(); }
  catch (e) { return jsonResponse({ error: 'invalid JSON body' }, 400, origin); }

  const natal = body.natal;
  if (!natal || !natal.points) return jsonResponse({ error: 'missing natal chart data' }, 400, origin);

  const houseSystem = body.houseSystem === 'whole_sign' ? 'whole_sign' : 'placidus';

  try {
    const interp = await generateReadings(natal, env.ANTHROPIC_API_KEY, houseSystem);
    return jsonResponse({ interp }, 200, origin);
  } catch (e) {
    console.error('generate-readings failed:', String(e).slice(0, 1000));
    return jsonResponse({ error: 'generation failed', detail: String(e).slice(0, 500) }, 502, origin);
  }
}

async function handleChat(request, env, origin, user) {
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
            // claude-sonnet-5 runs adaptive extended thinking by default -- there's
            // no way to omit it into a no-thinking mode the way older models work,
            // and a "thinking" content block counts against max_tokens. Raising
            // max_tokens alone (700 -> 4096, an earlier fix) still left a real
            // failure rate: thinking length is variable per request, so it could
            // still consume the whole budget before any visible text, especially
            // on an open-ended question (stop_reason: max_tokens, zero text
            // blocks) -- reproduced live, not rare. output_config.effort:"low" is
            // the documented lever for this (bounds thinking depth/spend directly,
            // rather than betting max_tokens is high enough to outrun it) --
            // appropriate here since the system prompt already asks for short,
            // direct answers, not deep multi-step reasoning. max_tokens raised to
            // 16000 (the documented non-streaming default) as headroom on top of
            // that, not as the primary fix.
            max_tokens: 16000,
            output_config: { effort: 'low' },
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

    // Path-based routing on the same Worker/deploy/secrets rather than a
    // second Worker — this file's header comment states it's deliberately
    // the only thing that touches ANTHROPIC_API_KEY; that invariant holds by
    // adding a route here instead of a new key-holder.
    const path = new URL(request.url).pathname;
    if (path === '/generate-readings') {
      return handleGenerateReadings(request, env, origin, user);
    }
    return handleChat(request, env, origin, user);
  },
};
