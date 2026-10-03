/* ===================== STATE ===================== */
const DEFAULT_CENTER = {lat:28.6139, lng:77.2090}; // Delhi fallback
let state = loadState();

function loadState(){
  const raw = localStorage.getItem('safecircle_state');
  if(raw){ try{ return JSON.parse(raw);}catch(e){} }
  return {
    user:null,
    contacts:[],
    available:true,
    center:null,
    zones:null
  };
}
function saveState(){ localStorage.setItem('safecircle_state', JSON.stringify(state)); }

const IN_SRC="Source: NCRB Crime in India (2022/2023). Counts are FIRs registered, not total incidents; higher numbers partly reflect better reporting and registration. Use as awareness, not a verdict on any neighbourhood.";
const ZONE_TEMPLATES = [
 {name:"Delhi (NCT)",level:"red",lat:28.6139,lng:77.2090,reason:"Highest among 19 metros: 1,204 rape cases in 2022 and 1,088 in 2023 (NCRB). Police attribute part of this to strict FIR registration."},
 {name:"Jaipur",level:"red",lat:26.9124,lng:75.7873,reason:"Second-highest among metros: 497 rape cases in 2022 and 573 in 2023 (NCRB). Rajasthan is also among the top states by absolute count."},
 {name:"Indore",level:"red",lat:22.7196,lng:75.8577,reason:"NCRB 2023 reported a crime-against-women rate per lakh higher than Delhi's. Madhya Pradesh is among the top states by rape cases."},
 {name:"Lucknow",level:"yellow",lat:26.8467,lng:80.9462,reason:"One of the 19 NCRB metros; Uttar Pradesh records among the highest absolute counts of crimes against women. Check NCRB city tables for exact figures."},
 {name:"Kanpur",level:"yellow",lat:26.4499,lng:80.3319,reason:"Higher-than-average dowry/crime-against-women rates among metros in NCRB 2023. Check NCRB city tables for exact figures."},
 {name:"Ghaziabad",level:"yellow",lat:28.6692,lng:77.4538,reason:"NCRB metro with elevated crime-against-women rates in 2023. Part of the Delhi-NCR belt; check NCRB tables for exact figures."},
 {name:"Mumbai",level:"yellow",lat:19.0760,lng:72.8777,reason:"6,176 crimes against women in 2022, second among metros in volume (NCRB), but 196 rape cases in 2023, far fewer than Delhi or Jaipur."},
 {name:"Bengaluru",level:"yellow",lat:12.9716,lng:77.5946,reason:"3,924 crimes against women in 2022, third among metros (NCRB). Large share is cyber and harassment-type cases."},
 {name:"Hyderabad",level:"yellow",lat:17.3850,lng:78.4867,reason:"Large metro with high cyber-crime-against-women volume (NCRB 2022). Check NCRB tables for rape and harassment counts."},
 {name:"Patna",level:"yellow",lat:25.5941,lng:85.1376,reason:"NCRB metro; Bihar reports elevated crimes against women. Check NCRB tables for exact figures."},
 {name:"Pune",level:"yellow",lat:18.5204,lng:73.8567,reason:"NCRB metro with moderate volume of crimes against women. Check NCRB tables for exact figures."},
 {name:"Kolkata",level:"green",lat:22.5726,lng:88.3639,reason:"Has had one of the lowest registered rates of crime against women among NCRB metros. Low reported rate is not zero risk."},
 {name:"Chennai",level:"green",lat:13.0827,lng:80.2707,reason:"Moderate reported rates relative to size among NCRB metros. Check NCRB tables for exact figures."}
];
function buildZones(center){
  return ZONE_TEMPLATES.map((t,i)=>({id:'z'+i,name:t.name,level:t.level,reason:t.reason+" "+IN_SRC,
    lat:t.lat,lng:t.lng,radius:14000,reports:[],baselineLevel:t.level}));
}

const LEVEL_COLOR = {red:'#FF3B4E', yellow:'#FFB020', green:'#2FD28F'};
const LEVEL_LABEL = {red:'High risk', yellow:'Moderate risk', green:'Generally safe'};

