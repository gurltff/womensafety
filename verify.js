'use strict';
/* =====================================================================
   SafeCircle India: sign-up with email + phone verification.
   With Supabase keys in config.js, real codes are sent (see SETUP.md).
   Without keys, it runs in demo mode and shows the code on screen.
   ===================================================================== */
(function(){
const CFG = window.SC_CONFIG || {};
const HAS_BACKEND = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const CODE_TTL = 10*60*1000, MAX_ATTEMPTS = 5, RESEND_COOLDOWN = 30*1000;

let pend = null, step = 'email', demo = null, codeExpiresAt = 0, attempts = 0;
let lastSentAt = 0, lastTarget = '', cooldownTick = null, sbPromise = null;

/** Loads supabase-js only when a backend is configured, so demo mode stays light. */
function getSupabase(){
  if(!HAS_BACKEND) return Promise.resolve(null);
  if(!sbPromise){
    sbPromise = new Promise(resolve => {
      const make = () => resolve(window.supabase ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null);
      if(window.supabase) return make();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = make;
      s.onerror = () => { sbPromise = null; resolve(null); };
      document.head.appendChild(s);
    });
  }
  return sbPromise;
}

function phoneOK(p){
  const d = p.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : null;
}
const emailOK = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const target = () => step === 'email' ? pend.email : pend.phone;

function startCooldown(){
  const btn = $('v-resend');
  clearInterval(cooldownTick);
  const upd = () => {
    const left = Math.ceil((RESEND_COOLDOWN - (Date.now() - lastSentAt))/1000);
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend in ${left}s` : 'Resend code';
    if(left <= 0) clearInterval(cooldownTick);
  };
  upd();
  cooldownTick = setInterval(upd, 1000);
}

async function send(){
  const t = target();
  const wait = RESEND_COOLDOWN - (Date.now() - lastSentAt);
  if(t === lastTarget && wait > 0){
    toast(`Please wait ${Math.ceil(wait/1000)}s before requesting another code`);
    return false;
  }
  const banner = $('v-demo');
  if(!HAS_BACKEND){
    demo = String(Math.floor(100000 + Math.random()*900000));
    banner.hidden = false;
    banner.innerHTML = `<b>Demo mode:</b> no real ${step === 'email' ? 'email' : 'SMS'} was sent. Your code is <code>${demo}</code>. ` +
      `To send real codes, add Supabase keys to <code>config.js</code> (see SETUP.md).`;
  }else{
    banner.hidden = true;
    const sb = await getSupabase();
    if(!sb){ toast("Couldn't reach the verification service. Check your connection."); return false; }
    const {error} = step === 'email'
      ? await sb.auth.signInWithOtp({email:t, options:{shouldCreateUser:true}})
      : await sb.auth.updateUser({phone:t});
    if(error){ toast(error.message); return false; }
  }
  attempts = 0;
  codeExpiresAt = Date.now() + CODE_TTL;
  lastSentAt = Date.now();
  lastTarget = t;
  startCooldown();
  return true;
}

async function check(code){
  if(Date.now() > codeExpiresAt){ toast('That code has expired. Request a new one.'); return false; }
  if(attempts >= MAX_ATTEMPTS){ toast('Too many attempts. Request a new code.'); return false; }
  attempts++;
  if(!HAS_BACKEND){
    if(code !== demo){ toast(attempts >= MAX_ATTEMPTS ? 'Too many attempts. Request a new code.' : 'That code is not correct'); return false; }
    return true;
  }
  const sb = await getSupabase();
  if(!sb){ toast("Couldn't reach the verification service."); return false; }
  const args = step === 'email'
    ? {email:pend.email, token:code, type:'email'}
    : {phone:pend.phone, token:code, type:'phone_change'};
  const {error} = await sb.auth.verifyOtp(args);
  if(error){ toast(error.message); return false; }
  return true;
}

function render(){
  $('v-dots').textContent = 'Step ' + (step === 'email' ? 1 : 2) + ' of 2';
  $('v-title').textContent = step === 'email' ? 'Verify your email' : 'Verify your mobile number';
  $('v-desc').textContent = 'Enter the 6-digit code sent to ' + (step === 'email' ? pend.email : formatPhone(pend.phone)) + '.';
  $('v-code').value = '';
  setTimeout(() => $('v-code').focus(), 50);
}

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('in-name').value.trim();
  const email = $('in-email').value.trim();
  const phone = phoneOK($('in-phone').value);
  if(name.length < 2){ toast('Enter your name'); $('in-name').focus(); return; }
  if(!phone){ toast('Enter a valid 10-digit Indian mobile number'); $('in-phone').focus(); return; }
  if(!emailOK(email)){ toast('Enter a valid email address'); $('in-email').focus(); return; }
  pend = {name, phone, email};
  step = 'email';
  showAuthStep('verify');
  render();
  const btn = $('v-confirm');
  btn.disabled = true;
  await send();
  btn.disabled = false;
});

async function confirmCode(){
  const code = $('v-code').value.replace(/\D/g, '');
  const btn = $('v-confirm');
  if(btn.disabled) return;
  if(code.length < 6){ toast('Enter the full 6-digit code'); return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  const ok = await check(code);
  btn.disabled = false; btn.textContent = 'Verify';
  if(!ok){ $('v-code').select(); return; }
  if(step === 'email'){
    step = 'phone';
    render();
    toast('Email verified');
    await send();
    return;
  }
  clearInterval(cooldownTick);
  $('v-demo').hidden = true;
  state.user = pend;
  state.verified = {email:true, phone:true, at:Date.now(), demo:!HAS_BACKEND};
  saveState();
  toast('Verified. Welcome, ' + pend.name.split(' ')[0]);
  requestLocationThenStart();
}
$('v-confirm').addEventListener('click', confirmCode);
$('v-code').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); confirmCode(); } });
$('v-code').addEventListener('input', () => {
  const v = $('v-code').value.replace(/\D/g, '');
  if(v.length === 6 && !$('v-confirm').disabled) confirmCode();
});
$('v-resend').addEventListener('click', async () => { if(await send()) toast('Code sent again'); });
$('v-back').addEventListener('click', () => {
  clearInterval(cooldownTick);
  $('v-demo').hidden = true;
  showAuthStep('form');
});
})();
