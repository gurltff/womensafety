'use strict';
/* =====================================================================
   SafeCircle India: core app (state, map, routes, reports, profile, SOS)
   Safety tools (fake call, siren, check-in, nearby help, PWA) live in tools.js
   ===================================================================== */

/* ===================== HELPERS ===================== */
const $ = id => document.getElementById(id);
const DAY = 86400000;
const DEFAULT_CENTER = {lat:28.6139, lng:77.2090}; // Delhi
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isDesktop = () => window.matchMedia('(min-width:768px)').matches;

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function toast(msg, ms = 2600){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function distanceMeters(a, b){
  const rad = Math.PI/180, dLat = (b.lat-a.lat)*rad, dLng = (b.lng-a.lng)*rad;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLng/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function fmtDist(m){
  if(m < 1000) return Math.max(10, Math.round(m/10)*10) + ' m';
  return (m < 10000 ? (m/1000).toFixed(1) : Math.round(m/1000)) + ' km';
}
function fmtDuration(sec){
  const m = Math.round(sec/60);
  if(m < 60) return m + ' min';
  return Math.floor(m/60) + ' h ' + (m%60 ? (m%60) + ' min' : '');
}
function timeAgo(ts){
  const mins = Math.floor((Date.now()-ts)/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs/24);
  return days < 30 ? days + 'd ago' : new Date(ts).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
}
function fmtClock(ts){ return new Date(ts).toLocaleTimeString('en-IN', {hour:'numeric', minute:'2-digit'}); }
function mapsLink(p){ return `https://maps.google.com/?q=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`; }
function directionsLink(to, from){
  return `https://www.google.com/maps/dir/?api=1${from ? `&origin=${from.lat},${from.lng}` : ''}&destination=${to.lat},${to.lng}`;
}
function formatPhone(p){
  const m = /^\+91(\d{5})(\d{5})$/.exec(p);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}
/** Accepts Indian mobiles in most formats, or any international number with +country code. */
function normalizePhone(p){
  let s = String(p || '').trim().replace(/[\s\-().]/g, '');
  if(s.startsWith('00')) s = '+' + s.slice(2);
  const d = s.replace(/^\+?91(?=[6-9]\d{9}$)/, '').replace(/^0(?=[6-9]\d{9}$)/, '');
  if(/^[6-9]\d{9}$/.test(d)) return '+91' + d;
  if(/^\+\d{7,15}$/.test(s)) return s;
  if(/^\d{6,15}$/.test(s)) return s; // landlines / local numbers
  return null;
}
async function fetchJSON(url, {timeout = 10000, signal, ...opts} = {}){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if(signal){
    if(signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), {once:true});
  }
  try{
    const res = await fetch(url, {...opts, signal:ctrl.signal});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }finally{ clearTimeout(timer); }
}
function vibrate(pattern){
  try{
    if(navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // browsers block it before the first tap
    if(navigator.vibrate) navigator.vibrate(pattern);
  }catch(e){}
}
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); return true; }
  catch(e){
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try{ ok = document.execCommand('copy'); }catch(err){}
    ta.remove();
    return ok;
  }
}
function isSecureCtx(){ return window.isSecureContext || ['localhost','127.0.0.1'].includes(location.hostname); }

/* ===================== ZONE DATA ===================== */
const IN_SRC = "Source: NCRB Crime in India (2022/2023). Counts are FIRs registered, not total incidents; higher numbers partly reflect better reporting and registration. Use as awareness, not a verdict on any neighbourhood.";
const ZONES = [
 {id:'delhi',     name:"Delhi (NCT)", level:"red",    lat:28.6139, lng:77.2090, reason:"Highest among 19 metros: 1,204 rape cases in 2022 and 1,088 in 2023 (NCRB). Police attribute part of this to strict FIR registration."},
 {id:'jaipur',    name:"Jaipur",      level:"red",    lat:26.9124, lng:75.7873, reason:"Second-highest among metros: 497 rape cases in 2022 and 573 in 2023 (NCRB). Rajasthan is also among the top states by absolute count."},
 {id:'indore',    name:"Indore",      level:"red",    lat:22.7196, lng:75.8577, reason:"NCRB 2023 reported a crime-against-women rate per lakh higher than Delhi's. Madhya Pradesh is among the top states by rape cases."},
 {id:'lucknow',   name:"Lucknow",     level:"yellow", lat:26.8467, lng:80.9462, reason:"One of the 19 NCRB metros; Uttar Pradesh records among the highest absolute counts of crimes against women. Check NCRB city tables for exact figures."},
 {id:'kanpur',    name:"Kanpur",      level:"yellow", lat:26.4499, lng:80.3319, reason:"Higher-than-average dowry/crime-against-women rates among metros in NCRB 2023. Check NCRB city tables for exact figures."},
 {id:'ghaziabad', name:"Ghaziabad",   level:"yellow", lat:28.6692, lng:77.4538, reason:"NCRB metro with elevated crime-against-women rates in 2023. Part of the Delhi-NCR belt; check NCRB tables for exact figures."},
 {id:'mumbai',    name:"Mumbai",      level:"yellow", lat:19.0760, lng:72.8777, reason:"6,176 crimes against women in 2022, second among metros in volume (NCRB), but 196 rape cases in 2023, far fewer than Delhi or Jaipur."},
 {id:'bengaluru', name:"Bengaluru",   level:"yellow", lat:12.9716, lng:77.5946, reason:"3,924 crimes against women in 2022, third among metros (NCRB). Large share is cyber and harassment-type cases."},
 {id:'hyderabad', name:"Hyderabad",   level:"yellow", lat:17.3850, lng:78.4867, reason:"Large metro with high cyber-crime-against-women volume (NCRB 2022). Check NCRB tables for rape and harassment counts."},
 {id:'patna',     name:"Patna",       level:"yellow", lat:25.5941, lng:85.1376, reason:"NCRB metro; Bihar reports elevated crimes against women. Check NCRB tables for exact figures."},
 {id:'pune',      name:"Pune",        level:"yellow", lat:18.5204, lng:73.8567, reason:"NCRB metro with moderate volume of crimes against women. Check NCRB tables for exact figures."},
 {id:'kolkata',   name:"Kolkata",     level:"green",  lat:22.5726, lng:88.3639, reason:"Has had one of the lowest registered rates of crime against women among NCRB metros. Low reported rate is not zero risk."},
 {id:'chennai',   name:"Chennai",     level:"green",  lat:13.0827, lng:80.2707, reason:"Moderate reported rates relative to size among NCRB metros. Check NCRB tables for exact figures."}
];
const ZONE_BY_ID = Object.fromEntries(ZONES.map(z => [z.id, z]));

const LEVEL_COLOR = {red:'#FF3B4E', yellow:'#FFB020', green:'#2FD28F'};
const LEVEL_LABEL = {red:'High risk', yellow:'Moderate risk', green:'Lower risk'};
const SEV_LABEL = {red:'High', yellow:'Moderate', green:'Low'};
const SEV_RANK = {green:0, yellow:1, red:2};
const ZONE_RADIUS = {red:45000, yellow:32000, green:25000}; // metres, matches the circles drawn on the map
const NEARBY_RANGE = 65000;
const REPORT_CATS = [
  ['harassment','Harassment / catcalling'], ['stalking','Followed / stalked'], ['groping','Groping / touching'],
  ['lighting','Poor lighting'], ['isolated','Isolated / deserted'], ['transport','Unsafe transport'],
  ['crowd','Drunk / rowdy crowd'], ['other','Other']
];
const CAT_LABEL = Object.fromEntries(REPORT_CATS);
const TOD_LABEL = {morning:'Morning', afternoon:'Afternoon', evening:'Evening', night:'Night'};

/* ===================== STATE ===================== */
const STORE_KEY = 'safecircle_state';
const STATE_VERSION = 2;