const NEARBY_USER_POOL = [
  {name:"Ananya R.", dist:"180 m"},
  {name:"Fatima K.", dist:"240 m"},
  {name:"Meera S.", dist:"310 m"},
  {name:"Divya N.", dist:"350 m"},
  {name:"Ritu P.", dist:"420 m"}
];

let map, zoneLayers = [], routeLine = null, userMarker = null;
let currentZoneId = null;
let sosTimers = [];

/* ===================== NAV / SCREENS ===================== */
function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active', b.dataset.nav===name));
  const chromeHidden = (name==='sos'||name==='auth');
  document.getElementById('bottomnav').style.display = chromeHidden ? 'none' : 'flex';
  document.getElementById('sos-fab').style.display = chromeHidden ? 'none' : 'flex';
  if(name==='map' && map){ setTimeout(()=>map.invalidateSize(), 80); }
}
document.querySelectorAll('.navbtn').forEach(b=>{
  b.addEventListener('click', ()=>{
    showScreen(b.dataset.nav);
    if(b.dataset.nav==='feed') renderFeed();
    if(b.dataset.nav==='profile') renderProfile();
  });
});

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ===================== AUTH ===================== */


function requestLocationThenStart(){
  document.getElementById('auth-title').textContent = 'Finding your area…';
  document.getElementById('auth-sub').textContent = 'Allow location access so we can show risk zones and route safety near you.';
  document.getElementById('auth-form').style.display = 'none';
  document.getElementById('manual-location-block').style.display = 'none';
  document.getElementById('locating-status').style.display = 'block';
  document.getElementById('locating-msg').textContent = 'Getting your location…';

  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  if(!isSecure){
    showManualLocation('This page needs to be served over HTTPS (or localhost) for GPS to work in most browsers. Enter your location manually below, or open this app via a secure URL.');
    return;
  }
  if(!navigator.geolocation){
    showManualLocation('Your browser doesn\'t support location access. Enter your location manually below.');
    return;
  }

  const isChange = !!state.zones;
  navigator.geolocation.getCurrentPosition(
    pos=>{
      state.center = {lat:pos.coords.latitude, lng:pos.coords.longitude};
      finishSetup(isChange);
    },
    err=>{
      let msg = 'We couldn\'t get your GPS location automatically.';
      if(err.code === err.PERMISSION_DENIED) msg = 'Location access was denied. You can enable it in your browser/site settings, or set your area manually below.';
      else if(err.code === err.TIMEOUT) msg = 'Location took too long to respond (weak GPS signal or indoors). Try again, or set your area manually.';
      showManualLocation(msg);
    },
    {timeout:12000, enableHighAccuracy:true, maximumAge:0}
  );
}

function showManualLocation(message){
  document.getElementById('locating-status').style.display = 'none';
  document.getElementById('auth-title').textContent = 'Set your location';
  document.getElementById('auth-sub').textContent = 'GPS didn\'t come through — no problem, just search for it manually.';
  const block = document.getElementById('manual-location-block');
  block.style.display = 'block';
  block.querySelector('p').textContent = message;
}

document.getElementById('manual-location-retry').addEventListener('click', requestLocationThenStart);

document.getElementById('btn-change-location').addEventListener('click', ()=>{
  showScreen('auth');
  document.getElementById('auth-form').style.display = 'none';
  showManualLocation('Update your area below, or retry GPS.');
});
document.getElementById('btn-recenter').addEventListener('click', ()=>{
  if(!map || !state.center){ toast('Location is not available yet'); return; }
  map.flyTo([state.center.lat,state.center.lng], Math.max(map.getZoom(), 11), {duration:.7});
  if(userMarker) userMarker.openTooltip();
});
document.getElementById('nearby-risk-toggle').addEventListener('click', ()=>{
  document.getElementById('nearby-risk-card').classList.toggle('collapsed');
});

