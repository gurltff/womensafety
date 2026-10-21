import './styles.css';
import { Globe } from './globe.js';
import { Panorama } from './panorama.js';
import { SITES, PLACES, parseCoords } from './sites.js';
import { Terrain, distance, bearing } from './terrain.js';
import { prepareRoute, routeHazards, pointAt, ephemeris, environment, simulate, monteCarlo } from './sim.js';
import { sunlightMap, planRoute, boxAround } from './planner.js';
import { ROVERS, ROVER_FIELDS } from './rovers.js';
import { MODELS } from './models.js';
import { RoverStage, thumbnail } from './preview.js';

const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_LEG_M = 200000;
const ALL_PLACES = [...SITES.map((s) => ({ ...s, group: 'South pole landing sites' })), ...PLACES.map((p) => ({ ...p, group: 'Famous places' }))];
const EXAMPLE = { name: 'Shackleton rim', waypoints: [{ lat: SITES[0].lat, lon: SITES[0].lon }, { lat: -89.691, lon: -141.26 }] };

const state = {
  mode: 'plan',
  rover: { ...ROVERS[1] },
  roverId: ROVERS[1].id,
  modelId: ROVERS[1].id, // which 3D model to show: the last preset chosen
  waypoints: [],
  landingName: '',
  start: new Date(Date.UTC(2026, 10, 20)),
  days: 14,
  slip: 2,
  runs: 50,
  mustSurvive: true,
  route: null,
  hazards: [],
  planned: false,
  result: null,
  stale: false,
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
const fmtDur = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : h >= 1 ? `${Math.round(h)} h` : `${Math.round(h * 60)} min`);
const dayStamp = (t, t0) => `Day ${Math.floor((t - t0) / DAY) + 1} · ${pad(new Date(t).getUTCHours())}:${pad(new Date(t).getUTCMinutes())}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tick = () => new Promise((r) => setTimeout(r, 0));
const DEG = Math.PI / 180;
const eph15 = ephemeris(15 * 60 * 1000);
const llDir = (p) => ({ x: Math.cos(p.lat * DEG) * Math.cos(p.lon * DEG), y: Math.sin(p.lat * DEG), z: -Math.cos(p.lat * DEG) * Math.sin(p.lon * DEG) });

function toast(text, ms = 3800) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// Hurdle and event types: icon, title, level.
const TYPES = {
  land: ['🛬', 'Touchdown', 'info'],
  night: ['🌑', 'Lunar night', 'warning'],
  shadow: ['🌘', 'Terrain shadow', 'warning'],
  comms: ['📡', 'Earth out of view', 'warning'],
  heat: ['🔥', 'Too hot to drive', 'warning'],
  wait: ['⏳', 'Waiting for sunlight ahead', 'warning'],
  slope: ['📐', 'Steep slope', 'warning'],
  wall: ['⛔', 'Slope too steep', 'critical'],
  slip: ['🛞', 'Wheel slip', 'warning'],
  crater: ['🕳️', 'Crater crossing', 'warning'],
  climb: ['⛰️', 'Long climb', 'info'],
  battery: ['🔋', 'Battery low', 'warning'],
  cold: ['❄️', 'Heaters on', 'warning'],
  dead: ['✖', 'Rover lost', 'critical'],
  arrive: ['🏁', 'Destination reached', 'ok'],
  info: ['•', 'Update', 'info'],
};
const typeOf = (k) => TYPES[k] ?? TYPES.info;

const STATE_INFO = {
  drive: ['Driving', '--ok'],
  retreat: ['Back to sunlight', '--teal'],
  charge: ['Charging', '--sun'],
  park: ['Parked', '--ink-dim'],
  hibernate: ['Hibernating', '--violet'],
  done: ['Arrived', '--earth'],
  dead: ['Lost', '--crit'],
};
const stateColour = (k) => cssVar(STATE_INFO[k]?.[1] ?? '--crit');

// ---------- globe and terrain ----------
const globe = new Globe($('globe'), $('labels'));
window.lunaview = { globe, state };
// (replay, seek and setPlaying are added below for testing from the console)
globe.setSites(ALL_PLACES, null);

let terrain = null;
const terrainReady = new Promise((resolve) => {
  const check = () => {
    if (globe.terrain?.sim && globe.polarH && globe.globalH) {
      terrain = new Terrain(globe.terrain, (lat, lon) => globe.coarseHeight(lat, lon));
      resolve(terrain);
    } else setTimeout(check, 150);
  };
  check();
});

globe.onPick = (site) => handleGroundClick(site.lat, site.lon, site.name);
globe.onSurfaceClick = ({ lat, lon }) => handleGroundClick(lat, lon);

// ============ 1. PLAN ============

function handleGroundClick(lat, lon, name) {
  if (state.mode !== 'plan') return;
  const p = { lat, lon };
  if (!state.waypoints.length) { setLanding(p, name ?? `Landing at ${fmtLL(p)}`); return; }
  const last = state.waypoints[state.waypoints.length - 1];
  const leg = distance(last, p);
  if (leg > MAX_LEG_M) {
    if (name) { setLanding(p, name); return; }
    toast(`That point is ${fmtKm(leg)} from the last one, too far for a rover in one go. Click closer, or press "New landing site" to start somewhere else.`);
    return;
  }
  state.waypoints.push(p);
  state.planned = false;
  routeChanged();
}

function setLanding(p, name) {
  state.landingName = name;
  state.waypoints = [{ lat: p.lat, lon: p.lon }];
  state.planned = false;
  const known = ALL_PLACES.find((x) => Math.abs(x.lat - p.lat) < 1e-6 && Math.abs(x.lon - p.lon) < 1e-6);
  $('fStart').value = known ? known.id : '';
  globe.select(known?.id ?? null);
  routeChanged();
  globe.flyToPoint(p.lat, p.lon);
}

let routeJob = 0;
async function routeChanged() {
  const job = ++routeJob;
  markStale();
  renderWaypoints();
  renderInstructions();
  await terrainReady;
  if (state.waypoints.length) await terrain.loadAround(state.waypoints, 30000);
  if (job !== routeJob) return;
  state.route = state.waypoints.length ? prepareRoute(terrain, state.waypoints) : null;
  state.hazards = state.route && state.waypoints.length > 1 ? routeHazards(state.route, state.rover) : [];
  drawRoute();
  renderRouteStats();
  renderHazards();
  drawProfile();
  // Just landed somewhere dark at the landing time: say so, since the real lighting shows it black.
  if (state.waypoints.length === 1 && state.mode === 'plan') {
    const w = state.waypoints[0];
    const env = environment(terrain, eph15, w.lat, w.lon, terrain.height(w.lat, w.lon), state.start.getTime());
    if (env.sunVis < 0.5) toast(`At the landing time the Sun is ${env.sun.el < 0 ? 'below the horizon (lunar night)' : 'hidden behind the terrain'} here, so the ground looks black. Press ☀ on the right for an even viewing light, or change the landing date.`, 7000);
  }
}

function slopeColour(slope, limit) {
  if (slope > limit) return [1, 0.42, 0.37];
  if (slope > limit * 0.6) return [0.95, 0.66, 0.31];
  return [0.37, 0.83, 0.6];
}

function drawRoute() {
  const r = state.route;
  if (!r) { globe.setRoute(null); globe.setWaypoints([]); globe.setMarkers(null); return; }
  globe.setRoute(r.pts.map((p) => ({ lat: p.lat, lon: p.lon, h: p.h, color: slopeColour(p.slope, state.rover.maxSlopeDeg) })));
  globe.setWaypoints(state.waypoints.map((w, i) => ({
    ...w, h: 0, kind: i === 0 ? 'start' : i === state.waypoints.length - 1 ? 'end' : 'via',
  })));
  if (state.mode === 'plan') {
    globe.setMarkers(state.hazards.map((h) => ({ lat: h.lat, lon: h.lon, icon: typeOf(h.type)[0], level: typeOf(h.type)[2], title: typeOf(h.type)[1] })));
  }
}

function renderInstructions() {
  const n = state.waypoints.length;
  $('routeInstr').innerHTML = !n
    ? '<b>Click anywhere on the Moon</b> to set the landing site, pick a known place below, or <a href="#" id="exampleLink">load an example route</a>.'
    : n === 1
      ? `Landing at <b>${esc(state.landingName)}</b>. Now <b>click the ground</b> to add waypoints; the rover drives through them in order.`
      : 'Keep clicking to extend the route, or remove points below. Ready? Press <b>Launch simulation</b>.';
  $('exampleLink')?.addEventListener('click', (e) => { e.preventDefault(); loadExample(); });
  $('mapHint').innerHTML = state.mode !== 'plan' ? ''
    : `<b>Click</b> ${n ? 'to add a waypoint' : 'to land'} · Drag to move · Right-drag to tilt · Scroll to zoom`;
  $('launchBtn').disabled = !n;
  $('launchHint').textContent = !n ? 'Set a landing site first.' : n === 1 ? 'No route yet: the simulation checks whether the rover survives where it lands.' : '';
}

function loadExample() {
  state.waypoints = EXAMPLE.waypoints.map((w) => ({ ...w }));
  state.landingName = EXAMPLE.name;
  $('fStart').value = SITES[0].id;
  routeChanged().then(() => globe.frameRoute(state.route.pts));
}

function renderWaypoints() {
  const ol = $('wpList');
  ol.textContent = '';
  state.waypoints.forEach((w, i) => {
    const li = document.createElement('li');
    const last = i === state.waypoints.length - 1 && i > 0;
    li.className = last ? 'end' : '';
    const leg = i ? distance(state.waypoints[i - 1], w) : 0;
    li.innerHTML = `<span class="wp-n">${i === 0 ? '▼' : last ? '⚑' : i}</span>
      <span class="wp-name"></span><span class="wp-leg">${i ? `+${fmtKm(leg)}` : ''}</span>
      ${i ? '<button type="button" class="wp-x" aria-label="Remove point">×</button>' : '<span></span>'}`;
    const nm = li.querySelector('.wp-name');
    nm.textContent = i === 0 ? state.landingName || 'Landing' : last ? 'Destination' : `Waypoint ${i}`;
    const sm = document.createElement('small');
    sm.textContent = fmtLL(w);
    nm.appendChild(sm);
    li.querySelector('.wp-x')?.addEventListener('click', () => { state.waypoints.splice(i, 1); state.planned = false; routeChanged(); });
    ol.appendChild(li);
  });
  $('undoBtn').disabled = state.waypoints.length < 2;
  $('clearBtn').disabled = state.waypoints.length < 2;
  $('planBtn').disabled = state.waypoints.length < 2;
}

function renderRouteStats() {
  const r = state.route, el = $('routeStats');
  if (!r || state.waypoints.length < 2) { el.innerHTML = ''; return; }
  const lim = state.rover.maxSlopeDeg, steep = r.steepest.slope;
  const driveH = r.length / state.rover.speedMh;
  const res = r.coarsest;
  const hs = r.pts.map((p) => p.h);
  el.innerHTML = `
    <div class="stat"><span>Length</span><b>${fmtKm(r.length)}</b></div>
    <div class="stat"><span>Drive time</span><b>~${fmtDur(driveH)}</b></div>
    <div class="stat"><span>Steepest</span><b class="${steep > lim ? 't-bad' : steep > lim * 0.6 ? 't-warn' : 't-ok'}">${steep.toFixed(0)}°</b></div>
    <div class="stat"><span>Climb</span><b>${Math.round(r.climb)} m</b></div>
    <div class="stat"><span>Height range</span><b>${Math.round(Math.max(...hs) - Math.min(...hs))} m</b></div>
    <div class="stat"><span>Terrain data</span><b>${res <= 100 ? '80 m' : `~${Math.round(res / 50) * 50} m`}</b></div>
    <p class="route-note">${state.planned ? 'Route re-planned to stay in sunlight. ' : ''}Line colour shows slope against the rover's ${lim}° limit: green easy, orange steep, red too steep.${res > 100 ? ' Away from the south pole, NASA LOLA terrain is ~950 m per sample, so small craters and boulders are smoothed out.' : ''}</p>`;
}