function defaultState(){
  return {
    v:STATE_VERSION,
    user:null, verified:null,
    contacts:[],
    available:false,
    center:null, manualAreaLabel:'', indiaView:false,
    reports:[],
    medical:{blood:'', allergies:'', notes:''},
    settings:{shake:false, sosMessage:'', fakeCaller:'', fakeVoice:true, baseLayer:'Dark'},
    checkin:null
  };
}
function loadState(){
  let raw = null;
  try{ raw = localStorage.getItem(STORE_KEY); }catch(e){}
  let parsed = null;
  if(raw){ try{ parsed = JSON.parse(raw); }catch(e){} }
  return migrateState(parsed);
}
/** Upgrades v1 state (reports nested inside stored zones) to v2 (flat report list). */
function migrateState(s){
  const d = defaultState();
  if(!s || typeof s !== 'object') return d;
  const out = {...d, ...s, medical:{...d.medical, ...(s.medical || {})}, settings:{...d.settings, ...(s.settings || {})}};
  if(Array.isArray(s.zones)){
    const legacy = [];
    s.zones.forEach((z, i) => {
      const tpl = ZONES.find(t => t.name === z.name) || ZONES[i];
      if(!tpl) return;
      (z.reports || []).forEach(r => legacy.push({
        id:r.id || ('r' + r.ts), zoneId:tpl.id, sev:r.sev, text:r.text, ts:r.ts,
        verified:!!r.verified, cats:[], tod:'', mine:true
      }));
    });
    out.reports = [...(Array.isArray(s.reports) ? s.reports : []), ...legacy];
    delete out.zones;
  }
  out.reports = (Array.isArray(out.reports) ? out.reports : []).filter(r =>
    r && ZONE_BY_ID[r.zoneId] && SEV_RANK[r.sev] !== undefined && typeof r.text === 'string' && Number.isFinite(r.ts));
  out.contacts = (Array.isArray(out.contacts) ? out.contacts : []).filter(c => c && c.name && c.phone)
    .map((c, i) => ({id:c.id || ('c' + Date.now().toString(36) + i), name:String(c.name), phone:normalizePhone(c.phone) || String(c.phone), relation:c.relation || ''}));
  if(out.center && !(Number.isFinite(out.center.lat) && Number.isFinite(out.center.lng))) out.center = null;
  out.v = STATE_VERSION;
  return out;
}
let state = loadState();
function saveState(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch(e){ toast("Couldn't save: browser storage is full or blocked"); }
}

/* ===================== RISK SCORING ===================== */
const BASE_SCORE = {green:15, yellow:50, red:85};
const SEV_SCORE = {green:10, yellow:55, red:95};
const scoreLevel = s => s >= 67 ? 'red' : s >= 34 ? 'yellow' : 'green';

function reportWeight(r){
  const ageDays = Math.max(0, (Date.now() - r.ts)/DAY);
  const freshness = Math.max(.15, 1 - ageDays/90);
  return freshness * (r.verified ? 1 : .65);
}
function zoneReports(id){ return state.reports.filter(r => r.zoneId === id); }
/**
 * Blends the NCRB baseline with recent community reports. More (and fresher, verified)
 * reports pull harder. Reports can raise a zone's level, but never drop it below its
 * public-data baseline category.
 */
function zoneSignal(z){
  const base = BASE_SCORE[z.level];
  const recent = zoneReports(z.id).filter(r => Date.now() - r.ts < 180*DAY);
  const wt = recent.reduce((s, r) => s + reportWeight(r), 0);
  if(!wt) return {score:base, level:z.level, evidence:0, confidence:35};
  const avg = recent.reduce((s, r) => s + SEV_SCORE[r.sev]*reportWeight(r), 0) / wt;
  const influence = wt / (wt + 3);
  const score = Math.round(Math.max(base*(1 - influence) + avg*influence, base - 15));
  return {score, level:scoreLevel(score), evidence:recent.length, confidence:Math.min(95, 35 + Math.round(60*influence))};
}
function nearbyRisk(pos){
  const near = ZONES.map(z => ({z, d:distanceMeters(pos, z), sig:zoneSignal(z)}))
    .filter(x => x.d < NEARBY_RANGE).sort((a, b) => a.d - b.d);
  if(!near.length) return null;
  let best = null;
  near.forEach(x => {
    const R = ZONE_RADIUS[x.sig.level];
    const f = x.d <= R ? 1 : 1 - .4*(x.d - R)/(NEARBY_RANGE - R);
    const s = x.sig.score*f;
    if(!best || s > best.score) best = {score:s, x};
  });
  return {
    score:Math.round(best.score), nearest:near[0], driver:best.x,
    evidence:near.reduce((s, x) => s + x.sig.evidence, 0),
    confidence:Math.round(near.reduce((s, x) => s + x.sig.confidence, 0)/near.length)
  };
}

/* ===================== SCREENS ===================== */
const CHROME_HIDDEN = new Set(['sos', 'auth']);
let currentScreen = 'auth';

function showScreen(name){
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  document.querySelectorAll('.navbtn').forEach(b => {
    const on = b.dataset.nav === name;
    b.classList.toggle('active', on);
    if(on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('chrome-hidden', CHROME_HIDDEN.has(name));
  currentScreen = name;
  if(name === 'map' && map) setTimeout(() => map.invalidateSize(), 60);
  if(name === 'feed') renderFeed();
  if(name === 'profile') renderProfile();
  if(typeof updateCheckinUI === 'function') updateCheckinUI();
}
document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.nav)));

/* ===================== OVERLAYS ===================== */
const overlayStack = [];
const escHandlers = {};
function openOverlay(id, focusSel){
  const el = $(id);
  el.hidden = false;
  el.classList.add('active');
  if(!overlayStack.includes(id)) overlayStack.push(id);
  const f = focusSel ? el.querySelector(focusSel) : el.querySelector('button, input, select, textarea');
  if(f) setTimeout(() => f.focus({preventScroll:true}), 40);
}
function closeOverlay(id){
  const el = $(id);
  el.classList.remove('active');
  if(el.classList.contains('fullscreen')) el.hidden = true;
  const i = overlayStack.lastIndexOf(id);
  if(i > -1) overlayStack.splice(i, 1);
}
document.addEventListener('keydown', e => {
  if(e.key !== 'Escape' || !overlayStack.length) return;
  const top = overlayStack[overlayStack.length - 1];
  if(escHandlers[top]) escHandlers[top]();
  else if(escHandlers[top] !== false) closeOverlay(top);
});
['zone-sheet-overlay', 'report-modal-overlay'].forEach(id => {
  $(id).addEventListener('click', e => { if(e.target.id === id) closeOverlay(id); });
});

function confirmDialog({title, body, ok = 'OK', cancel = 'Cancel', danger = false}){
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    const okB = $('confirm-ok'), cB = $('confirm-cancel'), ov = $('confirm-overlay');
    okB.textContent = ok; cB.textContent = cancel;
    okB.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    const done = v => {
      okB.onclick = cB.onclick = ov.onclick = null;
      delete escHandlers['confirm-overlay'];
      closeOverlay('confirm-overlay');
      resolve(v);
    };
    okB.onclick = () => done(true);
    cB.onclick = () => done(false);
    ov.onclick = e => { if(e.target === ov) done(false); };
    escHandlers['confirm-overlay'] = () => done(false);
    openOverlay('confirm-overlay', '#confirm-ok');
  });
}

/* ===================== WAKE LOCK ===================== */
const wakeReasons = new Set();
let wakeLock = null;
async function requestWakeLock(reason){
  wakeReasons.add(reason);
  if(wakeLock || !('wakeLock' in navigator)) return;
  try{
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  }catch(e){}
}
function releaseWakeLock(reason){
  wakeReasons.delete(reason);
  if(!wakeReasons.size && wakeLock){ wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && wakeReasons.size && !wakeLock) requestWakeLock([...wakeReasons][0]);
});

/* ===================== BATTERY ===================== */
let batteryPct = null;
function initBattery(){
  if(!navigator.getBattery) return;
  navigator.getBattery().then(b => {
    const upd = () => { batteryPct = Math.round(b.level*100); };
    upd(); b.addEventListener('levelchange', upd);
  }).catch(() => {});
}

/* ===================== LOCATION ===================== */
let lastFix = null; // most recent GPS fix from anywhere in the app

function getPosition({timeout = 10000, highAccuracy = true, maxAge = 15000} = {}){
  return new Promise(resolve => {
    if(!navigator.geolocation || !isSecureCtx()) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => { lastFix = {lat:p.coords.latitude, lng:p.coords.longitude, accuracy:p.coords.accuracy, ts:Date.now()}; resolve(lastFix); },
      () => resolve(null),
      {enableHighAccuracy:highAccuracy, timeout, maximumAge:maxAge}
    );
  });
}
/** GPS if possible, else a recent fix, else the saved area (flagged approx). */
async function bestPosition(opts){
  const p = await getPosition(opts);
  if(p) return p;
  return currentKnownPosition();
}
function currentKnownPosition(){
  if(lastFix && Date.now() - lastFix.ts < 10*60000) return lastFix;
  if(state.center) return {...state.center, accuracy:null, approx:true};
  return null;
}

