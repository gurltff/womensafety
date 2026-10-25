// LunaView planetarium: a Stellarium-style sky for the Moon. Stand anywhere on the lunar surface or
// look down from orbit, at any date and time, with the real Sun, Earth, planets and stars.
import './stellar.css';
import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { Globe, llToWorld } from '../globe.js';
import { Terrain } from '../terrain.js';
import { SITES, PLACES, parseCoords } from '../sites.js';
import { SkyLayer, loadSky } from './skylayer.js';
import { SurfaceView, dirOf, altAzOf } from './surface.js';
import { loadAlbedo, loadCloseUp, EYE_M } from './landscape.js';
import { loadEnv, localHour, temperatureK, rockFraction, timeline, spaceWeather, sScale, flareClass, assess } from './report.js';
import { observerAt, solarSystem, horizonMatrix, subPoints, riseSet, eqjToRaDec, moonPhase, MOON_R_KM } from './ephem.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const DAY = 86400e3;
const ALL_PLACES = [...SITES.map((s) => ({ ...s, group: 'South pole' })), ...PLACES.map((p) => ({ ...p, group: 'Landing sites and craters' }))];
const RATES = [-1e6, -1e5, -1e4, -1e3, -100, -10, -1, 1, 10, 100, 1e3, 1e4, 1e5, 1e6];

