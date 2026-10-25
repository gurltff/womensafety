'use strict';
/* =====================================================================
   SafeCircle India: safety toolkit
   Share location · check-in timer · fake call · siren · help near me ·
   helplines · shake to SOS · install (PWA) · notifications
   Depends on helpers and state from app.js.
   ===================================================================== */

/* ===================== AUDIO ===================== */
let audioCtx = null;
function getAudio(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return null;
  if(!audioCtx) audioCtx = new AC();
  if(audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
/** iOS only unlocks Web Audio inside a user gesture: play one silent sample there. */
function unlockAudio(){
  const ctx = getAudio();
  if(!ctx) return;
  const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
  s.buffer = b; s.connect(ctx.destination); s.start(0);
}
function tone(ctx, freq, t, dur, vol = .5, type = 'sine'){
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + .012);
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t); o.stop(t + dur + .05);
}

/* ===================== SHARE MY LOCATION ===================== */
let sharePos = null;
function shareLocationMessage(){
  const p = sharePos;
  return `My current location: ${mapsLink(p)}${p.approx ? ' (approximate area)' : p.accuracy ? ` (±${Math.round(p.accuracy)} m)` : ''}\n🕒 ${fmtClock(Date.now())}${batteryPct !== null ? ` · 🔋 ${batteryPct}%` : ''}${state.user ? `\n- ${state.user.name}` : ''}`;
}
/** Gets a position first. If GPS was slow the tap's permission to open a share sheet may have
    expired, so in that case ask for one more tap instead of failing silently. */
async function withSharePos(action){
  if(!sharePos || Date.now() - sharePos.ts > 60000){
    const btns = [$('share-location'), $('share-whatsapp')];
    btns.forEach(b => { b.disabled = true; });
    $('share-location').textContent = 'Locating…';
    const t0 = Date.now();
    const p = await bestPosition({timeout:10000});
    btns.forEach(b => { b.disabled = false; });
    $('share-location').textContent = 'Share…';
    if(!p){ toast('Location unavailable. Set your area on the map first'); return; }
    sharePos = {...p, ts:p.ts || Date.now()};
    if(Date.now() - t0 > 4000){ toast('Location ready. Tap again to send'); return; }
  }
  action();
}
$('share-location').addEventListener('click', () => withSharePos(() => shareText(shareLocationMessage(), 'My location')));
$('share-whatsapp').addEventListener('click', () => withSharePos(() => openWhatsApp(shareLocationMessage())));

