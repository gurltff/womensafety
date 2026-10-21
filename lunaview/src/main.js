import './styles.css';
import { Globe } from './globe.js';
import { Panorama } from './panorama.js';
import { SITES, parseCoords } from './sites.js';
import { Terrain, latLonToXY, xyToLatLon } from './terrain.js';
import { prepareRoute, ephemeris, environment, simulate, monteCarlo } from './sim.js';
import { sunlightMap, planRoute, boxAround } from './planner.js';
import { ROVERS, ROVER_FIELDS } from './rovers.js';

const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Example mission: a mid-size rover drives 3.5 km west along the sunlit rim from Shackleton.
const state = {
  rover: { ...ROVERS[1] },
  roverId: ROVERS[1].id,
  startSite: SITES[0],
  waypoints: [latLonToXY(SITES[0].lat, SITES[0].lon), latLonToXY(-89.691, -141.26)],
  start: new Date(Date.UTC(2026, 10, 20)),
  days: 14,
  slip: 2,
  runs: 50,
  mustSurvive: true,
  drawing: false,
  route: null,
  planned: false,
  result: null,
  stale: false,
  time: new Date(Date.UTC(2026, 10, 20)),
  saved: [],
  sunMap: null,
};

// ---------- formatting ----------
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
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
globe.setSites(SITES, state.startSite.id);

let terrain = null;
const terrainReady = new Promise((resolve) => {
  const check = () => {
    if (globe.terrain?.sim && globe.polarH) {
      terrain = new Terrain(globe.terrain.sim, (x, y) => { const { lat, lon } = xyToLatLon(x, y); return globe.coarseHeight(lat, lon); });
      globe.fineHeight = (lat, lon) => {
        if (lat > -80) return NaN;
        const { x, y } = latLonToXY(lat, lon);
        return terrain.isFine(x, y) ? terrain.height(x, y) : NaN;
      };
      resolve(terrain);
    } else setTimeout(check, 150);
  };
  check();
});

const toLL = (p) => xyToLatLon(p.x, p.y);
const inSimArea = (lat) => lat <= -80;

globe.onPick = (site) => {
  if (state.drawing) addWaypoint(site.lat, site.lon);
  else setStartSite(site);
};
globe.onSurfaceClick = ({ lat, lon }) => {
  if (state.drawing) addWaypoint(lat, lon);
};

function addWaypoint(lat, lon) {
  if (!inSimArea(lat)) { toast(`${fmtLat(lat)} ${fmtLon(lon)} is outside the simulated area. Route points must be poleward of 80°S.`); return; }
  state.waypoints.push(latLonToXY(lat, lon));
  state.planned = false;
  routeChanged();
}

function setStartSite(site) {
  state.startSite = site;
  globe.select(site.id);
  const p = latLonToXY(site.lat, site.lon);
  if (state.waypoints.length) state.waypoints[0] = p; else state.waypoints = [p];
  state.planned = false;
  $('fStart').value = site.id;
  routeChanged();
  globe.flyTo(site);
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
  if (state.waypoints.length) await terrain.loadAround(state.waypoints, 25000);
  if (job !== routeJob) return;
  state.route = state.waypoints.length ? prepareRoute(terrain, state.waypoints) : null;
  drawRoute();
  renderRouteStats();
  updateReadout();
}

function drawRoute() {
  const r = state.route;
  if (!r) { globe.setRoute(null); globe.setWaypoints([]); return; }
  globe.setRoute(r.pts.map((p) => ({ ...toLL(p), h: p.h, color: slopeColour(p.slope, state.rover.maxSlopeDeg) })));
  globe.setWaypoints(state.waypoints.map((w, i) => ({
    ...toLL(w), h: terrain.height(w.x, w.y), kind: i === 0 ? 'start' : i === state.waypoints.length - 1 ? 'end' : 'via',
  })));
}