const store = {
  get(k, d) { try { const v = localStorage.getItem(`lunaview-sky-${k}`); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`lunaview-sky-${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  t: Date.now(),
  rate: 1,
  paused: false,
  site: store.get('site', { name: 'Apollo 11, Sea of Tranquillity', lat: 0.674, lon: 23.473 }),
  siteH: 0,
  view: 'surface',
  sel: null,
  show: {
    stars: true, starLabels: true, planets: true, planetLabels: true, constLines: true, constNames: true, milkyWay: true,
    eqGrid: false, azGrid: false, ecliptic: false, ground: true, cardinals: true, shadows: true, earthshine: true,
    glare: false, night: false, bright: true, ...store.get('show', {}),
  },
  magBoost: store.get('magBoost', 0),
  mwBright: store.get('mwBright', 1),
};

// ---------- formatting ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtUTC = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
const fmtShort = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
function dms(deg, signed = true) {
  const sgn = deg < 0 ? '-' : '+';
  let a = Math.abs(deg);
  const d = Math.floor(a); a = (a - d) * 60;
  const m = Math.floor(a); const s = (a - m) * 60;
  return `${signed ? sgn : ''}${d}°${pad(m)}'${s.toFixed(1).padStart(4, '0')}"`;
}
function hms(deg) {
  let h = (((deg % 360) + 360) % 360) / 15;
  const H = Math.floor(h); h = (h - H) * 60;
  const M = Math.floor(h); const sec = (h - M) * 60;
  return `${H}h${pad(M)}m${sec.toFixed(2).padStart(5, '0')}s`;
}
const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'W' : 'E'}`;
const fmtKm = (km) => (km > 1e7 ? `${(km / Astronomy.KM_PER_AU).toFixed(4)} AU (${(km / 1e6).toFixed(1)} million km)` : `${Math.round(km).toLocaleString('en')} km`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- scene ----------
const globe = new Globe($('globe'), $('labels'));
globe.setFullLight(false);
if (globe.starField) globe.starField.visible = false;
globe.setSites(ALL_PLACES, null);
globe.markerRange = Infinity;
let sky = null, surface = null, terrain = null, albedo = null;
const terrainReady = new Promise((resolve) => {
  const check = () => {
    if (globe.terrain?.sim && globe.polarH && globe.globalH) {
      terrain = new Terrain(globe.terrain, (lat, lon) => globe.coarseHeight(lat, lon));
      resolve(terrain);
    } else setTimeout(check, 120);
  };
  check();
});

// ---------- per-frame state ----------
let frameState = null;
let lastFrame = performance.now(), fpsCount = 0, fpsT = performance.now(), fps = 0;
let lastLight = 0, lastInfo = 0, lastMarkers = 0;

function compute() {
  const date = new Date(S.t);
  if (S.view === 'surface') {
    const obs = observerAt(date, { ...S.site, hM: S.siteH + EYE_M });
    const bodies = solarSystem(obs);
    return { date, obs, bodies, R9: horizonMatrix(obs) };
  }
  // Orbit view: the sky as seen from the Moon's centre, in the globe's frame (Moon-fixed, y north).
  const obs = observerAt(date, { lat: 0, lon: 0, hM: -MOON_R_KM * 1000 });
  const { x, y, z } = obs.ax;
  return { date, obs, bodies: solarSystem(obs), R9: [x.x, x.y, x.z, z.x, z.y, z.z, -y.x, -y.y, -y.z] };
}

function tick() {
  const now = performance.now();
  const dt = Math.min(250, now - lastFrame);
  lastFrame = now;
  if (!S.paused) S.t += dt * S.rate;
  fpsCount++;
  if (now - fpsT > 1000) { fps = (fpsCount * 1000) / (now - fpsT); fpsCount = 0; fpsT = now; }
  if (!sky) return;
  frameState = compute();
  const { bodies, R9 } = frameState;
  sky.show = { ...sky.show, ...S.show };
  sky.local.visible = S.view === 'surface';
  sky.update(R9, bodies);
  const sun = bodies.find((b) => b.id === 'sun'), earth = bodies.find((b) => b.id === 'earth');

  // Faintest stars shown: like a dark-adapted eye, more as you zoom in; glare hides them in daylight.
  const fov = S.view === 'surface' ? surface.view.fov : globe.camera.fov;
  let lim = 6.4 + 2.2 * Math.log10(60 / fov) + S.magBoost;
  const sunUp = S.view === 'surface' && sun.alt > surface.landscape.horizonAt(sun.az);
  let fade = 1;
  if (S.show.glare && sunUp) { lim = Math.min(lim, 0.5); fade = 0.8; }
  sky.setMagLimit(Math.max(-1, Math.min(8, lim)), fade);
  sky.milkyWay.material.opacity = 0.2 * S.mwBright * (S.show.glare && sunUp ? 0 : 1);

  if (S.view === 'surface') {
    surface.showGround = S.show.ground;
    // Re-light the ground when the Sun has moved (shadows are ray-marched, so not every frame).
    if (now - lastLight > (S.rate === 1 && !S.paused ? 2000 : 250)) {
      lastLight = now;
      surface.landscape.light(S.show.shadows ? sun : { ...sun, alt: Math.max(sun.alt, 0) }, earth, { earthshine: S.show.earthshine, minAmbient: S.show.bright ? 1.1 : 0 });
    }
  } else {
    globe.nightLight = S.show.bright ? 2.4 : 0.14;
    globe.setSunDirection(subPoints(frameState.date).sunDirMf);
    if (now - lastMarkers > 500) { lastMarkers = now; orbitMarkers(); }
  }
  if (now - lastGng > 1500) { lastGng = now; renderGng(); }
  if (!$('win-report').hidden && now - lastRep > 2000) { lastRep = now; renderReport(); }
  if (now - lastInfo > 250) { lastInfo = now; renderInfo(); renderStatus(); syncDateWindow(); }
}

// ---------- labels over the sky ----------
const labelEls = new Map();
function label(key, cls, text, x, y, dx = 6, dy = -6) {
  let el = labelEls.get(key);
  if (!el) { el = document.createElement('div'); el.className = `sl ${cls}`; $('skyLabels').appendChild(el); labelEls.set(key, el); }
  if (el.textContent !== text) el.textContent = text;
  el.style.transform = `translate(${Math.round(x + dx)}px, ${Math.round(y + dy)}px)`;
  el.hidden = false;
  el.dataset.used = '1';
}

const tmpV = new THREE.Vector3();
// Screen position of a view-frame direction with the sky camera of the frame just drawn.
function project(v) {
  const cam = sky.camera;
  tmpV.copy(v).multiplyScalar(1000);
  const camSpace = tmpV.clone().applyMatrix4(cam.matrixWorldInverse);
  if (camSpace.z > 0) return null;
  tmpV.project(cam);
  if (Math.abs(tmpV.x) > 1.2 || Math.abs(tmpV.y) > 1.2) return null;
  const w = globe.canvas.clientWidth, h = globe.canvas.clientHeight;
  return { x: ((tmpV.x + 1) / 2) * w, y: ((1 - tmpV.y) / 2) * h };
}
// Is a view-frame direction hidden by the ground (surface) or the Moon (orbit)?
function hidden(v) {
  if (S.view === 'surface') {
    if (!S.show.ground) return false;
    const { alt, az } = altAzOf(v);
    return alt < surface.landscape.horizonAt(az) - 0.05;
  }
  const c = globe.camera.position, b = c.dot(v), cc = c.lengthSq() - 1;
  const disc = b * b - cc;
  return disc > 0 && -b - Math.sqrt(disc) > 0;
}

function drawLabels() {
  if (!sky || !frameState) return;
  for (const el of labelEls.values()) el.dataset.used = '';
  const { bodies } = frameState;
  const lim = sky.starUniforms.magLimit.value;
  if (S.show.planetLabels || S.sel?.kind === 'body') {
    for (const b of bodies) {
      if (!S.show.planetLabels && S.sel?.id !== b.id) continue;
      if (b.type === 'planet' && b.id !== 'earth' && !S.show.planets) continue;
      const p = project(b.view);
      if (!p || hidden(b.view)) continue;
      const big = b.id === 'sun' || b.id === 'earth';
      label(`b-${b.id}`, b.id === 'sun' ? 'sun' : b.id === 'earth' ? 'earth' : 'planet', b.name, p.x, p.y, big ? 14 : 6, big ? -16 : -6);
    }
  }
  if (S.show.stars && S.show.starLabels) {
    const names = sky.stars.names;
    const labelMag = lim - 4.3;
    for (let i = 0; i < sky.stars.mag.length; i++) {
      const mag = sky.stars.mag[i];
      if (mag > labelMag) break; // sorted by magnitude
      const n = names[sky.stars.hip[i]];
      if (!n?.name) continue;
      const v = sky.starView(i);
      const p = project(v);
      if (!p || hidden(v)) continue;
      label(`s-${i}`, 'star', n.name, p.x, p.y);
    }
  }
  if (S.show.constNames) {
    for (const c of sky.constLabels) {
      if (c.rank > (surface?.view.fov < 40 || S.view === 'orbit' ? 3 : 2)) continue;
      const v = sky.viewOf(c.v);
      const p = project(v);
      if (!p || hidden(v)) continue;
      label(`c-${c.id}`, 'const', c.name, p.x, p.y, -30, 0);
    }
  }
  if (S.view === 'surface' && S.show.cardinals) {
    for (const [name, az, minor] of [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['NE', 45, 1], ['SE', 135, 1], ['SW', 225, 1], ['NW', 315, 1]]) {
      const v = dirOf(Math.max(0, surface.landscape.horizonAt(az)) + 0.6, az);
      const p = project(v);
      if (p) label(`k-${name}`, `cardinal${minor ? ' minor' : ''}`, name, p.x, p.y, -6, -12);
    }
  }
  if (S.view === 'surface' && S.show.azGrid) {
    for (let az = 0; az < 360; az += 30) {
      const p = project(dirOf(30, az));
      if (p) label(`g-${az}`, 'grid', `${az}°`, p.x, p.y, 3, 0);
    }
  }
  for (const el of labelEls.values()) if (!el.dataset.used) el.hidden = true;

  // Selection pointer.
  const sv = selView();
  const ptr = $('pointer');
  const p = sv && project(sv);
  ptr.hidden = !p;
  if (p) ptr.style.left = `${p.x}px`, ptr.style.top = `${p.y}px`;
}

function selView() {
  if (!S.sel || !frameState) return null;
  if (S.sel.kind === 'body') return frameState.bodies.find((b) => b.id === S.sel.id)?.view ?? null;
  if (S.sel.kind === 'star') return sky.starView(S.sel.i);
  if (S.sel.kind === 'const') return sky.viewOf(sky.constLabels.find((c) => c.id === S.sel.id).v);
  return null;
}

// ---------- picking ----------
function pickSky(x, y) {
  if (!frameState) return;
  let best = null;
  const consider = (sel, v, mag) => {
    const p = project(v);
    if (!p || hidden(v)) return;
    const d = Math.hypot(p.x - x, p.y - y);
    const score = d - Math.max(0, 6 - mag) * 1.5;
    if (d < 18 && (!best || score < best.score)) best = { sel, score };
  };
  for (const b of frameState.bodies) consider({ kind: 'body', id: b.id }, b.view, b.id === 'sun' || b.id === 'earth' ? -30 : b.mag);
  const lim = sky.starUniforms.magLimit.value;
  if (S.show.stars) for (let i = 0; i < sky.stars.mag.length && sky.stars.mag[i] <= lim; i++) consider({ kind: 'star', i }, sky.starView(i), sky.stars.mag[i]);
  select(best?.sel ?? null);
}

function select(sel) {
  S.sel = sel;
  lastInfo = 0;
  riseCache = null;
}

// ---------- object information (top left) ----------
let riseCache = null;
function siteRiseSet(id) {
  const key = `${id}|${S.site.lat}|${S.site.lon}|${Math.floor(S.t / 3600e3)}`;
  if (riseCache?.key === key) return riseCache.v;
  if (riseCache?.pending === key) return null;
  riseCache = { pending: key };
  setTimeout(() => {
    const sky = (az) => (S.show.ground ? surface.landscape.horizonAt(az) : 0);
    const v = riseSet({ ...S.site, hM: S.siteH + EYE_M }, new Date(S.t), sky, id, 32);
    riseCache = { key, v };
    lastInfo = 0;
  }, 30);
  return null;
}

function renderInfo() {
  const el = $('info');
  if (!frameState) return;
  const lines = [];
  let title = '';
  if (S.sel?.kind === 'body') {
    const b = frameState.bodies.find((x) => x.id === S.sel.id);
    title = esc(b.name);
    const typ = b.id === 'sun' ? 'star' : b.id === 'earth' ? 'planet (home)' : 'planet';
    lines.push(`<b>Type:</b> ${typ}`);
    lines.push(`<b>Magnitude:</b> ${b.mag.toFixed(2)}${b.id === 'earth' ? ' (approximate)' : ''}`);
    lines.push(`<b>RA/Dec (J2000.0):</b> ${hms(b.ra)}/${dms(b.dec)}`);
    if (S.view === 'surface') lines.push(`<b>Az./Alt.:</b> ${dms(b.az, false)}/${dms(b.alt)}`);
    lines.push(`<b>Distance:</b> ${fmtKm(b.distKm)}`);
    lines.push(`<b>Apparent diameter:</b> ${b.angDiamDeg > 0.1 ? dms(b.angDiamDeg, false) : `${(b.angDiamDeg * 3600).toFixed(2)}"`}`);
    if (b.illum !== undefined) lines.push(`<b>Phase angle:</b> ${b.phaseAngle.toFixed(1)}° · <b>Illuminated:</b> ${(b.illum * 100).toFixed(1)}%`);
    if (b.id === 'earth') {
      lines.push(`<b>Facing you:</b> ${fmtLat(b.subObserver.lat)} ${fmtLon(b.subObserver.lon)} on Earth`);
      lines.push(`<b>Noon on Earth at:</b> ${fmtLat(b.subSolar.lat)} ${fmtLon(b.subSolar.lon)}`);
    }
    if (S.view === 'surface' && (b.id === 'sun' || b.id === 'earth')) {
      const hz = S.show.ground ? surface.landscape.horizonAt(b.az) : 0;
      const lit = b.alt + (b.id === 'sun' ? 0.27 : 0.95) > hz;
      lines.push(`<b>Terrain horizon in that direction:</b> ${hz.toFixed(2)}°, so <span class="hl">${lit ? (b.id === 'sun' ? 'Sun is up' : 'Earth in view') : (b.id === 'sun' ? 'Sun is below the skyline' : 'Earth hidden')}</span>`);
      const rs = siteRiseSet(b.id);
      if (rs) {
        const nm = b.id === 'sun' ? 'Sun' : 'Earth';
        if (rs.nextRise) lines.push(`<b>Next ${nm.toLowerCase()}rise here:</b> ${fmtShort(rs.nextRise.t)}`);
        if (rs.nextSet) lines.push(`<b>Next ${nm.toLowerCase()}set here:</b> ${fmtShort(rs.nextSet.t)}`);
        if (!rs.nextRise && !rs.nextSet) lines.push(`<b>${nm}:</b> ${rs.up ? 'stays above the skyline' : 'stays below the skyline'} for the next 32 days`);
      } else lines.push('<b>Rise/set:</b> calculating');
    }
  } else if (S.sel?.kind === 'star') {
    const i = S.sel.i, st = sky.stars;
    const n = st.names[st.hip[i]] ?? {};
    const cname = sky.constLabels.find((c) => c.id === n.c)?.name;
    title = `${esc(n.name || n.desig || `HIP ${st.hip[i]}`)} <small>${[n.name && n.desig, `HIP ${st.hip[i]}`, n.hd].filter(Boolean).map(esc).join(' - ')}</small>`;
    lines.push('<b>Type:</b> star');
    lines.push(`<b>Magnitude:</b> ${st.mag[i].toFixed(2)} · <b>Color Index (B-V):</b> ${st.bv[i].toFixed(2)}`);
    lines.push(`<b>RA/Dec (J2000.0):</b> ${hms(st.ra[i])}/${dms(st.dec[i])}`);
    if (S.view === 'surface') { const a = altAzOf(sky.starView(i)); lines.push(`<b>Az./Alt.:</b> ${dms(a.az, false)}/${dms(a.alt)}`); }
    if (cname) lines.push(`<b>Constellation:</b> ${esc(cname)}`);
  } else if (S.sel?.kind === 'const') {
    const c = sky.constLabels.find((x) => x.id === S.sel.id);
    title = esc(c.name);
    lines.push('<b>Type:</b> constellation');
    lines.push(`<b>RA/Dec (J2000.0):</b> ${hms(c.ra)}/${dms(c.dec)}`);
  } else if (S.view === 'orbit') {
    const sp = subPoints(frameState.date);
    const ph = moonPhase(frameState.date);
    const illum = Astronomy.Illumination(Astronomy.Body.Moon, Astronomy.MakeTime(frameState.date)).phase_fraction;
    const lib = Astronomy.Libration(Astronomy.MakeTime(frameState.date));
    const phaseName = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'][Math.round(ph / 45) % 8];
    title = 'Moon <small>orbit view</small>';
    lines.push(`<b>Phase seen from Earth:</b> ${phaseName} (${(illum * 100).toFixed(1)}% lit, elongation ${ph.toFixed(1)}°)`);
    lines.push(`<b>Sun overhead at:</b> ${fmtLat(sp.sun.lat)} ${fmtLon(sp.sun.lon)}`);
    lines.push(`<b>Earth overhead at:</b> ${fmtLat(sp.earth.lat)} ${fmtLon(sp.earth.lon)} (libration ${lib.elon.toFixed(2)}°, ${lib.elat.toFixed(2)}°)`);
    lines.push(`<b>Earth-Moon distance:</b> ${fmtKm(lib.dist_km)}`);
    lines.push('<b>Click</b> anywhere on the Moon to stand there.');
  }
  el.hidden = !title;
  if (title) el.innerHTML = `<h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}`;
}

function renderStatus() {
  const s = S.site;
  $('stLocation').textContent = S.view === 'surface'
    ? `Moon, ${s.name}, ${fmtLat(s.lat)} ${fmtLon(s.lon)}, ${Math.round(S.siteH)} m`
    : 'Moon, orbit view';
  const fov = S.view === 'surface' ? surface.view.fov : globe.camera.fov;
  $('stFov').textContent = `FOV ${fov.toFixed(fov < 10 ? 2 : 1)}°`;
  $('stFps').textContent = `${fps.toFixed(1)} FPS`;
  $('stTime').textContent = fmtUTC(new Date(S.t));
  $('stRate').textContent = S.paused ? 'paused' : S.rate === 1 ? '' : `time ×${S.rate.toLocaleString('en')}`;
  $('tPlay').classList.toggle('on', !S.paused && S.rate === 1);
}

// ---------- orbit view ----------
function orbitMarkers() {
  const sp = subPoints(new Date(S.t));
  globe.setMarkers([
    { lat: sp.sun.lat, lon: sp.sun.lon, icon: 'S', level: '', title: 'Sun overhead', label: true },
    { lat: sp.earth.lat, lon: sp.earth.lon, icon: 'E', level: 'info', title: 'Earth overhead', label: true },
    { lat: S.site.lat, lon: S.site.lon, icon: '', level: 'ok', title: S.site.name, label: true },
  ]);
}

function setView(view) {
  S.view = view;
  $('app').dataset.view = view;
  $('viewTxt').textContent = view === 'surface' ? 'Orbit view' : 'Stand on the surface';
  $('spot').hidden = true;
  if (view === 'surface') {
    globe.setMarkers(null);
    surface.setActive(true);
    for (const p of globe.pins) p.el.hidden = true;
  } else {
    surface.setActive(false);
    globe.cam.enabled = true;
    globe.cam.flyTo({ target: llToWorld(S.site.lat, S.site.lon), dist: 2.2, tilt: 0, heading: 0, ms: 1600 });
    orbitMarkers();
  }
  select(null);
  lastInfo = 0;
}
globe.onSurfaceClick = ({ lat, lon }) => spotPopup(lat, lon);
globe.onPick = (site) => spotPopup(site.lat, site.lon, site.name);
function spotPopup(lat, lon, name) {
  if (S.view !== 'orbit') return;
  const date = new Date(S.t);
  const obs = observerAt(date, { lat, lon, hM: 0 });
  const b = solarSystem(obs);
  const sun = b.find((x) => x.id === 'sun'), earth = b.find((x) => x.id === 'earth');
  const el = $('spot');
  el.innerHTML = `<b>${esc(name ?? 'Spot on the Moon')}</b>${fmtLat(lat)} ${fmtLon(lon)}<br>
    Sun ${sun.alt.toFixed(1)}° ${sun.alt > 0 ? 'above' : 'below'} the horizon<br>
    Earth ${earth.alt.toFixed(1)}° ${earth.alt > 0 ? 'above' : 'below'} the horizon<br>
    <span style="color:#999">(flat horizon; standing there uses the real terrain)</span><br>
    <button type="button">Stand here</button> <button type="button" data-act="report">Site report</button>`;
  const p = globe.camera.position.clone();
  const w = llToWorld(lat, lon, 1).project(globe.camera);
  void p;
  el.style.left = `${Math.min(window.innerWidth - 260, ((w.x + 1) / 2) * window.innerWidth + 12)}px`;
  el.style.top = `${Math.min(window.innerHeight - 180, ((1 - w.y) / 2) * window.innerHeight + 12)}px`;
  el.hidden = false;
  el.querySelector('button').addEventListener('click', () => setSite({ name: name ?? `${fmtLat(lat)} ${fmtLon(lon)}`, lat, lon }, true));
  el.querySelector('[data-act="report"]').addEventListener('click', () => {
    repTarget = { name: name ?? `${fmtLat(lat)} ${fmtLon(lon)}`, lat, lon };
    lastGng = 0;
    openWin('report', false);
  });
}

// ---------- location ----------
let siteJob = 0;
async function setSite(site, stand = false, look = true) {
  const job = ++siteJob;
  S.site = { name: site.name, lat: +site.lat, lon: +site.lon };
  store.set('site', S.site);
  repTarget = null;
  lastGng = 0; lastRep = 0;
  select(null);
  $('busy').hidden = false;
  $('busyTitle').textContent = `Building the landscape at ${S.site.name}`;
  $('busyText').textContent = 'Loading NASA LOLA terrain';
  $('busyBar').style.width = '5%';
  try {
    await terrainReady;
    albedo ??= await loadAlbedo('textures/lroc_color_4k.jpg').catch(() => null);
    // Named places carry a close-up of the finest NASA heights around them.
    const known = [...PLACES, ...SITES].find((p) => Math.abs(p.lat - S.site.lat) < 1e-4 && Math.abs(p.lon - S.site.lon) < 1e-4);
    const close = await loadCloseUp(known).catch(() => null);
    await surface.landscape.build(terrain, S.site, albedo, (f) => {
      $('busyBar').style.width = `${Math.round(f * 100)}%`;
      $('busyText').textContent = f < 0.4 ? 'Height grid' : f < 0.62 ? 'Small craters close to you' : f < 0.8 ? 'Skyline out to 150 km' : 'Ground and rocks';
    }, close);
    if (job !== siteJob) return;
    S.siteH = surface.landscape.h0;
    lastLight = 0;
    if (stand && S.view !== 'surface') setView('surface');
    if (look) lookAround();
    syncLocationWindow();
  } catch (err) {
    console.error(err);
    toast(`Could not build the landscape: ${err.message}`);
  } finally {
    if (job === siteJob) $('busy').hidden = true;
  }
}

// Face Earth if it is up, else the Sun if it is up, else the brightest part of the sky to the south.
function lookAround() {
  const obs = observerAt(new Date(S.t), { ...S.site, hM: S.siteH + EYE_M });
  const b = solarSystem(obs);
  const earth = b.find((x) => x.id === 'earth'), sun = b.find((x) => x.id === 'sun');
  const pick = earth.alt > -1 ? earth : sun.alt > -1 ? sun : null;
  if (pick) surface.lookAt(Math.min(35, Math.max(8, pick.alt * 0.55)), pick.az, Math.max(60, Math.min(100, pick.alt * 1.6 + 20)));
  else surface.lookAt(12, S.site.lat < 0 ? 0 : 180, 70);
}

// ---------- site report ----------
// Conditions at a spot (where you stand, or a spot picked in orbit view) with go / no-go lights,
// the next 30 days, a slope and shadow map of the ground around it, and live space weather.
let env = null;
loadEnv().then((e) => { env = e; lastGng = 0; });
let swData = null, swAt = 0, lastGng = 0, lastRep = 0;
function refreshSpaceWeather() {
  if (Date.now() - swAt < 5 * 60e3) return;
  swAt = Date.now();
  spaceWeather().then((v) => { swData = v; lastGng = 0; lastRep = 0; }).catch(() => { swData = { ok: false }; });
}
// Live feeds describe the present; within a few hours of now they apply.
const isLive = () => Math.abs(S.t - Date.now()) < 3 * 3600e3;
let repTarget = null; // a spot picked in orbit view; null means where you stand
const target = () => repTarget ?? S.site;
const builtHere = (t) => !!surface?.landscape?.ready && surface.landscape.site.lat === t.lat && surface.landscape.site.lon === t.lon;
const skylineFor = (t) => (builtHere(t) && S.show.ground ? (az) => surface.landscape.horizonAt(az) : () => 0);
const fmtC = (c) => `${c > 0 ? '+' : ''}${Math.round(c)} °C`;
const fmtIn = (ms) => { const h = ms / 3600e3; return h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} days`; };