function showAuthStep(step){ // form | verify | locating | manual
  $('auth-form').hidden = step !== 'form';
  $('verify-block').hidden = step !== 'verify';
  $('locating-status').hidden = step !== 'locating';
  $('manual-location-block').hidden = step !== 'manual';
  $('auth-note').hidden = !(step === 'form' || step === 'verify');
}

function requestLocationThenStart(){
  showScreen('auth');
  $('auth-title').textContent = 'Finding your area…';
  $('auth-sub').textContent = 'Allow location access so we can show the safety signal near you and check routes from where you are.';
  showAuthStep('locating');
  $('locating-msg').textContent = 'Getting your location…';

  if(!isSecureCtx()){
    showManualLocation('GPS needs a secure (https://) page in most browsers. Search for your area below, or open SafeCircle from its https:// address.');
    return;
  }
  if(!navigator.geolocation){
    showManualLocation("Your browser doesn't support location access. Search for your area below.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      lastFix = {lat:pos.coords.latitude, lng:pos.coords.longitude, accuracy:pos.coords.accuracy, ts:Date.now()};
      state.center = {lat:lastFix.lat, lng:lastFix.lng};
      state.manualAreaLabel = '';
      finishSetup(false);
    },
    err => {
      let msg = "We couldn't get your GPS location automatically.";
      if(err.code === err.PERMISSION_DENIED) msg = 'Location access was denied. You can allow it in your browser or site settings, or set your area manually below.';
      else if(err.code === err.TIMEOUT) msg = 'Location took too long (weak GPS signal or indoors). Try again, or set your area manually.';
      showManualLocation(msg);
    },
    {timeout:12000, enableHighAccuracy:true, maximumAge:60000}
  );
}

function showManualLocation(message){
  $('auth-title').textContent = 'Set your location';
  $('auth-sub').textContent = "GPS didn't come through. No problem: search for your area instead.";
  showAuthStep('manual');
  $('manual-location-msg').textContent = message;
  setTimeout(() => $('manual-location-input').focus({preventScroll:true}), 50);
}

$('manual-location-retry').addEventListener('click', requestLocationThenStart);
let changingArea = false;
function setChangingArea(on){
  changingArea = on;
  $('manual-location-skip').textContent = on ? 'Cancel: back to the map' : 'Skip: just show the India map';
}
$('manual-location-skip').addEventListener('click', () => {
  if(changingArea){ setChangingArea(false); showScreen('map'); return; }
  state.center = null;
  state.manualAreaLabel = '';
  finishSetup(true);
});
$('btn-change-location').addEventListener('click', () => {
  setChangingArea(true);
  showScreen('auth');
  showManualLocation('Search for a new area, or retry GPS.');
});

/* ---------- Place search (OpenStreetMap Nominatim + mapped cities) ---------- */
function attachPlaceSearch(input, resultsEl, {onPick, onClear}){
  let debounce = null, ctrl = null, items = [], active = -1;
  const row = (it, i) => `<div class="loc-result" role="option" data-idx="${i}">${escapeHtml(it.label)}${it.sub ? `<span class="loc-sub">${escapeHtml(it.sub)}</span>` : ''}</div>`;
  const render = (list, extra = '') => {
    items = list; active = -1;
    resultsEl.innerHTML = list.map(row).join('') + extra;
  };
  const pick = i => {
    const it = items[i];
    if(!it) return;
    input.value = it.label;
    resultsEl.innerHTML = '';
    onPick(it);
  };
  input.addEventListener('input', () => {
    onClear && onClear();
    const q = input.value.trim();
    clearTimeout(debounce);
    if(ctrl) ctrl.abort();
    if(!q){ resultsEl.innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const local = ZONES.filter(z => z.name.toLowerCase().includes(ql))
      .map(z => ({label:z.name, sub:'Mapped city · ' + LEVEL_LABEL[zoneSignal(z).level], full:z.name, lat:z.lat, lng:z.lng, zoneId:z.id}));
    if(q.length < 3){ render(local); return; }
    render(local, `<div class="loc-result loc-loading"><span class="loc-spin"></span>Searching…</div>`);
    debounce = setTimeout(async () => {
      ctrl = new AbortController();
      const mine = ctrl;
      try{
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=6&countrycodes=in&q=${encodeURIComponent(q)}`;
        const data = await fetchJSON(url, {signal:mine.signal, headers:{'Accept-Language':navigator.language || 'en'}});
        if(mine.signal.aborted) return;
        const remote = (data || []).map(r => {
          const parts = (r.display_name || '').split(',');
          return {label:parts[0].trim(), sub:parts.slice(1, 4).join(',').trim(), full:r.display_name, lat:parseFloat(r.lat), lng:parseFloat(r.lon)};
        }).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
        const all = [...local, ...remote];
        render(all, all.length ? '' : `<div class="loc-result loc-empty">No matches. Try a more specific place or a PIN code.</div>`);
      }catch(err){
        if(mine !== ctrl) return; // superseded by a newer search
        render(local, `<div class="loc-result loc-empty">Couldn't search right now. Check your connection and try again.</div>`);
      }
    }, 450);
  });
  resultsEl.addEventListener('click', e => {
    const el = e.target.closest('[data-idx]');
    if(el) pick(Number(el.dataset.idx));
  });
  input.addEventListener('keydown', e => {
    const rows = resultsEl.querySelectorAll('[data-idx]');
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      if(!rows.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('active', i === active));
      rows[active].scrollIntoView({block:'nearest'});
    }else if(e.key === 'Enter'){
      if(rows.length){ e.preventDefault(); pick(active >= 0 ? active : 0); }
    }else if(e.key === 'Escape' && resultsEl.innerHTML){
      e.stopPropagation(); resultsEl.innerHTML = '';
    }
  });
}

let selectedManualPlace = null;
attachPlaceSearch($('manual-location-input'), $('manual-location-results'), {
  onPick:p => {
    selectedManualPlace = p;
    $('manual-location-selected').textContent = '✓ ' + p.full;
    $('manual-location-selected').hidden = false;
    $('manual-location-confirm').disabled = false;
  },
  onClear:() => {
    selectedManualPlace = null;
    $('manual-location-confirm').disabled = true;
    $('manual-location-selected').hidden = true;
  }
});
$('manual-location-confirm').addEventListener('click', () => {
  if(!selectedManualPlace){ toast('Pick a location from the search results first'); return; }
  state.center = {lat:selectedManualPlace.lat, lng:selectedManualPlace.lng};
  state.manualAreaLabel = selectedManualPlace.full;
  finishSetup(false);
});

function finishSetup(indiaOnly){
  setChangingArea(false);
  state.indiaView = !!indiaOnly;
  saveState();
  initApp();
}

/* ===================== INIT ===================== */
function initApp(){
  showScreen('map');
  if(!map) buildMap(); else setInitialView();
  updateUserMarker();
  renderZonesOnMap();
  renderNearbyRisk();
  renderHotList();
  renderTips();
  renderProfile();
  renderFeed();
}

/* ===================== MAP ===================== */
let map = null, zoneLayer = null, userMarker = null, userAccuracy = null, routeLayer = null, helpLayer = null;

