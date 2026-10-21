import './styles.css';
import { Globe } from './globe.js';
import { Panorama } from './panorama.js';
import { bodyVectors } from './astro.js';
import { SITES, PLACES, parseCoords } from './sites.js';
import { Terrain, distance, bearing } from './terrain.js';
import { prepareRoute, pointAt, ephemeris, environment, simulate, monteCarlo } from './sim.js';
import { sunlightMap, planRoute, boxAround } from './planner.js';
import { ROVERS, ROVER_FIELDS } from './rovers.js';

const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ALL_PLACES = [...SITES.map((s) => ({ ...s, group: 'South pole' })), ...PLACES.map((p) => ({ ...p, group: 'Elsewhere on the Moon' }))];

// Example mission: a mid-size rover drives 3.5 km west along the sunlit rim from Shackleton.
const state = {
  stage: 'plan',
  rover: { ...ROVERS[1] },
  roverId: ROVERS[1].id,
  waypoints: [{ lat: SITES[0].lat, lon: SITES[0].lon }, { lat: -89.691, lon: -141.26 }],
  landingName: SITES[0].name,
  start: new Date(Date.UTC(2026, 10, 20)),
  days: 14,
  slip: 2,
  runs: 50,
  mustSurvive: true,
  pick: null, // 'land' | 'route' while clicking the Moon
  route: null,
  planned: false,
  result: null,
  stale: false,
  time: new Date(Date.UTC(2026, 10, 20)),
  saved: [],
};

// ---------- formatting ----------
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
const fmtLL = (p) => `${fmtLat(p.lat)} ${fmtLon(p.lon)}`;
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const fromLocalInput = (s) => { const d = new Date(`${s}:00Z`); return Number.isNaN(d.getTime()) ? null : d; };
const fmtDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fmtDateTime = (d) => `${fmtDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
const fmtKm = (m) => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
const fmtH = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Math.round(h)} h`);
const dayStamp = (t, t0) => `Day ${Math.floor((t - t0) / DAY) + 1} ${pad(new Date(t).getUTCHours())}:${pad(new Date(t).getUTCMinutes())}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function toast(text, ms = 3600) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- globe and terrain ----------
const globe = new Globe($('globe'), $('labels'));
window.lunaview = { globe, state }; // handy for poking at the scene from the browser console
globe.setSites(SITES, SITES[0].id);

let terrain = null;
const terrainReady = new Promise((resolve) => {
  const check = () => {
    if (globe.terrain?.sim && globe.polarH && globe.globalH) {
      terrain = new Terrain(globe.terrain, (lat, lon) => globe.coarseHeight(lat, lon));
      globe.fineHeight = (lat, lon) => (terrain.resolution(lat, lon) ? terrain.height(lat, lon) : NaN);
      resolve(terrain);
    } else setTimeout(check, 150);
  };
  check();
});

globe.onPick = (site) => handleGroundClick(site.lat, site.lon, site.name);
globe.onSurfaceClick = ({ lat, lon }) => handleGroundClick(lat, lon);

function handleGroundClick(lat, lon, name) {
  if (state.pick === 'land') { setLanding({ lat, lon }, name ?? `Landing at ${fmtLL({ lat, lon })}`); setPick(null); return; }
  if (state.pick === 'route') { state.waypoints.push({ lat, lon }); state.planned = false; routeChanged(); }
}

function setLanding(p, name) {
  state.landingName = name;
  if (state.waypoints.length) state.waypoints[0] = { lat: p.lat, lon: p.lon }; else state.waypoints = [{ lat: p.lat, lon: p.lon }];
  // A route from the old landing site would cross the Moon; start a new one.
  if (state.waypoints.length > 1 && distance(state.waypoints[0], state.waypoints[1]) > 300000) state.waypoints = state.waypoints.slice(0, 1);
  state.planned = false;
  const known = ALL_PLACES.find((x) => Math.abs(x.lat - p.lat) < 1e-6 && Math.abs(x.lon - p.lon) < 1e-6);
  $('fStart').value = known ? known.id : '';
  globe.select(known?.id ?? null);
  routeChanged().then(() => globe.flyToPoint(p.lat, p.lon));
}

function setPick(mode) {
  state.pick = mode;
  $('landBtn').setAttribute('aria-pressed', String(mode === 'land'));
  $('drawBtn').setAttribute('aria-pressed', String(mode === 'route'));
  $('drawBtn').textContent = mode === 'route' ? 'Done adding points' : 'Add route points';
  document.body.classList.toggle('drawing', !!mode);
  const hint = $('modeHint');
  hint.hidden = !mode;
  hint.textContent = mode === 'land' ? 'Click anywhere on the Moon to land there. Esc to cancel.' : mode === 'route' ? 'Click the ground to add route points. Esc when done.' : '';
  renderRouteStats();
}

// ---------- route ----------
function slopeColour(slope, limit) {
  if (slope > limit) return [1, 0.42, 0.37];
  if (slope > limit * 0.7) return [0.95, 0.76, 0.31];
  return [0.44, 0.83, 0.6];
}

let routeJob = 0;
async function routeChanged() {
  const job = ++routeJob;
  markStale();
  renderWaypoints();
  await terrainReady;
  if (state.waypoints.length) await terrain.loadAround(state.waypoints, 30000);
  if (job !== routeJob) return;
  state.route = state.waypoints.length ? prepareRoute(terrain, state.waypoints) : null;
  drawRoute();
  renderRouteStats();
  updateReadout();
}

function drawRoute() {
  const r = state.route;
  if (!r) { globe.setRoute(null); globe.setWaypoints([]); return; }
  globe.setRoute(r.pts.map((p) => ({ lat: p.lat, lon: p.lon, h: p.h, color: slopeColour(p.slope, state.rover.maxSlopeDeg) })));
  globe.setWaypoints(state.waypoints.map((w, i) => ({
    ...w, h: terrain.height(w.lat, w.lon), kind: i === 0 ? 'start' : i === state.waypoints.length - 1 ? 'end' : 'via',
  })));
}

function renderWaypoints() {
  const ol = $('wpList');
  ol.textContent = '';
  state.waypoints.forEach((w, i) => {
    const li = document.createElement('li');
    const label = i === 0 ? 'Landing' : i === state.waypoints.length - 1 ? 'Destination' : `Via ${i}`;
    li.innerHTML = `<span class="wp-k"></span><span class="mono"></span>${i ? '<button type="button" class="wp-x" aria-label="Remove point">×</button>' : ''}`;
    li.querySelector('.wp-k').textContent = label;
    li.querySelector('.mono').textContent = fmtLL(w);
    li.querySelector('.wp-x')?.addEventListener('click', () => { state.waypoints.splice(i, 1); state.planned = false; routeChanged(); });
    ol.appendChild(li);
  });
  $('siteName').textContent = state.rover.name.split(' (')[0].toUpperCase();
}

function renderRouteStats() {
  const r = state.route, el = $('routeStats');
  if (!r || state.waypoints.length < 2) {
    el.innerHTML = state.waypoints.length
      ? `<b>${esc(state.landingName)}</b>. Add route points to drive somewhere; with no route, the simulation checks whether the rover survives where it lands.`
      : 'Choose a landing place first.';
    $('siteCoords').textContent = state.waypoints.length ? 'Stays where it lands' : 'No landing site';
    return;
  }
  const lim = state.rover.maxSlopeDeg, steep = r.steepest.slope;
  const res = r.coarsest;
  el.innerHTML = `<b>${fmtKm(r.length)}</b> from ${esc(state.landingName)} · steepest slope <b class="${steep > lim ? 't-bad' : steep > lim * 0.7 ? 't-warn' : ''}">${steep.toFixed(0)}°</b> (rover limit ${lim}°) · climb ${Math.round(r.climb)} m`
    + `${state.planned ? ' · <b>planned for sunlight</b>' : ''}<br>Terrain: NASA LOLA at ${res <= 100 ? '80 m' : `about ${Math.round(res / 50) * 50} m`} detail${res > 100 ? ', so hills and craters smaller than about 2 km are smoothed out' : ''}.`
    + (steep > lim ? `<br><span class="t-bad">A ${steep.toFixed(0)}° slope at km ${(r.steepest.d / 1000).toFixed(1)} is too steep. Try <b>Find the sunniest route</b> to go around it.</span>` : '');
  $('siteCoords').textContent = `${fmtKm(r.length)} route`;
}

// ---------- route planner and sunlight map ----------
async function computeSunMap(a, b, label) {
  const len = distance(a, b);
  const margin = Math.max(2500, len * 0.35);
  const span = len + 2 * margin;
  const cell = Math.max(terrain.resolution(a.lat, a.lon) ?? 1000, Math.ceil(span / 55 / 40) * 40);
  const box = boxAround(a, b, margin, cell);
  await terrain.loadAround([a, b, box.centre], span);
  return sunlightMap(terrain, ephemeris(HOUR), box, state.start, state.days, {
    onProgress: (f) => { $('simStatus').textContent = `${label}: ${Math.round(f * 100)}%`; },
  });
}

function showSunMap(map) {
  const cells = map.ll.map((p, k) => ({ ...p, h: map.h[k], lit: map.lit[k] }));
  globe.setOverlay(cells, map.cell);
  setTool('map', true);
}

async function planSunniest() {
  if (state.waypoints.length < 2) { toast('Add a destination first: choose Add route points, then click the ground.'); return; }
  await terrainReady;
  $('planBtn').disabled = true;
  try {
    const out = [state.waypoints[0]];
    for (let i = 1; i < state.waypoints.length; i++) {
      const a = state.waypoints[i - 1], b = state.waypoints[i];
      const map = await computeSunMap(a, b, `Mapping sunlight for leg ${i}`);
      showSunMap(map);
      const leg = planRoute(map, a, b, { maxSlope: state.rover.maxSlopeDeg - 1 });
      if (!leg) { toast(`No safe path found for leg ${i}: slopes over ${state.rover.maxSlopeDeg}° block every way.`); return; }
      out.push(...leg.slice(1));
    }
    state.waypoints = out;
    state.planned = true;
    $('simStatus').textContent = 'Route planned to stay in sunlight and avoid steep slopes.';
    await routeChanged();
  } finally {
    $('planBtn').disabled = false;
  }
}

async function toggleSunMap() {
  if (globe.overlay) { globe.setOverlay(null); setTool('map', false); return; }
  if (!state.waypoints.length) { toast('Choose a landing place first.'); return; }
  await terrainReady;
  const a = state.waypoints[0], b = state.waypoints[state.waypoints.length - 1];
  const map = await computeSunMap(a, b, 'Mapping sunlight');
  showSunMap(map);
  $('simStatus').textContent = 'Sunlight map: yellow is sunlit for most of the mission, dark blue is mostly in shadow.';
}

// ---------- rover form ----------
const fRover = $('fRover');
for (const r of ROVERS) fRover.add(new Option(r.name, r.id));
fRover.add(new Option('Custom rover', 'custom'));
const specGrid = $('specGrid');
for (const [key, label, unit, step] of ROVER_FIELDS) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<label for="r_${key}"></label><div class="unit"><input id="r_${key}" type="number" step="${step}" inputmode="decimal"><span></span></div>`;
  wrap.querySelector('label').textContent = label;
  wrap.querySelector('span').textContent = unit;
  wrap.querySelector('input').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) { state.rover[key] = v; makeCustom(); markStale(); drawRoute(); renderRouteStats(); }
  });
  specGrid.appendChild(wrap);
}
function makeCustom() { state.roverId = 'custom'; fRover.value = 'custom'; state.rover.name = 'Custom rover'; renderWaypoints(); }
function syncRoverForm() {
  fRover.value = state.roverId;
  for (const [key] of ROVER_FIELDS) $(`r_${key}`).value = state.rover[key];
  $('fPanel').value = state.rover.panel;
  $('fComms').checked = !!state.rover.needsComms;
  renderWaypoints();
}
fRover.addEventListener('change', () => {
  const r = ROVERS.find((x) => x.id === fRover.value);
  if (r) { state.rover = { ...r }; state.roverId = r.id; }
  syncRoverForm(); markStale(); drawRoute(); renderRouteStats();
});
$('fPanel').addEventListener('change', (e) => { state.rover.panel = e.target.value; makeCustom(); markStale(); });
$('fComms').addEventListener('change', (e) => { state.rover.needsComms = e.target.checked; makeCustom(); markStale(); });