let tlCache = null;
function monthAhead(t) {
  const h0 = Math.floor(S.t / 3600e3) * 3600e3;
  const key = `${t.lat},${t.lon},${h0},${builtHere(t)},${S.show.ground}`;
  if (tlCache?.key === key) return tlCache.v;
  const v = timeline(env, t, new Date(h0), { days: 30, stepH: 1, skyline: skylineFor(t) });
  tlCache = { key, v };
  return v;
}

function conditions(t) {
  const date = new Date(S.t);
  const sp = subPoints(date);
  const built = builtHere(t);
  const obs = observerAt(date, { lat: t.lat, lon: t.lon, hM: (built ? S.siteH : 0) + EYE_M });
  const bodies = solarSystem(obs);
  const sun = bodies.find((x) => x.id === 'sun'), earth = bodies.find((x) => x.id === 'earth');
  const sky = skylineFor(t);
  const sunAbove = sun.alt + 0.27 > sky(sun.az);
  // The exact spot can sit in the shadow of a nearby rise even with the Sun above the skyline.
  const lit = built && sunAbove ? surface.landscape.sunlit(0, 0, 0.3, sun) : sunAbove ? 1 : 0;
  const sunUp = lit > 0.5;
  const earthMargin = earth.alt - sky(earth.az);
  const earthUp = earthMargin + 0.95 > 0;
  const hour = localHour(date, t.lon, sp);
  const temp = temperatureK(env, t.lat, t.lon, hour);
  const tl = monthAhead(t);
  const next = (pred) => tl.find((r, k) => k > 0 && pred(r))?.t ?? null;
  const ev = {
    sunset: tl[0].sunUp ? next((r) => !r.sunUp) : null, sunrise: !tl[0].sunUp ? next((r) => r.sunUp) : null,
    earthSet: tl[0].earthUp ? next((r) => !r.earthUp) : null, earthRise: !tl[0].earthUp ? next((r) => r.earthUp) : null,
    tailIn: !tl[0].tail ? next((r) => r.tail) : null, tailOut: tl[0].tail ? next((r) => !r.tail) : null,
  };
  const slope = built ? surface.landscape.slopeAt(0, 0) : terrain ? terrain.surface(t.lat, t.lon).slope : null;
  const rocks = rockFraction(env, t.lat, t.lon);
  const temps = tl.map((r) => r.tempK).filter((k) => k != null);
  const sunHours14 = tl.slice(0, 14 * 24).filter((r) => r.sunUp).length;
  const a = assess({ sunUp, sunAlt: sun.alt, setsInH: ev.sunset ? (ev.sunset - S.t) / 3600e3 : null, tempC: temp ? temp.k - K0 : null,
    earthUp, earthAlt: earth.alt, earthMargin, slope, rocks, sw: swData, live: isLive() });
  return { t, date, sun, earth, sunAbove, lit, sunUp, earthMargin, earthUp, hour, temp, tl, ev, slope, built, rocks, temps, sunHours14, a };
}
const K0 = 273.15;