/* ---------- Real-world geocoding (OpenStreetMap Nominatim, works anywhere) ---------- */
let selectedGeocodeResult = null;
let geocodeDebounce = null;
let geocodeAbortCtrl = null;

const locInput = document.getElementById('manual-location-input');
const locResults = document.getElementById('manual-location-results');
const locSelectedLabel = document.getElementById('manual-location-selected');
const locConfirmBtn = document.getElementById('manual-location-confirm');

function clearSelectedLocation(){
  selectedGeocodeResult = null;
  locConfirmBtn.disabled = true;
  locSelectedLabel.style.display = 'none';
}

locInput.addEventListener('input', function(){
  clearSelectedLocation();
  const q = this.value.trim();
  clearTimeout(geocodeDebounce);
  if(q.length < 3){ locResults.innerHTML = ''; return; }
  locResults.innerHTML = `<div class="loc-result loc-loading"><span class="loc-spin"></span>Searching…</div>`;
  geocodeDebounce = setTimeout(()=> runGeocodeSearch(q), 450);
});

async function runGeocodeSearch(q){
  if(geocodeAbortCtrl) geocodeAbortCtrl.abort();
  geocodeAbortCtrl = new AbortController();
  try{
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=in&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: geocodeAbortCtrl.signal, headers: { 'Accept-Language': navigator.language || 'en' } });
    if(!res.ok) throw new Error('geocode failed');
    const data = await res.json();
    renderGeocodeResults(data);
  }catch(err){
    if(err.name === 'AbortError') return;
    locResults.innerHTML = `<div class="loc-result loc-empty">Couldn't search right now — check your connection and try again.</div>`;
  }
}

function renderGeocodeResults(results){
  if(!results || !results.length){
    locResults.innerHTML = `<div class="loc-result loc-empty">No matches. Try a more specific place or postcode.</div>`;
    return;
  }
  locResults.innerHTML = results.map((r,i)=>{
    const main = (r.display_name || '').split(',')[0];
    const rest = (r.display_name || '').split(',').slice(1,4).join(',').trim();
    return `<div class="loc-result" data-idx="${i}">${escapeHtml(main)}${rest ? `<span class="loc-sub">${escapeHtml(rest)}</span>` : ''}</div>`;
  }).join('');
  locResults.querySelectorAll('.loc-result[data-idx]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const r = results[Number(el.dataset.idx)];
      selectedGeocodeResult = { lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: r.display_name };
      locInput.value = (r.display_name || '').split(',')[0];
      locResults.innerHTML = '';
      locSelectedLabel.textContent = '✓ ' + r.display_name;
      locSelectedLabel.style.display = 'block';
      locConfirmBtn.disabled = false;
    });
  });
}

document.getElementById('manual-location-confirm').addEventListener('click', ()=>{
  if(!selectedGeocodeResult){ toast('Pick a location from the search results first'); return; }
  const isChange = !!state.zones;
  state.center = { lat: selectedGeocodeResult.lat, lng: selectedGeocodeResult.lng };
  state.manualAreaLabel = selectedGeocodeResult.label;
  finishSetup(isChange);
});

function finishSetup(changedLocation){
  state.indiaView = !!window.__indiaOnly; window.__indiaOnly = false;
  if(!state.zones || changedLocation){ state.zones = buildZones(state.center); }
  saveState();
  initApp(changedLocation);
}

/* ===================== INIT ===================== */
function initApp(changedLocation){
  document.getElementById('auth-form').style.display = 'block';
  document.getElementById('locating-status').style.display = 'none';
  document.getElementById('manual-location-block').style.display = 'none';
  showScreen('map');
  if(changedLocation && map){ map.remove(); map = null; }
  buildMap();
  populateRouteSelects();
  renderTips();
  renderProfile();
  renderFeed();
  renderNearbyRisk();
}