function renderWaypoints() {
  const ol = $('wpList');
  ol.textContent = '';
  state.waypoints.forEach((w, i) => {
    const ll = toLL(w);
    const li = document.createElement('li');
    const label = i === 0 ? 'Landing' : i === state.waypoints.length - 1 ? 'Destination' : `Via ${i}`;
    li.innerHTML = `<span class="wp-k"></span><span class="mono"></span>${i ? '<button type="button" class="wp-x" aria-label="Remove point">×</button>' : ''}`;
    li.querySelector('.wp-k').textContent = label;
    li.querySelector('.mono').textContent = `${fmtLat(ll.lat)} ${fmtLon(ll.lon)}`;
    li.querySelector('.wp-x')?.addEventListener('click', () => { state.waypoints.splice(i, 1); state.planned = false; routeChanged(); });
    ol.appendChild(li);
  });
  $('siteName').textContent = state.rover.name.split(' (')[0].toUpperCase();
}

function renderRouteStats() {
  const r = state.route, el = $('routeStats');
  if (!r || state.waypoints.length < 2) {
    el.innerHTML = state.drawing
      ? '<b>Click the ground</b> to add the next point of the route.'
      : 'Add a destination: choose <b>Draw on map</b>, then click the ground. With only a landing point, the simulation checks whether the rover survives in place.';
    $('siteCoords').textContent = state.waypoints.length ? 'Stays at landing site' : 'No route yet';
    return;
  }
  const lim = state.rover.maxSlopeDeg, steep = r.steepest.slope;
  const coarse = r.pts.some((p) => !p.fine);
  el.innerHTML = `<b>${fmtKm(r.length)}</b> · steepest slope <b class="${steep > lim ? 't-bad' : steep > lim * 0.7 ? 't-warn' : ''}">${steep.toFixed(0)}°</b> (rover limit ${lim}°) · climb ${Math.round(r.climb)} m`
    + `${state.planned ? ' · <b>planned for sunlight</b>' : ''}<br>Slopes from NASA LOLA terrain at ${coarse ? 'coarser than ' : ''}80 m resolution.`
    + (steep > lim ? `<br><span class="t-bad">A ${steep.toFixed(0)}° slope at km ${(r.steepest.d / 1000).toFixed(1)} is too steep. Use <b>Find the sunniest route</b> to go around it.</span>` : '');
  $('siteCoords').textContent = `${fmtKm(r.length)} route`;
}

// ---------- route planner and sunlight map ----------
async function computeSunMap(a, b, label) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const margin = Math.max(2500, len * 0.35);
  // Keep the grid to about 3,000 cells so the map takes a few seconds.
  const area = (Math.abs(b.x - a.x) + 2 * margin) * (Math.abs(b.y - a.y) + 2 * margin);
  const cell = Math.max(160, Math.ceil(Math.sqrt(area / 3000) / 40) * 40);
  const box = boxAround(a, b, margin, cell);
  await terrain.loadAround([{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 }, a, b], 0);
  return sunlightMap(terrain, ephemeris(HOUR), box, state.start, state.days, {
    onProgress: (f) => { $('simStatus').textContent = `${label}: ${Math.round(f * 100)}%`; },
  });
}

function showSunMap(map) {
  const cells = [];
  for (let j = 0; j < map.ny; j++) for (let i = 0; i < map.nx; i++) {
    const k = j * map.nx + i, x = map.x0 + i * map.cell, y = map.y0 + j * map.cell;
    cells.push({ ...xyToLatLon(x, y), h: map.h[k], lit: map.lit[k] });
  }
  globe.setOverlay(cells, map.cell);
  setTool('map', true);
}

async function planSunniest() {
  if (state.waypoints.length < 2) { toast('Add a destination first: choose Draw on map, then click the ground.'); return; }
  await terrainReady;
  $('planBtn').disabled = true;
  try {
    const out = [state.waypoints[0]];
    for (let i = 1; i < state.waypoints.length; i++) {
      const a = state.waypoints[i - 1], b = state.waypoints[i];
      const map = await computeSunMap(a, b, `Mapping sunlight for leg ${i}`);
      state.sunMap = map;
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
  if (!state.waypoints.length) { toast('Pick a landing site first.'); return; }
  await terrainReady;
  const a = state.waypoints[0], b = state.waypoints[state.waypoints.length - 1];
  const map = await computeSunMap(a, b, 'Mapping sunlight');
  state.sunMap = map;
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
    if (Number.isFinite(v)) { state.rover[key] = v; state.roverId = 'custom'; fRover.value = 'custom'; state.rover.name = 'Custom rover'; markStale(); drawRoute(); renderRouteStats(); }
  });
  specGrid.appendChild(wrap);
}
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
$('fPanel').addEventListener('change', (e) => { state.rover.panel = e.target.value; markStale(); });
$('fComms').addEventListener('change', (e) => { state.rover.needsComms = e.target.checked; markStale(); });

