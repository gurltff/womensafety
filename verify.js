(function(){
const CFG=window.SC_CONFIG||{};
const sb=(CFG.SUPABASE_URL&&CFG.SUPABASE_ANON_KEY&&window.supabase)?window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_ANON_KEY):null;
const $=id=>document.getElementById(id);
let pend=null, step='email', demo=null, codeExpiresAt=0, attempts=0, lastSentAt=0;
const CODE_TTL=10*60*1000, MAX_ATTEMPTS=5, RESEND_COOLDOWN=30*1000;

function phoneOK(p){
  const d=p.replace(/\D/g,'').replace(/^91(?=\d{10}$)/,'').replace(/^0(?=\d{10}$)/,'');
  return /^[6-9]\d{9}$/.test(d)?'+91'+d:null;
}
async function send(){
  if(Date.now()-lastSentAt<RESEND_COOLDOWN){
    toast('Please wait before requesting another code');
    return false;
  }
  const t=step==='email'?pend.email:pend.phone;
  const b=$('v-demo');
  attempts=0;
  codeExpiresAt=Date.now()+CODE_TTL;
  lastSentAt=Date.now();
  if(!sb){
    demo=String(Math.floor(100000+Math.random()*900000));
    b.style.display='block';
    b.textContent='DEMO MODE: no real '+(step==='email'?'email':'SMS')+' was sent. Your code is '+demo+'. Real verification needs a backend: follow SETUP.md and add your keys to config.js.';
    return true;
  }
  b.style.display='none';
  const {error}= step==='email' ? await sb.auth.signInWithOtp({email:t}) : await sb.auth.updateUser({phone:t});
  if(error){toast(error.message);return false;}
  return true;
}
async function check(code){
  if(Date.now()>codeExpiresAt){toast('That code has expired. Request a new one.');return false;}
  if(attempts>=MAX_ATTEMPTS){toast('Too many attempts. Request a new code.');return false;}
  attempts++;
  if(!sb) return code===demo;
  const args= step==='email' ? {email:pend.email,token:code,type:'email'} : {phone:pend.phone,token:code,type:'phone_change'};
  const {error}=await sb.auth.verifyOtp(args);
  if(error){toast(error.message);return false;}
  return true;
}
function render(){
  $('v-dots').textContent='Step '+(step==='email'?1:2)+' of 2';
  $('v-title').textContent=step==='email'?'Verify your email':'Verify your mobile number';
  $('v-desc').textContent='Enter the code sent to '+(step==='email'?pend.email:pend.phone)+'.';
  $('v-code').value='';
}
$('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const phone=phoneOK($('in-phone').value);
  if(!phone){toast('Enter a valid 10-digit Indian mobile number');return;}
  pend={name:$('in-name').value.trim(),phone,email:$('in-email').value.trim()};
  step='email';
  $('auth-form').style.display='none';
  $('verify-block').style.display='block';
  render();
  await send();
});
$('v-confirm').addEventListener('click',async()=>{
  const code=$('v-code').value.trim();
  if(code.length<6){toast('Enter the full code');return;}
  if(!(await check(code))){toast(attempts>=MAX_ATTEMPTS?'Too many attempts — request a new code.':'That code is not correct');return;}
  if(step==='email'){ step='phone'; lastSentAt=0; render(); await send(); return; }
  state.user=pend;
  state.verified={email:true,phone:true,at:Date.now()};
  saveState();
  $('verify-block').style.display='none';
  requestLocationThenStart();
});
$('v-resend').addEventListener('click',async()=>{ if(await send()) toast('Code sent again'); });
$('v-back').addEventListener('click',()=>{
  $('verify-block').style.display='none';
  $('auth-form').style.display='block';
});
$('manual-location-skip').addEventListener('click',()=>{
  window.__indiaOnly=true;
  state.center=DEFAULT_CENTER;
  finishSetup(!!state.zones);
});
if(!document.querySelector('#screen-map.active')) showScreen('auth');
})();