// Landing place picker.
const fStart = $('fStart');
fStart.add(new Option('Custom spot (clicked or typed)', ''));
for (const group of ['South pole', 'Elsewhere on the Moon']) {
  const og = document.createElement('optgroup');
  og.label = group;
  for (const p of ALL_PLACES.filter((x) => x.group === group)) og.appendChild(new Option(`${p.name} (${fmtLL(p)})`, p.id));
  fStart.appendChild(og);
}
fStart.addEventListener('change', () => { const p = ALL_PLACES.find((x) => x.id === fStart.value); if (p) setLanding(p, p.name); });
$('landBtn').addEventListener('click', () => setPick(state.pick === 'land' ? null : 'land'));
$('drawBtn').addEventListener('click', () => setPick(state.pick === 'route' ? null : 'route'));
$('undoBtn').addEventListener('click', () => { if (state.waypoints.length > 1) { state.waypoints.pop(); state.planned = false; routeChanged(); } });
$('clearBtn').addEventListener('click', () => { state.waypoints = state.waypoints.slice(0, 1); state.planned = false; routeChanged(); });
$('planBtn').addEventListener('click', planSunniest);

// Timing.
function syncTiming() {
  $('fDate').value = toLocalInput(state.start);
  $('fDays').value = state.days;
  $('fSlip').value = state.slip;
  $('fRuns').value = String(state.runs);
  $('fSurvive').checked = state.mustSurvive;
}
$('fDate').addEventListener('change', (e) => { const d = fromLocalInput(e.target.value); if (d) { state.start = d; setTime(d); markStale(); } });
$('fDays').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 60) { state.days = v; markStale(); } });
$('fSlip').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v >= 0 && v <= 10) { state.slip = v; markStale(); } });
$('fRuns').addEventListener('change', (e) => { state.runs = parseInt(e.target.value, 10); });
$('fSurvive').addEventListener('change', (e) => { state.mustSurvive = e.target.checked; markStale(); });