// Landing site picker.
const fStart = $('fStart');
for (const s of SITES) fStart.add(new Option(`${s.name} (${fmtLat(s.lat)} ${fmtLon(s.lon)})`, s.id));
fStart.addEventListener('change', () => { const s = SITES.find((x) => x.id === fStart.value); if (s) setStartSite(s); });

// Timing.
function syncTiming() {
  $('fDate').value = toLocalInput(state.start);
  $('fDays').value = state.days;
  $('fSlip').value = state.slip;
  $('fRuns').value = String(state.runs);
}
$('fDate').addEventListener('change', (e) => { const d = fromLocalInput(e.target.value); if (d) { state.start = d; setTime(d); markStale(); } });
$('fDays').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 60) { state.days = v; markStale(); } });
$('fSlip').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v >= 0 && v <= 10) { state.slip = v; markStale(); } });
$('fRuns').addEventListener('change', (e) => { state.runs = parseInt(e.target.value, 10); });
$('fSurvive').addEventListener('change', (e) => { state.mustSurvive = e.target.checked; markStale(); });

// Route drawing controls.
function setDrawing(on) {
  state.drawing = on;
  $('drawBtn').setAttribute('aria-pressed', String(on));
  $('drawBtn').textContent = on ? 'Done drawing' : 'Draw on map';
  setTool('draw', on);
  document.body.classList.toggle('drawing', on);
  if (on) toast('Click the ground to add route points. Points must be poleward of 80°S.');
  renderRouteStats();
}
$('drawBtn').addEventListener('click', () => setDrawing(!state.drawing));
$('undoBtn').addEventListener('click', () => { if (state.waypoints.length > 1) { state.waypoints.pop(); state.planned = false; routeChanged(); } });
$('clearBtn').addEventListener('click', () => { state.waypoints = state.waypoints.slice(0, 1); state.planned = false; routeChanged(); });
$('planBtn').addEventListener('click', planSunniest);

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
  if (!state.waypoints.length) { toast('Pick a landing site first.'); return; }
  const job = ++simJob;
  setDrawing(false);
  $('simBtn').disabled = $('runBtn').disabled = true;
  $('simStatus').textContent = 'Loading terrain…';
  try {
    await terrainReady;
    await routeChanged();
    const r = state.route;
    if (r.pts.some((p) => !p.fine)) toast('Part of the route is outside the detailed 80 m terrain, so slopes there are less certain.');
    const args = { terrain, eph: ephemeris(15 * 60 * 1000), rover: { ...state.rover }, route: r, start: state.start, days: state.days, mustSurvive: state.mustSurvive };
    $('simStatus').textContent = 'Simulating the planned mission…';
    await new Promise((res) => setTimeout(res, 20));
    const nominal = simulate(args);
    const mc = await monteCarlo(args, {
      runs: state.runs, slipDays: state.slip,
      onProgress: (f) => { $('simStatus').textContent = `Simulating ${state.runs} missions with realistic uncertainty… ${Math.round(f * 100)}%`; },
    });
    if (job !== simJob) return;
    state.result = { nominal, mc, args, rover: { ...state.rover }, waypoints: state.waypoints.slice(), planned: state.planned, slip: state.slip };
    state.stale = false;
    $('simStatus').textContent = `Done: ${mc.successes} of ${mc.runs} simulated missions succeeded.`;
    renderReport();
    openPanel('report');
    setupPlayback();
    findImprovements(state.result);
  } finally {
    $('simBtn').disabled = $('runBtn').disabled = false;
  }
}
$('missionForm').addEventListener('submit', (e) => { e.preventDefault(); runSimulation(); });
$('runBtn').addEventListener('click', runSimulation);

