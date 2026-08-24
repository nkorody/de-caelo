// Wrapped in an IIFE deliberately: top-level const/let on a page is shared
// across every script tag, including whatever other browser extensions
// inject into this page. A generic name like `supabase` is exactly the kind
// of identifier likely to collide with something else declared globally.
(function(){

const cfg = window.DE_CAELO_CONFIG;
const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const loadingState = document.getElementById('loadingState');
const setPasswordForm = document.getElementById('setPasswordForm');
const loginForm = document.getElementById('loginForm');

function showError(el, msg){
  el.textContent = msg;
  el.classList.add('show');
}

async function afterAuth(){
  // route to onboarding if this user has no computed chart yet, otherwise into the app
  const { data: { user } } = await supabase.auth.getUser();
  if(!user){ location.href = 'login.html'; return; }
  const { data: chart } = await supabase.from('charts').select('user_id').eq('user_id', user.id).maybeSingle();
  location.href = chart ? 'app.html' : 'onboarding.html';
}

async function init(){
  const hash = window.location.hash;
  const isInviteOrRecovery = /type=invite|type=recovery|type=signup/.test(hash);

  const { data: { session } } = await supabase.auth.getSession();

  loadingState.style.display = 'none';

  if(isInviteOrRecovery && session){
    setPasswordForm.style.display = '';
    return;
  }
  if(session){
    await afterAuth();
    return;
  }
  loginForm.style.display = '';
}

setPasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw1 = document.getElementById('pw1').value;
  const pw2 = document.getElementById('pw2').value;
  const err = document.getElementById('setPasswordError');
  err.classList.remove('show');
  if(pw1 !== pw2){ showError(err, 'Passwords do not match.'); return; }
  if(pw1.length < 8){ showError(err, 'Password needs at least 8 characters.'); return; }
  const btn = setPasswordForm.querySelector('button');
  btn.disabled = true;
  const { error } = await supabase.auth.updateUser({ password: pw1 });
  btn.disabled = false;
  if(error){ showError(err, error.message); return; }
  await afterAuth();
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const err = document.getElementById('loginError');
  err.classList.remove('show');
  const btn = loginForm.querySelector('button');
  btn.disabled = true;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if(error){ showError(err, 'Incorrect email or password.'); return; }
  await afterAuth();
});

init();

})();