function renderHazards() {
  const box = $('hazardBox'), ul = $('hazardList');
  box.hidden = !state.hazards.length;
  ul.textContent = '';
  for (const h of state.hazards) {
    const [ico, , level] = typeOf(h.type);
    const li = document.createElement('li');
    li.className = level;
    li.innerHTML = `<span class="hz-i">${ico}</span><span></span>`;
    li.lastChild.textContent = h.text;
    li.title = 'Show on the Moon';
    li.addEventListener('click', () => flyToLL(h, 0.004));
    ul.appendChild(li);
  }
}
function flyToLL(p, dist) {
  const d = llDir(p);
  globe.cam.flyTo({ target: globe.camera.position.clone().set(d.x, d.y, d.z), dist, tilt: 55 * DEG });
}

// Elevation profile with slope colours and hazards.
function drawProfile() {
  const r = state.route;
  const show = state.mode === 'plan' && r && state.waypoints.length > 1;
  $('profile').hidden = !show;
  if (!show) return;
  const c = $('profileCanvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) { requestAnimationFrame(drawProfile); return; }
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const hs = r.pts.map((p) => p.h), lo = Math.min(...hs), hi = Math.max(...hs), span = Math.max(20, hi - lo);
  const L = 48, R = 8, T = 16, B = 16;
  const x = (d) => L + (d / r.length) * (W - L - R);
  const y = (h) => T + (1 - (h - lo) / span) * (H - T - B);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(95,211,154,0.10)';
  ctx.beginPath(); ctx.moveTo(x(0), H - B);
  r.pts.forEach((p) => ctx.lineTo(x(p.d), y(p.h)));
  ctx.lineTo(x(r.length), H - B); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 2.5;
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i];
    const col = slopeColour(Math.max(a.slope, b.slope), state.rover.maxSlopeDeg).map((v) => Math.round(v * 255));
    ctx.strokeStyle = `rgb(${col})`;
    ctx.beginPath(); ctx.moveTo(x(a.d), y(a.h)); ctx.lineTo(x(b.d), y(b.h)); ctx.stroke();
  }
  ctx.font = `500 10px ${cssVar('--font-mono')}`;
  ctx.fillStyle = cssVar('--ink-dim');
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(hi)} m`, L - 6, T + 4);
  ctx.fillText(`${Math.round(lo)} m`, L - 6, H - B);
  ctx.textAlign = 'center';
  const stepKm = r.length > 40000 ? 10 : r.length > 20000 ? 5 : r.length > 8000 ? 2 : r.length > 3000 ? 1 : 0.5;
  for (let k = 0; k * stepKm * 1000 <= r.length; k++) ctx.fillText(`${k * stepKm} km`, Math.min(W - 20, x(k * stepKm * 1000)), H - 3);
  let d = 0;
  state.waypoints.forEach((w, i) => {
    if (i) d += distance(state.waypoints[i - 1], w);
    ctx.fillStyle = i === 0 ? cssVar('--sun') : cssVar('--ink');
    ctx.fillRect(x(d) - 1, T - 6, 2, H - B - T + 6);
  });
  ctx.font = '13px sans-serif';
  for (const h of state.hazards) {
    const p = pointAt(r, h.d0);
    ctx.fillText(typeOf(h.type)[0], x(h.d0), Math.max(12, y(p.h) - 6));
  }
  $('profileText').textContent = `${fmtKm(r.length)} · climb ${Math.round(r.climb)} m · ${state.hazards.length ? `${state.hazards.length} hazard${state.hazards.length > 1 ? 's' : ''} spotted` : 'no terrain hazards spotted'}`;
}
window.addEventListener('resize', () => { drawProfile(); drawStrip(); });

// ---------- route tools: planner and sunlight map ----------
async function computeSunMap(a, b, label) {
  const len = distance(a, b);
  const margin = Math.max(2500, len * 0.35);
  const span = len + 2 * margin;
  const cell = Math.max(terrain.resolution(a.lat, a.lon) ?? 1000, Math.ceil(span / 55 / 40) * 40);
  const box = boxAround(a, b, margin, cell);
  await terrain.loadAround([a, b, box.centre], span);
  return sunlightMap(terrain, ephemeris(HOUR), box, state.start, state.days, {
    onProgress: (f) => { $('launchHint').textContent = `${label}: ${Math.round(f * 100)}%`; },
  });
}

function showSunMap(map) {
  globe.setOverlay(map.ll.map((p, k) => ({ ...p, h: map.h[k], lit: map.lit[k] })), map.cell);
  setToolOn('map', true);
}

async function planSunniest() {
  if (state.waypoints.length < 2) return;
  await terrainReady;
  $('planBtn').disabled = true;
  try {
    const out = [state.waypoints[0]];
    for (let i = 1; i < state.waypoints.length; i++) {
      const a = state.waypoints[i - 1], b = state.waypoints[i];
      const map = await computeSunMap(a, b, `Mapping sunlight for leg ${i}`);
      showSunMap(map);
      const leg = planRoute(map, a, b, { maxSlope: state.rover.maxSlopeDeg - 1 });
      if (!leg) { toast(`No safe path for leg ${i}: slopes over ${state.rover.maxSlopeDeg}° block every way.`); return; }
      out.push(...leg.slice(1));
    }
    state.waypoints = out;
    state.planned = true;
    $('launchHint').textContent = 'Route re-planned to stay in sunlight and avoid steep slopes.';
    await routeChanged();
  } finally {
    $('planBtn').disabled = state.waypoints.length < 2;
  }
}

async function toggleSunMap() {
  if (globe.overlay) { globe.setOverlay(null); setToolOn('map', false); return; }
  if (!state.waypoints.length) { toast('Set a landing site first.'); return; }
  await terrainReady;
  const a = state.waypoints[0], b = state.waypoints[state.waypoints.length - 1];
  showSunMap(await computeSunMap(a, b, 'Mapping sunlight'));
  $('launchHint').textContent = 'Sunlight map: yellow is sunlit most of the mission, dark blue mostly in shadow.';
}

$('undoBtn').addEventListener('click', () => { if (state.waypoints.length > 1) { state.waypoints.pop(); state.planned = false; routeChanged(); } });
$('clearBtn').addEventListener('click', () => { state.waypoints = state.waypoints.slice(0, 1); state.planned = false; routeChanged(); });
$('newLandBtn').addEventListener('click', () => { state.waypoints = []; state.landingName = ''; state.planned = false; globe.select(null); routeChanged(); toast('Click the Moon where the rover should land.'); });
$('planBtn').addEventListener('click', planSunniest);

const fStart = $('fStart');
fStart.add(new Option('Land at a known place…', ''));
for (const group of ['South pole landing sites', 'Famous places']) {
  const og = document.createElement('optgroup');
  og.label = group;
  for (const p of ALL_PLACES.filter((x) => x.group === group)) og.appendChild(new Option(p.name, p.id));
  fStart.appendChild(og);
}
fStart.addEventListener('change', () => { const p = ALL_PLACES.find((x) => x.id === fStart.value); if (p) setLanding(p, p.name); });

// ---------- rover ----------
// Pictures of the 3D models, rendered once in the browser.
const thumbs = {};
const thumbReady = Promise.all(ROVERS.map(async (r) => {
  try { thumbs[r.id] = await thumbnail(r.id); } catch { thumbs[r.id] = ''; }
}));
const CLASS = { micro: ['Micro', 'CLPS payload class, ~1 m'], mid: ['Mid-size', 'Science rover, ~2 m'], large: ['Large', 'Flagship class, ~3 m'] };
const roverCards = $('roverCards');
ROVERS.forEach((r, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rover-card';
  b.setAttribute('role', 'radio');
  b.dataset.id = r.id;
  b.innerHTML = `<img alt=""><b>${CLASS[r.id][0]}</b><small>${r.massKg} kg · ${r.batteryWh} Wh</small>`;
  thumbReady.then(() => { b.querySelector('img').src = thumbs[r.id]; });
  b.addEventListener('click', () => { state.rover = { ...r }; state.roverId = r.id; state.modelId = r.id; syncRoverForm(); markStale(); routeChanged(); });
  roverCards.appendChild(b);
});
const specGrid = $('specGrid');
for (const [key, label, unit, step] of ROVER_FIELDS) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<label for="r_${key}"></label><div class="unit"><input id="r_${key}" type="number" step="${step}" inputmode="decimal"><span></span></div>`;
  wrap.querySelector('label').textContent = label;
  wrap.querySelector('span').textContent = unit;
  wrap.querySelector('input').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) { state.rover[key] = v; makeCustom(); markStale(); if (key === 'maxSlopeDeg' || key === 'speedMh') routeChanged(); }
  });
  specGrid.appendChild(wrap);
}
function makeCustom() { state.roverId = 'custom'; state.rover.name = 'Custom rover'; syncRoverCards(); syncRoverStage(); }
function syncRoverCards() { for (const b of roverCards.children) b.setAttribute('aria-checked', String(b.dataset.id === state.roverId)); }
const roverStage = new RoverStage($('roverStage'));
function syncRoverStage() {
  roverStage.show(state.modelId);
  globe.setRoverModel(state.modelId);
  const r = state.rover;
  $('rsName').textContent = state.roverId === 'custom' ? 'Custom rover' : `${CLASS[state.modelId][0]} rover`;
  $('rsClass').textContent = state.roverId === 'custom' ? `Your specifications, shown as the ${CLASS[state.modelId][0].toLowerCase()} model` : CLASS[state.modelId][1];
  $('rsChips').innerHTML = [['Mass', `${r.massKg} kg`], ['Battery', `${r.batteryWh} Wh`], ['Solar', `${r.solarW} W`], ['Speed', `${r.speedMh} m/h`], ['Slope', `${r.maxSlopeDeg}°`]]
    .map(([k, v]) => `<span><i>${k}</i>${v}</span>`).join('');
}
function syncRoverForm() {
  syncRoverCards();
  syncRoverStage();
  for (const [key] of ROVER_FIELDS) $(`r_${key}`).value = state.rover[key];
  $('fPanel').value = state.rover.panel;
  $('fComms').checked = !!state.rover.needsComms;
}
$('fPanel').addEventListener('change', (e) => { state.rover.panel = e.target.value; makeCustom(); markStale(); });
$('fComms').addEventListener('change', (e) => { state.rover.needsComms = e.target.checked; makeCustom(); markStale(); });