// The height model under the current landscape, as named in tools/fetch_closeups.py.
const heightSource = () => surface.landscape.close?.source.replace(/ \(.*\)$/, '') ?? 'LOLA global heights';
const STATUS = { go: 'GO', caution: 'CAUTION', nogo: 'NO GO', none: 'N/A' };
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const latLonShort = (t) => `${Math.abs(t.lat).toFixed(3)}${t.lat < 0 ? 'S' : 'N'} ${Math.abs(t.lon).toFixed(3)}${t.lon < 0 ? 'W' : 'E'}`;

function renderGng() {
  const el = $('gng');
  if (!env || !frameState || !terrain) { el.hidden = true; return; }
  const t = target(), c = conditions(t);
  el.hidden = false;
  el.innerHTML = `<div class="head"><span>${esc(t.name.split(',')[0])}</span><span class="s ${c.a.overall}">${STATUS[c.a.overall]}</span></div>
    <table>${c.a.items.map((r) => `<tr><td>${r.label}</td><td class="v">${esc(r.reading)}</td><td><span class="s ${r.level}">${STATUS[r.level]}</span></td></tr>`).join('')}</table>
    <div class="more">Site report (R)</div>`;
}
$('gng').addEventListener('click', () => openWin('report', false));

// Real images of the place: NASA photos and renders for the named places (tools/site_images.py),
// and for any spot the LRO wide angle camera mosaic around it.
let siteImgs = null;
fetch('sites/index.json').then((r) => r.json()).then((v) => { siteImgs = v; lastRep = 0; }).catch(() => { siteImgs = {}; });
const knownPlace = (t) => [...PLACES, ...SITES].find((p) => Math.abs(p.lat - t.lat) < 1e-4 && Math.abs(p.lon - t.lon) < 1e-4);
const tileImgs = new Map();
function tileImage(r, c) {
  const k = `${r}_${c}`;
  if (!tileImgs.has(k)) {
    tileImgs.set(k, new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = `textures/globe/c${k}_c.jpg`; }));
  }
  return tileImgs.get(k);
}
// The 22.5 deg colour tiles of the CGI Moon Kit mosaic (399 m per pixel), drawn into a canvas
// centred on the spot, north up, with the spot marked and a 10 km scale bar.
async function drawWac(canvas, t, halfKm) {
  const ctx = canvas.getContext('2d'), N = canvas.width;
  const dLat = halfKm / ((MOON_R_KM * Math.PI) / 180), dLon = dLat / Math.max(0.1, Math.cos(t.lat * Math.PI / 180));
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  const lat0 = t.lat + dLat, lon0 = t.lon - dLon;
  const px = (lon) => ((lon - lon0) / (2 * dLon)) * N, py = (lat) => ((lat0 - lat) / (2 * dLat)) * N;
  const jobs = [];
  for (let r = 0; r < 8; r++) {
    const top = 90 - r * 22.5, bot = top - 22.5;
    if (bot > lat0 || top < t.lat - dLat) continue;
    for (let c = 0; c < 16; c++) {
      for (const wrap of [-360, 0, 360]) {
        const west = -180 + c * 22.5 + wrap, east = west + 22.5;
        if (east < lon0 || west > t.lon + dLon) continue;
        jobs.push(tileImage(r, c).then((im) => { if (im) ctx.drawImage(im, px(west), py(top), px(east) - px(west), py(bot) - py(top)); }));
      }
    }
  }
  await Promise.all(jobs);
  ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(N / 2 - 12, N / 2); ctx.lineTo(N / 2 - 4, N / 2); ctx.moveTo(N / 2 + 4, N / 2); ctx.lineTo(N / 2 + 12, N / 2);
  ctx.moveTo(N / 2, N / 2 - 12); ctx.lineTo(N / 2, N / 2 - 4); ctx.moveTo(N / 2, N / 2 + 4); ctx.lineTo(N / 2, N / 2 + 12); ctx.stroke();
  const bar = (10 / (2 * halfKm)) * N;
  ctx.fillStyle = '#fff'; ctx.fillRect(10, N - 14, bar, 3);
  ctx.font = '11px monospace'; ctx.fillText('10 km', 10, N - 18); ctx.fillText('N', N - 16, 16);
}

let imgKey = '';
function renderImagery(t) {
  const key = `${t.lat},${t.lon},${!!siteImgs}`;
  if (key === imgKey) return;
  imgKey = key;
  const id = knownPlace(t)?.id, list = (id && siteImgs?.[id]) || [];
  const polar = Math.abs(t.lat) > 80;
  const photo = (p, i) => `<figure class="${i ? 'alt' : ''}" data-i="${i}"><img src="sites/${p.file}" alt="${esc(p.caption)}" loading="lazy"><figcaption>${esc(p.caption)}<br><span>${p.kind === 'photo' ? 'Photograph' : p.kind === 'map' ? 'Map' : 'View rendered from spacecraft data'}. ${esc(p.credit)}.</span></figcaption></figure>`;
  $('repImg').innerHTML = `<div class="imgs">
    ${list.length ? `<div class="photos">${photo(list[0], 0)}${list.length > 1 ? `<div class="thumbs">${list.map((p, i) => `<button type="button" data-i="${i}"><img src="sites/${p.file}" alt=""></button>`).join('')}</div>` : ''}</div>` : ''}
    <figure class="wac">${polar ? '<div class="nowac">The mosaic is not usable this close to the pole: the low Sun leaves most of the ground in shadow in every image.</div>' : '<canvas width="300" height="300"></canvas>'}
      <figcaption>LRO Wide Angle Camera mosaic, ${polar ? '' : '80 km around the spot, '}north up.<br><span>NASA/GSFC/Arizona State University, via the NASA SVS CGI Moon Kit.</span></figcaption></figure>
  </div>`;
  if (!polar) drawWac($('repImg').querySelector('canvas'), t, 40);
  $('repImg').querySelectorAll('.thumbs button').forEach((b) => b.addEventListener('click', () => {
    $('repImg').querySelector('.photos figure').outerHTML = photo(list[+b.dataset.i], 0);
  }));
}