function distanceMeters(a,b){
  const rad = Math.PI/180, dLat=(b.lat-a.lat)*rad, dLng=(b.lng-a.lng)*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLng/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function reportWeight(report){
  const ageDays=Math.max(0,(Date.now()-(report.ts||0))/86400000);
  const freshness=Math.max(.15,1-ageDays/90);
  return freshness*(report.verified ? 1 : .65);
}
function zoneSignal(zone, center){
  const rank={green:0,yellow:1,red:2};
  const baseline=rank[zone.baselineLevel||zone.level]||0;
  const nearby=distanceMeters(center,zone)<65000;
  if(!nearby) return {score:0, evidence:0, confidence:0};
  const reports=(zone.reports||[]).filter(r=>Date.now()-(r.ts||0)<180*86400000);
  const weighted=reports.reduce((sum,r)=>sum+(rank[r.sev]||0)*reportWeight(r),0);
  const weightTotal=reports.reduce((sum,r)=>sum+reportWeight(r),0);
  const reportScore=weightTotal ? weighted/weightTotal*50 : 0;
  return {score:Math.min(100,baseline*50+reportScore),evidence:reports.length,confidence:Math.min(100,25+Math.round((weightTotal/4)*75))};
}
function renderNearbyRisk(){
  const card=document.getElementById('nearby-risk-card');
  if(!card||!state.center||!state.zones) return;
  const signals=state.zones.map(z=>zoneSignal(z,state.center)).filter(s=>s.confidence||s.score>0);
  const score=signals.length ? Math.round(Math.max.apply(null,signals.map(s=>s.score))) : 0;
  const evidence=signals.reduce((sum,s)=>sum+s.evidence,0);
  const confidence=signals.length ? Math.min(100,Math.round(signals.reduce((sum,s)=>sum+s.confidence,0)/signals.length)) : 0;
  const level=score>=67?'red':score>=34?'yellow':'green';
  const label=!signals.length?'No nearby signal':level==='red'?'Higher risk signal':level==='yellow'?'Caution advised':'Lower risk signal';
  const labelEl=document.getElementById('nearby-risk-label');
  labelEl.textContent=label;
  labelEl.style.color=LEVEL_COLOR[level];
  document.getElementById('nearby-risk-score').textContent=score+'/100';
  document.getElementById('nearby-risk-meter').style.width=score+'%';
  document.getElementById('nearby-risk-meter').style.background=LEVEL_COLOR[level];
  document.getElementById('nearby-risk-detail').textContent=!signals.length
    ? 'No mapped baseline or recent report was found within 65 km. Stay aware and check your route.'
    : evidence
    ? `${evidence} recent community report${evidence===1?'':'s'} included; use the zone details before deciding your route.`
    : 'Based mainly on public baseline data; there are no recent community reports close to your location.';
  document.getElementById('nearby-risk-confidence').textContent=`Confidence: ${confidence}% · registered reports only · not a live police feed`;
}

function buildMap(){
  const c = state.center;
  const inIndia = c.lat>6&&c.lat<36&&c.lng>68&&c.lng<98;
  map = L.map('map-canvas', {zoomControl:false,minZoom:4,maxBounds:[[3,60],[40,103]]}).setView((inIndia&&!state.indiaView)?[c.lat,c.lng]:[22.5,79], (inIndia&&!state.indiaView)?10:5);
  if(!(inIndia&&!state.indiaView)) map.fitBounds([[6.5,68],[36.5,97.5]],{paddingTopLeft:[innerWidth>=900?440:10,innerWidth>=900?20:230],paddingBottomRight:[10,90]});
  const sat=L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Imagery &copy; Esri, Maxar, Earthstar Geographics'}),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{maxZoom:19})
  ]).addTo(map);
  const street=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'});
  L.control.layers({'Satellite':sat,'Street':street},null,{position:'bottomleft'}).addTo(map);
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.control.scale({position:'bottomleft',imperial:false}).addTo(map);

  userMarker = L.circleMarker([c.lat,c.lng], {radius:8, color:'#fff', weight:3, fillColor:'#2C4A52', fillOpacity:1}).addTo(map);

  state.zones.forEach(z=>{
    const signal=zoneSignal(z,c);
    const effectiveLevel=signal.score>=67?'red':signal.score>=34?'yellow':z.level;
    const col = LEVEL_COLOR[effectiveLevel];
    L.circle([z.lat,z.lng],{radius:effectiveLevel==='red'?45000:(effectiveLevel==='yellow'?32000:25000),color:col,weight:1,opacity:.55,fillColor:col,fillOpacity:effectiveLevel==='red'?.30:.20,interactive:false}).addTo(map);
    const sz = effectiveLevel==='red'?22:(effectiveLevel==='yellow'?17:13);
    const pin = L.marker([z.lat,z.lng],{
      icon:L.divIcon({className:'',html:`<div class="zpin ${effectiveLevel}" style="--c:${col};--s:${sz}px"><b></b><i></i></div>`,iconSize:[sz*2,sz*2]}),
      zIndexOffset: effectiveLevel==='red'?1000:(effectiveLevel==='yellow'?500:0)
    }).addTo(map);
    pin.on('click', ()=>openZoneSheet(z.id));
    pin.bindTooltip(z.name+' · '+LEVEL_LABEL[effectiveLevel],{direction:'top',offset:[0,-sz],className:'zone-label '+effectiveLevel});
    zoneLayers.push({id:z.id, layer:pin});
  });
}