// ---------- mission window ----------
function syncTiming() {
  $('fDate').value = toLocalInput(state.start);
  $('fDays').value = state.days;
  $('fSlip').value = state.slip;
  $('fRuns').value = String(state.runs);
  $('fSurvive').checked = state.mustSurvive;
  $('windowHint').textContent = 'The globe shows the real sunlight at landing time. A lunar day lasts 29.5 Earth days: about two weeks of sunlight, then two weeks of night (polar ridges can stay lit much longer).';
}
$('fDate').addEventListener('change', (e) => { const d = fromLocalInput(e.target.value); if (d) { state.start = d; setTime(d); markStale(); } });
$('fDays').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 60) { state.days = v; markStale(); } });
$('fSlip').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v >= 0 && v <= 10) { state.slip = v; markStale(); } });
$('fRuns').addEventListener('change', (e) => { state.runs = parseInt(e.target.value, 10); });
$('fSurvive').addEventListener('change', (e) => { state.mustSurvive = e.target.checked; markStale(); });

function markStale() { if (state.result) state.stale = true; }

// ============ modes ============
function setMode(mode) {
  if (mode !== 'plan' && !state.result) return;
  state.mode = mode;
  $('app').dataset.mode = mode;
  document.querySelectorAll('[data-goto]').forEach((b) => {
    b.disabled = b.dataset.goto !== 'plan' && !state.result;
    if (b.dataset.goto === mode) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  const run = mode === 'run';
  $('telemetry').hidden = $('feed').hidden = $('runbar').hidden = !run;
  $('debrief').hidden = mode !== 'debrief';
  if (!run) { $('banner').hidden = true; setPlaying(false); }
  if (mode === 'plan') {
    globe.setRover(null);
    globe.setTrail(null);
    globe.setFollow('off');
    drawRoute();
    renderInstructions();
    drawProfile();
    setTime(state.start);
  }
  if (run) startRun();
  if (mode === 'debrief') { globe.setFollow('off'); $('debrief').scrollTop = 0; }
}
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.goto === 'debrief') renderDebrief();
  setMode(b.dataset.goto);
}));

// ============ launch: simulate the mission ============
const COMP_STEPS = ['Loading NASA terrain around the route', 'Tracing skylines and sunlight along the route', 'Simulating the planned mission', 'Running variations with realistic uncertainty', 'Finding the hurdles'];
function compStep(i, text, f) {
  $('compSteps').innerHTML = COMP_STEPS.map((s, k) => `<li class="${k < i ? 'done' : k === i ? 'active' : ''}">${esc(s)}</li>`).join('');
  if (text) $('compText').textContent = text;
  $('compBar').style.width = `${Math.round((f ?? i / COMP_STEPS.length) * 100)}%`;
}

let simJob = 0;
async function launch() {
  if (!state.waypoints.length) { toast('Set a landing site first: click the Moon.'); return; }
  const job = ++simJob;
  $('computing').hidden = false;
  $('launchBtn').disabled = true;
  try {
    compStep(0, 'Loading terrain…', 0.03);
    await terrainReady;
    await routeChanged();
    const r = state.route;
    await terrain.loadAround([r.pts[0], r.pts[Math.floor(r.pts.length / 2)], r.pts[r.pts.length - 1]], 150000);
    compStep(1, `${fmtKm(r.length)} route, ${r.pts.length} terrain samples`, 0.12);
    await tick();
    const args = { terrain, eph: ephemeris(15 * 60 * 1000), rover: { ...state.rover }, route: r, start: state.start, days: state.days, mustSurvive: state.mustSurvive };
    compStep(2, `${state.rover.name}, ${state.days} days from ${fmtDateTime(state.start)}`, 0.2);
    await tick();
    const nominal = simulate(args);
    compStep(3, `0 of ${state.runs} variations`, 0.35);
    const mc = await monteCarlo(args, {
      runs: state.runs, slipDays: state.slip,
      onProgress: (f) => compStep(3, `${Math.round(f * state.runs)} of ${state.runs} variations: landing time ±${state.slip} days, panel output, battery health, wheel slip, heat loss`, 0.35 + f * 0.6),
    });
    if (job !== simJob) return;
    compStep(4, `${nominal.hurdles.length} hurdles in the planned run`, 1);
    await new Promise((res) => setTimeout(res, 350));
    state.result = { nominal, mc, args, rover: { ...state.rover }, modelId: state.modelId, waypoints: state.waypoints.slice(), landingName: state.landingName, planned: state.planned, slip: state.slip, tips: null };
    state.stale = false;
    replay.t = 0;
    replay.ended = false;
    setMode('run');
    findImprovements(state.result);
  } catch (err) {
    console.error(err);
    toast(`Simulation failed: ${err.message}`);
  } finally {
    $('computing').hidden = true;
    $('launchBtn').disabled = !state.waypoints.length;
  }
}
$('launchBtn').addEventListener('click', launch);