function buildMap(){
  map = L.map('map-canvas', {zoomControl:false, attributionControl:false, minZoom:4, maxBounds:[[3,60],[40,103]], maxBoundsViscosity:.8});
  const baseLayers = {
    'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {maxZoom:19, subdomains:'abcd', attribution:'&copy; OpenStreetMap contributors &copy; CARTO'}),
    'Satellite': L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics'}),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {maxZoom:19})
    ]),
    'Street': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'})
  };
  (baseLayers[state.settings.baseLayer] || baseLayers.Dark).addTo(map);
  map.on('baselayerchange', e => { state.settings.baseLayer = e.name; saveState(); });
  L.control.attribution({position:'bottomleft'}).addTo(map);
  L.control.layers(baseLayers, null, {position:'bottomleft'}).addTo(map);
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.control.scale({position:'bottomleft', imperial:false}).addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  helpLayer = L.layerGroup().addTo(map);
  setInitialView();
}
function inIndia(c){ return c && c.lat > 6 && c.lat < 36 && c.lng > 68 && c.lng < 98; }
function setInitialView(){
  const c = state.center;
  if(inIndia(c) && !state.indiaView) map.setView([c.lat, c.lng], 11);
  else map.fitBounds([[6.5,68],[36.5,97.5]], mapPadding());
}
/** Keeps fitted bounds clear of the floating cards. */
function mapPadding(){
  if(isDesktop()) return {paddingTopLeft:[40, 110], paddingBottomRight:[400, 40]};
  const tb = document.querySelector('.map-topbar');
  const h = tb ? Math.min(tb.getBoundingClientRect().height + 10, window.innerHeight*.55) : 200;
  return {paddingTopLeft:[16, h], paddingBottomRight:[16, 24]};
}

function updateUserMarker(pos){
  if(!map) return;
  const c = pos || lastFix || state.center;
  if(!c){
    if(userMarker){ map.removeLayer(userMarker); userMarker = null; }
    if(userAccuracy){ map.removeLayer(userAccuracy); userAccuracy = null; }
    return;
  }
  if(!userMarker){
    userMarker = L.marker([c.lat, c.lng], {
      icon:L.divIcon({className:'', html:'<div class="me-dot"><i></i></div>', iconSize:[22,22]}),
      zIndexOffset:3000, keyboard:false
    }).addTo(map).bindTooltip('You are here', {direction:'top', offset:[0,-10]});
  }else userMarker.setLatLng([c.lat, c.lng]);
  if(c.accuracy && c.accuracy < 3000){
    if(!userAccuracy) userAccuracy = L.circle([c.lat, c.lng], {radius:c.accuracy, color:'#7DD3FC', weight:1, opacity:.6, fillOpacity:.08, interactive:false}).addTo(map);
    else userAccuracy.setLatLng([c.lat, c.lng]).setRadius(c.accuracy);
  }
}

function renderZonesOnMap(){
  if(!map) return;
  zoneLayer.clearLayers();
  ZONES.forEach(z => {
    const sig = zoneSignal(z), lvl = sig.level, col = LEVEL_COLOR[lvl];
    L.circle([z.lat, z.lng], {radius:ZONE_RADIUS[lvl], color:col, weight:1, opacity:.55, fillColor:col, fillOpacity:lvl === 'red' ? .24 : .14, interactive:false}).addTo(zoneLayer);
    const sz = lvl === 'red' ? 22 : lvl === 'yellow' ? 17 : 13;
    const pin = L.marker([z.lat, z.lng], {
      icon:L.divIcon({className:'', html:`<div class="zpin ${lvl}" style="--c:${col};--s:${sz}px"><b></b><i></i></div>`, iconSize:[sz*2, sz*2]}),
      zIndexOffset:lvl === 'red' ? 1000 : lvl === 'yellow' ? 500 : 0,
      title:`${z.name}: ${LEVEL_LABEL[lvl]}`
    }).addTo(zoneLayer);
    pin.on('click', () => openZoneSheet(z.id));
    pin.bindTooltip(`${escapeHtml(z.name)} · ${LEVEL_LABEL[lvl]}`, {direction:'top', offset:[0, -sz], className:'zone-label ' + lvl});
  });
}

$('btn-recenter').addEventListener('click', async () => {
  if(!map) return;
  const btn = $('btn-recenter');
  btn.disabled = true; btn.textContent = '◎ Locating…';
  const pos = await getPosition({timeout:10000});
  btn.disabled = false; btn.textContent = '◎ Locate';
  if(pos){
    state.center = {lat:pos.lat, lng:pos.lng};
    state.indiaView = false; state.manualAreaLabel = '';
    saveState();
    updateUserMarker(pos);
    map.flyTo([pos.lat, pos.lng], Math.max(map.getZoom(), 14), {duration:.8});
    renderNearbyRisk();
  }else if(state.center){
    map.flyTo([state.center.lat, state.center.lng], Math.max(map.getZoom(), 11), {duration:.8});
    toast('GPS unavailable: showing your saved area');
  }else{
    toast('Location unavailable. Use "Change area" to set it.');
  }
});

/* ===================== NEARBY RISK CARD ===================== */
$('nearby-risk-toggle').addEventListener('click', () => {
  const card = $('nearby-risk-card');
  card.classList.toggle('collapsed');
  $('nearby-risk-toggle').setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
});
function renderNearbyRisk(){
  const labelEl = $('nearby-risk-label'), meter = $('nearby-risk-meter');
  if(!state.center){
    labelEl.textContent = 'Set your area';
    labelEl.style.color = '';
    $('nearby-risk-score').textContent = '—';
    meter.style.width = '0';
    $('nearby-risk-detail').textContent = 'Tap "Locate" or "Change area" to see the signal around you.';
    $('nearby-risk-confidence').textContent = 'No location set';
    return;
  }
  const r = nearbyRisk(state.center);
  if(!r){
    labelEl.textContent = 'No mapped signal nearby';
    labelEl.style.color = LEVEL_COLOR.green;
    $('nearby-risk-score').textContent = '—';
    meter.style.width = '0';
    $('nearby-risk-detail').textContent = `No mapped city or recent report within ${NEARBY_RANGE/1000} km. That isn't the same as safe: stay aware and check your route.`;
    $('nearby-risk-confidence').textContent = 'Coverage: 13 NCRB metro cities';
    return;
  }
  const level = scoreLevel(r.score);
  labelEl.textContent = level === 'red' ? 'Higher risk signal' : level === 'yellow' ? 'Caution advised' : 'Lower risk signal';
  labelEl.style.color = LEVEL_COLOR[level];
  $('nearby-risk-score').textContent = r.score + '/100';
  meter.style.width = r.score + '%';
  meter.style.background = LEVEL_COLOR[level];
  const nearest = `Nearest mapped area: ${r.nearest.z.name}, ${fmtDist(r.nearest.d)} away.`;
  $('nearby-risk-detail').textContent = nearest + ' ' + (r.evidence
    ? `${r.evidence} recent community report${r.evidence === 1 ? '' : 's'} included.`
    : 'Based on public NCRB baseline data; no recent community reports nearby.');
  $('nearby-risk-confidence').textContent = `Confidence: ${r.confidence}% · registered cases only · not a live police feed`;
}

function renderHotList(){
  const hl = $('hot-list');
  if(!hl) return;
  const list = ZONES.map(z => ({z, sig:zoneSignal(z)})).filter(x => x.sig.level !== 'green')
    .sort((a, b) => b.sig.score - a.sig.score).slice(0, 8);
  hl.innerHTML = list.map(({z, sig}) => `<button type="button" class="hot-item" data-id="${z.id}"><i style="background:${LEVEL_COLOR[sig.level]};color:${LEVEL_COLOR[sig.level]}"></i>${escapeHtml(z.name)}<span>${LEVEL_LABEL[sig.level]} · ${sig.score}</span></button>`).join('');
}
$('hot-list').addEventListener('click', e => {
  const b = e.target.closest('.hot-item');
  if(!b || !map) return;
  const z = ZONE_BY_ID[b.dataset.id];
  map.flyTo([z.lat, z.lng], 9, {duration:1.1});
  openZoneSheet(z.id);
});

/* ===================== ROUTE CHECK ===================== */
let routeFrom = null, routeTo = null;
attachPlaceSearch($('route-from'), $('route-from-results'), {onPick:p => { routeFrom = p; }, onClear:() => { routeFrom = null; }});
attachPlaceSearch($('route-to'), $('route-to-results'), {onPick:p => { routeTo = p; checkRoute(); }, onClear:() => { routeTo = null; }});
$('btn-route').addEventListener('click', checkRoute);
$('route-toggle').addEventListener('click', () => setRouteCardOpen($('route-card').classList.contains('collapsed')));
function setRouteCardOpen(open){
  $('route-card').classList.toggle('collapsed', !open);
  $('route-toggle').setAttribute('aria-expanded', String(open));
}