/* ===================== CHECK-IN TIMER ===================== */
let checkinMins = 20, checkinTick = null, checkinAlertTick = null, checkinBeep = null;
$('checkin-mins').addEventListener('click', e => {
  const c = e.target.closest('[data-min]');
  if(!c) return;
  checkinMins = Number(c.dataset.min);
  $('checkin-mins').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b === c));
});
function fmtLeft(ms){
  const s = Math.max(0, Math.ceil(ms/1000)), h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = s%60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(sec).padStart(2, '0');
}
function startCheckin(tell){
  unlockAudio();
  requestNotifyPermission();
  const note = $('checkin-note').value.trim();
  const endAt = Date.now() + checkinMins*60000;
  state.checkin = {startAt:Date.now(), endAt, note, mins:checkinMins};
  saveState();
  runCheckinTicker();
  postCheckin('checkin.started');
  toast(`Check-in set for ${fmtClock(endAt)}`);
  if(tell){
    const pos = currentKnownPosition();
    const msg = `I'm heading out${note ? ': ' + note : ''}. I should be safe by ${fmtClock(endAt)}. If you don't hear from me by then, please call me.` +
      (pos ? `\nMy location now: ${mapsLink(pos)}` : '') + (state.user ? `\n- ${state.user.name}` : '');
    if(state.contacts.length) openSMS(state.contacts.map(c => c.phone), msg);
    else shareText(msg, 'My check-in');
  }
}
$('checkin-start').addEventListener('click', () => startCheckin(false));
$('checkin-start-tell').addEventListener('click', () => startCheckin(true));
$('checkin-safe').addEventListener('click', () => endCheckin(true));
$('checkin-pill-safe').addEventListener('click', () => endCheckin(true));
$('checkin-extend').addEventListener('click', () => {
  if(!state.checkin) return;
  state.checkin.endAt = Math.max(state.checkin.endAt, Date.now()) + 10*60000;
  state.checkin.alerting = false;
  saveState();
  updateCheckinUI();
  postCheckin('checkin.extended');
  toast(`Extended to ${fmtClock(state.checkin.endAt)}`);
});
function runCheckinTicker(){
  clearInterval(checkinTick);
  if(!state.checkin) return updateCheckinUI();
  checkinTick = setInterval(checkinTickFn, 1000);
  checkinTickFn();
}
function checkinTickFn(){
  const c = state.checkin;
  if(!c){ clearInterval(checkinTick); updateCheckinUI(); return; }
  updateCheckinUI();
  if(c.endAt - Date.now() <= 0 && $('checkin-alert').hidden) triggerCheckinAlert();
}
function updateCheckinUI(){
  const c = state.checkin;
  $('checkin-setup').hidden = !!c;
  $('checkin-running').hidden = !c;
  const pillVisible = !!c && !CHROME_HIDDEN.has(currentScreen);
  $('checkin-pill').hidden = !pillVisible;
  document.body.classList.toggle('has-checkin', pillVisible);
  if(!c) return;
  const left = c.endAt - Date.now();
  $('checkin-countdown').textContent = fmtLeft(left);
  $('checkin-pill-time').textContent = left > 0 ? fmtLeft(left) : 'overdue';
  $('checkin-running-note').textContent = `Due at ${fmtClock(c.endAt)}${c.note ? ' · ' + c.note : ''}. Keep SafeCircle open: phones may pause web apps when locked.`;
}
function triggerCheckinAlert(){
  const c = state.checkin;
  if(!c) return;
  let n = 60;
  $('checkin-alert-count').textContent = n;
  openOverlay('checkin-alert', '#checkin-alert-safe');
  requestWakeLock('checkin');
  notify('Are you safe?', `Your SafeCircle check-in${c.note ? ' (' + c.note + ')' : ''} is overdue. Open the app to confirm.`);
  const ctx = getAudio();
  const beep = () => {
    vibrate([400, 150, 400]);
    if(ctx){ const t = ctx.currentTime + .02; tone(ctx, 880, t, .18, .6, 'square'); tone(ctx, 880, t + .3, .18, .6, 'square'); }
  };
  beep();
  clearInterval(checkinBeep); clearInterval(checkinAlertTick);
  checkinBeep = setInterval(beep, 1500);
  checkinAlertTick = setInterval(() => {
    n -= 1;
    $('checkin-alert-count').textContent = Math.max(0, n);
    if(n <= 0){
      postCheckin('checkin.missed');
      endCheckin(false, true);
      startSOS('Check-in missed' + (c.note ? ': ' + c.note : '') + '. Message your contacts below.');
    }
  }, 1000);
}
escHandlers['checkin-alert'] = false; // must be answered explicitly
/** Lets a server run its own timer, so contacts are alerted even if the phone is locked (see API.md). */
function postCheckin(type){
  const c = state.checkin;
  if(!c) return;
  const pos = currentKnownPosition();
  SCApi.postEvent(type, {
    user:state.user ? {name:state.user.name, phone:state.user.phone} : null,
    contacts:state.contacts.map(x => ({name:x.name, phone:x.phone})),
    checkin:{startAt:new Date(c.startAt).toISOString(), endAt:new Date(c.endAt).toISOString(), note:c.note || ''},
    location:pos ? {lat:pos.lat, lng:pos.lng, accuracy:pos.accuracy || null, approx:!!pos.approx, mapsUrl:mapsLink(pos)} : null,
    battery:batteryPct,
    message:type === 'checkin.missed'
      ? `${state.user ? state.user.name : 'A SafeCircle user'} missed their check-in${c.note ? ' (' + c.note + ')' : ''}. Last location: ${pos ? mapsLink(pos) : 'unknown'}`
      : `${state.user ? state.user.name : 'A SafeCircle user'} started a check-in${c.note ? ' (' + c.note + ')' : ''}, due ${fmtClock(c.endAt)}.`
  });
}
function endCheckin(safe, silent){
  if(state.checkin && !silent) postCheckin(safe ? 'checkin.ended' : 'checkin.cancelled');
  clearInterval(checkinTick); clearInterval(checkinAlertTick); clearInterval(checkinBeep);
  vibrate(0);
  if(!$('checkin-alert').hidden) closeOverlay('checkin-alert');
  releaseWakeLock('checkin');
  state.checkin = null;
  saveState();
  updateCheckinUI();
  if(safe) toast("Check-in complete. Glad you're safe");
}
$('checkin-alert-safe').addEventListener('click', () => endCheckin(true));
$('checkin-alert-sos').addEventListener('click', () => {
  const note = state.checkin && state.checkin.note;
  endCheckin(false); // tells an alert server to stop its own timer; startSOS sends the alert itself
  startSOS('You asked for help from the check-in timer' + (note ? ' (' + note + ')' : '') + '.');
});