// ============ 2. RUN: the rover drives the mission ============
const replay = {
  t: 0, playing: false, mult: 4, lastFrame: 0, lastUi: 0, lastTrail: 0, heading: 0, odometer: 0,
  shown: new Set(), markers: [], ended: false, cam: 'chase', holdUntil: 0,
  duration() { const n = state.result?.nominal; return n ? (n.timeline.length - 1) * n.stepMin * 60000 : 0; },
  // Mission time per real second while driving: the whole drive takes ~40 s to watch at 4x.
  driveRate() {
    const n = state.result.nominal;
    if (this.driveFor !== n) {
      this.driveFor = n;
      let moving = 0;
      for (let i = 1; i < n.timeline.length; i++) if (Math.abs(n.timeline[i].d - n.timeline[i - 1].d) > 0.5) moving++;
      this.driveMs = Math.max(HOUR / 6, (moving * n.stepMin * 60000) / 40);
    }
    return this.driveMs;
  },
};

function camDistance() {
  return state.result.args.route.coarsest <= 100 ? 1500 : 6000;
}

function startRun() {
  const n = state.result.nominal;
  globe.setRoverModel(state.result.modelId);
  $('tmImg').src = thumbs[state.result.modelId] ?? '';
  $('tmName').textContent = state.result.rover.name.split(' (')[0];
  $('tmWhere').textContent = state.result.landingName;
  globe.setRoute(state.result.args.route.pts.map((p) => ({ lat: p.lat, lon: p.lon, h: p.h, color: [0.75, 0.78, 0.85] })));
  globe.setOverlay(null);
  setToolOn('map', false);
  rebuildFeed();
  replayFrame(true);
  setCam(replay.cam);
  setPlaying(!replay.ended);
  $('feedCount').textContent = `${n.events.length} events`;
}

function setPlaying(on) {
  replay.playing = on;
  replay.lastFrame = performance.now();
  $('pbPlay').textContent = on ? '❚❚' : '▶';
  $('pbPlay').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on && replay.t >= replay.duration()) { replay.t = 0; replay.ended = false; rebuildFeed(); }
}
$('pbPlay').addEventListener('click', () => setPlaying(!replay.playing));
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
  replay.mult = +b.dataset.speed;
  document.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
function setCam(mode) {
  replay.cam = mode;
  document.querySelectorAll('[data-cam]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.cam === mode)));
  const d = camDistance();
  globe.setFollow(mode, mode === 'top' ? d * 2.5 : d);
}
document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)));
$('toDebrief').addEventListener('click', () => { renderDebrief(); setMode('debrief'); });
$('skyBtn').addEventListener('click', () => openStand());

// Mission state at replay time t, between the 15-minute steps.
function replayState(t) {
  const n = state.result.nominal, tl = n.timeline, stepMs = n.stepMin * 60000;
  const f = Math.max(0, Math.min(tl.length - 1, t / stepMs));
  const i = Math.min(Math.max(0, tl.length - 2), Math.floor(f)), k = tl.length > 1 ? f - i : 0;
  const a = tl[i], b = tl[Math.min(tl.length - 1, i + 1)];
  return { a, b, k, d: a.d + (b.d - a.d) * k, i, f, t: n.start.getTime() + t, live: k < 0.5 ? a : b };
}

function replayFrame(force) {
  const res = state.result;
  if (!res || state.mode !== 'run') return;
  const now = performance.now();
  const dur = replay.duration();
  if (replay.playing && now > replay.holdUntil) {
    const cur = replayState(replay.t);
    const driving = Math.abs(cur.b.d - cur.a.d) > 0.5;
    const rate = (driving ? replay.driveRate() : 12 * HOUR) * (replay.mult / 4);
    replay.t = Math.min(dur, replay.t + ((now - Math.max(replay.lastFrame, replay.holdUntil)) / 1000) * rate);
    if (replay.t >= dur) {
      setPlaying(false);
      if (!replay.ended) {
        replay.ended = true;
        setTimeout(() => { if (state.mode === 'run' && !replay.playing && replay.ended) { renderDebrief(); setMode('debrief'); } }, 2500);
      }
    }
  }
  replay.lastFrame = now;
  const s = replayState(replay.t);
  const route = res.args.route;
  const here = pointAt(route, s.d);
  const moving = s.b.d - s.a.d;
  if (Math.abs(moving) > 0.5) {
    const ahead = pointAt(route, s.d + Math.sign(moving) * 30);
    if (distance(here, ahead) > 1) replay.heading = bearing(here, ahead);
  }
  const lerpAng = (x, y, k) => x + ((((y - x) % 360) + 540) % 360 - 180) * k;
  const prevOdo = replay.odometer;
  replay.odometer = s.d;
  globe.setRover({
    lat: here.lat, lon: here.lon, h: here.h, heading: replay.heading,
    sunAz: lerpAng(s.a.sunAz, s.b.sunAz, s.k), colour: stateColour(s.live.state),
    odometer: prevOdo === s.d ? undefined : s.d,
  });
  if (force || now - replay.lastUi > 100) {
    replay.lastUi = now;
    setTime(new Date(s.t));
    updateTelemetry(s, here);
    drawStrip();
    passEvents(s.t);
  }
  if (force || now - replay.lastTrail > 250) {
    replay.lastTrail = now;
    let maxD = 0;
    for (let j = 0; j <= s.i && j < res.nominal.timeline.length; j++) maxD = Math.max(maxD, res.nominal.timeline[j].d);
    maxD = Math.max(maxD, s.d);
    const pts = route.pts.filter((p) => p.d <= maxD).map((p) => ({ lat: p.lat, lon: p.lon, h: p.h }));
    const tip = pointAt(route, maxD);
    pts.push({ lat: tip.lat, lon: tip.lon, h: tip.h });
    globe.setTrail(pts.length > 1 ? pts : null);
  }
}