/** Shortest distance (m) from point p to a polyline of [lat,lng] pairs. */
function distToPath(p, coords){
  const kx = 111320*Math.cos(p.lat*Math.PI/180), ky = 110540;
  let best = Infinity;
  for(let i = 0; i < coords.length; i++){
    const ax = (coords[i][1] - p.lng)*kx, ay = (coords[i][0] - p.lat)*ky;
    if(i === coords.length - 1){ best = Math.min(best, Math.hypot(ax, ay)); break; }
    const bx = (coords[i+1][1] - p.lng)*kx, by = (coords[i+1][0] - p.lat)*ky;
    const dx = bx - ax, dy = by - ay, len2 = dx*dx + dy*dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax*dx + ay*dy)/len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t*dx, ay + t*dy));
  }
  return best;
}

let lastRoute = null;
async function checkRoute(){
  if(!routeTo){
    toast($('route-to').value.trim() ? 'Pick your destination from the list' : 'Type a destination first');
    $('route-to').focus();
    return;
  }
  const btn = $('btn-route');
  btn.disabled = true; btn.textContent = 'Checking…';
  try{
    let start = routeFrom;
    if(!start){
      if($('route-from').value.trim()){ toast('Pick a start point from the list, or clear it to use your location'); return; }
      const p = await bestPosition({timeout:8000});
      if(!p){ toast('Your location is unavailable. Type a start point.'); $('route-from').focus(); return; }
      start = {...p, label:p.approx ? 'Your saved area' : 'Your location'};
    }
    const end = routeTo;
    let coords, approx = false, dist, dur = null;
    try{
      const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
      const data = await fetchJSON(url, {timeout:9000});
      if(data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('no route');
      const r = data.routes[0];
      coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      dist = r.distance; dur = r.duration;
    }catch(e){
      approx = true;
      coords = [[start.lat, start.lng], [end.lat, end.lng]];
      dist = distanceMeters(start, end);
    }
    const hits = ZONES.map(z => ({z, sig:zoneSignal(z), d:distToPath(z, coords)}))
      .filter(x => x.d <= ZONE_RADIUS[x.sig.level])
      .sort((a, b) => b.sig.score - a.sig.score);
    const worst = hits.length ? hits[0].sig.level : 'green';
    const col = LEVEL_COLOR[worst];

    if(routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.layerGroup([
      L.polyline(coords, {color:'#000', weight:9, opacity:.35}),
      L.polyline(coords, {color:col, weight:5, opacity:.95, dashArray:approx ? '4 10' : null}),
      L.circleMarker([start.lat, start.lng], {radius:7, color:'#fff', weight:3, fillColor:'#18181B', fillOpacity:1}).bindTooltip('Start: ' + escapeHtml(start.label || 'Start')),
      L.circleMarker([end.lat, end.lng], {radius:8, color:'#fff', weight:3, fillColor:col, fillOpacity:1}).bindTooltip('Destination: ' + escapeHtml(end.label))
    ]).addTo(map);
    map.fitBounds(L.latLngBounds(coords), mapPadding());

    const night = (() => { const h = new Date().getHours(); return h >= 20 || h < 6; })();
    const arrive = dur ? fmtClock(Date.now() + dur*1000) : null;
    lastRoute = {start, end, dist, dur, arrive};
    const head = hits.length
      ? `<strong style="color:${col}">Heads up.</strong> This route passes through ${hits.length === 1 ? 'a flagged area' : hits.length + ' flagged areas'}:`
      : `<strong style="color:${LEVEL_COLOR.green}">No flagged areas</strong> on this route. Mapped coverage is limited to 13 cities, so stay aware.`;
    const zonesHtml = hits.length ? `<ul class="route-zones">${hits.map(x => `<li><i style="background:${LEVEL_COLOR[x.sig.level]}"></i>${escapeHtml(x.z.name)} <span>${LEVEL_LABEL[x.sig.level]}</span></li>`).join('')}</ul>` : '';
    const res = $('route-result');
    res.hidden = false;
    res.innerHTML = `
      ${head}${zonesHtml}
      <div class="route-meta">${fmtDist(dist)}${dur ? ' · ~' + fmtDuration(dur) + ' by road · arrive ~' + arrive : ' · straight-line estimate (road routing unavailable)'}</div>
      ${night && hits.length ? '<div class="route-tip">It\'s late: prefer main roads, share your trip, and consider starting a check-in timer.</div>' : ''}
      <div class="btn-pair">
        <a class="btn btn-secondary btn-sm" href="${directionsLink(end, start.approx ? null : start)}" target="_blank" rel="noopener">Navigate</a>
        <button class="btn btn-ghost btn-sm" type="button" id="route-share">Share trip</button>
      </div>`;
    $('route-share').addEventListener('click', shareTrip);
  }finally{
    btn.disabled = false; btn.textContent = 'Check route safety';
  }
}
async function shareTrip(){
  if(!lastRoute) return;
  const {start, end, dur, arrive} = lastRoute;
  const text = `I'm heading from ${start.label || 'my location'} to ${end.full || end.label}.` +
    (dur ? ` Expected travel time ~${fmtDuration(dur)}, arriving around ${arrive}.` : '') +
    ` Route: ${directionsLink(end, start.approx ? null : start)}`;
  await shareText(text, 'My trip');
}

/* ===================== ZONE SHEET ===================== */
let currentZoneId = null;
function openZoneSheet(id){
  currentZoneId = id;
  renderZoneSheet();
  openOverlay('zone-sheet-overlay', '#zone-add-report');
}
function renderZoneSheet(){
  const z = ZONE_BY_ID[currentZoneId];
  if(!z) return;
  const sig = zoneSignal(z);
  $('zone-name').textContent = z.name;
  $('zone-reason').textContent = z.reason;
  const tagEl = $('zone-tag');
  tagEl.className = 'tag ' + sig.level;
  tagEl.querySelector('.tag-dot').style.background = LEVEL_COLOR[sig.level];
  $('zone-tag-text').textContent = LEVEL_LABEL[sig.level];
  $('zone-score-bar').style.width = sig.score + '%';
  $('zone-score-bar').style.background = LEVEL_COLOR[sig.level];
  const dist = state.center ? ` · ${fmtDist(distanceMeters(state.center, z))} from you` : '';
  $('zone-meta').textContent = `Signal ${sig.score}/100 · NCRB baseline: ${LEVEL_LABEL[z.level].toLowerCase()} · ${sig.evidence} recent report${sig.evidence === 1 ? '' : 's'}${dist}`;
  $('zone-source').textContent = IN_SRC;
  renderZoneReports(z);
}
$('zone-sheet-close').addEventListener('click', () => closeOverlay('zone-sheet-overlay'));
$('zone-add-report').addEventListener('click', () => openReportModal(currentZoneId));
$('zone-route').addEventListener('click', () => {
  const z = ZONE_BY_ID[currentZoneId];
  closeOverlay('zone-sheet-overlay');
  showScreen('map');
  setRouteCardOpen(true);
  $('route-to').value = z.name;
  routeTo = {label:z.name, full:z.name, lat:z.lat, lng:z.lng, zoneId:z.id};
  checkRoute();
});

function reportHTML(r, withZone){
  const cats = (r.cats || []).map(c => `<span class="mini-chip">${escapeHtml(CAT_LABEL[c] || c)}</span>`).join('');
  const meta = [r.verified ? '✓ verified account' : 'anonymous', r.tod ? TOD_LABEL[r.tod] : '', timeAgo(r.ts)].filter(Boolean).join(' · ');
  return `
    <article class="${withZone ? 'feed-item' : 'report-item'}">
      <div class="meta">
        ${withZone ? `<button type="button" class="zone-name" data-zone="${r.zoneId}">${escapeHtml(ZONE_BY_ID[r.zoneId].name)}</button>` : ''}
        <span class="tag ${r.sev}"><span class="tag-dot" style="background:${LEVEL_COLOR[r.sev]}"></span>${SEV_LABEL[r.sev]}</span>
      </div>
      ${cats ? `<div class="mini-chips">${cats}</div>` : ''}
      <p>${escapeHtml(r.text)}</p>
      <div class="report-foot"><span class="time">${meta}</span>${r.mine !== false ? `<button type="button" class="link-btn" data-del="${escapeHtml(r.id)}">Delete</button>` : ''}</div>
    </article>`;
}
function renderZoneReports(z){
  const list = $('zone-reports');
  const reports = zoneReports(z.id).sort((a, b) => b.ts - a.ts);
  list.innerHTML = reports.length
    ? reports.map(r => reportHTML(r, false)).join('')
    : `<p class="muted small">No community reports for this area yet. Seen something? Adding a report helps the next person decide.</p>`;
}

/* ===================== REPORTS ===================== */
function zonesByDistance(){
  if(!state.center) return [...ZONES];
  return [...ZONES].sort((a, b) => distanceMeters(state.center, a) - distanceMeters(state.center, b));
}
let reportTod = '';
$('report-cats').innerHTML = REPORT_CATS.map(([k, label]) => `<button class="chip" type="button" data-cat="${k}" aria-pressed="false">${label}</button>`).join('');
$('report-cats').addEventListener('click', e => {
  const c = e.target.closest('[data-cat]');
  if(!c) return;
  c.classList.toggle('active');
  c.setAttribute('aria-pressed', String(c.classList.contains('active')));
});
$('report-tod').addEventListener('click', e => {
  const c = e.target.closest('[data-tod]');
  if(!c) return;
  reportTod = reportTod === c.dataset.tod ? '' : c.dataset.tod;
  $('report-tod').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.tod === reportTod));
});
$('report-text').addEventListener('input', () => { $('report-count').textContent = $('report-text').value.length + '/500'; });

