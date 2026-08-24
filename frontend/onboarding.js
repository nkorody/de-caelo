// Wrapped in an IIFE deliberately: top-level const/let is shared across every
// script tag on the page, including whatever other browser extensions inject.
// See login.js for the specific collision this avoids (a `supabase` identifier
// collision with another extension's own content script broke login.html).
(function(){

const cfg = window.DE_CAELO_CONFIG;
const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

let cities = null;
let selectedCity = null; // {name, region, country, lat, lon}

async function loadCities(){
  const res = await fetch('cities.json');
  cities = await res.json();
}
loadCities();

const placeInput = document.getElementById('place');
const cityResults = document.getElementById('cityResults');

function searchCities(q){
  q = q.trim().toLowerCase();
  if(!q || !cities) return [];
  const matches = [];
  for(const c of cities){
    if(c[0].toLowerCase().startsWith(q)){ matches.push(c); if(matches.length >= 8) break; }
  }
  if(matches.length < 8){
    for(const c of cities){
      if(matches.length >= 8) break;
      if(matches.includes(c)) continue;
      if(c[0].toLowerCase().includes(q)) matches.push(c);
    }
  }
  return matches;
}

placeInput.addEventListener('input', () => {
  selectedCity = null;
  const matches = searchCities(placeInput.value);
  if(matches.length === 0){ cityResults.style.display = 'none'; return; }
  cityResults.innerHTML = '';
  matches.forEach(c => {
    const [name, region, country, lat, lon] = c;
    const label = [name, region, country].filter(Boolean).join(', ');
    const row = document.createElement('div');
    row.className = 'city-result';
    row.textContent = label;
    row.addEventListener('click', () => {
      placeInput.value = label;
      selectedCity = { name, region, country, lat, lon };
      cityResults.style.display = 'none';
      document.getElementById('latManual').value = lat;
      document.getElementById('lonManual').value = lon;
    });
    cityResults.appendChild(row);
  });
  cityResults.style.display = '';
});
document.addEventListener('click', (e) => {
  if(!cityResults.contains(e.target) && e.target !== placeInput) cityResults.style.display = 'none';
});

const manualToggle = document.getElementById('manualToggle');
const manualFields = document.getElementById('manualFields');
manualToggle.addEventListener('click', () => {
  manualFields.classList.toggle('show');
});

const birthForm = document.getElementById('birthForm');
const formState = document.getElementById('formState');
const computingState = document.getElementById('computingState');
const formError = document.getElementById('formError');

function showError(msg){
  formError.textContent = msg;
  formError.classList.add('show');
}

birthForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.remove('show');

  const dateVal = document.getElementById('date').value; // YYYY-MM-DD
  const timeVal = document.getElementById('time').value; // HH:MM
  const place = placeInput.value.trim();
  const latManual = document.getElementById('latManual').value;
  const lonManual = document.getElementById('lonManual').value;

  if(!dateVal || !timeVal || !place){ showError('All fields are required.'); return; }

  let lat, lon;
  if(selectedCity){
    lat = selectedCity.lat; lon = selectedCity.lon;
  } else if(latManual !== '' && lonManual !== ''){
    lat = parseFloat(latManual); lon = parseFloat(lonManual);
  } else {
    showError('Select a city from the list, or enter coordinates manually.');
    return;
  }

  const [year, month, day] = dateVal.split('-').map(Number);
  const [hour, minute] = timeVal.split(':').map(Number);

  formState.style.display = 'none';
  computingState.style.display = '';
  const computingExtra = document.getElementById('computingExtra');
  computingExtra.style.display = 'none';
  const extraMsgTimer = setTimeout(() => { computingExtra.style.display = ''; }, 15000);

  try{
    const { data: { user } } = await supabase.auth.getUser();
    if(!user) throw new Error('Session expired. Please log in again.');

    const { error: birthErr } = await supabase.from('birth_data').upsert({
      user_id: user.id, year, month, day, hour, minute, lat, lon, place,
      utc_offset: 0, // placeholder; the ephemeris service resolves the real offset server-side
    });
    if(birthErr) throw birthErr;

    const chartRes = await fetch(cfg.EPHEMERIS_URL + '/compute-chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ephemeris-Key': cfg.EPHEMERIS_ACCESS_KEY },
      body: JSON.stringify({ year, month, day, hour, minute, lat, lon, place }),
    });
    if(!chartRes.ok) throw new Error('Chart computation failed (' + chartRes.status + '). Try again.');
    const { natal, progressions } = await chartRes.json();

    // the ephemeris service resolves the real utc_offset; store it back on birth_data
    const { error: offsetErr } = await supabase.from('birth_data').update({ utc_offset: natal.birth.utc_offset }).eq('user_id', user.id);
    if(offsetErr) throw offsetErr;

    const { error: chartErr } = await supabase.from('charts').upsert({
      user_id: user.id, natal_json: natal, prog_json: progressions, computed_at: new Date().toISOString(),
    });
    if(chartErr) throw chartErr;

    clearTimeout(extraMsgTimer);
    location.href = 'app.html';
  } catch(err){
    clearTimeout(extraMsgTimer);
    computingState.style.display = 'none';
    formState.style.display = '';
    showError(err.message || 'Something went wrong. Try again.');
  }
});

(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if(!session){ location.href = 'login.html'; return; }
  const { data: { user } } = await supabase.auth.getUser();
  const { data: chart } = await supabase.from('charts').select('user_id').eq('user_id', user.id).maybeSingle();
  if(chart){ location.href = 'app.html'; }
})();

})();