// ---------- stages ----------
function setStage(stage) {
  if (stage !== 'plan' && !state.result) return;
  state.stage = stage;
  document.getElementById('app').dataset.stage = stage;
  document.querySelectorAll('.stages button').forEach((b) => {
    b.disabled = b.dataset.stage !== 'plan' && !state.result;
    if (b.dataset.stage === stage) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  setPick(null);
  if (stage === 'plan') { closePanel('report'); openPanel('setup'); stopReplay(); }
  if (stage === 'forecast') { closePanel('setup'); openPanel('report'); stopReplay(); }
  if (stage === 'replay') { closePanel('setup'); closePanel('report'); startReplay(); }
}
document.querySelectorAll('.stages button').forEach((b) => b.addEventListener('click', () => setStage(b.dataset.stage)));

// ---------- simulation ----------
function markStale() {
  if (state.result && !state.stale) {
    state.stale = true;
    const b = document.querySelector('#reportBody .stale');
    if (b) b.hidden = false;
  }
}

let simJob = 0;
async function runSimulation() {
  if (!state.waypoints.length) { toast('Choose a landing place first.'); return; }
  const job = ++simJob;
  setPick(null);
  $('simBtn').disabled = $('runBtn').disabled = true;
  $('simStatus').textContent = 'Loading terrain…';
  try {
    await terrainReady;
    await routeChanged();
    const r = state.route;
    // Skylines reach 150 km, so load terrain that far around the route.
    await terrain.loadAround([r.pts[0], r.pts[r.pts.length - 1]], 150000);
    const args = { terrain, eph: ephemeris(15 * 60 * 1000), rover: { ...state.rover }, route: r, start: state.start, days: state.days, mustSurvive: state.mustSurvive };
    $('simStatus').textContent = 'Simulating the planned mission…';
    await new Promise((res) => setTimeout(res, 20));
    const nominal = simulate(args);
    const mc = await monteCarlo(args, {
      runs: state.runs, slipDays: state.slip,
      onProgress: (f) => { $('simStatus').textContent = `Simulating ${state.runs} missions with realistic uncertainty… ${Math.round(f * 100)}%`; },
    });
    if (job !== simJob) return;
    state.result = { nominal, mc, args, rover: { ...state.rover }, waypoints: state.waypoints.slice(), landingName: state.landingName, planned: state.planned, slip: state.slip };
    state.stale = false;
    $('simStatus').textContent = `Done: ${mc.successes} of ${mc.runs} simulated missions succeeded.`;
    renderReport();
    setStage('forecast');
    findImprovements(state.result);
  } finally {
    $('simBtn').disabled = $('runBtn').disabled = false;
  }
}
$('missionForm').addEventListener('submit', (e) => { e.preventDefault(); runSimulation(); });
$('runBtn').addEventListener('click', runSimulation);

// ---------- forecast ----------
const CAUSE = {
  battery: { label: 'Battery ran out' },
  slope: { label: 'Route blocked by a steep slope' },
  time: { label: 'Ran out of time' },
};
const STATE_INFO = [
  ['drive', 'Driving', 'var(--ok)'],
  ['retreat', 'Driving back to sunlight', 'var(--teal)'],
  ['charge', 'Charging in sunlight', 'var(--sun)'],
  ['park', 'Parked', 'var(--ink-dim)'],
  ['hibernate', 'Hibernating in shadow', 'var(--violet)'],
  ['done', 'Arrived', 'var(--earth)'],
  ['dead', 'Lost', 'var(--crit)'],
];
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const stateColour = (k) => { const c = STATE_INFO.find((x) => x[0] === k)?.[2] ?? 'var(--crit)'; return cssVar(c.slice(4, -1)); };

function verdict(rate) {
  if (rate >= 0.85) return ['Likely to succeed', 'var(--ok)'];
  if (rate >= 0.5) return ['Risky', 'var(--warn)'];
  return ['Unlikely to succeed', 'var(--crit)'];
}

function renderReport() {
  const { nominal: n, mc, rover, waypoints } = state.result;
  const [word, colour] = verdict(mc.rate);
  const C = 2 * Math.PI * 48;
  const t0 = n.start.getTime();
  const tl = n.timeline;
  const counts = {};
  for (const r of tl) counts[r.state] = (counts[r.state] || 0) + 1;
  const waits = {};
  for (const r of tl) if (r.why) for (const w of r.why.split(', ')) waits[w] = (waits[w] || 0) + 1;
  const coldest = Math.min(...tl.map((r) => r.tSurfC)), hottest = Math.max(...tl.map((r) => r.tSurfC));
  const maxHeater = Math.max(...tl.map((r) => r.heater));
  const causes = Object.entries(mc.causes).sort((a, b) => b[1].length - a[1].length);
  const routeTxt = waypoints.length > 1 ? `${fmtKm(n.routeLength)} from ${esc(state.result.landingName)}` : `stays at ${esc(state.result.landingName)}`;

  $('reportBody').innerHTML = `
    <p class="stale hint" hidden><b>Inputs changed.</b> Simulate again to update this forecast.</p>
    <p class="hint">${esc(rover.name)} · ${routeTxt} · landing ${fmtDateTime(n.start)} ±${state.result.slip} d · ${n.days} days</p>
    <div class="score-row">
      <div class="score-ring" role="img" aria-label="${Math.round(mc.rate * 100)} percent of simulated missions succeeded">
        <svg viewBox="0 0 112 112"><circle cx="56" cy="56" r="48" stroke="var(--shadow)" stroke-width="10"/>
          <circle cx="56" cy="56" r="48" stroke="${colour}" stroke-width="10" stroke-dasharray="${C * mc.rate} ${C}"/></svg>
        <div class="num"><div>${Math.round(mc.rate * 100)}%<small>success</small></div></div>
      </div>
      <div>
        <p class="verdict" style="color:${colour}">${word}</p>
        <p class="lead">Succeeded in <b>${mc.successes} of ${mc.runs}</b> simulated missions, each with a different landing time, panel output, battery health, driving speed and heat loss.</p>
      </div>
    </div>
    <div class="nominal"><span class="pill ${n.success ? 'ok' : 'critical'}">As planned</span><span>${esc(n.text)}</span></div>
    <button class="cta wide watch" type="button" id="toReplay">▶ Watch the rover drive it</button>

    <h3>Why missions failed</h3>
    ${causes.length ? `<ul class="cause-list">${causes.map(([k, list]) => `
      <li><div class="cause-bar"><i style="width:${(100 * list.length) / mc.runs}%"></i></div>
        <div><b>${CAUSE[k]?.label ?? k}</b>: ${list.length} of ${mc.runs} runs<br><span class="hint">${esc(list[0].text)}</span></div></li>`).join('')}</ul>`
      : '<p class="hint">None of the simulated missions failed.</p>'}

    <h3>The planned mission, hour by hour</h3>
    <div class="chart-wrap"><canvas id="simChart" aria-label="Battery, ground temperature, sunlight, Earth contact and rover activity over the mission. Click to replay from that moment."></canvas></div>
    <div class="legend">
      <span><i style="background:var(--ok)"></i>Battery</span>
      <span><i style="background:var(--crit)"></i>Ground temperature</span>
      <span><i style="background:var(--sun)"></i>Sunlight</span>
      <span><i style="background:var(--earth)"></i>Earth in view</span>
    </div>
    <dl class="facts">
      <div><dt>Distance driven</dt><dd>${fmtKm(n.distance)} of ${fmtKm(n.routeLength || 0)}</dd></div>
      <div><dt>Lowest battery</dt><dd>${Math.max(0, Math.round(n.minSoc * 100))}%</dd></div>
      <div><dt>Longest shadow</dt><dd>${n.longestShadowH ? fmtH(n.longestShadowH) : 'none'}</dd></div>
      <div><dt>Earth in view</dt><dd>${Math.round(n.commsFrac * 100)}%</dd></div>
      <div><dt>Ground temperature</dt><dd>${Math.round(coldest)} to ${Math.round(hottest)} °C</dd></div>
      <div><dt>Peak heater power</dt><dd>${Math.round(maxHeater)} W</dd></div>
    </dl>

    <h3>How the rover spent its time</h3>
    <div class="time-bar">${STATE_INFO.filter(([k]) => counts[k]).map(([k, label, c]) => `<i style="flex:${counts[k]};background:${c}" title="${label}: ${Math.round((100 * counts[k]) / tl.length)}%"></i>`).join('')}</div>
    <ul class="time-list">${STATE_INFO.filter(([k]) => counts[k]).map(([k, label, c]) => `<li><i style="background:${c}"></i>${label}<b>${Math.round((100 * counts[k]) / tl.length)}%</b></li>`).join('')}</ul>
    ${Object.keys(waits).length ? `<p class="hint">Stopped because of: ${Object.entries(waits).sort((a, b) => b[1] - a[1]).map(([w, c]) => `${w} (${fmtH((c * n.stepMin) / 60)})`).join(', ')}.</p>` : ''}

    <h3>How to improve the odds</h3>
    <div id="improve" class="improve"><p class="hint">Trying other landing dates and options…</p></div>

    <h3>Mission log (as planned)</h3>
    <ol class="log">${n.events.slice(0, 40).map((e) => `<li class="${e.level}"><span class="mono">${dayStamp(e.t.getTime(), t0)}</span>${esc(e.text)}</li>`).join('') || '<li>No notable events.</li>'}</ol>

    <div class="report-actions">
      <button class="ghost" type="button" id="toStand">See the sky from the rover</button>
      <button class="ghost" type="button" id="toCompare">Add to compare</button>
      <button class="ghost" type="button" id="toPlan">Change the plan</button>
    </div>
    <p class="hint method">Model: rover position every ${n.stepMin} min on NASA LOLA terrain (80 m near the south pole, ~950 m elsewhere); Sun and Earth from astronomy-engine with the real skyline in their direction; ground temperature from radiative balance on the local slope (cooling to ~95 K in shadow); solar power from panel angle and the share of the Sun's disc above the skyline; heaters run in shadow. The rover follows simple operating rules: it waits for sunlight ahead unless the battery can carry it through a shadow, backs out of shadow to the nearest sunlight, and hibernates in the dark.</p>`;

  drawChart();
  $('simChart').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left - CH.left) / (rect.width - CH.left - CH.right);
    replay.t = Math.max(0, Math.min(1, f)) * replay.duration();
    setStage('replay');
  });
  $('toReplay').addEventListener('click', () => { replay.t = 0; setStage('replay'); });
  $('toStand').addEventListener('click', () => openStand());
  $('toCompare').addEventListener('click', () => addCompare(state.result));
  $('toPlan').addEventListener('click', () => setStage('plan'));
}