function populateRouteSelects(){
  const to = document.getElementById('route-to');
  state.zones.forEach(z=>{
    const opt = document.createElement('option');
    opt.value = z.id; opt.textContent = z.name;
    to.appendChild(opt);
  });
  const from = document.getElementById('route-from');
  state.zones.forEach(z=>{
    const opt = document.createElement('option');
    opt.value = z.id; opt.textContent = z.name;
    from.appendChild(opt);
  });
}

document.getElementById('btn-route').addEventListener('click', ()=>{
  const fromId = document.getElementById('route-from').value;
  const toId = document.getElementById('route-to').value;
  if(!toId){ toast('Choose a destination'); return; }
  const start = fromId ? state.zones.find(z=>z.id===fromId) : {lat:state.center.lat,lng:state.center.lng};
  const end = state.zones.find(z=>z.id===toId);
  if(routeLine){ map.removeLayer(routeLine); }

  const crossed = state.zones.filter(z=> pointNearSegment(z, start, end));
  const worst = crossed.reduce((acc,z)=>{
    const rank = {red:2,yellow:1,green:0};
    return rank[z.level] > rank[acc] ? z.level : acc;
  }, 'green');
  const lineColor = crossed.length ? LEVEL_COLOR[worst] : LEVEL_COLOR.green;

  routeLine = L.polyline([[start.lat,start.lng],[end.lat,end.lng]], {color:lineColor, weight:5, opacity:0.85, dashArray: worst==='green' && !crossed.length ? null : '2 8'}).addTo(map);
  map.fitBounds(routeLine.getBounds(), {padding:[60,60]});

  const resultEl = document.getElementById('route-result');
  resultEl.style.display='block';
  if(crossed.length===0){
    resultEl.innerHTML = `<strong style="color:var(--safe)">Looks clear.</strong> No flagged zones along this route.`;
  } else {
    const names = crossed.map(z=>`${z.name} (${LEVEL_LABEL[z.level].toLowerCase()})`).join(', ');
    resultEl.innerHTML = `<strong style="color:${LEVEL_COLOR[worst]}">Heads up.</strong> This route passes near: ${names}.`;
  }
});

function pointNearSegment(zone, a, b){
  // rough planar distance from zone center to segment a-b, in degrees converted to meters approx
  const toXY = p => ({x:p.lng, y:p.lat});
  const A = toXY(a), B = toXY(b), P = {x:zone.lng, y:zone.lat};
  const dx = B.x-A.x, dy = B.y-A.y;
  const len2 = dx*dx+dy*dy || 0.00001;
  let t = ((P.x-A.x)*dx + (P.y-A.y)*dy)/len2;
  t = Math.max(0, Math.min(1, t));
  const cx = A.x + t*dx, cy = A.y + t*dy;
  const distDeg = Math.sqrt((P.x-cx)**2 + (P.y-cy)**2);
  const distMeters = distDeg * 111000;
  return distMeters < (zone.radius + 150);
}