// ---------- report ----------
const CAUSE = {
  battery: { label: 'Battery ran out', tip: 'usually during a long shadow, with heaters running' },
  slope: { label: 'Route blocked by a steep slope', tip: 'steeper than the rover can climb' },
  time: { label: 'Ran out of time', tip: 'waited too long for sunlight or Earth contact' },
};
const STATE_INFO = [
  ['drive', 'Driving', 'var(--ok)'],
  ['retreat', 'Driving back to sunlight', 'var(--teal)'],
  ['charge', 'Charging in sunlight', 'var(--sun)'],
  ['park', 'Parked', 'var(--ink-dim)'],
  ['hibernate', 'Hibernating in shadow', 'var(--violet)'],
  ['done', 'Arrived', 'var(--earth)'],
];

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
  const routeTxt = waypoints.length > 1 ? `${fmtKm(n.routeLength)} route` : 'stays at the landing site';

  $('reportBody').innerHTML = `
    <p class="stale hint" hidden><b>Inputs changed.</b> Run the simulation again to update this forecast.</p>
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
    <div class="nominal ${n.success ? 'ok' : 'bad'}"><span class="pill ${n.success ? 'ok' : 'critical'}">As planned</span><span>${esc(n.text)}</span></div>

    <h3>Why missions failed</h3>
    ${causes.length ? `<ul class="cause-list">${causes.map(([k, list]) => `
      <li><div class="cause-bar"><i style="width:${(100 * list.length) / mc.runs}%"></i></div>
        <div><b>${CAUSE[k]?.label ?? k}</b>: ${list.length} of ${mc.runs} runs<br><span class="hint">${esc(list[0].text)}</span></div></li>`).join('')}</ul>`
      : '<p class="hint">None of the simulated missions failed.</p>'}

    <h3>The planned mission, hour by hour</h3>
    <div class="chart-wrap"><canvas id="simChart" aria-label="Battery, ground temperature, sunlight, Earth contact and rover activity over the mission. Click to jump to a moment."></canvas></div>
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
      <button class="cta" type="button" id="toReplay">Replay on the Moon</button>
      <button class="ghost" type="button" id="toStand">Stand where the rover is</button>
      <button class="ghost" type="button" id="toCompare">Add to compare</button>
    </div>
    <p class="hint method">Model: rover position every ${n.stepMin} min on NASA LOLA 80 m terrain; Sun and Earth from astronomy-engine with the real skyline in their direction; ground temperature from radiative balance on the local slope (cooling to ~95 K in shadow); solar power from panel angle and the share of the Sun's disc above the skyline; heaters run in shadow. The rover follows simple operating rules: it waits for sunlight ahead unless the battery can carry it through a shadow, backs out of shadow to the nearest sunlight, and hibernates in the dark.</p>`;

  drawChart();
  $('simChart').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left - CH.left) / (rect.width - CH.left - CH.right);
    seek(Math.round(Math.max(0, Math.min(1, f)) * (tl.length - 1)));
  });
  $('toReplay').addEventListener('click', () => { closePanel('report'); globe.frameRoute(tl.map((r) => xyToLatLon(r.x, r.y))); play(true); });
  $('toStand').addEventListener('click', () => openStand());
  $('toCompare').addEventListener('click', () => addCompare(state.result));
}