const CH = { left: 46, right: 44, top: 10 };
function drawChart(canvas = $('simChart'), result = state.result, { compact = false, cursor = null } = {}) {
  if (!canvas || !result) return;
  const tl = result.nominal.timeline;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = compact ? 0 : CH.left, R = compact ? 0 : CH.right;
  const w = W - L - R, n = Math.max(2, result.nominal.days * 24 * 60 / result.nominal.stepMin + 1);
  const x = (i) => L + (i / (n - 1)) * w;
  const lineTop = compact ? 2 : CH.top, lineH = compact ? H - 16 : H - 78;
  const bandY = lineTop + lineH + (compact ? 2 : 10), bandH = compact ? 4 : 12;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = cssVar('--line');
  ctx.lineWidth = 1;
  for (const f of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(L, lineTop + lineH * f); ctx.lineTo(L + w, lineTop + lineH * f); ctx.stroke(); }
  // Battery (0-100%) on the left axis, ground temperature (-200..+130 C) on the right.
  const yB = (v) => lineTop + lineH * (1 - v);
  const yT = (c) => lineTop + lineH * (1 - (c + 200) / 330);
  const path = (get, color, width, fill) => {
    ctx.beginPath();
    tl.forEach((r, i) => (i ? ctx.lineTo(x(i), get(r)) : ctx.moveTo(x(i), get(r))));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    if (fill) { ctx.lineTo(x(tl.length - 1), lineTop + lineH); ctx.lineTo(x(0), lineTop + lineH); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
  };
  path((r) => yT(r.tSurfC), cssVar('--crit'), 1.2);
  path((r) => yB(r.soc), cssVar('--ok'), 2, 'rgba(111,211,154,0.12)');
  ctx.fillStyle = cssVar('--shadow');
  for (let row = 0; row < 3; row++) ctx.fillRect(L, bandY + row * (bandH + 3), w, bandH);
  tl.forEach((r, i) => {
    const xx = x(i), ww = Math.max(1, x(i + 1) - xx + 0.5);
    if (r.sunVis > 0.5) { ctx.fillStyle = cssVar('--sun'); ctx.fillRect(xx, bandY, ww, bandH); }
    if (r.earthVis) { ctx.fillStyle = cssVar('--earth'); ctx.fillRect(xx, bandY + bandH + 3, ww, bandH); }
    ctx.fillStyle = stateColour(r.state); ctx.fillRect(xx, bandY + 2 * (bandH + 3), ww, bandH);
  });
  if (compact) return;
  ctx.font = `500 10.5px ${cssVar('--font-mono')}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = cssVar('--ok');
  ctx.fillText('100%', L - 6, yB(1) + 4); ctx.fillText('50%', L - 6, yB(0.5) + 4); ctx.fillText('0%', L - 6, yB(0) + 4);
  ctx.fillStyle = cssVar('--crit');
  ctx.textAlign = 'left';
  ctx.fillText('+130°C', L + w + 4, yT(130) + 9); ctx.fillText('0°C', L + w + 4, yT(0) + 4); ctx.fillText('−200°C', L + w + 4, yT(-200) - 2);
  ctx.fillStyle = cssVar('--ink-dim');
  ctx.textAlign = 'right';
  ['SUN', 'EARTH', 'ROVER'].forEach((t, row) => ctx.fillText(t, L - 6, bandY + row * (bandH + 3) + 10));
  ctx.textAlign = 'center';
  const days = result.nominal.days, every = days > 20 ? 5 : days > 10 ? 2 : 1;
  for (let d = 0; d <= days; d += every) ctx.fillText(d ? `D${d}` : 'Land', Math.min(L + w - 12, x((d * 24 * 60) / result.nominal.stepMin)), H - 4);
  if (Number.isFinite(cursor)) { ctx.fillStyle = cssVar('--ink'); ctx.fillRect(x(cursor) - 0.5, lineTop, 1.5, bandY + 3 * (bandH + 3) - lineTop); }
}

// Try other landing dates, a bigger battery, heaters and a planned route, and report what helps.
async function findImprovements(res) {
  const tips = [];
  const base = res.args;
  const rate = res.mc.rate;
  const quick = (args) => monteCarlo(args, { runs: 20, slipDays: res.slip, seed: 11 });
  const screened = [];
  for (const s of [-6, -4, -2, 2, 4, 6, 8, 10, 12, 14]) {
    const start = new Date(base.start.getTime() + s * DAY);
    const r = simulate({ ...base, start, record: false });
    screened.push({ s, start, ok: r.success, d: r.distance });
    await new Promise((x) => setTimeout(x, 0));
    if (state.result !== res) return;
  }
  screened.sort((a, b) => (b.ok - a.ok) || (b.d - a.d) || (Math.abs(a.s) - Math.abs(b.s)));
  let bestDate = null;
  for (const c of screened.slice(0, 2)) {
    const mc = await quick({ ...base, start: c.start });
    if (state.result !== res) return;
    if (!bestDate || mc.rate > bestDate.rate) bestDate = { ...c, rate: mc.rate, of: mc.runs, ok: mc.successes };
  }
  if (bestDate && bestDate.rate > rate + 0.05) {
    tips.push({ text: `Land on <b>${fmtDate(bestDate.start)}</b> (${bestDate.s > 0 ? `${bestDate.s} days later` : `${-bestDate.s} days earlier`}): ${bestDate.ok} of ${bestDate.of} runs succeed.`, act: 'Use this date', run: () => { state.start = bestDate.start; syncTiming(); setTime(state.start); runSimulation(); } });
  }
  if (res.mc.causes.battery?.length) {
    const mc = await quick({ ...base, rover: { ...base.rover, batteryWh: base.rover.batteryWh * 1.5 } });
    if (state.result !== res) return;
    tips.push({ text: `A <b>50% bigger battery</b> (${Math.round(base.rover.batteryWh * 1.5)} Wh): ${mc.successes} of ${mc.runs} runs succeed.`, act: 'Use it', run: () => { state.rover.batteryWh = Math.round(base.rover.batteryWh * 1.5); makeCustom(); syncRoverForm(); runSimulation(); } });
    const rhu = Math.round(base.rover.heatWperK * 60);
    const mc2 = await quick({ ...base, rover: { ...base.rover, rhuW: (base.rover.rhuW ?? 0) + rhu } });
    if (state.result !== res) return;
    tips.push({ text: `<b>Radioisotope heaters</b> worth ${rhu} W to keep warm in shadow: ${mc2.successes} of ${mc2.runs} runs succeed.`, act: 'Add them', run: () => { state.rover.rhuW = (state.rover.rhuW ?? 0) + rhu; makeCustom(); syncRoverForm(); runSimulation(); } });
  }
  if (!res.planned && res.waypoints.length > 1 && rate < 0.95) {
    tips.push({ text: 'Let the planner find a route that <b>stays in sunlight</b> and avoids steep slopes, then simulate again.', act: 'Find route', run: async () => { setStage('plan'); await planSunniest(); runSimulation(); } });
  }
  if (res.mc.causes.time?.length) tips.push({ text: `Some runs ran out of time. A <b>longer mission</b> (${res.nominal.days + 7} days) gives the rover more time to wait for sunlight.`, act: 'Add 7 days', run: () => { state.days += 7; syncTiming(); runSimulation(); } });
  const el = $('improve');
  if (!el || state.result !== res) return;
  el.innerHTML = tips.length
    ? `<ul>${tips.map((t, i) => `<li><span>${t.text}</span><button class="ghost" type="button" data-tip="${i}">${t.act}</button></li>`).join('')}</ul>`
    : '<p class="hint">Nothing we tried improved the odds noticeably. This plan is as good as these options get.</p>';
  el.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => tips[+b.dataset.tip].run()));
}

// ---------- replay: the rover drives the mission on the Moon ----------
const replay = {
  t: 0, // ms since landing
  playing: false,
  lastFrame: 0,
  lastUi: 0,
  lastTrail: 0,
  heading: 0,
  odometer: 0,
  shownEvents: new Set(),
  duration() { const n = state.result?.nominal; return n ? (n.timeline.length - 1) * n.stepMin * 60000 : 0; },
  // Replay rate while driving: all moving steps fit in ~30 s, but never slower than 15 minutes per second.
  driveSpeed() {
    const n = state.result?.nominal;
    if (!n) return HOUR;
    if (this.driveFor !== n) {
      this.driveFor = n;
      let moving = 0;
      for (let i = 1; i < n.timeline.length; i++) if (Math.abs(n.timeline[i].d - n.timeline[i - 1].d) > 0.5) moving++;
      this.driveMs = Math.max(HOUR / 4, (moving * n.stepMin * 60000) / 30);
    }
    return this.driveMs;
  },
};

function startReplay() {
  if (!state.result) return;
  const n = state.result.nominal;
  $('timeline').hidden = false;
  $('readout').hidden = true;
  $('hud').hidden = false;
  replay.shownEvents = new Set(n.events.filter((e) => e.t.getTime() - n.start.getTime() < replay.t).map((e) => e.text));
  replay.odometer = 0;
  drawStrip();
  replayFrame(true);
  globe.setFollow(true, 5000);
  $('followBtn').setAttribute('aria-pressed', 'true');
  $('followBtn').textContent = 'Following rover';
  setPlaying(true);
}

function stopReplay() {
  setPlaying(false);
  globe.setFollow(false);
  $('timeline').hidden = !state.result;
  $('hud').hidden = true;
  $('caption').hidden = true;
  $('readout').hidden = !!state.result;
}

function setPlaying(on) {
  replay.playing = on;
  replay.lastFrame = performance.now();
  $('pbPlay').textContent = on ? '❚❚' : '▶';
  $('pbPlay').setAttribute('aria-label', on ? 'Pause' : 'Play the mission');
  if (on && replay.t >= replay.duration()) replay.t = 0;
}
$('pbPlay').addEventListener('click', () => { if (state.stage !== 'replay') setStage('replay'); else setPlaying(!replay.playing); });
$('followBtn').addEventListener('click', () => {
  const on = !globe.follow;
  globe.setFollow(on, 5000);
  $('followBtn').setAttribute('aria-pressed', String(on));
  $('followBtn').textContent = on ? 'Following rover' : 'Free camera';
});

// State of the mission at replay time t, interpolated between the 15-minute steps.
function replayState(t) {
  const n = state.result.nominal, tl = n.timeline, stepMs = n.stepMin * 60000;
  const f = Math.max(0, Math.min(tl.length - 1, t / stepMs));
  const i = Math.min(tl.length - 2, Math.floor(f)), k = tl.length > 1 ? f - i : 0;
  const a = tl[Math.max(0, i)], b = tl[Math.min(tl.length - 1, i + 1)];
  const d = a.d + (b.d - a.d) * k;
  return { a, b, k, d, i, f, t: n.start.getTime() + t };
}

function replayFrame(force) {
  const res = state.result;
  if (!res) return;
  const now = performance.now();
  if (replay.playing) {
    let speed = parseFloat($('pbSpeed').value) * HOUR; // mission ms per real second
    // Slow down while the rover is moving so the drive itself takes about half a minute to watch.
    const cur = replayState(replay.t);
    replay.slowed = Math.abs(cur.b.d - cur.a.d) > 0.5 && replay.driveSpeed() < speed;
    if (replay.slowed) speed = replay.driveSpeed();
    replay.t = Math.min(replay.duration(), replay.t + ((now - replay.lastFrame) / 1000) * speed);
    if (replay.t >= replay.duration()) setPlaying(false);
  }
  else replay.slowed = false;
  replay.lastFrame = now;
  const s = replayState(replay.t);
  const route = res.args.route;
  const here = pointAt(route, s.d);
  // Face the direction of travel; keep the last heading while stopped.
  const moving = s.b.d - s.a.d;
  if (Math.abs(moving) > 0.5) {
    const ahead = pointAt(route, s.d + Math.sign(moving) * 20);
    if (distance(here, ahead) > 1) replay.heading = bearing(here, ahead);
  }
  const prevOdo = replay.odometer;
  replay.odometer = s.d;
  const lerpAng = (x, y, k) => x + ((((y - x) % 360) + 540) % 360 - 180) * k;
  const live = s.k < 0.5 ? s.a : s.b;
  globe.setRover({
    lat: here.lat, lon: here.lon, h: here.h, heading: replay.heading,
    sunAz: lerpAng(s.a.sunAz, s.b.sunAz, s.k), colour: stateColour(live.state),
    odometer: prevOdo === s.d ? undefined : s.d,
  });
  // Sun and Earth move smoothly with the replay clock.
  if (now - replay.lastUi > 90 || force) {
    replay.lastUi = now;
    setTime(new Date(s.t), bodyVectors(new Date(s.t)));
    updateHud(s, live);
    drawStrip(s.f);
    showEvents(s);
  }
  if (now - replay.lastTrail > 300 || force) {
    replay.lastTrail = now;
    // The trail covers the stretch of route driven so far (the rover can back up, so use the furthest point).
    let maxD = 0;
    for (let j = 0; j <= s.i + 1 && j < res.nominal.timeline.length; j++) maxD = Math.max(maxD, res.nominal.timeline[j].d);
    maxD = Math.min(maxD, Math.max(s.d, maxD));
    const pts = route.pts.filter((p) => p.d <= maxD).map((p) => ({ lat: p.lat, lon: p.lon, h: p.h }));
    pts.push({ lat: here.lat, lon: here.lon, h: here.h });
    globe.setTrail(pts.length > 1 ? pts : null);
  }
}

function updateHud(s, live) {
  const n = state.result.nominal;
  const soc = s.a.soc + (s.b.soc - s.a.soc) * s.k;
  const t = new Date(s.t);
  $('hudDay').textContent = `Day ${Math.floor((s.t - n.start.getTime()) / DAY) + 1}`;
  $('hudClock').textContent = `${fmtDate(t)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
  $('hudState').textContent = (n.states[live.state] ?? live.state) + (live.why ? ` · ${live.why}` : '');
  $('hudState').style.color = stateColour(live.state);
  $('hudBatt').style.width = `${Math.round(soc * 100)}%`;
  $('hudBatt').style.background = soc < 0.2 ? cssVar('--crit') : soc < 0.4 ? cssVar('--warn') : cssVar('--ok');
  $('hudBattTxt').textContent = `${Math.round(soc * 100)}%`;
  $('hudTemp').textContent = `${Math.round(live.tSurfC)} °C`;
  $('hudDist').textContent = `${(s.d / 1000).toFixed(2)} km`;
  $('hudSun').textContent = live.sunVis > 0.5 ? 'Shining' : live.sunEl < 0 ? 'Below horizon' : 'Behind terrain';
  $('hudEarth').textContent = live.earthVis ? 'In view' : 'Hidden';
  $('hudGen').textContent = `${Math.round(live.gen)} W`;
  $('hudLoad').textContent = `${Math.round(live.load)} W`;
  const x = globe.roverScale ?? 1;
  $('hudScale').textContent = x > 1.5 ? `Rover drawn ${Math.round(x)}× life size so you can see it. Zoom in to see it at true size.` : 'Rover at true size.';
  $('pbText').textContent = `${dayStamp(s.t, n.start.getTime())} · ${(s.d / 1000).toFixed(2)} km${replay.slowed ? ' · slowed to watch the drive' : ''}`;
}

function showEvents(s) {
  const n = state.result.nominal;
  for (const e of n.events) {
    if (e.t.getTime() <= s.t && !replay.shownEvents.has(e.text)) {
      replay.shownEvents.add(e.text);
      if (s.t - e.t.getTime() < 12 * HOUR) {
        const c = $('caption');
        c.className = `caption ${e.level}`;
        c.innerHTML = `<span class="mono">${dayStamp(e.t.getTime(), n.start.getTime())}</span>${esc(e.text)}`;
        c.hidden = false;
        clearTimeout(showEvents.timer);
        showEvents.timer = setTimeout(() => { c.hidden = true; }, 4500);
        if (e.level === 'critical' || e.level === 'ok') setPlaying(false);
      }
    }
  }
}

// Timeline strip: rover activity colours, event marks and the playhead.
function drawStrip(cursor) {
  const c = $('pbStrip');
  const res = state.result;
  if (!c || !res) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tl = res.nominal.timeline, n = tl.length;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--shadow');
  ctx.fillRect(0, 6, W, H - 12);
  tl.forEach((r, i) => {
    ctx.fillStyle = stateColour(r.state);
    ctx.fillRect((i / n) * W, 6 + (H - 12) / 2, Math.max(1, W / n + 0.5), (H - 12) / 2);
    if (r.sunVis > 0.5) { ctx.fillStyle = cssVar('--sun'); ctx.globalAlpha = 0.55; ctx.fillRect((i / n) * W, 6, Math.max(1, W / n + 0.5), (H - 12) / 2); ctx.globalAlpha = 1; }
  });
  const t0 = res.nominal.start.getTime(), stepMs = res.nominal.stepMin * 60000;
  for (const e of res.nominal.events) {
    if (e.level === 'info') continue;
    const xx = ((e.t.getTime() - t0) / stepMs / n) * W;
    ctx.fillStyle = e.level === 'critical' ? cssVar('--crit') : e.level === 'ok' ? cssVar('--ok') : cssVar('--warn');
    ctx.fillRect(xx - 1, 0, 2, H);
  }
  const f = cursor ?? replay.t / stepMs;
  ctx.fillStyle = cssVar('--ink');
  ctx.fillRect((f / n) * W - 1, 0, 3, H);
}
function scrubTo(e) {
  const r = $('pbStrip').getBoundingClientRect();
  replay.t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * replay.duration();
  replay.shownEvents = new Set(state.result.nominal.events.filter((ev) => ev.t.getTime() - state.result.nominal.start.getTime() < replay.t).map((ev) => ev.text));
  if (state.stage !== 'replay') setStage('replay');
  replayFrame(true);
}
let scrubbing = false;
$('pbStrip').addEventListener('pointerdown', (e) => { scrubbing = true; e.currentTarget.setPointerCapture(e.pointerId); setPlaying(false); scrubTo(e); });
$('pbStrip').addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
$('pbStrip').addEventListener('pointerup', () => { scrubbing = false; });

// ---------- readout (plan stage) ----------
function updateReadout() {
  if (!terrain || !state.waypoints.length || state.stage === 'replay') return;
  const w = state.waypoints[0];
  const env = environment(terrain, ephemeris(15 * 60 * 1000), w.lat, w.lon, terrain.height(w.lat, w.lon), state.time.getTime());
  $('roSun').textContent = env.sunVis > 0.5 ? `Sun ${(env.sun.el - env.sunHz).toFixed(1)}° over the skyline` : env.sun.el < 0 ? 'Night at the landing site' : 'Landing site in shadow';
  $('roEarth').textContent = `Earth ${env.earthVis ? 'in view' : 'hidden'}`;
}

// ---------- panels ----------
const panels = ['setup', 'report', 'stand', 'compare'];
function openPanel(id) {
  $(id).hidden = false;
  if (id === 'setup') $('menuBtn').setAttribute('aria-expanded', 'true');
  document.body.classList.toggle('report-open', !$('report').hidden);
  document.body.classList.toggle('setup-open', !$('setup').hidden);
  if (id === 'report') requestAnimationFrame(() => drawChart());
}
function closePanel(id) {
  $(id).hidden = true;
  if (id === 'setup') $('menuBtn').setAttribute('aria-expanded', 'false');
  if (id === 'stand') stopStandPlay();
  document.body.classList.toggle('report-open', !$('report').hidden);
  document.body.classList.toggle('setup-open', !$('setup').hidden);
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel(b.dataset.close)));
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && state.stage === 'replay' && e.target === document.body) { e.preventDefault(); setPlaying(!replay.playing); return; }
  if (e.key !== 'Escape') return;
  if (state.pick) { setPick(null); return; }
  const top = [...panels].reverse().find((p) => !$(p).hidden);
  if (top) closePanel(top);
  $('timePanel').hidden = true;
});
$('menuBtn').addEventListener('click', () => { if (state.stage !== 'plan') setStage('plan'); else ($('setup').hidden ? openPanel('setup') : closePanel('setup')); });
$('siteChip').addEventListener('click', () => setStage('plan'));