function renderReport() {
  if (!env || !frameState || !terrain) { $('repBody').innerHTML = '<p>Loading data</p>'; return; }
  const t = target(), c = conditions(t);
  $('repTitle').textContent = `Site report: ${t.name}`;
  if (!$('repBody').querySelector('.rep')) {
    imgKey = '';
    $('repBody').innerHTML = `<div class="rep">
      <div class="hdr" id="repHdr"></div>
      <section><h3>Status</h3><div id="repLights"></div></section>
      <section><h3>Imagery</h3><div id="repImg"></div></section>
      <section><h3>Conditions</h3><div id="repFacts"></div></section>
      <section><h3>30-day outlook</h3><div id="repTl"></div><p class="note">Click the chart to set the time. Rows: Sun above local skyline; Earth in view; Moon inside Earth's magnetotail. Line: surface temperature (Diviner).</p></section>
      <section><h3>Local terrain</h3><div id="repMap"></div></section>
      <section><h3>Space weather</h3><div id="repSw"></div></section>
      <details class="note"><summary>Data sources and limits</summary><p id="repNotes"></p></details>
    </div>`;
    $('repTl').addEventListener('click', (e) => {
      const svg = $('repTl').querySelector('svg');
      if (!svg || !tlCache) return;
      const r = svg.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left) / r.width) * 764 - 40);
      if (i < 0) return;
      const row = tlCache.v[Math.max(0, Math.min(tlCache.v.length - 1, i))];
      S.t = row.t; lastLight = 0; riseCache = null; lastRep = 0; lastGng = 0;
    });
    $('repMap').addEventListener('click', (e) => { if (e.target.dataset.act === 'stand') setSite(target(), true); });
  }
  const at = (ms) => (ms ? `${fmtShort(new Date(ms))} (T+${fmtIn(ms - S.t)})` : '');
  $('repHdr').innerHTML = `<span><b>SITE</b>${esc(t.name)}</span><span><b>POS</b>${latLonShort(t)}</span>${c.built ? `<span><b>ELEV</b>${Math.round(S.siteH)} m</span>` : ''}<span><b>TIME</b>${fmtShort(c.date)}</span><span><b>LST</b>${hhmm(c.hour)}</span><span class="s ${c.a.overall}">${STATUS[c.a.overall]}</span>`;
  $('repLights').innerHTML = `<table class="st"><tr><th>Item</th><th>Reading</th><th>Limit</th><th>Status</th></tr>
    ${c.a.items.map((r) => `<tr><td>${r.label}</td><td class="v">${esc(r.reading)}</td><td class="lim">${esc(r.limit)}</td><td><span class="s ${r.level}">${STATUS[r.level]}</span></td></tr>`).join('')}</table>`;
  renderImagery(t);
  const tmin = Math.min(...c.temps) - K0, tmax = Math.max(...c.temps) - K0;
  const row = (k, v, note = '') => `<tr><td>${k}</td><td class="v">${v}</td><td class="lim">${note}</td></tr>`;
  $('repFacts').innerHTML = `<table class="st facts">
    ${row('Sun', `el ${c.sun.alt.toFixed(1)}°  az ${c.sun.az.toFixed(0)}°`, c.sunAbove && !c.sunUp ? 'spot shadowed by nearby ground' : '')}
    ${c.tl[0].sunUp ? row('Sunset', c.ev.sunset ? at(c.ev.sunset) : 'none in 30 d', c.ev.sunset ? '' : 'continuous sunlight') : row('Sunrise', c.ev.sunrise ? at(c.ev.sunrise) : 'none in 30 d', c.ev.sunrise ? '' : 'continuous darkness')}
    ${row('Sunlight, 14 d', `${c.sunHours14} / 336 h`, 'solar power')}
    ${row('Earth', `el ${c.earth.alt.toFixed(1)}°  ${c.earthUp ? 'in view' : 'hidden'}`, c.ev.earthSet ? `sets ${at(c.ev.earthSet)}` : c.ev.earthRise ? `rises ${at(c.ev.earthRise)}` : 'in view all month')}
    ${row('Surface temp', c.temp ? fmtC(c.temp.k - K0) : 'n/a', c.temp ? `${fmtC(tmin)} to ${fmtC(tmax)} over 30 d; ${esc(c.temp.src)}` : '')}
    ${row('Rocks >1 m', c.rocks != null ? `${(c.rocks * 100).toFixed(1)}%` : 'n/a', c.rocks != null ? 'area covered; typical mare 0.5% (Diviner)' : 'Diviner map covers 60S to 60N')}
    ${row('Slope', c.slope != null ? `${c.slope.toFixed(1)}°` : 'n/a', c.built ? `over ${Math.round(surface.landscape.grid.cell * 2)} m, ${heightSource()}` : 'coarse; stand here for the measured value')}
    ${row('Magnetotail', c.tl[0].tail ? 'inside' : 'outside', c.tl[0].tail ? `leaves ${at(c.ev.tailOut)}` : c.ev.tailIn ? `enters ${at(c.ev.tailIn)}` : '')}
  </table>`;
  $('repTl').innerHTML = timelineSvg(c.tl);
  renderHazardMap(c);
  renderSpaceWeather(c);
  $('repNotes').innerHTML = `Surface temperature: LRO Diviner Global Cumulative Product, bolometric temperature by local solar time, 2009 to 2015 (Williams et al. 2017); values are bin averages, so a shadowed floor inside a bin is colder and a Sun-facing slope warmer. Rocks: Diviner rock abundance (Bandfield et al. 2011). Heights: LOLA and SLDEM2015. Sun and Earth: astronomy-engine. Space weather: NOAA SWPC GOES feeds and NASA DONKI, live. Imagery: NASA SVS (LRO, Lunar Orbiter). Limits are planning values chosen for this prototype (suit range about -160 to +120 °C; landing slope 8°, hard limit 15°), not an agency standard.`;
}

function timelineSvg(tl) {
  // 720 hours across, after a gutter for the row names.
  const G = 40, W = 720, rowY = { sun: 14, earth: 30, tail: 44 }, top = 58, H = 170, tH = H - top - 18;
  const yT = (c) => top + tH * (1 - (c + 200) / 340);
  let sun = '', earth = '', tail = '', line = '';
  tl.forEach((r, i) => {
    if (i >= W) return;
    const x = G + i;
    if (r.sunUp) sun += `M${x},${rowY.sun}h1`;
    if (r.earthUp) earth += `M${x},${rowY.earth}h1`;
    if (r.tail) tail += `M${x},${rowY.tail}h1`;
    if (r.tempK != null) line += `${line ? 'L' : 'M'}${x},${yT(r.tempK - K0).toFixed(1)}`;
  });
  let ticks = '';
  for (let d = 0; d <= 30; d++) {
    const x = G + d * 24;
    ticks += `<path d="M${x},${top - 4}v${tH + 8}" stroke="${d % 5 ? '#2c2c30' : '#444'}" stroke-width="1"/>`;
    if (d % 5 === 0 && d < 30) ticks += `<text x="${x + 3}" y="${H - 4}" fill="#999" font-size="10">${fmtShort(new Date(tl[0].t + d * DAY)).slice(5, 10)}</text>`;
  }
  const lab = (y, t) => `<text x="${G - 5}" y="${y + 3.5}" fill="#aaa" font-size="10" text-anchor="end">${t}</text>`;
  return `<svg class="tl" viewBox="0 0 ${G + W + 4} ${H}" role="img" aria-label="Sunlight, Earth visibility, magnetotail and temperature over the next 30 days">
    ${ticks}
    <rect x="${G}" y="${yT(100)}" width="${W}" height="${yT(-100) - yT(100)}" fill="rgba(63,191,106,0.10)"/>
    ${lab(rowY.sun, 'Sun')}${lab(rowY.earth, 'Earth')}${lab(rowY.tail, 'Tail')}${lab(yT(100), '+100°')}${lab(yT(0), '0°C')}${lab(yT(-100), '-100°')}
    <path d="${sun}" stroke="#f2c14e" stroke-width="10"/><path d="${earth}" stroke="#5aa0e8" stroke-width="10"/><path d="${tail}" stroke="#9b6bd6" stroke-width="6"/>
    <path d="${line}" fill="none" stroke="#ff8a5c" stroke-width="1.8"/>
    <path d="M${G + 0.5},4v${H - 12}" stroke="#fff" stroke-width="1.5"/><text x="${G + 4}" y="${top - 6}" fill="#fff" font-size="9">now</text>
  </svg>`;
}