const CH = { left: 46, right: 10, top: 10 };
function drawChart(canvas = $('simChart'), result = state.result, { compact = false, cursor = state.pbIndex } = {}) {
  if (!canvas) return;
  const tl = result.nominal.timeline;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const L = compact ? 0 : CH.left, R = compact ? 0 : CH.right;
  const w = W - L - R, n = Math.max(2, result.nominal.days * 24 * 60 / result.nominal.stepMin + 1);
  const x = (i) => L + (i / (n - 1)) * w;
  const lineTop = compact ? 2 : CH.top, lineH = compact ? H - 16 : H - 78;
  const bandY = lineTop + lineH + (compact ? 2 : 10), bandH = compact ? 4 : 12;
  ctx.clearRect(0, 0, W, H);
  // Grid.
  ctx.strokeStyle = col('--line');
  ctx.lineWidth = 1;
  for (const f of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(L, lineTop + lineH * f); ctx.lineTo(L + w, lineTop + lineH * f); ctx.stroke(); }
  // Battery (0-100%) and ground temperature (-200..+130 C) share the plot.
  const yB = (v) => lineTop + lineH * (1 - v);
  const yT = (c) => lineTop + lineH * (1 - (c + 200) / 330);
  const path = (get, color, width, fill) => {
    ctx.beginPath();
    tl.forEach((r, i) => (i ? ctx.lineTo(x(i), get(r)) : ctx.moveTo(x(i), get(r))));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    if (fill) { ctx.lineTo(x(tl.length - 1), lineTop + lineH); ctx.lineTo(x(0), lineTop + lineH); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
  };
  path((r) => yT(r.tSurfC), col('--crit'), 1.2);
  path((r) => yB(r.soc), col('--ok'), 2, 'rgba(111,211,154,0.12)');
  // Bands: sunlight, Earth, activity.
  const band = (row, test, color) => {
    ctx.fillStyle = color;
    tl.forEach((r, i) => { const c = test(r); if (c) { ctx.fillStyle = c === true ? color : c; ctx.fillRect(x(i), bandY + row * (bandH + 3), Math.max(1, x(i + 1) - x(i) + 0.5), bandH); } });
  };
  ctx.fillStyle = col('--shadow');
  for (let row = 0; row < 3; row++) ctx.fillRect(L, bandY + row * (bandH + 3), w, bandH);
  band(0, (r) => r.sunVis > 0.5, col('--sun'));
  band(1, (r) => r.earthVis, col('--earth'));
  const stc = Object.fromEntries(STATE_INFO.map(([k, , c]) => [k, c.startsWith('var(') ? col(c.slice(4, -1)) : c]));
  band(2, (r) => stc[r.state] ?? col('--crit'), '#fff');
  if (tl.length && tl[tl.length - 1].state === 'dead') {
    const i = tl.length - 1;
    ctx.fillStyle = col('--crit');
    ctx.fillRect(x(i) - 1, lineTop, 2, lineH);
  }
  if (compact) return;
  // Axes.
  ctx.fillStyle = col('--ink-dim');
  ctx.font = `500 10.5px ${col('--font-mono')}`;
  ctx.textAlign = 'right';
  ctx.fillText('100%', L - 6, yB(1) + 4);
  ctx.fillText('0%', L - 6, yB(0) + 4);
  ctx.fillText('+130°', L - 6, lineTop + 14);
  ctx.fillText('−200°', L - 6, yB(0) - 6);
  ['SUN', 'EARTH', 'ROVER'].forEach((t, row) => ctx.fillText(t, L - 6, bandY + row * (bandH + 3) + 10));
  ctx.textAlign = 'center';
  const days = result.nominal.days, every = days > 20 ? 5 : days > 10 ? 2 : 1;
  for (let d = 0; d <= days; d += every) ctx.fillText(d ? `D${d}` : 'Land', Math.min(L + w - 12, x((d * 24 * 60) / result.nominal.stepMin)), H - 4);
  // Playback cursor.
  if (Number.isFinite(cursor)) {
    ctx.fillStyle = col('--ink');
    ctx.fillRect(x(cursor) - 0.5, lineTop, 1.5, bandY + 3 * (bandH + 3) - lineTop);
  }
}

// Try other landing dates, a bigger battery and a planned route, and report what helps.
async function findImprovements(res) {
  const box = () => $('improve');
  const tips = [];
  const base = res.args;
  const rate = res.mc.rate;
  const quick = (args) => monteCarlo(args, { runs: 20, slipDays: res.slip, seed: 11 });
  // Landing date: screen with the planned run, confirm the best two with 20 runs.
  const shifts = [-6, -4, -2, 2, 4, 6, 8, 10, 12, 14];
  const screened = [];
  for (const s of shifts) {
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
  // Bigger battery, if batteries are what failed.
  if (res.mc.causes.battery?.length) {
    const mc = await quick({ ...base, rover: { ...base.rover, batteryWh: base.rover.batteryWh * 1.5 } });
    if (state.result !== res) return;
    tips.push({ text: `A <b>50% bigger battery</b> (${Math.round(base.rover.batteryWh * 1.5)} Wh): ${mc.successes} of ${mc.runs} runs succeed.`, act: 'Use it', run: () => { state.rover.batteryWh = Math.round(base.rover.batteryWh * 1.5); state.roverId = 'custom'; state.rover.name = 'Custom rover'; syncRoverForm(); runSimulation(); } });
    const rhu = Math.round(base.rover.heatWperK * 60);
    const mc2 = await quick({ ...base, rover: { ...base.rover, rhuW: (base.rover.rhuW ?? 0) + rhu } });
    if (state.result !== res) return;
    tips.push({ text: `<b>Radioisotope heaters</b> worth ${rhu} W to keep warm in shadow: ${mc2.successes} of ${mc2.runs} runs succeed.`, act: 'Add them', run: () => { state.rover.rhuW = (state.rover.rhuW ?? 0) + rhu; state.roverId = 'custom'; state.rover.name = 'Custom rover'; syncRoverForm(); runSimulation(); } });
  }
  if (!res.planned && res.waypoints.length > 1 && rate < 0.95) {
    tips.push({ text: 'Let the planner find a route that <b>stays in sunlight</b> and avoids steep slopes, then simulate again.', act: 'Find route', run: async () => { await planSunniest(); runSimulation(); } });
  }
  if (res.mc.causes.time?.length) tips.push({ text: `Some runs ran out of time. A <b>longer mission</b> (${res.nominal.days + 7} days) would give the rover more time to wait for sunlight.`, act: 'Add 7 days', run: () => { state.days += 7; syncTiming(); runSimulation(); } });
  const el = box();
  if (!el || state.result !== res) return;
  el.innerHTML = tips.length
    ? `<ul>${tips.map((t, i) => `<li><span>${t.text}</span><button class="ghost" type="button" data-tip="${i}">${t.act}</button></li>`).join('')}</ul>`
    : '<p class="hint">Nothing we tried improved the odds noticeably. This plan is as good as these options get.</p>';
  el.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => tips[+b.dataset.tip].run()));
}