/* ===================== ZONE SHEET ===================== */
function openZoneSheet(id){
  currentZoneId = id;
  const z = state.zones.find(zz=>zz.id===id);
  document.getElementById('zone-name').textContent = z.name;
  document.getElementById('zone-reason').textContent = z.reason;
  const tagEl = document.getElementById('zone-tag');
  tagEl.className = 'tag '+z.level;
  tagEl.querySelector('.tag-dot').style.background = LEVEL_COLOR[z.level];
  document.getElementById('zone-tag-text').textContent = LEVEL_LABEL[z.level];
  renderZoneReports(z);
  document.getElementById('zone-sheet-overlay').classList.add('active');
}
document.getElementById('zone-sheet-close').addEventListener('click', ()=>{
  document.getElementById('zone-sheet-overlay').classList.remove('active');
});
document.getElementById('zone-sheet-overlay').addEventListener('click', e=>{
  if(e.target.id==='zone-sheet-overlay') e.currentTarget.classList.remove('active');
});

function renderZoneReports(z){
  const list = document.getElementById('zone-reports');
  if(!z.reports.length){
    list.innerHTML = `<p style="font-size:13.5px;color:var(--ink-soft);">No reports yet for this spot.</p>`;
    return;
  }
  const sorted = [...z.reports].sort((a,b)=>b.ts-a.ts);
  list.innerHTML = sorted.map(r=>`
    <div class="report-item">
      <div class="meta">
        <span class="tag ${r.sev}"><span class="tag-dot" style="background:${LEVEL_COLOR[r.sev]}"></span>${LEVEL_LABEL[r.sev]}</span>
        <span class="time">${r.verified ? '✓ verified account · ' : ''}${timeAgo(r.ts)}</span>
      </div>
      <p>${escapeHtml(r.text)}</p>
    </div>
  `).join('');
}

document.getElementById('zone-add-report').addEventListener('click', ()=>{
  document.getElementById('report-text').value='';
  document.getElementById('report-severity').value='yellow';
  document.getElementById('report-modal-overlay').classList.add('active');
});
document.getElementById('report-cancel').addEventListener('click', ()=>{
  document.getElementById('report-modal-overlay').classList.remove('active');
});
document.getElementById('report-submit').addEventListener('click', ()=>{
  const text = document.getElementById('report-text').value.trim();
  if(!text){ toast('Add a short description first'); return; }
  const sev = document.getElementById('report-severity').value;
  if(!['green','yellow','red'].includes(sev)){ toast('Choose a valid severity'); return; }
  if(text.length<12){ toast('Add a little more detail so others can judge the signal'); return; }
  const z = state.zones.find(zz=>zz.id===currentZoneId);
  z.reports.unshift({id:z.id+'-'+Date.now(), sev, text, ts:Date.now(), verified:!!state.verified});
  saveState();
  renderZoneReports(z);
  renderNearbyRisk();
  document.getElementById('report-modal-overlay').classList.remove('active');
  toast('Report added — thank you for keeping others safe');
});

/* ===================== FEED ===================== */
function renderFeed(){
  const all = [];
  state.zones.forEach(z=> z.reports.forEach(r=> all.push({...r, zoneName:z.name})));
  all.sort((a,b)=>b.ts-a.ts);
  const list = document.getElementById('feed-list');
  if(!all.length){ list.innerHTML = `<p style="color:var(--ink-soft);font-size:14px;">No reports yet.</p>`; return; }
  list.innerHTML = all.map(r=>`
    <div class="feed-item">
      <div class="meta">
        <span class="zone-name">${escapeHtml(r.zoneName)}</span>
        <span class="tag ${r.sev}"><span class="tag-dot" style="background:${LEVEL_COLOR[r.sev]}"></span>${LEVEL_LABEL[r.sev]}</span>
      </div>
      <p>${escapeHtml(r.text)}</p>
      <span class="time">${r.verified ? '✓ verified account · ' : ''}${timeAgo(r.ts)}</span>
    </div>
  `).join('');
}