// Slope classes from the measured heights and the shadows of the Sun at this moment, north up.
let mapJob = 0, mapKey = '';
function renderHazardMap(c) {
  const box = $('repMap');
  if (!c.built) {
    mapKey = '';
    box.innerHTML = '<p class="note">Needs the local terrain model. <button type="button" class="link" data-act="stand">Stand here</button></p>';
    return;
  }
  const L = surface.landscape, R = Math.min(4000, L.grid.Rg * 0.6), N = 160;
  const key = `${c.t.lat},${c.t.lon},${c.sun.alt.toFixed(1)},${c.sun.az.toFixed(1)},${R}`;
  if (key === mapKey && box.querySelector('canvas')) return;
  mapKey = key;
  box.innerHTML = `<div class="map"><canvas width="${N}" height="${N}" aria-label="Slope and shadow map"></canvas><div class="key">
    <span><i style="background:#3fbf6a"></i>slope under 8°</span>
    <span><i style="background:#f0b429"></i>8 to 15°</span>
    <span><i style="background:#e5533f"></i>over 15°</span>
    <span><i style="background:#222"></i>in shadow at this time</span>
    <span class="note">${(2 * R / 1000).toFixed(0)} x ${(2 * R / 1000).toFixed(0)} km, north up, spot at centre. Slopes over ${Math.round(L.grid.cell * 2)} m baselines from ${heightSource()}; shadows traced for the Sun at this time.</span></div></div>`;
  const ctx = box.querySelector('canvas').getContext('2d');
  const img = ctx.createImageData(N, N);
  const job = ++mapJob, sun = c.sun;
  let row = 0;
  const step = () => {
    if (job !== mapJob) return;
    for (const end = Math.min(N, row + 16); row < end; row++) {
      for (let col = 0; col < N; col++) {
        const x = -R + ((col + 0.5) / N) * 2 * R, y = R - ((row + 0.5) / N) * 2 * R;
        const s = L.slopeAt(x, y);
        const base = s < 8 ? [63, 191, 106] : s < 15 ? [240, 180, 41] : [229, 83, 63];
        const lit = sun.alt > -1 ? L.sunlit(x, y, L.gridAt(x, y) + 0.3, sun) : 0;
        const k = 0.28 + 0.72 * lit;
        const i = (row * N + col) * 4;
        img.data[i] = base[0] * k; img.data[i + 1] = base[1] * k; img.data[i + 2] = base[2] * k; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(N / 2, N / 2, 2.5, 0, 2 * Math.PI); ctx.fill();
    if (row < N) setTimeout(step, 0);
  };
  step();
}

function renderSpaceWeather(c) {
  const box = $('repSw');
  const base = '<p class="note">Background dose on the surface from galactic cosmic rays: about 1.4 mSv per day (Chang\'e 4 LND, Zhang et al. 2020). A solar proton event can exceed this within hours.</p>';
  if (!isLive()) { box.innerHTML = `<p class="note">Live data apply to the present only (press 8 for now). Solar events cannot be forecast beyond about 3 days.</p>${base}`; return; }
  refreshSpaceWeather();
  const sw = swData;
  if (!sw) { box.innerHTML = `<p class="note">Fetching NOAA SWPC and NASA DONKI</p>${base}`; return; }
  if (!sw.ok) { box.innerHTML = `<p class="note">NOAA SWPC and NASA DONKI feeds not reachable from this browser.</p>${base}`; return; }
  const s = sScale(sw.protons ?? 0);
  const row = (k, v, n = '') => `<tr><td>${k}</td><td class="v">${v}</td><td class="lim">${n}</td></tr>`;
  box.innerHTML = `<table class="st facts">
    ${row('Protons >10 MeV', `${(sw.protons ?? 0).toFixed(2)} pfu`, `24 h max ${(sw.protonsMax ?? 0).toFixed(2)}; ${s ? `S${s} storm` : 'below S1 (10 pfu)'}`)}
    ${row('X-ray flux', flareClass(sw.xray), `24 h max ${flareClass(sw.xrayMax)}`)}
    ${sw.flares ? row('M/X flares, 7 d', sw.flares.length ? sw.flares.map((f) => esc(f.cls)).join(' ') : 'none') : ''}
    ${sw.seps ? row('SEP events, 7 d', String(sw.seps.length)) : ''}
    ${sw.cmes != null ? row('CMEs, 7 d', String(sw.cmes)) : ''}
    ${sw.s1Next3 ? row('S1+ forecast', sw.s1Next3.map((v) => `${v}%`).join(' / '), 'NOAA, next 3 days') : ''}
  </table><p class="note">GOES data to ${esc(String(sw.protonsAt ?? '').replace('T', ' ').slice(0, 16))} UTC.</p>${base}`;
}

// ---------- windows ----------
function openWin(name, toggle = true) {
  const w = $(`win-${name}`);
  const show = toggle ? w.hidden : true;
  w.hidden = !show;
  document.querySelector(`.leftbar [data-win="${name}"]`)?.classList.toggle('on', show);
  if (show) {
    if (name === 'location') syncLocationWindow();
    if (name === 'datetime') syncDateWindow(true);
    if (name === 'search') { $('searchBox').focus(); renderSearch(); }
    if (name === 'report') renderReport();
    // Bring to front.
    document.querySelectorAll('.win').forEach((x) => { x.style.zIndex = 10; });
    w.style.zIndex = 11;
  }
}
document.querySelectorAll('.leftbar [data-win]').forEach((b) => b.addEventListener('click', () => openWin(b.dataset.win)));
document.querySelectorAll('.win').forEach((w) => {
  w.querySelector('.x').addEventListener('click', () => { w.hidden = true; document.querySelector(`.leftbar [data-win="${w.id.slice(4)}"]`)?.classList.remove('on'); });
  // Drag by the title bar.
  const head = w.querySelector('header');
  let d = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('.x')) return; d = { x: e.clientX - w.offsetLeft, y: e.clientY - w.offsetTop }; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (d) { w.style.left = `${Math.max(0, e.clientX - d.x)}px`; w.style.top = `${Math.max(0, e.clientY - d.y)}px`; } });
  head.addEventListener('pointerup', () => { d = null; });
  w.addEventListener('pointerdown', () => { document.querySelectorAll('.win').forEach((x) => { x.style.zIndex = 10; }); w.style.zIndex = 11; });
});

// Location window.
function syncLocationWindow() {
  $('locName').value = S.site.name;
  $('locLat').value = S.site.lat.toFixed(4);
  $('locLon').value = S.site.lon.toFixed(4);
  $('locAlt').textContent = `Ground height ${Math.round(S.siteH)} m (relative to the 1737.4 km reference sphere, NASA LOLA). Eye height ${EYE_M} m.`;
  placeMapMark($('locMark'), S.site.lat, S.site.lon);
  const sp = subPoints(new Date(S.t));
  placeMapMark($('locSun'), sp.sun.lat, sp.sun.lon);
  placeMapMark($('locEarth'), sp.earth.lat, sp.earth.lon);
  renderLocList();
}
function placeMapMark(el, lat, lon) { el.style.left = `${((lon + 180) / 360) * 100}%`; el.style.top = `${((90 - lat) / 180) * 100}%`; }
$('locMap').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const lon = ((e.clientX - r.left) / r.width) * 360 - 180, lat = 90 - ((e.clientY - r.top) / r.height) * 180;
  $('locLat').value = lat.toFixed(4); $('locLon').value = lon.toFixed(4); $('locName').value = `${fmtLat(lat)} ${fmtLon(lon)}`;
  placeMapMark($('locMark'), lat, lon);
});
function renderLocList() {
  const q = $('locFilter').value.trim().toLowerCase();
  $('locList').innerHTML = ALL_PLACES.filter((p) => !q || p.name.toLowerCase().includes(q))
    .map((p) => `<li data-id="${p.id}"><span>${esc(p.name)}</span><small>${fmtLat(p.lat)} ${fmtLon(p.lon)}</small></li>`).join('');
  $('locList').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    const p = ALL_PLACES.find((x) => x.id === li.dataset.id);
    $('locName').value = p.name; $('locLat').value = p.lat; $('locLon').value = p.lon;
    placeMapMark($('locMark'), p.lat, p.lon);
    $('locList').querySelectorAll('li').forEach((x) => x.classList.toggle('sel', x === li));
  }));
}
$('locFilter').addEventListener('input', renderLocList);
$('locGo').addEventListener('click', () => {
  const lat = parseFloat($('locLat').value), lon = parseFloat($('locLon').value);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast('Latitude must be -90..90 and longitude -180..180.'); return; }
  setSite({ name: $('locName').value || `${fmtLat(lat)} ${fmtLon(lon)}`, lat, lon }, true);
});