// ---------- search: land anywhere ----------
const search = $('search');
const results = $('results');
let active = 0;
function renderResults() {
  const q = search.value.trim().toLowerCase();
  const items = [];
  const c = parseCoords(search.value);
  if (c) items.push({ id: null, name: `Land at ${fmtLL(c)}`, lat: c.lat, lon: c.lon });
  for (const s of ALL_PLACES) if (!q || s.name.toLowerCase().includes(q)) items.push(s);
  results.textContent = '';
  items.slice(0, 12).forEach((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = s.name;
    li.lastChild.textContent = fmtLL(s);
    li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(s); });
    results.appendChild(li);
  });
  results.hidden = items.length === 0;
  renderResults.items = items;
}
function choose(s) {
  search.value = '';
  results.hidden = true;
  search.blur();
  if (state.stage !== 'plan') setStage('plan');
  setLanding(s, s.id ? s.name : `Landing at ${fmtLL(s)}`);
  toast(`Landing set: ${s.id ? s.name : fmtLL(s)}. Add route points, then simulate.`);
}
search.addEventListener('focus', () => { active = 0; renderResults(); });
search.addEventListener('input', () => { active = 0; renderResults(); });
search.addEventListener('blur', () => { results.hidden = true; });
search.addEventListener('keydown', (e) => {
  const items = renderResults.items || [];
  if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); renderResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderResults(); e.preventDefault(); }
  if (e.key === 'Enter' && items[active]) choose(items[active]);
  if (e.key === 'Escape') search.blur();
});