function openReportModal(zoneId){
  const sel = $('report-zone');
  const ordered = zonesByDistance();
  sel.innerHTML = ordered.map(z => `<option value="${z.id}">${escapeHtml(z.name)}${state.center ? ' · ' + fmtDist(distanceMeters(state.center, z)) : ''}</option>`).join('');
  sel.value = zoneId || ordered[0].id;
  $('report-severity').value = 'yellow';
  $('report-text').value = '';
  $('report-count').textContent = '0/500';
  $('report-cats').querySelectorAll('.chip').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
  const h = new Date().getHours();
  reportTod = h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  $('report-tod').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.tod === reportTod));
  openOverlay('report-modal-overlay', '#report-severity');
}
$('report-cancel').addEventListener('click', () => closeOverlay('report-modal-overlay'));
$('report-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('report-text').value.trim();
  const sev = $('report-severity').value;
  const zoneId = $('report-zone').value;
  if(!ZONE_BY_ID[zoneId]){ toast('Choose an area'); return; }
  if(SEV_RANK[sev] === undefined){ toast('Choose a valid severity'); return; }
  if(text.length < 12){ toast('Add a little more detail so others can judge the signal'); $('report-text').focus(); return; }
  const cats = [...$('report-cats').querySelectorAll('.chip.active')].map(c => c.dataset.cat);
  state.reports.unshift({
    id:'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    zoneId, sev, text, ts:Date.now(), verified:!!state.verified, cats, tod:reportTod, mine:true
  });
  saveState();
  closeOverlay('report-modal-overlay');
  afterReportsChanged();
  toast('Report added. Thank you for keeping others safe');
});
async function deleteReport(id){
  const ok = await confirmDialog({title:'Delete this report?', body:'It will be removed from this device and stop affecting the map.', ok:'Delete', danger:true});
  if(!ok) return;
  state.reports = state.reports.filter(r => r.id !== id);
  saveState();
  afterReportsChanged();
  toast('Report deleted');
}
function afterReportsChanged(){
  renderZonesOnMap();
  renderNearbyRisk();
  renderHotList();
  renderFeed();
  if($('zone-sheet-overlay').classList.contains('active')) renderZoneSheet();
}
$('zone-reports').addEventListener('click', e => {
  const d = e.target.closest('[data-del]');
  if(d) deleteReport(d.dataset.del);
});

/* ===================== FEED ===================== */
let feedFilter = 'all';
$('feed-filters').addEventListener('click', e => {
  const c = e.target.closest('[data-filter]');
  if(!c) return;
  feedFilter = c.dataset.filter;
  $('feed-filters').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b === c));
  renderFeed();
});
$('feed-new-report').addEventListener('click', () => {
  const near = state.center ? zonesByDistance()[0] : null;
  openReportModal(near && distanceMeters(state.center, near) < NEARBY_RANGE ? near.id : null);
});
function renderFeed(){
  const list = $('feed-list');
  if(!state.reports.length){
    list.innerHTML = `<div class="empty">
      <div class="empty-ico" aria-hidden="true">✎</div>
      <h3>No reports yet</h3>
      <p>Felt unsafe somewhere? A short, anonymous report raises that area's signal on your map and helps you remember places to avoid.</p>
      <button class="btn btn-primary btn-sm" type="button" data-new-report>+ Add the first report</button>
    </div>`;
    return;
  }
  const all = state.reports.filter(r => feedFilter === 'all' || r.sev === feedFilter).sort((a, b) => b.ts - a.ts);
  list.innerHTML = all.length ? all.map(r => reportHTML(r, true)).join('') : `<p class="muted">No reports at this level.</p>`;
}
$('feed-list').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if(del){ deleteReport(del.dataset.del); return; }
  if(e.target.closest('[data-new-report]')){ $('feed-new-report').click(); return; }
  const zb = e.target.closest('[data-zone]');
  if(zb){
    const z = ZONE_BY_ID[zb.dataset.zone];
    showScreen('map');
    if(map) map.flyTo([z.lat, z.lng], 9, {duration:1});
    openZoneSheet(z.id);
  }
});

/* ===================== TIPS ===================== */
const TIPS = [
  {title:'Before you go out', items:[
    'Share your route and expected arrival time with someone you trust, or start a check-in timer in the Toolkit.',
    'Check the map for high or moderate signals along your route, especially after dark.',
    'Keep your phone above 30% and carry a power bank on long days.',
    'Prefer well-lit, busy roads over shortcuts. Know a few safe stops on your regular routes: a pharmacy, petrol pump or 24×7 shop.',
    'Install SafeCircle to your home screen so SOS is one tap away.'
  ]},
  {title:'Cabs, autos and public transport', items:[
    'Match the number plate, driver photo and name before you get in, and sit in the back.',
    "Share the live trip from your ride app with a contact, and keep your own map open to follow the route.",
    "Use women-only coaches where available, such as the Delhi Metro's first coach or Mumbai local ladies' compartments.",
    'If a driver leaves the route or makes you uncomfortable, ask to stop somewhere busy and call someone on speaker.'
  ]},
  {title:'If you feel unsafe', items:[
    'Trust the feeling. Move toward a shop, a group of people or a well-lit area.',
    'Call a friend and stay on the line, or use the fake call in the Toolkit as a reason to leave.',
    "If someone is following you, cross the road, change direction and head somewhere public. Don't lead them to your home.",
    'Use the siren to draw attention, and press SOS to call 112 and send your live location in one tap.'
  ]},
  {title:'Online safety', items:[
    'Share live location only with people you trust, never publicly on social media.',
    'Report online harassment, morphed photos or blackmail at cybercrime.gov.in or call 1930. Keep screenshots as evidence.',
    'Turn on two-factor authentication for your email and social accounts.'
  ]},
  {title:'Know your rights', note:'General information, not legal advice.', items:[
    'Zero FIR: you can report a cognizable offence at any police station, wherever it happened. It is then transferred to the right station.',
    'For sexual offences, your statement should be recorded by a woman police officer.',
    "A woman can't be required to go to a police station to be questioned as a witness; she can be questioned where she lives.",
    "Women generally can't be arrested between sunset and sunrise, except in exceptional cases with a magistrate's prior permission.",
    'Free legal aid is available to women: call NALSA on 15100, or 181 to reach a One Stop Centre (Sakhi) for medical, legal and shelter support.'
  ]}
];
function renderTips(){
  $('tips-list').innerHTML = TIPS.map(cat => `
    <section class="tips-cat">
      <h3>${escapeHtml(cat.title)}</h3>
      ${cat.note ? `<p class="tips-note">${escapeHtml(cat.note)}</p>` : ''}
      ${cat.items.map(t => `<div class="tip-row"><span class="dot"></span><p>${escapeHtml(t)}</p></div>`).join('')}
    </section>`).join('');
}