// Date/time window: spinners like Stellarium's.
const DT_FIELDS = [['Y', 'year', 4], ['M', 'month', 2], ['D', 'day', 2], ['h', 'hour', 2], ['m', 'minute', 2], ['s', 'second', 2]];
function spinner(key, label, small) {
  return `<div class="spin${small ? ' small' : ''}"><button type="button" data-step="${key}" data-d="1" aria-label="${label} up">▲</button><input id="dt${key}" type="number" aria-label="${label}"><button type="button" data-step="${key}" data-d="-1" aria-label="${label} down">▼</button></div>`;
}
$('dtDate').innerHTML = `${spinner('Y', 'Year')}<span class="dt-sep">/</span>${spinner('M', 'Month', 1)}<span class="dt-sep">/</span>${spinner('D', 'Day', 1)}`;
$('dtTime').innerHTML = `${spinner('h', 'Hour', 1)}<span class="dt-sep">:</span>${spinner('m', 'Minute', 1)}<span class="dt-sep">:</span>${spinner('s', 'Second', 1)}<span class="note">&nbsp;UTC</span>`;
function dtParts() { const d = new Date(S.t); return { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() }; }
function setParts(p) { S.t = Date.UTC(p.Y, p.M - 1, p.D, p.h, p.m, p.s); lastLight = 0; riseCache = null; syncDateWindow(true); }
function syncDateWindow(force) {
  if ($('win-datetime').hidden && !force) return;
  const p = dtParts();
  for (const [k] of DT_FIELDS) { const el = $(`dt${k}`); if (document.activeElement !== el) el.value = k === 'Y' ? p[k] : pad(p[k]); }
  const jd = S.t / DAY + 2440587.5;
  if (document.activeElement !== $('dtJD')) $('dtJD').value = jd.toFixed(5);
  if (document.activeElement !== $('dtMJD')) $('dtMJD').value = (jd - 2400000.5).toFixed(5);
}
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { const p = dtParts(); p[b.dataset.step] += +b.dataset.d; setParts(p); }));
for (const [k] of DT_FIELDS) $(`dt${k}`).addEventListener('change', (e) => { const p = dtParts(); const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) { p[k] = v; setParts(p); } });
$('dtJD').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { S.t = (v - 2440587.5) * DAY; lastLight = 0; } });
$('dtMJD').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { S.t = (v + 2400000.5 - 2440587.5) * DAY; lastLight = 0; } });
$('dtNow').addEventListener('click', () => setNow());

// Sky and viewing options window.
const OPTS = [
  ['Stars', [['stars', 'Show stars'], ['starLabels', 'Star names'], ['magBoost', 'Fainter stars', 'range', -3, 2, 0.1]]],
  ['Solar system', [['planets', 'Show planets'], ['planetLabels', 'Labels for Sun, Earth and planets']]],
  ['Sky', [['milkyWay', 'Milky Way'], ['mwBright', 'Milky Way brightness', 'range', 0, 3, 0.1], ['constLines', 'Constellation lines'], ['constNames', 'Constellation names'], ['eqGrid', 'Equatorial grid (J2000)'], ['ecliptic', 'Ecliptic'], ['azGrid', 'Azimuthal grid']]],
  ['Landscape', [['ground', 'Show ground'], ['cardinals', 'Cardinal points'], ['shadows', 'Terrain shadows from the real Sun'], ['earthshine', 'Earthshine on the night side'], ['bright', 'Bright view: light the night side so the ground can be seen'], ['glare', 'Sunlight glare (hide faint stars in daylight)']]],
];
$('skyOpts').innerHTML = OPTS.map(([title, items]) => `<fieldset><legend>${title}</legend>${items.map(([k, l, type, min, max, step]) => (type === 'range'
  ? `<label>${l}<input type="range" data-opt="${k}" min="${min}" max="${max}" step="${step}"></label>`
  : `<label class="ck"><input type="checkbox" data-opt="${k}">${l}</label>`)).join('')}</fieldset>`).join('');
function syncOpts() {
  document.querySelectorAll('[data-opt]').forEach((el) => {
    const k = el.dataset.opt;
    if (el.type === 'range') el.value = k === 'magBoost' ? S.magBoost : S.mwBright;
    else el.checked = !!S.show[k];
  });
  document.querySelectorAll('[data-toggle]').forEach((b) => b.classList.toggle('on', !!S.show[b.dataset.toggle]));
  $('app').classList.toggle('night', S.show.night);
}
document.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('input', () => {
  const k = el.dataset.opt;
  if (k === 'magBoost') S.magBoost = +el.value; else if (k === 'mwBright') S.mwBright = +el.value; else S.show[k] = el.checked;
  persist();
  if (k === 'shadows' || k === 'earthshine' || k === 'bright') lastLight = 0, surface.landscape.lastSun = null;
}));
function persist() { store.set('show', S.show); store.set('magBoost', S.magBoost); store.set('mwBright', S.mwBright); syncOpts(); }
function toggle(k) { S.show[k] = !S.show[k]; if (k === 'shadows') surface.landscape.lastSun = null; persist(); }
document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.toggle)));

// Search window.
function searchItems() {
  const items = [];
  for (const b of frameState?.bodies ?? []) items.push({ label: b.name, sub: b.id === 'sun' ? 'star' : 'planet', sel: { kind: 'body', id: b.id } });
  const st = sky.stars;
  for (let i = 0; i < st.hip.length; i++) {
    const n = st.names[st.hip[i]];
    if (n?.name) items.push({ label: n.name, sub: `${n.desig || ''} · mag ${st.mag[i].toFixed(1)}`, sel: { kind: 'star', i } });
  }
  for (const c of sky.constLabels) items.push({ label: c.name, sub: 'constellation', sel: { kind: 'const', id: c.id } });
  for (const p of ALL_PLACES) items.push({ label: p.name, sub: 'place on the Moon', place: p });
  return items;
}
function renderSearch() {
  if (!sky) return;
  const q = $('searchBox').value.trim().toLowerCase();
  const c = parseCoords($('searchBox').value);
  let items = searchItems().filter((x) => !q || x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q));
  if (c) items = [{ label: `Stand at ${fmtLat(c.lat)} ${fmtLon(c.lon)}`, sub: 'position on the Moon', place: { name: `${fmtLat(c.lat)} ${fmtLon(c.lon)}`, ...c } }, ...items];
  items = items.slice(0, 40);
  $('searchList').innerHTML = items.map((x, i) => `<li data-i="${i}"><span>${esc(x.label)}</span><small>${esc(x.sub)}</small></li>`).join('');
  $('searchList').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => chooseSearch(items[+li.dataset.i])));
  renderSearch.items = items;
}
function chooseSearch(x) {
  if (x.place) { setSite(x.place, true); return; }
  select(x.sel);
  centerOnSelection();
}
$('searchBox').addEventListener('input', renderSearch);
$('searchBox').addEventListener('keydown', (e) => { if (e.key === 'Enter' && renderSearch.items?.[0]) chooseSearch(renderSearch.items[0]); });

function centerOnSelection() {
  const v = selView();
  if (!v) return;
  if (S.view === 'surface') {
    const { alt, az } = altAzOf(v);
    surface.lookAt(alt, az, S.sel.kind === 'body' && S.sel.id === 'earth' ? Math.min(surface.view.fov, 20) : surface.view.fov);
  }
}

// Data and help windows.
$('configBody').innerHTML = `
  <h3>Where the numbers come from</h3>
  <table>
    <tr><th>What</th><th>Source</th><th>Accuracy</th></tr>
    <tr><td>Sun, Earth, planets</td><td>astronomy-engine: VSOP87 planetary theory, ELP/MPP02 lunar theory, IAU 2006 precession, nutation</td><td>under 1 arcminute (Sun, planets); Moon position about 1 arcminute</td></tr>
    <tr><td>Moon's orientation</td><td>IAU/WGCCRE rotation model for the Moon (pole and prime meridian, with periodic terms)</td><td>about 0.01 to 0.1°</td></tr>
    <tr><td>Earth's rotation and face</td><td>Greenwich apparent sidereal time, precession and nutation</td><td>under 0.01°</td></tr>
    <tr><td>Stars</td><td>Hipparcos catalogue to magnitude 7.5 (25,723 stars), names from IAU WGSN, via d3-celestial</td><td>J2000 positions, milli-arcsecond catalogue</td></tr>
    <tr><td>Constellations, Milky Way</td><td>d3-celestial (IAU constellation figures; Milky Way outline)</td><td>illustrative figures</td></tr>
    <tr><td>Lunar terrain</td><td>NASA LRO LOLA: 80 m polar DEM (LDEM_80S_80M) poleward of 80°S, global heights about 474 m per sample elsewhere</td><td>heights a few metres; skyline traced to 150 km with the Moon's curvature</td></tr>
    <tr><td>Close-up terrain at the named places</td><td>16 km around each landing site and crater in the place list: SLDEM2015 (LOLA laser altimetry merged with Kaguya stereo images, 512 samples per degree, about 59 m) between 60°S and 60°N; LOLA polar DEMs at 5 m, 10 m, 20 m and 60 m nearer the south pole (PDS Geosciences Node)</td><td>heights a few metres; the craters and hills you see within 8 km are the real ones</td></tr>
    <tr><td>Small craters and rocks within 800 m</td><td>Too small for any orbital height map, so drawn from measured lunar statistics: crater counts at saturation N(&gt;D) = 10<sup>-1.1</sup> D<sup>-2</sup> per km² (Gault 1970) and rock counts from Surveyor and Apollo (Shoemaker and Morris 1969; Golombek and Rapp 1997)</td><td>typical of the Moon, not the individual rocks at that spot</td></tr>
    <tr><td>Lunar colour</td><td>NASA LRO LROC WAC mosaic (CGI Moon Kit)</td><td>1 to 3 km per pixel for ground colour</td></tr>
    <tr><td>Earth's surface</td><td>NASA Blue Marble Next Generation (SVS 3615)</td><td>cloud-free composite: real geography, not today's clouds</td></tr>
  </table>
  <h3>Checked against independent facts (npm test)</h3>
  <table>
    <tr><td>The zenith at the lunar north pole is the Moon's pole in Draco (RA ≈ 270°, Dec ≈ 66.5°)</td></tr>
    <tr><td>Earth stands about 66° up at Apollo 11 on any date (within libration)</td></tr>
    <tr><td>Earth is overhead at the sub-Earth point and on the horizon 90° away</td></tr>
    <tr><td>Mars, Jupiter and Saturn from the Moon match their geocentric positions within parallax (&lt; 0.1°)</td></tr>
    <tr><td>Sun altitude matches a second, independent Moon-fixed calculation to 0.05°</td></tr>
    <tr><td>Earth's phase from the Moon is the complement of the Moon's phase from Earth</td></tr>
    <tr><td>Sunrise to sunrise at Apollo 11 is one synodic month (29.53 days)</td></tr>
    <tr><td>Shackleton rim comes out 86% sunlit over 2026 and 2027, the published value (Bussey et al. 2010)</td></tr>
  </table>
  <h3>What is approximate</h3>
  <p>Earth's brightness (magnitude) is estimated from its albedo and phase. Earthshine on the ground and star visibility are shown as a dark-adapted eye would see them, not to photometric scale. Away from the named places the terrain is about 474 m per sample. Craters smaller than about 60 m and all rocks are statistical (see above), not mapped one by one. Light-time and aberration for stars (about 20″) are not applied.</p>`;