// ---------- sky from the rover ----------
const pano = new Panorama($('pano'));
let standTimer = null;
function roverNow() {
  if (state.result) {
    const s = replayState(replay.t);
    const p = pointAt(state.result.args.route, s.d);
    return { p, i: Math.round(s.f) };
  }
  const w = state.waypoints[0];
  return { p: { ...w, h: terrain.height(w.lat, w.lon) }, i: 0 };
}
function openStand() {
  if (!terrain || !state.waypoints.length) { toast('Choose a landing place first.'); return; }
  const { p, i } = roverNow();
  const horizon = [];
  for (let az = 0; az < 360; az += 1) horizon.push(terrain.horizon(p.lat, p.lon, az, p.h + 1.5));
  openPanel('stand');
  $('standSite').textContent = `Rover at ${fmtLL(p)} · skyline from NASA LOLA terrain · vertical scale ×${pano.vScale}`;
  $('standNote').textContent = state.result ? 'The slider follows the simulated mission.' : 'Simulate the mission to follow the rover through it.';
  const tl = state.result?.nominal.timeline;
  pano.set({ horizon, track: tl ? tl.filter((_, k) => k % 4 === 0).map((q) => ({ sunAz: q.sunAz, sunEl: q.sunEl, earthAz: q.earthAz, earthEl: q.earthEl })) : [] });
  $('standSlider').max = tl ? tl.length - 1 : 0;
  setStandIdx(i, p);
  pano.lookAt(pano.state?.sun.az ?? 180);
}
function setStandIdx(i, fixed) {
  const tl = state.result?.nominal.timeline;
  const r = tl ? tl[i] : null;
  const t = r ? r.t : state.time.getTime();
  const p = r ? { lat: r.lat, lon: r.lon, h: r.h } : fixed;
  const eph = ephemeris(15 * 60 * 1000);
  const env = environment(terrain, eph, p.lat, p.lon, p.h, t);
  const v = eph(t);
  const lit = (1 + (v.sun.x * v.earth.x + v.sun.y * v.earth.y + v.sun.z * v.earth.z)) / 2;
  pano.set({ state: { sun: env.sun, earth: env.earth, sunlit: env.sunVis > 0.5, earthVisible: env.earthVis, earthLit: lit } });
  $('standSlider').value = i;
  $('standTime').textContent = r ? dayStamp(t, state.result.nominal.start.getTime()) : fmtDateTime(new Date(t));
  $('standReadout').innerHTML = `<span class="sun-dot"></span>Sun ${env.sun.el.toFixed(2)}° at az ${env.sun.az.toFixed(0)}° · ${env.sunVis > 0.5 ? 'above skyline' : 'behind skyline'}
    <span class="earth-dot"></span>Earth ${env.earth.el.toFixed(2)}° · ${env.earthVis ? 'in view' : 'hidden'} · ground ${Math.round(env.teq - 273.15)} °C`;
  if (r) { replay.t = i * state.result.nominal.stepMin * 60000; }
}
$('standSlider').addEventListener('input', (e) => setStandIdx(+e.target.value));
function stopStandPlay() { clearInterval(standTimer); standTimer = null; $('standPlay').textContent = '▶'; }
$('standPlay').addEventListener('click', () => {
  if (standTimer) return stopStandPlay();
  if (!state.result) return;
  $('standPlay').textContent = '❚❚';
  standTimer = setInterval(() => {
    const max = state.result.nominal.timeline.length - 1;
    const i = +$('standSlider').value;
    setStandIdx(i >= max ? 0 : i + 2);
  }, 80);
});
$('lookSun').addEventListener('click', () => pano.lookAt(pano.state.sun.az));
$('lookEarth').addEventListener('click', () => pano.lookAt(pano.state.earth.az));

