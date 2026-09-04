// Ask/Oracle drawer. Wrapped in an IIFE for the same reason as login.js/
// onboarding.js: top-level const/let is shared across every script tag on
// the page, including whatever other browser extensions inject.
(function(){

const cfg = window.DE_CAELO_CONFIG;
// Reuses app.html's client (the only page that loads this script) rather than
// creating a second one -- see the comment at that client's creation site.
const supabase = window.SUPABASE_CLIENT;

const toggle = document.getElementById('oracleToggle');
const drawer = document.getElementById('oracleDrawer');
const scrim = document.getElementById('oracleScrim');
const closeBtn = document.getElementById('oracleClose');
const body = document.getElementById('oracleBody');
const form = document.getElementById('oracleForm');
const input = document.getElementById('oracleInput');

let history = []; // {role, content}, kept client-side for this page session only

const OUROBOROS_SVG = `<svg width="20" height="20" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
  <circle cx="20" cy="20" r="15" fill="none" stroke="#fff" stroke-width="2.5" stroke-dasharray="2,3.2"/>
  <path d="M 20 4 L 24.5 11 L 15.5 11 Z" fill="#fff"/>
  <circle cx="19" cy="8.2" r="1.1" fill="#000"/>
</svg>`;

function openDrawer(){ drawer.classList.add('open'); scrim.classList.add('show'); input.focus(); }
function closeDrawer(){ drawer.classList.remove('open'); scrim.classList.remove('show'); }

function addMessage(role, text){
  const div = document.createElement('div');
  div.className = 'oracle-msg ' + role;
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function addLoader(){
  const div = document.createElement('div');
  div.className = 'oracle-loader';
  div.innerHTML = OUROBOROS_SVG + '<span>Consulting the chart&hellip;</span>';
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

toggle.addEventListener('click', openDrawer);
closeBtn.addEventListener('click', closeDrawer);
scrim.addEventListener('click', closeDrawer);

input.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if(!question) return;

  addMessage('user', question);
  input.value = '';
  const btn = document.getElementById('oracleSend');
  btn.disabled = true;
  const loader = addLoader();

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
    loader.remove();
    addMessage('assistant', payload.reply);
  } catch(err){
    loader.remove();
    addMessage('error', err.message || 'Something went wrong. Try again.');
  } finally {
    btn.disabled = false;
  }
});

})();