// ---------- playback ----------
let pbTimer = null;
state.pbIndex = 0;
function setupPlayback() {
  const tl = state.result.nominal.timeline;
  $('playback').hidden = false;
  $('readout').hidden = true;
  $('pbSlider').max = tl.length - 1;
  seek(0);
}
function seek(i) {
  const res = state.result;
  if (!res) return;
  const tl = res.nominal.timeline;
  i = Math.max(0, Math.min(tl.length - 1, i));
  state.pbIndex = i;
  const r = tl[i];
  $('pbSlider').value = i;
  const ll = xyToLatLon(r.x, r.y);
  globe.setRover({ ...ll, h: r.h });
  setTime(new Date(r.t));
  const label = res.nominal.states[r.state] ?? r.state;
  $('pbText').textContent = `${dayStamp(r.t, res.nominal.start.getTime())} · ${label} · battery ${Math.round(r.soc * 100)}% · ground ${Math.round(r.tSurfC)} °C · ${(r.d / 1000).toFixed(1)} km`;
  drawChart();
}
function play(on) {
  clearInterval(pbTimer); pbTimer = null;
  $('pbPlay').textContent = on ? '❚❚' : '▶';
  $('pbPlay').setAttribute('aria-label', on ? 'Pause' : 'Play the mission');
  if (!on) return;
  pbTimer = setInterval(() => {
    const tl = state.result.nominal.timeline;
    if (state.pbIndex >= tl.length - 1) { play(false); return; }
    seek(state.pbIndex + 2);
  }, 60);
}
$('pbSlider').addEventListener('input', (e) => { play(false); seek(+e.target.value); });
$('pbPlay').addEventListener('click', () => play(!pbTimer));