function updateTelemetry(s, here) {
  const n = state.result.nominal, live = s.live;
  const soc = s.a.soc + (s.b.soc - s.a.soc) * s.k;
  const tempC = s.a.tSurfC + (s.b.tSurfC - s.a.tSurfC) * s.k;
  const t = new Date(s.t);
  $('tmDay').textContent = `Day ${Math.floor((s.t - n.start.getTime()) / DAY) + 1}`;
  $('tmClock').textContent = `${fmtDate(t)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
  const badge = $('tmState');
  badge.textContent = STATE_INFO[live.state]?.[0] ?? live.state;
  badge.style.color = stateColour(live.state);
  $('tmWhy').textContent = live.why ? `Why: ${live.why}` : '';
  const len = state.result.args.route.length;
  $('tmRoute').style.width = `${len ? (100 * s.d) / len : 100}%`;
  $('tmDist').textContent = len ? `${(s.d / 1000).toFixed(2)} / ${(len / 1000).toFixed(1)} km` : 'stationary';
  $('tmBatt').textContent = `${Math.round(soc * 100)}%`;
  $('tmBattBar').style.width = `${Math.round(soc * 100)}%`;
  $('tmBattBar').style.background = soc < 0.2 ? cssVar('--crit') : soc < 0.4 ? cssVar('--warn') : cssVar('--ok');
  $('tmTemp').textContent = `${Math.round(tempC)} °C`;
  $('tmTemp').style.color = tempC < -100 ? cssVar('--cold') : tempC > 60 ? cssVar('--hot') : '';
  $('tmTempBar').style.width = `${Math.max(2, Math.min(100, ((tempC + 200) / 330) * 100))}%`;
  $('tmGen').textContent = `${Math.round(live.gen)} W`;
  $('tmLoad').textContent = `${Math.round(live.load)} W`;
  $('tmHeat').textContent = live.heater > 0.5 ? `${Math.round(live.heater)} W` : 'off';
  $('tmSlope').textContent = `${here.slope.toFixed(0)}° (max ${state.result.rover.maxSlopeDeg}°)`;
  $('tmSun').textContent = live.sunVis > 0.5 ? `Up ${live.sunEl.toFixed(1)}°` : live.sunEl < 0 ? 'Night' : 'Behind terrain';
  $('tmSun').style.color = live.sunVis > 0.5 ? cssVar('--sun') : cssVar('--ink-dim');
  $('tmEarth').textContent = live.earthVis ? 'In contact' : 'Lost';
  $('tmEarth').style.color = live.earthVis ? cssVar('--earth') : cssVar('--warn');
  const x = globe.roverScale ?? 1;
  $('tmScale').textContent = x > 1.5 ? `Rover drawn ${Math.round(x)}× life size so you can see it.` : 'Rover at true size.';
  $('pbText').textContent = dayStamp(s.t, n.start.getTime());
  drawSpark(s.f);
}

function drawSpark(f) {
  const c = $('tmSpark');
  const tl = state.result.nominal.timeline;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const n = tl.length, upto = Math.min(n - 1, Math.ceil(f));
  const x = (i) => 4 + (i / Math.max(1, n - 1)) * (W - 8);
  ctx.fillStyle = 'rgba(155,140,255,0.14)';
  for (let i = 0; i <= upto; i++) if (tl[i].sunVis <= 0.5) ctx.fillRect(x(i), 0, Math.max(1, (W - 8) / n + 0.5), H);
  const line = (get, col) => {
    ctx.beginPath();
    for (let i = 0; i <= upto; i++) { if (i) ctx.lineTo(x(i), get(tl[i])); else ctx.moveTo(x(i), get(tl[i])); }
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
  };
  line((r) => 4 + (1 - (r.tSurfC + 200) / 330) * (H - 8), cssVar('--hot'));
  line((r) => 4 + (1 - r.soc) * (H - 8), cssVar('--ok'));
}

// Events the replay has passed: mission log, banner and markers on the ground.
function rebuildFeed() {
  replay.shown = new Set();
  replay.markers = [];
  $('feedList').textContent = '';
  globe.setMarkers(null);
  passEvents(state.result.nominal.start.getTime() + replay.t, true);
}

function passEvents(now, quiet = false) {
  const n = state.result.nominal;
  let added = false;
  for (const e of n.events) {
    if (e.t.getTime() > now || replay.shown.has(e)) continue;
    replay.shown.add(e);
    added = true;
    const [ico, title] = typeOf(e.type);
    const li = document.createElement('li');
    li.className = e.level;
    li.innerHTML = '<span class="f-ico"></span><span><span class="f-t"></span><span class="f-m"></span><span class="f-x"></span></span>';
    li.querySelector('.f-ico').textContent = ico;
    li.querySelector('.f-t').textContent = `${dayStamp(e.t.getTime(), n.start.getTime())} · ${title}`;
    li.querySelector('.f-m').textContent = e.text;
    li.querySelector('.f-x').textContent = [Number.isFinite(e.tempC) ? `ground ${Math.round(e.tempC)} °C` : null, Number.isFinite(e.soc) ? `battery ${Math.round(e.soc * 100)}%` : null, `km ${(e.d / 1000).toFixed(2)}`].filter(Boolean).join(' · ');
    li.title = 'Replay from just before this';
    li.addEventListener('click', () => seek(e.t.getTime() - n.start.getTime() - HOUR));
    $('feedList').appendChild(li);
    if (Number.isFinite(e.lat) && ((e.level !== 'info' && e.type !== 'comms' && e.type !== 'cold') || e.type === 'land')) {
      for (const m of replay.markers) m.label = m.level === 'critical';
      replay.markers.push({ lat: e.lat, lon: e.lon, icon: ico, level: e.level, title, label: true });
    }
    if (!quiet && (e.level !== 'info' || e.type === 'land')) {
      const b = $('banner');
      b.className = `banner ${e.level}`;
      b.innerHTML = '<span class="b-ico"></span><span><small></small><span class="b-msg"></span></span>';
      b.querySelector('.b-ico').textContent = ico;
      b.querySelector('small').textContent = `${dayStamp(e.t.getTime(), n.start.getTime())} · ${title}`;
      b.querySelector('.b-msg').textContent = e.text;
      b.hidden = false;
      clearTimeout(passEvents.timer);
      passEvents.timer = setTimeout(() => { b.hidden = true; }, 5200);
      // Hold the picture for a moment at important moments.
      if (e.level === 'critical' || e.level === 'ok' || e.type === 'land') replay.holdUntil = performance.now() + 1800;
      else if (e.level === 'warning') replay.holdUntil = performance.now() + 700;
    }
  }
  if (added) {
    globe.setMarkers(replay.markers);
    const fl = $('feedList');
    fl.scrollTop = fl.scrollHeight;
  }
}

function seek(t) {
  replay.t = Math.max(0, Math.min(replay.duration(), t));
  replay.ended = replay.t >= replay.duration();
  rebuildFeed();
  replayFrame(true);
}

// Timeline strip: sunlight, rover activity, events and the playhead.
function drawStrip() {
  const c = $('pbStrip');
  const res = state.result;
  if (!c || !res || state.mode !== 'run') return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tl = res.nominal.timeline, n = tl.length;
  ctx.clearRect(0, 0, W, H);
  const top = 14, band = (H - top - 4) / 2;
  ctx.fillStyle = cssVar('--shadow');
  ctx.fillRect(0, top, W, band * 2);
  const w = Math.max(1, W / n + 0.5);
  tl.forEach((r, i) => {
    const xx = (i / n) * W;
    ctx.fillStyle = r.sunVis > 0.5 ? 'rgba(242,193,78,0.75)' : 'rgba(155,140,255,0.3)';
    ctx.fillRect(xx, top, w, band - 1);
    ctx.fillStyle = stateColour(r.state);
    ctx.fillRect(xx, top + band, w, band);
  });
  const t0 = res.nominal.start.getTime(), stepMs = res.nominal.stepMin * 60000;
  ctx.font = `500 9.5px ${cssVar('--font-mono')}`;
  ctx.fillStyle = cssVar('--ink-faint');
  const days = res.nominal.days, every = days > 20 ? 5 : days > 10 ? 2 : 1;
  for (let d = every; d < days; d += every) ctx.fillText(`D${d + 1}`, ((d * DAY) / stepMs / n) * W + 2, 10);
  for (const e of res.nominal.events) {
    if (e.level === 'info' && e.type !== 'land') continue;
    const xx = ((e.t.getTime() - t0) / stepMs / n) * W;
    ctx.fillStyle = e.level === 'critical' ? cssVar('--crit') : e.level === 'ok' ? cssVar('--ok') : cssVar('--warn');
    ctx.beginPath(); ctx.moveTo(xx - 4, top - 6); ctx.lineTo(xx + 4, top - 6); ctx.lineTo(xx, top); ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect((replay.t / stepMs / n) * W - 1, 2, 3, H - 4);
}
function scrubTo(e) {
  const r = $('pbStrip').getBoundingClientRect();
  seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * replay.duration());
}
let scrubbing = false, wasPlaying = false;
$('pbStrip').addEventListener('pointerdown', (e) => { scrubbing = true; wasPlaying = replay.playing; e.currentTarget.setPointerCapture(e.pointerId); setPlaying(false); scrubTo(e); });
$('pbStrip').addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
$('pbStrip').addEventListener('pointerup', () => { scrubbing = false; if (wasPlaying) setPlaying(true); });

// ============ 3. DEBRIEF ============
function verdict(rate) {
  if (rate >= 0.85) return ['Likely to succeed', '--ok'];
  if (rate >= 0.5) return ['Risky', '--warn'];
  return ['Unlikely to succeed', '--crit'];
}

// Plain-language account of one hurdle: what happened, the conditions, how the rover dealt with it.
function describeHurdle(h, res) {
  const rover = res.rover;
  const dur = fmtDur(((h.t1 ?? h.t0) - h.t0) / HOUR);
  const tmin = Number.isFinite(h.minTempC) ? Math.round(h.minTempC) : null, tmax = Number.isFinite(h.maxTempC) ? Math.round(h.maxTempC) : null;
  const still = h.ongoing ? ' It was still going on when the mission ended.' : '';
  const heat = h.heaterWh > 1 ? ` Heaters used <b>${Math.round(h.heaterWh)} Wh</b> to keep the electronics above ${rover.minTempC} °C.` : '';
  const batt = ` Battery bottomed out at <b>${Math.round(h.minSoc * 100)}%</b>.`;
  switch (h.type) {
    case 'night': return `The Sun set and the rover spent <b>${dur}</b> in the lunar night. The ground cooled to <b>${tmin} °C</b>. ${h.stopped ? 'The rover hibernated to save power.' : 'It stayed awake.'}${heat}${batt}${still}`;
    case 'shadow': return `Hills blocked the Sun for <b>${dur}</b> at km ${(h.d / 1000).toFixed(1)} while it was still daytime. The ground fell to <b>${tmin} °C</b>. ${h.stopped ? 'The rover hibernated.' : 'The rover ran on battery.'}${heat}${batt}${still}`;
    case 'comms': return `Earth sat below the skyline for <b>${dur}</b>, so there was no radio link to mission control${rover.needsComms ? ' and the rover was not allowed to drive' : ''}.${still}`;
    case 'heat': return `The sunlit ground reached <b>${tmax} °C</b>, above the rover's ${rover.maxTempC} °C driving limit, so it paused for <b>${dur}</b> to avoid overheating.${still}`;
    case 'wait': return `Shadow lay across the route ahead. Rather than risk its battery in the dark, the rover waited <b>${dur}</b> in sunlight for it to clear.${still}`;
    case 'slip': return `Wheels slipped <b>${Math.round(h.value * 100)}%</b> on a <b>${h.slope.toFixed(0)}°</b> slope at km ${(h.d / 1000).toFixed(1)}: more power for less progress. Ground ${tmin} °C.`;
    case 'slope': case 'climb': case 'crater': return `${esc(h.text)}. Ground ${tmin} °C and battery ${Math.round(h.minSoc * 100)}% when the rover got there.`;
    case 'wall': return `${esc(h.text)} The rover cannot go on along this route.`;
    case 'battery': return `The battery fell below 20% at km ${(h.d / 1000).toFixed(1)} with the ground at ${tmin} °C. The rover is close to losing power.`;
    case 'dead': return `${esc(h.text)} With no power the heaters stop and the electronics freeze.`;
    default: return esc(h.text ?? '');
  }
}