/* ===================== TIPS ===================== */
const TIPS = {
  "Before you go out":[
    "Share your live route or destination with someone you trust.",
    "Check SafeCircle's map for any red or yellow zones along your path.",
    "Keep your phone charged above 30% and know where your SOS button is.",
    "Prefer well-lit, populated routes over shortcuts, especially after dark."
  ],
  "If you feel unsafe":[
    "Trust the feeling — move toward a shop, group of people, or well-lit area.",
    "Call a friend and stay on the line, even if you just talk normally.",
    "Use the SOS button — it alerts nearby verified users, not only the police.",
    "If someone is following you, change direction and head somewhere public."
  ],
  "Emergency contacts":[
    "Add at least two emergency contacts in your Profile — they're notified during an SOS.",
    "National women's helpline: 1091. Police: 100. Ambulance: 102.",
    "Save a trusted neighbour or local shopkeeper's number for your regular routes."
  ]
};
function renderTips(){
  const wrap = document.getElementById('tips-list');
  wrap.innerHTML = Object.entries(TIPS).map(([cat, items])=>`
    <div class="tips-cat">
      <h3>${cat}</h3>
      ${items.map(t=>`<div class="tip-row"><span class="dot"></span><p>${t}</p></div>`).join('')}
    </div>
  `).join('');
}

/* ===================== PROFILE ===================== */
function renderProfile(){
  if(!state.user) return;
  document.getElementById('profile-initial').textContent = state.user.name.charAt(0).toUpperCase();
  document.getElementById('profile-name').textContent = state.user.name;
  document.getElementById('profile-phone').textContent = state.user.phone;
  document.getElementById('profile-email').value = state.user.email;
  document.getElementById('toggle-available').checked = state.available;
  renderContacts();
}
document.getElementById('toggle-available').addEventListener('change', e=>{
  state.available = e.target.checked;
  saveState();
  toast(state.available ? "You're now visible to nearby users needing help" : "You won't receive nearby SOS alerts");
});
document.getElementById('profile-email').addEventListener('change', e=>{
  state.user.email = e.target.value; saveState();
});
document.getElementById('logout-btn').addEventListener('click', ()=>{
  localStorage.removeItem('safecircle_state');
  location.reload();
});

function renderContacts(){
  const list = document.getElementById('contacts-list');
  if(!state.contacts.length){
    list.innerHTML = `<p style="font-size:13px;color:var(--ink-soft);">No emergency contacts added yet.</p>`;
  } else {
    list.innerHTML = state.contacts.map((c,i)=>`
      <div class="contact-row">
        <div><div class="name">${escapeHtml(c.name)}</div><div class="phone">${escapeHtml(c.phone)}</div></div>
        <button class="icon-btn" data-idx="${i}" onclick="removeContact(${i})">✕</button>
      </div>
    `).join('');
  }
}
function removeContact(i){ state.contacts.splice(i,1); saveState(); renderContacts(); }
document.getElementById('add-contact-btn').addEventListener('click', ()=>{
  const f = document.getElementById('contact-form');
  f.style.display = f.style.display==='none' ? 'block' : 'none';
});
document.getElementById('save-contact').addEventListener('click', ()=>{
  const name = document.getElementById('contact-name').value.trim();
  const phone = document.getElementById('contact-phone').value.trim();
  if(!name || !phone){ toast('Add both name and phone'); return; }
  if(state.contacts.length>=3){ toast('You can add up to 3 contacts for this demo'); return; }
  state.contacts.push({name,phone});
  saveState();
  document.getElementById('contact-name').value='';
  document.getElementById('contact-phone').value='';
  document.getElementById('contact-form').style.display='none';
  renderContacts();
});