// ---------- compare ----------
function addCompare(res) {
  if (state.saved.includes(res)) { toast('This forecast is already in compare.'); openCompare(); return; }
  state.saved.push(res);
  if (state.saved.length > 3) state.saved.shift();
  $('cmpCount').textContent = state.saved.length;
  openCompare();
}
function openCompare() {
  openPanel('compare');
  const grid = $('cmpGrid');
  grid.textContent = '';
  if (!state.saved.length) {
    grid.innerHTML = '<p class="cmp-empty">Simulate a mission and choose <b>Add to compare</b>. You can line up to three rovers, routes or dates side by side.</p>';
    return;
  }
  const best = Math.max(...state.saved.map((s) => s.mc.rate));
  state.saved.forEach((res, i) => {
    const [word, colour] = verdict(res.mc.rate);
    const card = document.createElement('article');
    card.className = `cmp-card${res.mc.rate === best && state.saved.length > 1 ? ' best' : ''}`;
    card.innerHTML = `
      <header><div><strong></strong><div class="chip-sub"></div></div><div class="big" style="color:${colour}">${Math.round(res.mc.rate * 100)}%</div></header>
      <p class="hint">${word}: ${res.mc.successes} of ${res.mc.runs} runs succeeded</p>
      <canvas></canvas>
      <dl class="facts">
        <div><dt>Driven (as planned)</dt><dd>${fmtKm(res.nominal.distance)}</dd></div>
        <div><dt>Lowest battery</dt><dd>${Math.max(0, Math.round(res.nominal.minSoc * 100))}%</dd></div>
      </dl>
      <div class="row"><button class="ghost" type="button" data-open>Open forecast</button><button class="ghost" type="button" data-remove>Remove</button></div>`;
    card.querySelector('strong').textContent = res.rover.name;
    card.querySelector('.chip-sub').textContent = `${res.landingName} · ${res.waypoints.length > 1 ? fmtKm(res.nominal.routeLength) + ' route' : 'stays put'} · ${fmtDate(res.nominal.start)} · ${res.nominal.days} d`;
    grid.appendChild(card);
    drawChart(card.querySelector('canvas'), res, { compact: true });
    card.querySelector('[data-open]').addEventListener('click', () => { state.result = res; closePanel('compare'); renderReport(); setStage('forecast'); });
    card.querySelector('[data-remove]').addEventListener('click', () => { state.saved.splice(i, 1); $('cmpCount').textContent = state.saved.length; openCompare(); });
  });
}