// ---------- readout ----------
function updateReadout() {
  if (!terrain || !state.waypoints.length || !$('playback').hidden) return;
  const w = state.waypoints[0];
  const env = environment(terrain, ephemeris(15 * 60 * 1000), w.x, w.y, terrain.height(w.x, w.y), state.time.getTime());
  $('roSun').textContent = `Sun ${env.sunVis > 0.5 ? 'up' : 'hidden'} ${(env.sun.el - env.sunHz).toFixed(1)}° over skyline`;
  $('roEarth').textContent = `Earth ${env.earthVis ? 'in view' : 'hidden'}`;
}

// ---------- panels ----------
const panels = ['setup', 'report', 'stand', 'compare'];
function openPanel(id) {
  if (id === 'report' && window.innerWidth < 1600) closePanel('setup');
  if (id === 'setup' && window.innerWidth < 1600) closePanel('report');
  $(id).hidden = false;
  if (id === 'setup') $('menuBtn').setAttribute('aria-expanded', 'true');
  document.body.classList.toggle('report-open', !$('report').hidden);
  document.body.classList.toggle('setup-open', !$('setup').hidden);
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
  if (e.key !== 'Escape') return;
  if (state.drawing) { setDrawing(false); return; }
  const top = [...panels].reverse().find((p) => !$(p).hidden);
  if (top) closePanel(top);
  $('timePanel').hidden = true;
});
$('menuBtn').addEventListener('click', () => ($('setup').hidden ? openPanel('setup') : closePanel('setup')));
$('siteChip').addEventListener('click', () => openPanel('setup'));