/* ===================== PROFILE ===================== */
const MAX_CONTACTS = 5;
function renderProfile(){
  if(!state.user) return;
  $('profile-initial').textContent = (state.user.name || '?').trim().charAt(0).toUpperCase() || '?';
  $('profile-name').textContent = state.user.name || '—';
  $('profile-phone').innerHTML = `${escapeHtml(formatPhone(state.user.phone))}${state.verified ? ' <span class="verified">✓ verified</span>' : ''}`;
  $('profile-email').textContent = state.user.email || '';
  $('toggle-available').checked = !!state.available;
  $('toggle-shake').checked = !!state.settings.shake;
  if(document.activeElement !== $('sos-message')) $('sos-message').value = state.settings.sosMessage || '';
  $('med-blood').value = state.medical.blood || '';
  $('med-allergies').value = state.medical.allergies || '';
  $('med-notes').value = state.medical.notes || '';
  renderContacts();
}
function renderContacts(){
  const list = $('contacts-list');
  list.innerHTML = state.contacts.length
    ? state.contacts.map(c => `
      <div class="contact-row">
        <div class="contact-ava" aria-hidden="true">${escapeHtml(c.name.charAt(0).toUpperCase())}</div>
        <div class="contact-info"><div class="name">${escapeHtml(c.name)}${c.relation ? ` <span class="rel">${escapeHtml(c.relation)}</span>` : ''}</div><div class="phone">${escapeHtml(formatPhone(c.phone))}</div></div>
        <a class="icon-btn" href="tel:${escapeHtml(c.phone)}" aria-label="Call ${escapeHtml(c.name)}">📞</a>
        <button class="icon-btn" type="button" data-remove="${escapeHtml(c.id)}" aria-label="Remove ${escapeHtml(c.name)}">✕</button>
      </div>`).join('')
    : `<p class="muted small warn">No emergency contacts yet. Add at least one so SOS can message them.</p>`;
  $('add-contact-btn').hidden = state.contacts.length >= MAX_CONTACTS || !$('contact-form').hidden;
}
$('contacts-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-remove]');
  if(!b) return;
  const c = state.contacts.find(x => x.id === b.dataset.remove);
  if(!c) return;
  if(!(await confirmDialog({title:`Remove ${c.name}?`, body:"They won't be included in SOS messages any more.", ok:'Remove', danger:true}))) return;
  state.contacts = state.contacts.filter(x => x.id !== c.id);
  saveState();
  renderContacts();
});
$('add-contact-btn').addEventListener('click', () => {
  $('contact-form').hidden = false;
  $('add-contact-btn').hidden = true;
  $('contact-name').focus();
});
$('cancel-contact').addEventListener('click', () => {
  $('contact-form').reset();
  $('contact-form').hidden = true;
  renderContacts();
});
$('contact-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('contact-name').value.trim();
  const phone = normalizePhone($('contact-phone').value);
  if(!name){ toast('Add a name'); $('contact-name').focus(); return; }
  if(!phone){ toast('Enter a valid phone number'); $('contact-phone').focus(); return; }
  if(state.contacts.length >= MAX_CONTACTS){ toast(`You can add up to ${MAX_CONTACTS} contacts`); return; }
  if(state.contacts.some(c => c.phone === phone)){ toast('That number is already a contact'); return; }
  state.contacts.push({id:'c' + Date.now().toString(36), name, phone, relation:$('contact-relation').value.trim()});
  saveState();
  $('contact-form').reset();
  $('contact-form').hidden = true;
  renderContacts();
  toast(`${name} added to emergency contacts`);
});

let sosMsgSave = null;
$('sos-message').addEventListener('input', () => {
  clearTimeout(sosMsgSave);
  sosMsgSave = setTimeout(() => { state.settings.sosMessage = $('sos-message').value.trim(); saveState(); }, 400);
});
$('sos-preview').addEventListener('click', () => {
  state.settings.sosMessage = $('sos-message').value.trim();
  saveState();
  const box = $('sos-preview-box');
  box.textContent = composeSOSMessage(currentKnownPosition() || {...DEFAULT_CENTER, accuracy:25});
  box.hidden = false;
});
['med-blood', 'med-allergies', 'med-notes'].forEach(id => $(id).addEventListener('change', () => {
  state.medical = {blood:$('med-blood').value, allergies:$('med-allergies').value.trim(), notes:$('med-notes').value.trim()};
  saveState();
  toast('Medical info saved');
}));
$('toggle-available').addEventListener('change', e => {
  state.available = e.target.checked;
  saveState();
  toast(state.available ? "Saved. You'll be asked to help once the nearby network launches" : 'Nearby help alerts off');
});
$('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({...state, exportedAt:new Date().toISOString()}, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `safecircle-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('logout-btn').addEventListener('click', async () => {
  const ok = await confirmDialog({title:'Log out and erase?', body:'This deletes your profile, contacts, reports and settings from this device. It cannot be undone.', ok:'Erase everything', danger:true});
  if(!ok) return;
  try{ localStorage.removeItem(STORE_KEY); }catch(e){}
  location.reload();
});

/* ===================== SOS ===================== */
const sos = {active:false, startedAt:0, watchId:null, pos:null, address:'', addressPos:null, addressBusy:false, tick:null, reason:''};
let sosCountTimer = null;

function startSOSCountdown(){
  if(sos.active){ showScreen('sos'); return; }
  if(!$('sos-countdown').hidden) return;
  let n = 3;
  $('sos-count').textContent = n;
  openOverlay('sos-countdown', '#sos-count-cancel');
  vibrate(200);
  clearInterval(sosCountTimer);
  sosCountTimer = setInterval(() => {
    n -= 1;
    if(n <= 0){ clearInterval(sosCountTimer); closeOverlay('sos-countdown'); startSOS(); return; }
    $('sos-count').textContent = n;
    vibrate(200);
  }, 1000);
}
function cancelSOSCountdown(){
  clearInterval(sosCountTimer);
  closeOverlay('sos-countdown');
  toast('SOS cancelled');
}
escHandlers['sos-countdown'] = cancelSOSCountdown;
$('sos-fab').addEventListener('click', startSOSCountdown);
$('sos-count-cancel').addEventListener('click', cancelSOSCountdown);
$('sos-now').addEventListener('click', () => { clearInterval(sosCountTimer); closeOverlay('sos-countdown'); startSOS(); });