function debriefHurdles(n) {
  return n.hurdles.filter((h) => !['night', 'shadow', 'comms', 'heat', 'wait'].includes(h.type) || (h.t1 - h.t0) >= HOUR);
}

function renderDebrief() {
  const res = state.result;
  if (!res) return;
  const { nominal: n, mc, rover } = res;
  const [word, col] = verdict(mc.rate);
  const C = 2 * Math.PI * 56;
  const tl = n.timeline;
  const t0 = n.start.getTime();
  const hurdles = debriefHurdles(n);
  const longestDark = Math.max(0, ...n.hurdles.filter((h) => h.type === 'night' || h.type === 'shadow').map((h) => (h.t1 - h.t0) / HOUR));
  const sumH = (types) => n.hurdles.filter((h) => types.includes(h.type)).reduce((s, h) => s + (h.t1 - h.t0) / HOUR, 0);
  const counts = {};
  for (const r of tl) counts[r.state] = (counts[r.state] || 0) + 1;
  const causes = Object.entries(mc.causes).sort((a, b) => b[1].length - a[1].length);
  const CAUSE = { battery: 'Battery ran out', slope: 'Blocked by a slope too steep to climb', time: 'Ran out of time before reaching the destination' };
  const outcomeCols = { ok: '--ok', battery: '--crit', slope: '--warn', time: '--violet' };
  const route = res.args.route;
  const hs = route.pts.map((p) => p.h);

  $('debriefBody').innerHTML = `
    <div class="db-hero">
      ${thumbs[res.modelId] ? `<img class="db-rover" src="${thumbs[res.modelId]}" alt="">` : '<span></span>'}
      <div class="ring" role="img" aria-label="${Math.round(mc.rate * 100)} percent of simulated missions succeeded">
        <svg viewBox="0 0 132 132"><circle cx="66" cy="66" r="56" fill="none" stroke="var(--shadow)" stroke-width="12"/>
          ${mc.rate > 0 ? `<circle cx="66" cy="66" r="56" fill="none" stroke="var(${col})" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C * mc.rate} ${C}"/>` : ''}</svg>
        <div class="rv"><div><b>${Math.round(mc.rate * 100)}%</b><small>success</small></div></div>
      </div>
      <div>
        <h2 style="color:var(${n.success ? '--ok' : '--crit'})">${n.success ? 'Mission accomplished' : n.cause === 'battery' ? 'Rover lost' : n.cause === 'slope' ? 'Route blocked' : 'Mission incomplete'}</h2>
        <p>${esc(n.text)}</p>
        <p><b style="color:var(${col})">${word}.</b> ${mc.successes} of ${mc.runs} simulated variations succeeded (landing ±${res.slip} days, panel output, battery health, wheel slip and heat loss varied).</p>
        <p class="hint">${esc(rover.name)} · ${res.waypoints.length > 1 ? `${fmtKm(n.routeLength)} route from ${esc(res.landingName)}` : `stays at ${esc(res.landingName)}`} · landing ${fmtDateTime(n.start)} · ${n.days} days${state.stale ? ' · <b class="t-warn">the plan has changed since this run</b>' : ''}</p>
      </div>
      <div class="db-actions">
        <button class="btn accent" type="button" id="dbReplay">▶ Watch again</button>
        <button class="btn" type="button" id="dbPlan">Edit the plan</button>
        <button class="btn" type="button" id="dbDownload">Download report</button>
      </div>
    </div>

    <div class="db-grid">
      <div class="db-num"><span>Distance driven</span><b>${fmtKm(n.distance)}</b><small>of ${fmtKm(n.routeLength || 0)} planned</small></div>
      <div class="db-num"><span>Arrived</span><b>${n.reachedAt ? `Day ${Math.floor((n.reachedAt - t0) / DAY) + 1}` : '—'}</b><small>${n.reachedAt ? `after ${fmtDur((n.reachedAt - t0) / HOUR)}` : res.waypoints.length > 1 ? 'did not arrive' : 'no route'}</small></div>
      <div class="db-num"><span>Coldest ground</span><b style="color:var(--cold)">${Math.round(n.minTempC)} °C</b><small>hottest <span style="color:var(--hot)">${Math.round(n.maxTempC)} °C</span></small></div>
      <div class="db-num"><span>Lowest battery</span><b class="${n.minSoc < 0.2 ? 't-bad' : n.minSoc < 0.4 ? 't-warn' : ''}">${Math.max(0, Math.round(n.minSoc * 100))}%</b><small>${rover.batteryWh} Wh pack</small></div>
      <div class="db-num"><span>Energy in / used</span><b>${(n.energyIn / 1000).toFixed(1)} / ${(n.energyOut / 1000).toFixed(1)} kWh</b><small>heaters ${Math.round(n.heaterWh)} Wh</small></div>
      <div class="db-num"><span>In the dark</span><b>${fmtDur(sumH(['night', 'shadow']))}</b><small>longest spell ${longestDark ? fmtDur(longestDark) : 'none'}</small></div>
      <div class="db-num"><span>No Earth contact</span><b>${fmtDur(sumH(['comms']))}</b><small>in contact ${Math.round(n.commsFrac * 100)}% of the time</small></div>
      <div class="db-num"><span>Worst wheel slip</span><b>${Math.round(n.maxSlip * 100)}%</b><small>steepest ${route.steepest.slope.toFixed(0)}° on the route</small></div>
    </div>

    <div class="db-cols">
      <section class="db-sec">
        <h3>Hurdles encountered <small>${hurdles.length} in the planned run</small></h3>
        <ol class="hurdles">${hurdles.slice(0, 40).map((h, i) => {
          const [ico, title, level] = typeOf(h.type);
          const durH = (h.t1 - h.t0) / HOUR;
          return `<li class="hurdle ${h.fatal ? 'critical' : level}"><span class="h-ico">${ico}</span><div>
            <h4>${title}${durH >= 1 ? ` · ${fmtDur(durH)}` : ''}</h4>
            <span class="h-when">${dayStamp(h.t0, t0)} · km ${(h.d / 1000).toFixed(2)} · ${fmtLL(h)}</span>
            <p>${describeHurdle(h, res)}</p>
            <div class="h-tags">${Number.isFinite(h.minTempC) ? `<span class="${h.minTempC < -100 ? 'cold' : h.maxTempC > 60 ? 'hot' : ''}">ground ${Math.round(h.minTempC)}${Math.round(h.maxTempC) !== Math.round(h.minTempC) ? ` to ${Math.round(h.maxTempC)}` : ''} °C</span>` : ''}<span>battery ${Math.round(h.minSoc * 100)}%</span>${h.heaterWh > 1 ? `<span>heaters ${Math.round(h.heaterWh)} Wh</span>` : ''}</div>
          </div><button class="btn" type="button" data-watch="${i}">Watch</button></li>`;
        }).join('') || '<li class="hurdle ok"><span class="h-ico">✓</span><div><h4>No hurdles</h4><p>The rover met no shadow, steep ground or loss of contact worth noting.</p></div></li>'}</ol>
        ${hurdles.length > 40 ? `<p class="hint">and ${hurdles.length - 40} more in the downloadable report.</p>` : ''}
      </section>

      <div class="db-side" style="display:flex;flex-direction:column;gap:18px;min-width:0">
        <section class="db-sec db-chart">
          <h3>Mission timeline</h3>
          <canvas id="dbChart" aria-label="Battery, ground temperature, sunlight, Earth contact and rover activity over the mission"></canvas>
          <div class="legend">
            <span><i style="background:var(--ok)"></i>Battery</span><span><i style="background:var(--hot)"></i>Ground temperature</span>
            <span><i style="background:var(--sun)"></i>Sunlight</span><span><i style="background:var(--earth)"></i>Earth in view</span>
          </div>
          <div class="legend">${Object.entries(STATE_INFO).filter(([k]) => counts[k]).map(([k, [label, c]]) => `<span><i style="background:var(${c})"></i>${label} ${Math.round((100 * counts[k]) / tl.length)}%</span>`).join('')}</div>
        </section>

        <section class="db-sec">
          <h3>All ${mc.runs} variations</h3>
          <div class="outcomes">${[['ok', mc.successes], ...causes.map(([k, l]) => [k, l.length])].filter(([, c]) => c).map(([k, c]) => `<i style="flex:${c};background:var(${outcomeCols[k] ?? '--crit'})" title="${k === 'ok' ? 'Succeeded' : CAUSE[k] ?? k}: ${c}"></i>`).join('')}</div>
          <ul class="cause-list">
            <li><b class="pct" style="color:var(--ok)">${Math.round(mc.rate * 100)}%</b><span>succeeded</span></li>
            ${causes.map(([k, list]) => `<li><b class="pct">${Math.round((100 * list.length) / mc.runs)}%</b><span><b>${CAUSE[k] ?? k}</b><br><span class="hint">e.g. ${esc(list[0].text)}</span></span></li>`).join('')}
          </ul>
        </section>

        <section class="db-sec">
          <h3>How to improve the odds</h3>
          <div id="tips"><p class="hint">Testing other landing dates and options…</p></div>
        </section>

        <section class="db-sec">
          <h3>Site conditions</h3>
          <dl class="env-list">
            <div><dt>Ground temperature</dt><dd>${Math.round(n.minTempC)} to ${Math.round(n.maxTempC)} °C</dd></div>
            <div><dt>Sunlit</dt><dd>${Math.round(n.sunFrac * 100)}% of the mission</dd></div>
            <div><dt>Terrain data</dt><dd>NASA LOLA ${route.coarsest <= 100 ? '80 m' : '~950 m'}</dd></div>
            <div><dt>Height range on route</dt><dd>${Math.round(Math.max(...hs) - Math.min(...hs))} m</dd></div>
          </dl>
        </section>
      </div>
    </div>
    <p class="method">How it works: every ${n.stepMin} minutes of mission time, the rover's position on NASA LOLA terrain is checked against the real Sun and Earth (astronomy-engine), with the true skyline traced over the terrain out to 150 km. Ground temperature comes from radiative balance on the local slope, falling to about −178 °C in shadow. Solar power depends on the panel angle and how much of the Sun's disc clears the skyline. Heaters run in the dark, wheel slip rises with slope, and the rover follows simple rules: wait for sunlight ahead unless the battery can carry it across the shadow, back out of shadow to the nearest sunlight, hibernate in the dark. Rover presets are illustrative.</p>`;

  requestAnimationFrame(() => drawChart($('dbChart'), res));
  $('dbReplay').addEventListener('click', () => { replay.t = 0; replay.ended = false; setMode('run'); });
  $('dbPlan').addEventListener('click', () => setMode('plan'));
  $('dbDownload').addEventListener('click', () => downloadReport(res));
  $('debriefBody').querySelectorAll('[data-watch]').forEach((b) => b.addEventListener('click', () => {
    const h = hurdles[+b.dataset.watch];
    replay.ended = false;
    setMode('run');
    seek(h.t0 - t0 - 2 * HOUR);
    setPlaying(true);
  }));
  renderTips(res);
}

function drawChart(canvas, result) {
  if (!canvas || !result) return;
  const tl = result.nominal.timeline;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = 40, R = 46, top = 8;
  const w = W - L - R, n = Math.max(2, (result.nominal.days * 24 * 60) / result.nominal.stepMin + 1);
  const x = (i) => L + (i / (n - 1)) * w;
  const lineH = H - 72, bandY = top + lineH + 8, bandH = 10;
  ctx.strokeStyle = cssVar('--line');
  for (const f of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(L, top + lineH * f); ctx.lineTo(L + w, top + lineH * f); ctx.stroke(); }
  const yB = (v) => top + lineH * (1 - v);
  const yT = (c) => top + lineH * (1 - (c + 200) / 330);
  const path = (get, color, width, fill) => {
    ctx.beginPath();
    tl.forEach((r, i) => (i ? ctx.lineTo(x(i), get(r)) : ctx.moveTo(x(i), get(r))));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    if (fill) { ctx.lineTo(x(tl.length - 1), top + lineH); ctx.lineTo(x(0), top + lineH); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
  };
  path((r) => yT(r.tSurfC), cssVar('--hot'), 1.3);
  path((r) => yB(r.soc), cssVar('--ok'), 2, 'rgba(95,211,154,0.12)');
  for (let row = 0; row < 3; row++) { ctx.fillStyle = cssVar('--shadow'); ctx.fillRect(L, bandY + row * (bandH + 3), w, bandH); }
  tl.forEach((r, i) => {
    const xx = x(i), ww = Math.max(1, x(i + 1) - xx + 0.5);
    if (r.sunVis > 0.5) { ctx.fillStyle = cssVar('--sun'); ctx.fillRect(xx, bandY, ww, bandH); }
    if (r.earthVis) { ctx.fillStyle = cssVar('--earth'); ctx.fillRect(xx, bandY + bandH + 3, ww, bandH); }
    ctx.fillStyle = stateColour(r.state); ctx.fillRect(xx, bandY + 2 * (bandH + 3), ww, bandH);
  });
  ctx.font = `500 10px ${cssVar('--font-mono')}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = cssVar('--ok');
  ctx.fillText('100%', L - 5, yB(1) + 8); ctx.fillText('0%', L - 5, yB(0));
  ctx.fillStyle = cssVar('--hot');
  ctx.textAlign = 'left';
  ctx.fillText('+130°C', L + w + 4, yT(130) + 8); ctx.fillText('0°C', L + w + 4, yT(0) + 4); ctx.fillText('−200°C', L + w + 4, yT(-200));
  ctx.fillStyle = cssVar('--ink-dim');
  ctx.textAlign = 'right';
  ['SUN', 'EARTH', 'ROVER'].forEach((t, row) => ctx.fillText(t, L - 5, bandY + row * (bandH + 3) + 9));
  ctx.textAlign = 'center';
  const days = result.nominal.days, every = days > 20 ? 5 : days > 10 ? 2 : 1;
  for (let d = 0; d <= days; d += every) ctx.fillText(d ? `D${d}` : 'Land', Math.min(L + w - 12, x((d * 24 * 60) / result.nominal.stepMin)), H - 3);
}