/* ===================== NOTIFICATIONS ===================== */
function requestNotifyPermission(){
  try{ if('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); }catch(e){}
}
async function notify(title, body){
  try{
    if(!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = {body, tag:'safecircle-alert', requireInteraction:true, renotify:true, icon:'icons/icon-192.png', badge:'icons/icon-192.png', vibrate:[300, 100, 300]};
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if(reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  }catch(e){}
}

/* ===================== FAKE CALL ===================== */
let fakeDelay = 10, fakeTimer = null, fakeStatusTick = null, fakeRing = null, fakeCallTick = null, fakeSpeech = null;
const FAKE_SCRIPT = [
  'Hi! Where are you right now?',
  "Okay, I'm nearby. I'll come and pick you up.",
  "Stay where you are, I'll be there in five minutes.",
  'Keep your phone on, and call me if anything happens. See you soon.'
];
$('fake-delay').addEventListener('click', e => {
  const c = e.target.closest('[data-sec]');
  if(!c) return;
  fakeDelay = Number(c.dataset.sec);
  $('fake-delay').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b === c));
});
$('fake-start').addEventListener('click', () => {
  if(fakeTimer){ cancelFakeCall(); return; }
  const name = $('fake-caller').value.trim() || 'Mom';
  state.settings.fakeCaller = $('fake-caller').value.trim();
  state.settings.fakeVoice = $('fake-voice').checked;
  saveState();
  unlockAudio();
  if('speechSynthesis' in window) speechSynthesis.getVoices();
  requestWakeLock('fakecall');
  if(fakeDelay === 0){ showFakeCall(name); return; }
  const at = Date.now() + fakeDelay*1000;
  fakeTimer = setTimeout(() => showFakeCall(name), fakeDelay*1000);
  $('fake-start').textContent = 'Cancel scheduled call';
  $('fake-start').classList.replace('btn-primary', 'btn-ghost');
  const st = $('fake-status');
  st.hidden = false;
  const upd = () => { st.textContent = `${name} will call in ${Math.max(0, Math.ceil((at - Date.now())/1000))}s. Keep this screen on.`; };
  upd();
  clearInterval(fakeStatusTick);
  fakeStatusTick = setInterval(upd, 1000);
  toast(`Fake call from ${name} in ${fakeDelay >= 60 ? fakeDelay/60 + ' min' : fakeDelay + ' s'}`);
});
function resetFakeScheduler(){
  clearTimeout(fakeTimer); fakeTimer = null;
  clearInterval(fakeStatusTick);
  $('fake-status').hidden = true;
  $('fake-start').textContent = 'Schedule fake call';
  $('fake-start').classList.replace('btn-ghost', 'btn-primary');
}
function cancelFakeCall(){
  resetFakeScheduler();
  releaseWakeLock('fakecall');
  toast('Fake call cancelled');
}
function showFakeCall(name){
  resetFakeScheduler();
  $('fc-name').textContent = name;
  $('fc-avatar').textContent = name.charAt(0).toUpperCase();
  $('fc-status').textContent = 'incoming call';
  $('fc-sub').textContent = 'Mobile · India';
  $('fc-incoming').hidden = false;
  $('fc-active').hidden = true;
  $('fakecall').classList.remove('in-call');
  openOverlay('fakecall', '#fc-accept');
  startRingtone();
}
function startRingtone(){
  stopRingtone();
  const ctx = getAudio();
  const notes = [1318.5, 1568, 1975.5, 1568, 1318.5, 1975.5, 1568, 1318.5];
  const bar = () => {
    vibrate([600, 250, 600]);
    if(!ctx) return;
    const t0 = ctx.currentTime + .03;
    notes.forEach((f, i) => { tone(ctx, f/2, t0 + i*.14, .32, .45); tone(ctx, f, t0 + i*.14, .12, .12); });
  };
  bar();
  fakeRing = setInterval(bar, 2400);
}
function stopRingtone(){ clearInterval(fakeRing); fakeRing = null; vibrate(0); }
function speakScript(){
  if(!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  const voice = voices.find(v => /en[-_]IN/i.test(v.lang)) || voices.find(v => /^en/i.test(v.lang));
  let i = 0;
  const next = () => {
    if(i >= FAKE_SCRIPT.length || $('fakecall').hidden) return;
    const u = new SpeechSynthesisUtterance(FAKE_SCRIPT[i++]);
    if(voice) u.voice = voice;
    u.rate = 1; u.pitch = 1.05;
    u.onend = () => { fakeSpeech = setTimeout(next, 2600); };
    speechSynthesis.speak(u);
  };
  fakeSpeech = setTimeout(next, 900);
}
$('fc-accept').addEventListener('click', () => {
  stopRingtone();
  $('fc-incoming').hidden = true;
  $('fc-active').hidden = false;
  $('fakecall').classList.add('in-call');
  const t0 = Date.now();
  const upd = () => { const s = Math.floor((Date.now() - t0)/1000); $('fc-status').textContent = String(Math.floor(s/60)).padStart(2, '0') + ':' + String(s%60).padStart(2, '0'); };
  upd();
  fakeCallTick = setInterval(upd, 1000);
  if($('fake-voice').checked){
    // Speak one silent utterance inside the tap so iOS allows the delayed lines.
    if('speechSynthesis' in window){ const warm = new SpeechSynthesisUtterance(' '); warm.volume = 0; speechSynthesis.speak(warm); }
    speakScript();
  }
});
function endFakeCall(){
  stopRingtone();
  clearInterval(fakeCallTick);
  clearTimeout(fakeSpeech);
  if('speechSynthesis' in window) speechSynthesis.cancel();
  closeOverlay('fakecall');
  releaseWakeLock('fakecall');
}
$('fc-decline').addEventListener('click', endFakeCall);
$('fc-end').addEventListener('click', endFakeCall);
escHandlers['fakecall'] = endFakeCall;

/* ===================== SIREN ===================== */
let siren = null;
function startSiren(){
  if(siren) return;
  const ctx = getAudio();
  openOverlay('siren', '#siren-stop');
  requestWakeLock('siren');
  siren = {nodes:[], vib:setInterval(() => vibrate([500, 200]), 700)};
  vibrate([500, 200]);
  if(!ctx) return;
  const master = ctx.createGain();
  master.gain.value = .95;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp); comp.connect(ctx.destination);
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
  o1.type = 'sawtooth'; o2.type = 'square'; g2.gain.value = .35;
  o1.frequency.value = 1050; o2.frequency.value = 1062;
  const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
  lfo.type = 'triangle'; lfo.frequency.value = 1.8; lfoGain.gain.value = 480;
  lfo.connect(lfoGain); lfoGain.connect(o1.frequency); lfoGain.connect(o2.frequency);
  o1.connect(master); o2.connect(g2); g2.connect(master);
  o1.start(); o2.start(); lfo.start();
  siren.nodes = [o1, o2, lfo];
  siren.master = master;
}
function stopSiren(){
  if(!siren) return;
  siren.nodes.forEach(n => { try{ n.stop(); }catch(e){} });
  if(siren.master) siren.master.disconnect();
  clearInterval(siren.vib);
  vibrate(0);
  siren = null;
  closeOverlay('siren');
  releaseWakeLock('siren');
}
$('siren-start').addEventListener('click', startSiren);
$('siren-stop').addEventListener('click', stopSiren);
escHandlers['siren'] = stopSiren;

/* ===================== HELP NEAR ME (OpenStreetMap / Overpass) ===================== */
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const HELP_META = {
  police:{label:'Police station', icon:'🛡', color:'#60A5FA'},
  hospital:{label:'Hospital / clinic', icon:'✚', color:'#F87171'},
  pharmacy:{label:'Pharmacy', icon:'℞', color:'#34D399'}
};
let helpCache = null, helpKind = 'police', helpItems = [], helpOrigin = null;

async function findNearbyHelp(pos, radius = 6000){
  if(helpCache && distanceMeters(helpCache.pos, pos) < 400 && Date.now() - helpCache.ts < 15*60000) return helpCache.items;
  const a = `(around:${radius},${pos.lat.toFixed(5)},${pos.lng.toFixed(5)})`;
  const q = `[out:json][timeout:25];` +
    `nwr["amenity"="police"]${a};out center 60;` +
    `nwr["amenity"~"^(hospital|clinic)$"]${a};out center 80;` +
    `nwr["amenity"="pharmacy"]${a};out center 80;`;
  let lastErr = null;
  for(const url of OVERPASS_URLS){
    try{
      const data = await fetchJSON(url, {method:'POST', body:'data=' + encodeURIComponent(q), headers:{'Content-Type':'application/x-www-form-urlencoded'}, timeout:20000});
      const seen = new Set();
      const items = (data.elements || []).map(el => {
        const lat = el.lat ?? (el.center && el.center.lat), lng = el.lon ?? (el.center && el.center.lon);
        if(!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const t = el.tags || {};
        const kind = t.amenity === 'police' ? 'police' : t.amenity === 'pharmacy' ? 'pharmacy' : 'hospital';
        const phone = (t.phone || t['contact:phone'] || t['phone:mobile'] || '').split(/[;,]/)[0].trim();
        const addr = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'] || t['addr:city']].filter(Boolean).join(', ');
        return {id:el.type + el.id, kind, lat, lng, name:t['name:en'] || t.name || HELP_META[kind].label, phone, addr, dist:distanceMeters(pos, {lat, lng}), open24:t.opening_hours === '24/7'};
      }).filter(x => x && !seen.has(x.id) && seen.add(x.id)).sort((x, y) => x.dist - y.dist);
      helpCache = {pos:{lat:pos.lat, lng:pos.lng}, ts:Date.now(), items};
      return items;
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('Overpass unavailable');
}

$('help-tabs').addEventListener('click', e => {
  const c = e.target.closest('[data-kind]');
  if(!c) return;
  helpKind = c.dataset.kind;
  $('help-tabs').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b === c));
  renderHelpList();
});
$('help-find').addEventListener('click', async () => {
  const btn = $('help-find');
  btn.disabled = true; btn.textContent = 'Searching…';
  $('help-list').innerHTML = '<p class="muted"><span class="loc-spin"></span> Finding your location and nearby help…</p>';
  try{
    const p = await bestPosition({timeout:10000});
    if(!p){ $('help-list').innerHTML = '<p class="muted">Location unavailable. Set your area on the map first.</p>'; return; }
    helpOrigin = p;
    helpItems = await findNearbyHelp(p);
    renderHelpList();
    renderHelpOnMap();
  }catch(e){
    $('help-list').innerHTML = `<p class="muted">Couldn't reach OpenStreetMap right now. In an emergency call <a href="tel:112">112</a>.</p>`;
  }finally{
    btn.disabled = false; btn.textContent = 'Refresh';
  }
});
function helpItemHTML(x){
  const m = HELP_META[x.kind];
  return `<div class="help-item">
    <span class="help-ico" style="--hc:${m.color}" aria-hidden="true">${m.icon}</span>
    <div class="help-info"><div class="name">${escapeHtml(x.name)}</div><div class="sub">${fmtDist(x.dist)}${x.open24 ? ' · open 24/7' : ''}${x.addr ? ' · ' + escapeHtml(x.addr) : ''}</div></div>
    <div class="help-actions">
      ${x.phone ? `<a class="pill-btn" href="tel:${escapeHtml(x.phone.replace(/\s/g, ''))}">Call</a>` : ''}
      <a class="pill-btn" href="${directionsLink(x, helpOrigin && !helpOrigin.approx ? helpOrigin : null)}" target="_blank" rel="noopener">Go</a>
      <button class="pill-btn" type="button" data-show="${escapeHtml(x.id)}">Map</button>
    </div>
  </div>`;
}
function renderHelpList(){
  if(!helpOrigin) return;
  const list = helpItems.filter(x => x.kind === helpKind).slice(0, 8);
  $('help-list').innerHTML = (helpOrigin.approx ? '<p class="hint">Searching around your saved area (GPS unavailable).</p>' : '') +
    (list.length ? list.map(helpItemHTML).join('') : `<p class="muted">No ${HELP_META[helpKind].label.toLowerCase()}s mapped within 6 km. Call <a href="tel:112">112</a> in an emergency.</p>`);
}
$('help-list').addEventListener('click', e => {
  const b = e.target.closest('[data-show]');
  if(!b) return;
  const x = helpItems.find(i => i.id === b.dataset.show);
  if(!x || !map) return;
  renderHelpOnMap();
  showScreen('map');
  setTimeout(() => { map.flyTo([x.lat, x.lng], 16, {duration:.9}); }, 120);
});
function renderHelpOnMap(){
  if(!map || !helpLayer) return;
  helpLayer.clearLayers();
  helpItems.slice(0, 120).forEach(x => {
    const m = HELP_META[x.kind];
    L.marker([x.lat, x.lng], {
      icon:L.divIcon({className:'', html:`<div class="help-pin" style="--hc:${m.color}">${m.icon}</div>`, iconSize:[28, 28]}),
      title:x.name
    }).addTo(helpLayer).bindPopup(`<b>${escapeHtml(x.name)}</b><br>${m.label} · ${fmtDist(x.dist)}<br>` +
      `${x.phone ? `<a href="tel:${escapeHtml(x.phone.replace(/\s/g, ''))}">Call</a> · ` : ''}<a href="${directionsLink(x)}" target="_blank" rel="noopener">Directions</a>`);
  });
  $('btn-help-layer').setAttribute('aria-pressed', String(helpItems.length > 0));
}
$('btn-help-layer').addEventListener('click', async () => {
  const btn = $('btn-help-layer');
  if(btn.getAttribute('aria-pressed') === 'true'){
    helpLayer.clearLayers();
    btn.setAttribute('aria-pressed', 'false');
    return;
  }
  btn.disabled = true; btn.textContent = '✚ Searching…';
  try{
    let p = await bestPosition({timeout:8000});
    // Exploring another part of the map? Search around what's on screen instead.
    if(!p || (map.getZoom() >= 12 && distanceMeters(p, map.getCenter()) > 8000)){
      const c = map.getCenter();
      p = {lat:c.lat, lng:c.lng, approx:true};
    }
    if(map.getZoom() < 12) map.setView([p.lat, p.lng], 14);
    helpOrigin = p;
    helpItems = await findNearbyHelp(p);
    renderHelpOnMap();
    renderHelpList();
    const counts = ['police', 'hospital', 'pharmacy'].map(k => helpItems.filter(x => x.kind === k).length);
    toast(`${counts[0]} police · ${counts[1]} hospitals/clinics · ${counts[2]} pharmacies within 6 km`);
  }catch(e){
    toast("Couldn't reach OpenStreetMap. Check your connection");
  }finally{
    btn.disabled = false; btn.textContent = '✚ Help nearby';
  }
});

/* ===================== HELPLINES ===================== */
const HELPLINES = [
  ['112', 'Emergency', 'Police, fire, ambulance · all India, 24×7', true],
  ['181', 'Women Helpline', '24×7 · connects to One Stop Centres', true],
  ['1091', 'Women in Distress', 'Police women helpline'],
  ['100', 'Police', ''],
  ['108', 'Ambulance', 'Medical emergency'],
  ['1930', 'Cyber Crime', 'Online harassment, fraud · cybercrime.gov.in'],
  ['7827170170', 'NCW Helpline', 'National Commission for Women, 24×7'],
  ['1098', 'Childline', 'Children in need of care or protection'],
  ['15100', 'Free legal aid', 'NALSA legal services'],
  ['14416', 'Tele-MANAS', 'Mental health support, 24×7']
];
$('helpline-list').innerHTML = HELPLINES.map(([num, name, sub, key]) => `
  <a class="helpline${key ? ' key' : ''}" href="tel:${num}">
    <span class="hl-num">${num.length > 6 ? num.replace(/(\d{5})(\d{5})/, '$1 $2') : num}</span>
    <span class="hl-text"><b>${name}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    <span class="hl-call" aria-hidden="true">Call</span>
  </a>`).join('');

/* ===================== SHAKE TO SOS ===================== */
let shakeHits = [], lastHit = 0, shakeListening = false;
function onMotion(e){
  const a = e.accelerationIncludingGravity || e.acceleration;
  if(!a || a.x === null) return;
  const mag = Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z);
  if(mag < 24) return;
  const now = Date.now();
  if(now - lastHit < 220) return;
  lastHit = now;
  shakeHits = shakeHits.filter(t => now - t < 1600);
  shakeHits.push(now);
  if(shakeHits.length >= 4){
    shakeHits = [];
    if(!state.user || currentScreen === 'auth' || sos.active || !$('sos-countdown').hidden) return;
    startSOSCountdown();
  }
}
function listenShake(on){
  if(on && !shakeListening) window.addEventListener('devicemotion', onMotion);
  if(!on && shakeListening) window.removeEventListener('devicemotion', onMotion);
  shakeListening = on;
}
async function enableShake(){
  if(!('DeviceMotionEvent' in window)){ toast("Shake detection isn't supported on this device"); return false; }
  if(typeof DeviceMotionEvent.requestPermission === 'function'){
    try{
      if(await DeviceMotionEvent.requestPermission() !== 'granted'){ toast('Motion access was denied'); return false; }
    }catch(e){ toast('Tap the switch again to allow motion access'); return false; }
  }
  listenShake(true);
  return true;
}
$('toggle-shake').addEventListener('change', async e => {
  if(e.target.checked){
    const ok = await enableShake();
    e.target.checked = ok;
    state.settings.shake = ok;
    if(ok) toast('Shake to SOS is on while SafeCircle is open');
  }else{
    listenShake(false);
    state.settings.shake = false;
  }
  saveState();
});

/* ===================== INSTALL (PWA) ===================== */
let deferredInstall = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('tool-install').hidden = false;
  $('install-btn').hidden = false;
});
window.addEventListener('appinstalled', () => { $('tool-install').hidden = true; deferredInstall = null; toast('SafeCircle installed'); });
$('install-btn').addEventListener('click', async () => {
  if(!deferredInstall) return;
  deferredInstall.prompt();
  try{ await deferredInstall.userChoice; }catch(e){}
  deferredInstall = null;
  $('tool-install').hidden = true;
});

/* ===================== INIT ===================== */
function initTools(){
  $('fake-caller').value = state.settings.fakeCaller || '';
  $('fake-voice').checked = state.settings.fakeVoice !== false;
  if(IS_IOS && !isStandalone()){
    $('tool-install').hidden = false;
    $('install-btn').hidden = true;
    $('install-copy').textContent = 'On iPhone: tap the Share button in Safari, then "Add to Home Screen" so SOS is one tap away, even offline.';
  }
  if(state.settings.shake){
    if(typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'){
      // iOS needs a tap before motion events flow: ask on the first touch.
      document.addEventListener('click', () => { enableShake(); }, {once:true});
    }else listenShake(true);
  }
  if(state.checkin) runCheckinTicker(); // fires the alert straight away if it ran out while closed
  if('serviceWorker' in navigator && isSecureCtx() && location.protocol !== 'file:'){
    // While developing on your own computer (e.g. VS Code Live Server) skip the offline cache so
    // every edit shows up on reload. Add ?sw=on to the URL to test offline mode locally.
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    if(local && new URLSearchParams(location.search).get('sw') !== 'on'){
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
    }else navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