// ---------- search ----------
const search = $('search');
const results = $('results');
let active = 0;
function renderResults() {
  const q = search.value.trim().toLowerCase();
  const items = [];
  const c = parseCoords(search.value);
  if (c) items.push({ id: null, name: 'Go to coordinates', lat: c.lat, lon: c.lon });
  for (const s of SITES) if (!q || s.name.toLowerCase().includes(q)) items.push(s);
  results.textContent = '';
  items.forEach((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = s.name;
    li.lastChild.textContent = `${fmtLat(s.lat)} ${fmtLon(s.lon)}`;
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
  if (s.id) setStartSite(s); else globe.flyToPoint(s.lat, s.lon);
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

// ---------- stand where the rover is ----------
const pano = new Panorama($('pano'));
let standTimer = null;
function openStand() {
  if (!terrain || !state.waypoints.length) { toast('Pick a landing site first.'); return; }
  const res = state.result;
  const r = res ? res.nominal.timeline[state.pbIndex] : null;
  const p = r ? { x: r.x, y: r.y, h: r.h } : { ...state.waypoints[0], h: terrain.height(state.waypoints[0].x, state.waypoints[0].y) };
  const horizon = [];
  for (let az = 0; az < 360; az += 1) horizon.push(terrain.horizon(p.x, p.y, az, p.h + 1.5));
  const ll = xyToLatLon(p.x, p.y);
  openPanel('stand');
  $('standSite').textContent = `Rover position ${fmtLat(ll.lat)} ${fmtLon(ll.lon)} · skyline from NASA LOLA terrain · vertical scale ×${pano.vScale}`;
  $('standNote').textContent = res ? 'Slider follows the simulated mission.' : 'Run a simulation to follow the rover through the mission.';
  const tl = res ? res.nominal.timeline : null;
  pano.set({ horizon, track: tl ? tl.filter((_, i) => i % 4 === 0).map((q) => ({ sunAz: q.sunAz, sunEl: q.sunEl, earthAz: q.earthAz, earthEl: q.earthEl })) : [] });
  const slider = $('standSlider');
  slider.max = tl ? tl.length - 1 : 0;
  setStandIdx(r ? state.pbIndex : 0, p);
  pano.lookAt(pano.state?.sun.az ?? 180);
}
function setStandIdx(i, fixed) {
  const res = state.result;
  const tl = res?.nominal.timeline;
  const r = tl ? tl[i] : null;
  const t = r ? r.t : state.time.getTime();
  const p = r ? { x: r.x, y: r.y, h: r.h } : fixed;
  const eph = ephemeris(15 * 60 * 1000);
  const env = environment(terrain, eph, p.x, p.y, p.h, t);
  // Earth's phase seen from the Moon: share of its disc that is lit.
  const v = eph(t);
  const lit = (1 + (v.sun.x * v.earth.x + v.sun.y * v.earth.y + v.sun.z * v.earth.z)) / 2;
  pano.set({ state: { sun: env.sun, earth: env.earth, sunlit: env.sunVis > 0.5, earthVisible: env.earthVis, earthLit: lit } });
  $('standSlider').value = i;
  $('standTime').textContent = r ? dayStamp(t, res.nominal.start.getTime()) : fmtDateTime(new Date(t));
  $('standReadout').innerHTML = `<span class="sun-dot"></span>Sun ${env.sun.el.toFixed(2)}° at az ${env.sun.az.toFixed(0)}° · ${env.sunVis > 0.5 ? 'above skyline' : 'behind skyline'}
    <span class="earth-dot"></span>Earth ${env.earth.el.toFixed(2)}° · ${env.earthVis ? 'in view' : 'hidden'} · ground ${Math.round(env.teq - 273.15)} °C`;
  if (r) { state.pbIndex = i; seek(i); }
}
$('standSlider').addEventListener('input', (e) => setStandIdx(+e.target.value));
function stopStandPlay() { clearInterval(standTimer); standTimer = null; $('standPlay').textContent = '▶'; }
$('standPlay').addEventListener('click', () => {
  if (standTimer) return stopStandPlay();
  if (!state.result) return;
  $('standPlay').textContent = '❚❚';
  standTimer = setInterval(() => {
    const max = state.result.nominal.timeline.length - 1;
    setStandIdx(state.pbIndex >= max ? 0 : state.pbIndex + 2);
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
    card.querySelector('.chip-sub').textContent = `${res.waypoints.length > 1 ? fmtKm(res.nominal.routeLength) + ' route' : 'Stay at site'} · ${fmtDate(res.nominal.start)} · ${res.nominal.days} d`;
    grid.appendChild(card);
    drawChart(card.querySelector('canvas'), res, { compact: true, cursor: null });
    card.querySelector('[data-open]').addEventListener('click', () => { state.result = res; closePanel('compare'); renderReport(); openPanel('report'); setupPlayback(); });
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
  if (t === 'draw') { setDrawing(!state.drawing); if (state.drawing) openPanel('setup'); }
  if (t === 'map') toggleSunMap();
  if (t === 'sun') { setTool('sun', on); globe.setFullLight(!on); toast(on ? 'Real sunlight for the chosen date and time.' : 'Viewing light: terrain lit from the side so it is easy to see anywhere. Turn Sunlight back on for real lighting.'); }
  if (t === 'relief') { setTool('relief', on); globe.setRelief(on ? 5 : 1); $('reliefLabel').textContent = on ? 'Relief ×5' : 'Relief ×1'; }
  if (t === 'fly') { const pts = state.route ? state.route.pts.map(toLL) : state.waypoints.map(toLL); if (pts.length) globe.frameRoute(pts); }
  if (t === 'home') globe.flyHome();
  if (t === 'stand') openStand();
  if (t === 'compare') openCompare();
}));

// ---------- time ----------
function setTime(d) {
  state.time = d;
  globe.setSunDirection(ephemeris(15 * 60 * 1000)(d.getTime()).sun);
  $('clock').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  $('dateStr').textContent = `${fmtDate(d)} UTC`;
  if (document.activeElement !== $('timeInput')) $('timeInput').value = toLocalInput(d);
  updateReadout();
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
  if (playing) setTime(new Date(state.time.getTime() + (now - last) * 20000));
  last = now;
};
globe.onNight = () => toast('It is night here at the chosen time. Tap Sunlight to switch to a viewing light, or change the time.');

// ---------- start ----------
if (window.innerWidth < 900) closePanel('setup'); else openPanel('setup');
syncRoverForm();
syncTiming();
fStart.value = state.startSite.id;
setTime(state.start);
routeChanged().then(() => {
  // Open on the example route so the first view shows what the simulator is for.
  globe.frameRoute(state.route.pts.map(toLL));
});