// Try other landing dates, a bigger battery, heaters and a sun-planned route; keep what helps.
async function findImprovements(res) {
  const tips = [];
  const base = res.args;
  const quick = (args) => monteCarlo(args, { runs: 20, slipDays: res.slip, seed: 11 });
  const screened = [];
  for (const s of [-6, -4, -2, 2, 4, 6, 8, 10, 12, 14]) {
    const start = new Date(base.start.getTime() + s * DAY);
    const r = simulate({ ...base, start, record: false });
    screened.push({ s, start, ok: r.success, d: r.distance });
    await tick();
    if (state.result !== res) return;
  }
  screened.sort((a, b) => (b.ok - a.ok) || (b.d - a.d) || (Math.abs(a.s) - Math.abs(b.s)));
  let best = null;
  for (const c of screened.slice(0, 2)) {
    const mc = await quick({ ...base, start: c.start });
    if (state.result !== res) return;
    if (!best || mc.rate > best.rate) best = { ...c, rate: mc.rate, of: mc.runs, ok: mc.successes };
  }
  if (best && best.rate > res.mc.rate + 0.05) {
    tips.push({ text: `Land on <b>${fmtDate(best.start)}</b> (${best.s > 0 ? `${best.s} days later` : `${-best.s} days earlier`}): ${best.ok} of ${best.of} runs succeed.`, act: 'Use this date', run: () => { state.start = best.start; syncTiming(); launch(); } });
  }
  if (res.mc.causes.battery?.length) {
    const mc = await quick({ ...base, rover: { ...base.rover, batteryWh: base.rover.batteryWh * 1.5 } });
    if (state.result !== res) return;
    tips.push({ text: `A <b>50% bigger battery</b> (${Math.round(base.rover.batteryWh * 1.5)} Wh): ${mc.successes} of ${mc.runs} runs succeed.`, act: 'Use it', run: () => { state.rover.batteryWh = Math.round(base.rover.batteryWh * 1.5); makeCustom(); syncRoverForm(); launch(); } });
    const rhu = Math.round(base.rover.heatWperK * 60);
    const mc2 = await quick({ ...base, rover: { ...base.rover, rhuW: (base.rover.rhuW ?? 0) + rhu } });
    if (state.result !== res) return;
    tips.push({ text: `<b>Radioisotope heaters</b> worth ${rhu} W to stay warm in the dark: ${mc2.successes} of ${mc2.runs} runs succeed.`, act: 'Add them', run: () => { state.rover.rhuW = (state.rover.rhuW ?? 0) + rhu; makeCustom(); syncRoverForm(); launch(); } });
  }
  if (!res.planned && res.waypoints.length > 1 && res.mc.rate < 0.95) {
    tips.push({ text: 'Let the planner re-route between your points to <b>stay in sunlight</b> and avoid steep slopes.', act: 'Re-route', run: async () => { setMode('plan'); await planSunniest(); launch(); } });
  }
  if (res.mc.causes.time?.length) tips.push({ text: `Some runs ran out of time. A <b>longer mission</b> (${res.nominal.days + 7} days) gives the rover time to wait out shadows.`, act: 'Add 7 days', run: () => { state.days += 7; syncTiming(); launch(); } });
  res.tips = tips;
  renderTips(res);
}