// ---------- toolbar ----------
function setTool(name, on) {
  const b = document.querySelector(`.tool[data-tool="${name}"]`);
  if (!b) return;
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  const on = !b.classList.contains('on');
  if (t === 'map') toggleSunMap();
  if (t === 'sun') { setTool('sun', on); globe.setFullLight(!on); toast(on ? 'Real sunlight for the chosen date and time.' : 'Viewing light: terrain lit from the side so it is easy to see anywhere. Turn Sunlight back on for real lighting.'); }
  if (t === 'relief') { setTool('relief', on); globe.setRelief(on ? 5 : 1); $('reliefLabel').textContent = on ? 'Relief ×5' : 'Relief ×1'; }
  if (t === 'fly') { globe.setFollow(false); const pts = state.route ? state.route.pts : state.waypoints; if (pts.length) globe.frameRoute(pts); }
  if (t === 'home') { globe.setFollow(false); globe.flyHome(); }
  if (t === 'stand') openStand();
  if (t === 'compare') openCompare();
}));

// ---------- time ----------
function setTime(d, vectors) {
  state.time = d;
  globe.setSunDirection((vectors ?? ephemeris(15 * 60 * 1000)(d.getTime())).sun);
  $('clock').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  $('dateStr').textContent = `${fmtDate(d)} UTC`;
  if (document.activeElement !== $('timeInput')) $('timeInput').value = toLocalInput(d);
  if (state.stage !== 'replay') updateReadout();
}
$('timeChip').addEventListener('click', () => {
  const p = $('timePanel');
  p.hidden = !p.hidden;
  $('timeChip').setAttribute('aria-expanded', String(!p.hidden));
});
$('timeInput').addEventListener('change', (e) => { const d = fromLocalInput(e.target.value); if (d) setTime(d); });
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => setTime(new Date(state.time.getTime() + +b.dataset.step * HOUR))));
$('nowBtn').addEventListener('click', () => setTime(new Date()));
let playing = false, last = performance.now();
$('playBtn').addEventListener('click', (e) => { playing = !playing; e.currentTarget.setAttribute('aria-pressed', String(playing)); last = performance.now(); });
globe.onFrame = () => {
  const now = performance.now();
  if (state.stage === 'replay') replayFrame(false);
  else if (playing) setTime(new Date(state.time.getTime() + (now - last) * 20000));
  last = now;
};
globe.onNight = () => { if (state.stage !== 'replay') toast('It is night here at the chosen time. Tap Sunlight to switch to a viewing light, or change the time.'); };

// ---------- start ----------
if (window.innerWidth < 900) closePanel('setup'); else openPanel('setup');
syncRoverForm();
syncTiming();
fStart.value = SITES[0].id;
setTime(state.start);
routeChanged().then(() => globe.frameRoute(state.route.pts));
