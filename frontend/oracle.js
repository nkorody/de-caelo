// Ask/Oracle drawer. Wrapped in an IIFE for the same reason as login.js/
// onboarding.js: top-level const/let is shared across every script tag on
// the page, including whatever other browser extensions inject.
(function(){

const cfg = window.DE_CAELO_CONFIG;
const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const toggle = document.getElementById('oracleToggle');
const drawer = document.getElementById('oracleDrawer');
const scrim = document.getElementById('oracleScrim');
const closeBtn = document.getElementById('oracleClose');
const body = document.getElementById('oracleBody');
const form = document.getElementById('oracleForm');
const input = document.getElementById('oracleInput');

let history = []; // {role, content}, kept client-side for this page session only

function openDrawer(){ drawer.classList.add('open'); scrim.classList.add('show'); input.focus(); }
function closeDrawer(){ drawer.classList.remove('open'); scrim.classList.remove('show'); }

function addMessage(role, text){
  const div = document.createElement('div');
  div.className = 'oracle-msg ' + role;
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

toggle.addEventListener('click', openDrawer);
closeBtn.addEventListener('click', closeDrawer);
scrim.addEventListener('click', closeDrawer);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if(!question) return;

  addMessage('user', question);
  input.value = '';
  const btn = document.getElementById('oracleSend');
  btn.disabled = true;

  try{
    const { data: { session } } = await supabase.auth.getSession();
    if(!session) throw new Error('Session expired. Reload and log in again.');

    const res = await fetch(cfg.CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ question, history: history.slice(-10) }),
    });
    const payload = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(payload.error || ('Request failed (' + res.status + ')'));

    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: payload.reply });
    addMessage('assistant', payload.reply);
  } catch(err){
    addMessage('error', err.message || 'Something went wrong. Try again.');
  } finally {
    btn.disabled = false;
  }
});

})();