function renderTips(res) {
  const el = $('tips');
  if (!el || state.result !== res || !res.tips) return;
  el.innerHTML = res.tips.length
    ? `<ul class="tips">${res.tips.map((t, i) => `<li><span>${t.text}</span><button class="btn accent" type="button" data-tip="${i}">${t.act}</button></li>`).join('')}</ul>`
    : '<p class="hint">Nothing we tried improved the odds noticeably: this plan is as good as these options get.</p>';
  el.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => res.tips[+b.dataset.tip].run()));
}

function downloadReport(res) {
  const { nominal: n, mc, rover } = res;
  const t0 = n.start.getTime();
  const strip = (h) => h.replace(/<[^>]+>/g, '');
  const lines = [
    '# LunaView mission debrief', '',
    `- Rover: ${rover.name} (${rover.massKg} kg, ${rover.solarW} W solar, ${rover.batteryWh} Wh battery, ${rover.maxSlopeDeg}° max slope)`,
    `- Route: ${res.waypoints.map(fmtLL).join(' → ')} (${fmtKm(n.routeLength)})`,
    `- Landing: ${fmtDateTime(n.start)} ±${res.slip} days, ${n.days}-day mission`, '',
    '## Result', '',
    `- Planned run: ${n.success ? 'SUCCESS' : 'FAILURE'}. ${n.text}`,
    `- Chance of success: ${Math.round(mc.rate * 100)}% (${mc.successes} of ${mc.runs} variations)`,
    ...Object.entries(mc.causes).map(([k, l]) => `- Failed (${k}): ${l.length} runs`), '',
    '## Key numbers', '',
    `- Driven: ${fmtKm(n.distance)} of ${fmtKm(n.routeLength)}`,
    `- Ground temperature: ${Math.round(n.minTempC)} to ${Math.round(n.maxTempC)} °C`,
    `- Lowest battery: ${Math.round(n.minSoc * 100)}%`,
    `- Energy generated ${(n.energyIn / 1000).toFixed(1)} kWh, used ${(n.energyOut / 1000).toFixed(1)} kWh, heaters ${Math.round(n.heaterWh)} Wh`,
    `- Earth in view ${Math.round(n.commsFrac * 100)}% of the time; sunlit ${Math.round(n.sunFrac * 100)}%`,
    `- Worst wheel slip ${Math.round(n.maxSlip * 100)}%`, '',
    '## Hurdles', '',
    ...debriefHurdles(n).map((h) => `- **${typeOf(h.type)[1]}**, ${dayStamp(h.t0, t0)}, km ${(h.d / 1000).toFixed(2)}${(h.t1 - h.t0) >= HOUR ? `, ${fmtDur((h.t1 - h.t0) / HOUR)}` : ''}: ${strip(describeHurdle(h, res))}`), '',
    '## Mission log', '',
    ...n.events.map((e) => `- ${dayStamp(e.t.getTime(), t0)}: ${e.text}`),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lunaview-debrief-${fmtDate(n.start)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ============ search ============
const search = $('search');
const results = $('results');
let active = 0;
function renderResults() {
  const q = search.value.trim().toLowerCase();
  const items = [];
  const c = parseCoords(search.value);
  if (c) items.push({ id: null, name: `Go to ${fmtLL(c)}`, lat: c.lat, lon: c.lon });
  for (const s of ALL_PLACES) if (!q || s.name.toLowerCase().includes(q)) items.push(s);
  results.textContent = '';
  items.slice(0, 14).forEach((s, i) => {
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
  if (state.mode !== 'plan') setMode('plan');
  if (!state.waypoints.length) setLanding(s, s.id ? s.name : `Landing at ${fmtLL(s)}`);
  else { globe.flyToPoint(s.lat, s.lon); toast(`Showing ${s.id ? s.name : fmtLL(s)}. Click the ground to add waypoints, or "New landing site" to start here.`); }
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

// ============ sky from the rover ============
const pano = new Panorama($('pano'));
function openStand() {
  if (!terrain || !state.result) return;
  setPlaying(false);
  const s = replayState(replay.t);
  const p = pointAt(state.result.args.route, s.d);
  const horizon = [];
  for (let az = 0; az < 360; az += 1) horizon.push(terrain.horizon(p.lat, p.lon, az, p.h + 1.5));
  $('stand').hidden = false;
  $('standSite').textContent = `${dayStamp(s.t, state.result.nominal.start.getTime())} · rover at ${fmtLL(p)} · skyline from NASA LOLA terrain, heights ×${pano.vScale}`;
  const tl = state.result.nominal.timeline;
  pano.set({ horizon, track: tl.filter((_, k) => k % 4 === 0).map((q) => ({ sunAz: q.sunAz, sunEl: q.sunEl, earthAz: q.earthAz, earthEl: q.earthEl })) });
  const eph = ephemeris(15 * 60 * 1000);
  const env = environment(terrain, eph, p.lat, p.lon, p.h, s.t);
  const v = eph(s.t);
  const lit = (1 + (v.sun.x * v.earth.x + v.sun.y * v.earth.y + v.sun.z * v.earth.z)) / 2;
  pano.set({ state: { sun: env.sun, earth: env.earth, sunlit: env.sunVis > 0.5, earthVisible: env.earthVis, earthLit: lit } });
  $('standReadout').innerHTML = `<span class="sun-dot"></span>Sun ${env.sun.el.toFixed(2)}° · ${env.sunVis > 0.5 ? 'above the skyline' : 'behind the skyline'}
    <span class="earth-dot"></span>Earth ${env.earth.el.toFixed(2)}° · ${env.earthVis ? 'in view' : 'hidden'}`;
  pano.lookAt(env.sun.az);
}
$('closeStand').addEventListener('click', () => { $('stand').hidden = true; });
$('lookSun').addEventListener('click', () => pano.lookAt(pano.state.sun.az));
$('lookEarth').addEventListener('click', () => pano.lookAt(pano.state.earth.az));

// ============ map tools ============
function setToolOn(name, on) {
  const b = document.querySelector(`.mt[data-tool="${name}"]`);
  if (!b) return;
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}
document.querySelectorAll('.mt').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'zin') { globe.cam.interrupt(); globe.cam.zoomBy(0.5); }
  if (t === 'zout') { globe.cam.interrupt(); globe.cam.zoomBy(2); }
  if (t === 'fit') {
    if (state.mode === 'run') setCam('off');
    const pts = state.route?.pts ?? state.waypoints;
    if (pts.length) globe.frameRoute(pts); else globe.flyHome();
  }
  if (t === 'home') { if (state.mode === 'run') setCam('off'); globe.flyHome(); }
  if (t === 'map') toggleSunMap();
  if (t === 'relief') { const on = b.getAttribute('aria-pressed') !== 'true'; setToolOn('relief', on); globe.setRelief(on ? 5 : 1); toast(on ? 'Relief exaggerated 5× so hills and craters stand out.' : 'True-scale relief.'); }
  if (t === 'sun') { const on = b.getAttribute('aria-pressed') !== 'true'; setToolOn('sun', on); globe.setFullLight(!on); toast(on ? 'Real sunlight at the mission time.' : 'Even viewing light: terrain lit from the side so it reads anywhere, day or night.'); }
}));

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (e.key === ' ' && state.mode === 'run') { e.preventDefault(); setPlaying(!replay.playing); }
  if (e.key === 'Escape' && !$('stand').hidden) $('stand').hidden = true;
  if (e.key === 'Escape' && !$('welcome').hidden) closeWelcome();
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.mode === 'plan' && state.waypoints.length > 1) { state.waypoints.pop(); routeChanged(); }
});

Object.assign(window.lunaview, { replay, seek, setPlaying, setMode });

// ============ time ============
function setTime(d) { globe.setSunDirection(eph15(d.getTime()).sun); }
globe.onFrame = () => { if (state.mode === 'run') replayFrame(false); };

// ============ welcome ============
let welcomeStage = null;
function showWelcome() {
  $('welcome').hidden = false;
  welcomeStage ??= new RoverStage($('welcomeStage'));
  welcomeStage.lift = 0;
  const order = ['large', 'mid', 'micro'];
  let k = 0;
  welcomeStage.show(order[0]);
  clearInterval(showWelcome.timer);
  showWelcome.timer = setInterval(() => { if ($('welcome').hidden) return clearInterval(showWelcome.timer); welcomeStage.show(order[++k % 3]); }, 4500);
}
function closeWelcome() {
  $('welcome').hidden = true;
  try { localStorage.setItem('lunaview-welcomed', '1'); } catch { /* private mode */ }
}
$('wStart').addEventListener('click', closeWelcome);
$('wExample').addEventListener('click', () => { closeWelcome(); loadExample(); });
$('welcome').addEventListener('click', (e) => { if (e.target === $('welcome')) closeWelcome(); });
$('modelCredit').textContent = `3D models: ${Object.values(MODELS).map((m) => m.credit).join(' · ')}.`;

// ============ start ============
syncRoverForm();
syncTiming();
setTime(state.start);
renderWaypoints();
renderInstructions();
let welcomed = false;
try { welcomed = localStorage.getItem('lunaview-welcomed') === '1'; } catch { /* private mode */ }
if (!welcomed) showWelcome();