function startSOS(reason){
  clearInterval(sosCountTimer);
  if(!$('sos-countdown').hidden) closeOverlay('sos-countdown');
  if(!sos.active){
    sos.active = true;
    sos.startedAt = Date.now();
    sos.address = ''; sos.addressPos = null;
    sos.pos = currentKnownPosition();
  }
  sos.reason = reason || sos.reason || '';
  showScreen('sos');
  $('sos-banner').hidden = !sos.reason;
  $('sos-banner').textContent = sos.reason;
  renderSOSContacts();
  renderSOSMedical();
  renderSOSLocation();
  requestWakeLock('sos');
  vibrate([300, 120, 300]);

  if(navigator.geolocation && isSecureCtx() && sos.watchId === null){
    sos.watchId = navigator.geolocation.watchPosition(
      p => {
        sos.pos = lastFix = {lat:p.coords.latitude, lng:p.coords.longitude, accuracy:p.coords.accuracy, ts:Date.now()};
        renderSOSLocation();
        updateUserMarker(sos.pos);
        maybeReverseGeocode();
        if(!sos.policeLoaded) loadSOSPolice();
      },
      () => { if(!sos.pos) $('sos-loc-sub').textContent = 'GPS unavailable. Messages will use your saved area.'; },
      {enableHighAccuracy:true, maximumAge:5000, timeout:20000}
    );
  }
  clearInterval(sos.tick);
  sos.tick = setInterval(() => { renderSOSElapsed(); renderSOSLocation(); }, 1000);
  renderSOSElapsed();
  maybeReverseGeocode();
  loadSOSPolice();
}
function renderSOSElapsed(){
  const s = Math.floor((Date.now() - sos.startedAt)/1000);
  $('sos-elapsed').textContent = s < 60 ? `Started ${s}s ago · ${fmtClock(sos.startedAt)}` : `Active for ${Math.floor(s/60)} min · since ${fmtClock(sos.startedAt)}`;
}
function renderSOSLocation(){
  const p = sos.pos;
  if(!p){ $('sos-loc-main').textContent = 'Locating…'; return; }
  $('sos-loc-main').textContent = sos.address || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  const age = p.ts ? Math.round((Date.now() - p.ts)/1000) : null;
  $('sos-loc-sub').textContent = p.approx
    ? 'Approximate: your saved area (waiting for GPS)'
    : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ±${Math.round(p.accuracy || 0)} m · updated ${age < 5 ? 'just now' : age + 's ago'}`;
}
async function maybeReverseGeocode(){
  const p = sos.pos;
  if(!p || p.approx || sos.addressBusy) return;
  if(sos.addressPos && distanceMeters(sos.addressPos, p) < 150) return;
  sos.addressBusy = true;
  try{
    const d = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${p.lat}&lon=${p.lng}`, {timeout:8000, headers:{'Accept-Language':'en'}});
    if(d && d.display_name){
      sos.address = d.display_name.split(',').slice(0, 3).join(',').trim();
      sos.addressPos = {lat:p.lat, lng:p.lng};
      renderSOSLocation();
    }
  }catch(e){}
  finally{ sos.addressBusy = false; }
}
function renderSOSContacts(){
  const el = $('sos-contacts');
  if(!state.contacts.length){
    el.innerHTML = `<div class="sos-card"><h4>Emergency contacts</h4><p>No contacts saved. Use “WhatsApp location” or “Share” to send your location to anyone.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="sos-card"><h4>Call a contact</h4>${state.contacts.map(c => `
    <div class="sos-contact"><span>${escapeHtml(c.name)}${c.relation ? ` <small>${escapeHtml(c.relation)}</small>` : ''}</span>
      <span class="sos-contact-actions">
        <a href="tel:${escapeHtml(c.phone)}" class="pill-btn">Call</a>
        <button type="button" class="pill-btn" data-wa="${escapeHtml(c.phone)}">WhatsApp</button>
      </span></div>`).join('')}</div>`;
}
$('sos-contacts').addEventListener('click', e => {
  const b = e.target.closest('[data-wa]');
  if(!b) return;
  openWhatsApp(composeSOSMessage(sos.pos), b.dataset.wa);
});
function renderSOSMedical(){
  const m = state.medical;
  const rows = [['Blood group', m.blood], ['Allergies', m.allergies], ['Notes', m.notes]].filter(r => r[1]);
  $('sos-medical').innerHTML = rows.length
    ? `<div class="sos-card medical"><h4>Medical info${state.user ? ' · ' + escapeHtml(state.user.name) : ''}</h4>${rows.map(r => `<div class="med-row"><span>${r[0]}</span><b>${escapeHtml(r[1])}</b></div>`).join('')}</div>`
    : '';
}
async function loadSOSPolice(){
  const el = $('sos-police');
  const p = sos.pos;
  if(!p){
    el.innerHTML = `<div class="sos-card"><h4>Nearest police</h4><p>Waiting for your location. Call 112 meanwhile: it routes to your local police.</p></div>`;
    return;
  }
  if(typeof findNearbyHelp !== 'function' || sos.policeBusy) return;
  if(sos.policeFailedAt && Date.now() - sos.policeFailedAt < 30000) return; // offline: retry every 30s, not on every GPS fix
  sos.policeBusy = true;
  if(!sos.policeLoaded) el.innerHTML = `<div class="sos-card"><h4>Nearest police</h4><p>Searching near you…</p></div>`;
  try{
    const items = (await findNearbyHelp(p)).filter(x => x.kind === 'police').slice(0, 2);
    sos.policeLoaded = !p.approx;
    el.innerHTML = `<div class="sos-card"><h4>Nearest police</h4>${items.length ? items.map(x => `
      <div class="sos-contact"><span>${escapeHtml(x.name)} <small>${fmtDist(x.dist)}</small></span>
        <span class="sos-contact-actions">${x.phone ? `<a class="pill-btn" href="tel:${escapeHtml(x.phone)}">Call</a>` : ''}<a class="pill-btn" target="_blank" rel="noopener" href="${directionsLink(x, p.approx ? null : p)}">Directions</a></span>
      </div>`).join('') : '<p>No police station found nearby in OpenStreetMap. Call 112.</p>'}</div>`;
  }catch(e){
    sos.policeFailedAt = Date.now();
    el.innerHTML = `<div class="sos-card"><h4>Nearest police</h4><p>Couldn't load nearby stations (offline?). Call 112: it routes to your local police.</p></div>`;
  }finally{ sos.policeBusy = false; }
}

/* ---------- Messages: SMS / WhatsApp / share ---------- */
function composeSOSMessage(pos){
  const lines = [(state.settings.sosMessage || 'I need help. Please call me or come to my location.').trim()];
  if(pos){
    lines.push(`📍 ${mapsLink(pos)}${pos.approx ? ' (approximate area)' : pos.accuracy ? ` (±${Math.round(pos.accuracy)} m)` : ''}`);
    if(sos.active && sos.address) lines.push('Near: ' + sos.address);
  }else lines.push('(Location unavailable)');
  lines.push(`🕒 ${fmtClock(Date.now())}${batteryPct !== null ? ` · 🔋 ${batteryPct}%` : ''}`);
  if(state.user && state.user.name) lines.push(`- ${state.user.name}, via SafeCircle`);
  return lines.join('\n');
}
function smsHref(numbers, body){
  const enc = encodeURIComponent(body);
  if(IS_IOS) return numbers.length > 1 ? `sms:/open?addresses=${numbers.join(',')}&body=${enc}` : `sms:${numbers[0] || ''}&body=${enc}`;
  return `sms:${numbers.join(',')}?body=${enc}`;
}
function openSMS(numbers, body){ location.href = smsHref(numbers, body); }
function openWhatsApp(text, phone){
  const url = `https://wa.me/${phone ? phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(text)}`;
  const w = window.open(url, '_blank');
  if(w) w.opener = null; else location.href = url; // popup blocked: open in this tab
}
async function shareText(text, title){
  if(navigator.share){
    try{ await navigator.share({title, text}); return; }
    catch(e){ if(e.name === 'AbortError') return; }
  }
  toast(await copyText(text) ? 'Copied: paste it into any chat' : "Couldn't copy. Long-press to select instead");
}

$('btn-sms').addEventListener('click', () => {
  if(!state.contacts.length){ toast('No contacts saved. Pick someone in your SMS app'); openSMS([], composeSOSMessage(sos.pos)); return; }
  openSMS(state.contacts.map(c => c.phone), composeSOSMessage(sos.pos));
});
$('btn-whatsapp').addEventListener('click', () => openWhatsApp(composeSOSMessage(sos.pos)));
$('btn-share-link').addEventListener('click', () => shareText(composeSOSMessage(sos.pos), 'I need help'));
$('btn-sos-siren').addEventListener('click', () => { if(typeof startSiren === 'function') startSiren(); });
$('btn-end-sos').addEventListener('click', endSOS);

async function endSOS(){
  const tell = state.contacts.length
    ? await confirmDialog({title:"Glad you're safe", body:"Let your emergency contacts know you're okay?", ok:"Send \"I'm safe\" SMS", cancel:'Just end alert'})
    : false;
  if(sos.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(sos.watchId);
  sos.watchId = null;
  clearInterval(sos.tick);
  sos.active = false; sos.reason = ''; sos.policeLoaded = false; sos.policeFailedAt = 0;
  releaseWakeLock('sos');
  if(typeof stopSiren === 'function') stopSiren();
  showScreen(state.user ? 'map' : 'auth');
  toast('Alert ended');
  if(tell) openSMS(state.contacts.map(c => c.phone), `I'm safe now. Sorry to worry you.${state.user ? ' - ' + state.user.name : ''}`);
}

/* ===================== BOOT ===================== */
function boot(){
  initBattery();
  renderTips();
  if(state.user && state.verified){
    if(state.center || state.indiaView) initApp();
    else requestLocationThenStart();
  }else{
    showScreen('auth');
    showAuthStep('form');
  }
  if(typeof initTools === 'function') initTools();
  // Home-screen shortcuts from the manifest: ?action=sos | fakecall
  const action = new URLSearchParams(location.search).get('action');
  if(action){
    history.replaceState(null, '', location.pathname);
    if(state.user && state.verified){
      if(action === 'sos') startSOSCountdown();
      else if(action === 'fakecall'){ showScreen('tools'); $('tool-fakecall').scrollIntoView({block:'center'}); }
    }
  }
}
document.addEventListener('DOMContentLoaded', boot);