$('helpBody').innerHTML = `
  <h3>Two views</h3>
  <p><b>Standing on the surface</b>: you are 1.7 m above the real NASA terrain. Drag to look around, scroll to zoom, click any object for its details. <b>Orbit view</b>: the whole Moon lit by the real Sun at the chosen time; the S marker is where the Sun is overhead, the E marker where Earth is overhead. Click a spot and choose <b>Stand here</b>.</p>
  <h3>Site report</h3>
  <p>The panel at the top right gives a go / no-go for the place and time: light, surface temperature, radiation, contact with Earth and the ground. Click it (or press <kbd>R</kbd>) for the full report: measured temperatures from NASA's Diviner radiometer, rock cover, slopes, the next 30 days of sunlight, Earth visibility and temperature, a slope and shadow map of the ground around you, and live solar radiation alerts from NOAA and NASA. In orbit view, click any spot and choose <b>Site report</b>.</p>
  <h3>Keys (as in Stellarium)</h3>
  <table>
    <tr><td><kbd>F1</kbd> Help · <kbd>F2</kbd> Data · <kbd>F3</kbd> Search · <kbd>F4</kbd> Sky options · <kbd>F5</kbd> Date/time · <kbd>F6</kbd> Location · <kbd>F7</kbd> or <kbd>R</kbd> Site report</td></tr>
    <tr><td><kbd>J</kbd> slower / backwards · <kbd>K</kbd> real time / pause · <kbd>L</kbd> faster · <kbd>8</kbd> now</td></tr>
    <tr><td><kbd>-</kbd> / <kbd>=</kbd> one day back / forward · <kbd>[</kbd> / <kbd>]</kbd> one week · <kbd>Ctrl</kbd>+<kbd>-</kbd>/<kbd>=</kbd> one hour</td></tr>
    <tr><td><kbd>C</kbd> constellation lines · <kbd>V</kbd> names · <kbd>E</kbd> equatorial grid · <kbd>Z</kbd> azimuthal grid · <kbd>,</kbd> ecliptic</td></tr>
    <tr><td><kbd>G</kbd> ground · <kbd>Q</kbd> cardinal points · <kbd>M</kbd> Milky Way · <kbd>P</kbd> labels · <kbd>A</kbd> sunlight glare · <kbd>B</kbd> bright view · <kbd>O</kbd> orbit / surface view</td></tr>
    <tr><td>Arrows look around · <kbd>Page Up</kbd>/<kbd>Page Down</kbd> zoom · <kbd>Space</kbd> centre on the selected object · <kbd>Esc</kbd> deselect / close · <kbd>Ctrl</kbd>+<kbd>N</kbd> night mode</td></tr>
  </table>
  <p>The left and bottom bars appear when the mouse comes near the left or bottom edge. The <b>rover icon</b> on the left bar opens the rover mission simulator.</p>`;

// ---------- time controls ----------
function setNow() { S.t = Date.now(); S.rate = 1; S.paused = false; lastLight = 0; riseCache = null; syncDateWindow(true); }
function faster(dir) {
  if (S.paused) { S.paused = false; S.rate = dir > 0 ? 1 : -1; return; }
  const i = RATES.indexOf(S.rate);
  S.rate = RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 7 : i) + dir))];
}
$('tSlower').addEventListener('click', () => faster(-1));
$('tFaster').addEventListener('click', () => faster(1));
$('tPlay').addEventListener('click', () => { if (S.paused || S.rate !== 1) { S.paused = false; S.rate = 1; } else S.paused = true; });
$('tNow').addEventListener('click', setNow);
$('viewBtn').addEventListener('click', () => setView(S.view === 'surface' ? 'orbit' : 'surface'));
$('fullBtn').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); });

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key;
  const fn = { F1: 'help', F2: 'config', F3: 'search', F4: 'sky', F5: 'datetime', F6: 'location', F7: 'report' }[k];
  if (fn) { e.preventDefault(); openWin(fn); return; }
  if (e.ctrlKey && (k === 'n' || k === 'N')) { e.preventDefault(); toggle('night'); return; }
  const step = (ms) => { S.t += ms; lastLight = 0; riseCache = null; };
  const map = {
    c: () => toggle('constLines'), v: () => toggle('constNames'), e: () => toggle('eqGrid'), z: () => toggle('azGrid'), ',': () => toggle('ecliptic'),
    g: () => toggle('ground'), q: () => toggle('cardinals'), m: () => toggle('milkyWay'), p: () => toggle('planetLabels'), a: () => toggle('glare'), b: () => toggle('bright'), r: () => openWin('report'),
    o: () => setView(S.view === 'surface' ? 'orbit' : 'surface'),
    j: () => faster(-1), l: () => faster(1), k: () => $('tPlay').click(), 8: setNow,
    '-': () => step(e.ctrlKey ? -3600e3 : -DAY), '=': () => step(e.ctrlKey ? 3600e3 : DAY), '[': () => step(-7 * DAY), ']': () => step(7 * DAY),
    ' ': () => centerOnSelection(),
    Escape: () => { if (S.sel) select(null); else document.querySelectorAll('.win').forEach((w) => { w.hidden = true; }); },
    PageUp: () => surface.zoom(0.7), PageDown: () => surface.zoom(1.4),
  };
  const f = map[k] ?? map[k.toLowerCase?.()];
  if (f) { e.preventDefault(); f(); return; }
  if (S.view === 'surface' && k.startsWith('Arrow')) {
    e.preventDefault();
    const s = surface.view.fov * 0.05;
    if (k === 'ArrowLeft') surface.view.az = (surface.view.az - s + 360) % 360;
    if (k === 'ArrowRight') surface.view.az = (surface.view.az + s) % 360;
    if (k === 'ArrowUp') surface.view.alt = Math.min(89.9, surface.view.alt + s);
    if (k === 'ArrowDown') surface.view.alt = Math.max(-89.9, surface.view.alt - s);
  }
});

// ---------- bars that slide in near the edges (Stellarium style) ----------
let barTimer = null;
function showBars(left, bottom) {
  $('leftbar').classList.toggle('show', left);
  $('bottombar').classList.toggle('show', bottom);
}
document.addEventListener('pointermove', (e) => {
  if (barTimer) return;
  const nearLeft = e.clientX < 70 && e.clientY > window.innerHeight * 0.25;
  const nearBottom = e.clientY > window.innerHeight - 90;
  const overLeft = e.target.closest?.('.leftbar'), overBottom = e.target.closest?.('.buttons');
  showBars(nearLeft || !!overLeft || (nearBottom && e.clientX < 70), nearBottom || !!overBottom || (nearLeft && e.clientY > window.innerHeight - 160));
});

// Orbit view: click the sky (not the Moon) to pick stars and planets.
let downAt = null;
globe.canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
globe.canvas.addEventListener('pointerup', (e) => {
  if (S.view !== 'orbit' || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  if (!globe.pickPoint(e)) pickSky(e.clientX, e.clientY);
});

// ---------- start ----------
(async () => {
  const data = await loadSky('sky/');
  sky = new SkyLayer(data);
  surface = new SurfaceView(globe, sky);
  surface.onFrame = tick;
  surface.afterFrame = drawLabels;
  surface.onClick = (x, y) => pickSky(x, y);
  globe.onFrame = tick;
  globe.afterRender = drawLabels;
  globe.background = (r, cam) => sky.render(r, cam);
  window.lunaview = { globe, sky, surface, S, setSite, setView, select, places: [...PLACES, ...SITES] };
  syncOpts();
  setView('surface');
  showBars(true, true);
  barTimer = setTimeout(() => { barTimer = null; showBars(false, false); }, 5000);
  await setSite(S.site, false, true);
})();