/* ===================== SOS FLOW ===================== */
document.getElementById('sos-fab').addEventListener('click', ()=>{
  document.getElementById('sos-confirm-overlay').classList.add('active');
});
document.getElementById('sos-cancel').addEventListener('click', ()=>{
  document.getElementById('sos-confirm-overlay').classList.remove('active');
});
document.getElementById('sos-confirm').addEventListener('click', ()=>{
  document.getElementById('sos-confirm-overlay').classList.remove('active');
  startSOS();
});

function stepHTML(id, iconState, title, desc){
  const icons = {
    send:'<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    police:'<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/>',
    users:'<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="2.3"/><path d="M15.5 13.2c2.7.4 4.8 2.3 4.8 4.8"/>',
    contact:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.4 2.1L8 9.9a16 16 0 0 0 6 6l1.4-1.4a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.8 2.2z"/>'
  };
  return `<div class="sos-step" id="${id}">
    <div class="step-icon ${iconState}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[title.icon]}</svg></div>
    <div><h4>${title.text}</h4><p>${desc}</p></div>
  </div>`;
}

function startSOS(){
  sosTimers.forEach(t=>clearTimeout(t));
  sosTimers = [];
  showScreen('sos');
  const wrap = document.getElementById('sos-steps');
  wrap.innerHTML =
    stepHTML('step-send','done',{icon:'send',text:'Alert sent'},'Use the buttons below to call 112 and message your contacts with your location.') +
    stepHTML('step-police','pending',{icon:'police',text:'Nearest police station'},'Call 112 (police/emergency) now: this app cannot dispatch police by itself.') +
    stepHTML('step-users','pending',{icon:'users',text:'Nearby verified users'},'Nearby-responder network needs a live server and is not active yet.') +
    (state.contacts.length ? stepHTML('step-contacts','pending',{icon:'contact',text:'Emergency contacts'},'Notifying your saved contacts…') : '');

  sosTimers.push(setTimeout(()=>{
    const el = document.getElementById('step-police');
    el.querySelector('.step-icon').classList.replace('pending','pending');
    el.querySelector('p').textContent = 'Tap Call 112 below. Women Helpline: 181. Police: 100.';
  }, 1400));

  

  

  sosTimers.push(setTimeout(()=>{
    const el = document.getElementById('step-police');
    if(el){
      el.querySelector('p').textContent = 'Please call 112 directly if you have not yet.';
    }
  }, 12000));
}

document.getElementById('btn-share-link').addEventListener('click', ()=>{
  const token = Math.random().toString(36).slice(2,9);
  const c=state.center||DEFAULT_CENTER; const link = `https://www.google.com/maps?q=${c.lat},${c.lng}`;
  navigator.clipboard && navigator.clipboard.writeText(link);
  toast('Live location link copied');
});
document.getElementById('btn-end-sos').addEventListener('click', ()=>{
  sosTimers.forEach(t=>clearTimeout(t));
  showScreen('map');
  toast('Alert ended');
});

/* ===================== HELPERS ===================== */
function timeAgo(ts){
  const mins = Math.floor((Date.now()-ts)/60000);
  if(mins<60) return mins+'m ago';
  const hrs = Math.floor(mins/60);
  if(hrs<24) return hrs+'h ago';
  return Math.floor(hrs/24)+'d ago';
}
function escapeHtml(s){
  return s.replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ===================== BOOT ===================== */
if(state.user && state.verified && state.center && state.zones){
  initApp();
}
document.getElementById('btn-sms').addEventListener('click',()=>{
  const c=state.center||DEFAULT_CENTER;
  const nums=state.contacts.map(x=>x.phone.replace(/\s/g,'')).join(',');
  if(!nums){toast('Add emergency contacts in Profile first');return;}
  const go=(lat,lng)=>{location.href=`sms:${nums}?body=${encodeURIComponent('I need help. My location: https://www.google.com/maps?q='+lat+','+lng)}`;};
  navigator.geolocation?navigator.geolocation.getCurrentPosition(p=>go(p.coords.latitude,p.coords.longitude),()=>go(c.lat,c.lng),{timeout:5000}):go(c.lat,c.lng);
});
