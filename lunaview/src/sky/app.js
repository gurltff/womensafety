// LunaView planetarium: see the sky from anywhere on the Moon, at any moment, with the real Sun,
// Earth, planets and stars over the real lunar ground. Or see the whole Moon lit as it is.
import './stellar.css';
import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { Globe, llToWorld } from '../globe.js';
import { Terrain } from '../terrain.js';
import { SITES, PLACES, parseCoords } from '../sites.js';
import { SkyLayer, loadSky } from './skylayer.js';
import { SurfaceView, dirOf, altAzOf } from './surface.js';
import { loadAlbedo, EYE_M } from './landscape.js';
import { observerAt, solarSystem, horizonMatrix, subPoints, riseSet, moonPhase, MOON_R_KM } from './ephem.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400e3;
const ALL_PLACES = [
  ...PLACES.filter((p) => /apollo|lunokhod|chang|chandrayaan|slim/i.test(p.id)).map((p) => ({ ...p, group: 'Where missions landed' })),
  ...SITES.map((s) => ({ ...s, group: 'South pole (Artemis)' })),
  ...PLACES.filter((p) => !/apollo|lunokhod|chang|chandrayaan|slim/i.test(p.id)).map((p) => ({ ...p, group: 'Craters' })),
];
// Time speeds, in seconds of Moon time per real second.
const RATES = [-604800, -86400, -3600, -60, -1, 1, 60, 3600, 86400, 604800];
const RATE_NAME = { 1: 'second', 60: 'minute', 3600: 'hour', 86400: 'day', 604800: 'week' };

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
  techOpen: false,
  show: {
    bright: true, stars: true, starLabels: true, planets: true, planetLabels: true, constLines: true, constNames: true, milkyWay: true,
    eqGrid: false, azGrid: false, ecliptic: false, ground: true, cardinals: true, shadows: true, earthshine: true,
    glare: false, night: false, ...store.get('show', {}),
  },
  magBoost: store.get('magBoost', 0),
  mwBright: store.get('mwBright', 1),
};

// ---------- formatting ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtNice = (d) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const fmtUTC = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
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
  return `${H}h${pad(M)}m${sec.toFixed(1).padStart(4, '0')}s`;
}
const fmtLat = (v, n = 2) => `${Math.abs(v).toFixed(n)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v, n = 2) => `${Math.abs(v).toFixed(n)}°${v < 0 ? 'W' : 'E'}`;
const fmtKm = (km) => (km > 1e7 ? `${(km / Astronomy.KM_PER_AU).toFixed(3)} AU (${(km / 1e6).toFixed(1)} million km)` : `${Math.round(km).toLocaleString('en')} km`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const compass = (az) => ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(az / 45) % 8];
function fmtIn(ms) {
  const h = Math.abs(ms) / 3600e3;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  const d = Math.floor(h / 24);
  return `${d} days ${Math.round(h - d * 24)} h`;
}
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

// ---------- per frame ----------
let frameState = null;
let lastFrame = performance.now();
let lastLight = 0, lastCard = 0, lastMarkers = 0;

function compute() {
  const date = new Date(S.t);
  if (S.view === 'surface') {
    const obs = observerAt(date, { ...S.site, hM: S.siteH + EYE_M });
    return { date, obs, bodies: solarSystem(obs), R9: horizonMatrix(obs) };
  }
  // Whole Moon: the sky as seen from the Moon's centre, in the globe's frame (Moon-fixed, y north).
  const obs = observerAt(date, { lat: 0, lon: 0, hM: -MOON_R_KM * 1000 });
  const { x, y, z } = obs.ax;
  return { date, obs, bodies: solarSystem(obs), R9: [x.x, x.y, x.z, z.x, z.y, z.z, -y.x, -y.y, -y.z] };
}

function tick() {
  const now = performance.now();
  const dt = Math.min(250, now - lastFrame);
  lastFrame = now;
  if (!S.paused) S.t += dt * S.rate;
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
    if (now - lastLight > (S.rate === 1 && !S.paused ? 2000 : 250)) {
      lastLight = now;
      surface.landscape.light(S.show.shadows ? sun : { ...sun, alt: Math.max(sun.alt, 0) }, earth, { earthshine: S.show.earthshine, minAmbient: S.show.bright ? 1.1 : 0 });
    }
  } else {
    globe.nightLight = S.show.bright ? 2.4 : 0.14;
    globe.setSunDirection(subPoints(frameState.date).sunDirMf);
    if (now - lastMarkers > 500) { lastMarkers = now; orbitMarkers(); }
  }
  if (now - lastCard > 300) { lastCard = now; renderCard(); renderTimeUi(); }
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
function project(v) {
  const cam = sky.camera;
  tmpV.copy(v).multiplyScalar(1000);
  if (tmpV.clone().applyMatrix4(cam.matrixWorldInverse).z > 0) return null;
  tmpV.project(cam);
  if (Math.abs(tmpV.x) > 1.2 || Math.abs(tmpV.y) > 1.2) return null;
  const w = globe.canvas.clientWidth, h = globe.canvas.clientHeight;
  return { x: ((tmpV.x + 1) / 2) * w, y: ((1 - tmpV.y) / 2) * h };
}
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
  const lim = sky.starUniforms.magLimit.value;
  for (const b of frameState.bodies) {
    if (!S.show.planetLabels && S.sel?.id !== b.id) continue;
    if (b.type === 'planet' && b.id !== 'earth' && !S.show.planets) continue;
    const p = project(b.view);
    if (!p || hidden(b.view)) continue;
    const big = b.id === 'sun' || b.id === 'earth';
    label(`b-${b.id}`, b.id === 'sun' ? 'sun' : b.id === 'earth' ? 'earth' : 'planet', b.name, p.x, p.y, big ? 14 : 6, big ? -16 : -6);
  }
  if (S.show.stars && S.show.planetLabels && S.show.starLabels) {
    const names = sky.stars.names;
    for (let i = 0; i < sky.stars.mag.length; i++) {
      if (sky.stars.mag[i] > lim - 4.3) break;
      const n = names[sky.stars.hip[i]];
      if (!n?.name) continue;
      const v = sky.starView(i);
      const p = project(v);
      if (p && !hidden(v)) label(`s-${i}`, 'star', n.name, p.x, p.y);
    }
  }
  if (S.show.constLines && S.show.constNames) {
    for (const c of sky.constLabels) {
      if (c.rank > (S.view === 'orbit' || surface.view.fov < 40 ? 3 : 2)) continue;
      const v = sky.viewOf(c.v);
      const p = project(v);
      if (p && !hidden(v)) label(`c-${c.id}`, 'const', c.name, p.x, p.y, -30, 0);
    }
  }
  if (S.view === 'surface' && S.show.cardinals) {
    for (const [name, az, minor] of [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['NE', 45, 1], ['SE', 135, 1], ['SW', 225, 1], ['NW', 315, 1]]) {
      const p = project(dirOf(Math.max(0, surface.landscape.horizonAt(az)) + 0.6, az));
      if (p) label(`k-${name}`, `cardinal${minor ? ' minor' : ''}`, name, p.x, p.y, -6, -12);
    }
  }
  if (S.view === 'surface' && S.show.azGrid) {
    for (let az = 0; az < 360; az += 30) { const p = project(dirOf(30, az)); if (p) label(`g-${az}`, 'grid', `${az}°`, p.x, p.y, 3, 0); }
  }
  for (const el of labelEls.values()) if (!el.dataset.used) el.hidden = true;
  const sv = selView();
  const p = sv && project(sv);
  $('pointer').hidden = !p;
  if (p) { $('pointer').style.left = `${p.x}px`; $('pointer').style.top = `${p.y}px`; }
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
    if (d < 20 && (!best || score < best.score)) best = { sel, score };
  };
  for (const b of frameState.bodies) consider({ kind: 'body', id: b.id }, b.view, b.id === 'sun' || b.id === 'earth' ? -30 : b.mag);
  const lim = sky.starUniforms.magLimit.value;
  if (S.show.stars) for (let i = 0; i < sky.stars.mag.length && sky.stars.mag[i] <= lim; i++) consider({ kind: 'star', i }, sky.starView(i), sky.stars.mag[i]);
  select(best?.sel ?? null);
}
function select(sel) { S.sel = sel; lastCard = 0; }

// ---------- rise and set over the real skyline (cached, computed in the background) ----------
const riseCache = new Map();
function siteRiseSet(id) {
  const key = `${id}|${S.site.lat}|${S.site.lon}|${S.show.ground}|${Math.floor(S.t / 3600e3)}`;
  const c = riseCache.get(key);
  if (c) return c === 'pending' ? null : c;
  riseCache.set(key, 'pending');
  setTimeout(() => {
    const skyline = (az) => (S.show.ground ? surface.landscape.horizonAt(az) : 0);
    riseCache.set(key, riseSet({ ...S.site, hM: S.siteH + EYE_M }, new Date(S.t), skyline, id, 32));
    lastCard = 0;
  }, 20);
  return null;
}

// ---------- the information card ----------
const phaseWord = (illum, waxing) => (illum < 0.03 ? 'new' : illum > 0.97 ? 'full' : illum < 0.4 ? `${waxing ? 'waxing' : 'waning'} crescent` : illum < 0.6 ? 'half lit' : `${waxing ? 'waxing' : 'waning'} gibbous`);
function groundTemp(sun, lit) {
  if (!lit) return { c: -170, text: 'about −170 °C (no sunlight)' };
  // Radiative balance of sunlit regolith on level ground: albedo 0.12, emissivity 0.95.
  const t = ((0.88 * 1361 * Math.max(0, Math.sin(sun.alt * Math.PI / 180))) / (0.95 * 5.67e-8)) ** 0.25 - 273.15;
  const c = Math.max(-170, t);
  return { c, text: `about ${c > 0 ? '+' : ''}${Math.round(c)} °C (sunlit ground)` };
}

function row(e, main, sub) { return `<div class="row"><span class="e">${e}</span><span>${main}${sub ? `<span class="sub">${sub}</span>` : ''}</span></div>`; }

function cardHere() {
  const { bodies } = frameState;
  const sun = bodies.find((b) => b.id === 'sun'), earth = bodies.find((b) => b.id === 'earth');
  const hz = (az) => (S.show.ground ? surface.landscape.horizonAt(az) : 0);
  const sunHz = hz(sun.az);
  const lit = sun.alt + 0.27 > sunHz;
  const state = sun.alt < -0.27 ? ['night', 'Night'] : lit ? ['day', 'Daytime'] : ['shade', 'In the shadow of the hills'];
  const rs = siteRiseSet('sun');
  let sunMain, sunSub = '';
  if (lit) sunMain = `<b>Sun</b> ${Math.round(sun.alt)}° up, towards the ${compass(sun.az)}`;
  else if (sun.alt > -0.27) sunMain = `<b>Sun</b> just ${sun.alt.toFixed(1)}° up in the ${compass(sun.az)}, but behind hills ${sunHz.toFixed(1)}° high`;
  else sunMain = `<b>Sun</b> below the horizon (${Math.round(sun.alt)}°)`;
  if (rs) {
    const next = lit ? rs.nextSet : rs.nextRise;
    sunSub = next ? `${lit ? 'Sets' : 'Rises'} in ${fmtIn(next.t - S.t)} · ${fmtNice(next.t)} UTC` : `${lit ? 'Stays up' : 'Stays down'} for the next month`;
  } else sunSub = 'Working out sunrise and sunset…';
  const eHz = hz(earth.az);
  const eUp = earth.alt + 0.95 > eHz;
  const waxing = moonPhase(frameState.date) > 180; // Earth waxes while the Moon wanes
  const earthMain = eUp
    ? `<b>Earth</b> ${Math.round(earth.alt)}° up, towards the ${compass(earth.az)} · ${Math.round(earth.illum * 100)}% lit (${phaseWord(earth.illum, waxing)})`
    : `<b>Earth</b> not visible from here${earth.alt > 0 ? ' (behind hills)' : ' (below the horizon)'}`;
  const earthSub = eUp ? `The part of Earth facing you: ${fmtLat(earth.subObserver.lat, 0)} ${fmtLon(earth.subObserver.lon, 0)}` : 'Earth stays in about the same place in the Moon\'s sky';
  const t = groundTemp(sun, lit);
  const planets = bodies.filter((b) => b.type === 'planet' && b.id !== 'earth' && b.alt > hz(b.az) && b.mag < 3).map((b) => b.name);
  return `<h2>${esc(S.site.name)} <small>${fmtLat(S.site.lat)} ${fmtLon(S.site.lon)} · ground ${Math.round(S.siteH)} m</small></h2>
    <p class="lead"><span class="tag ${state[0]}">${state[1]}</span> on the Moon here</p>
    ${row('☀', sunMain, sunSub)}
    ${row('🌍', earthMain, earthSub)}
    ${row('🌡', `<b>Ground</b> ${t.text}`, 'estimate for level ground')}
    ${row('🪐', `<b>Planets up</b> ${planets.length ? planets.join(', ') : 'none bright right now'}`, 'The sky is black even by day: the Moon has no air.')}
    <div class="acts">
      ${lit || sun.alt > -1 ? '<button type="button" data-act="look-sun">Look at the Sun</button>' : ''}
      ${eUp ? '<button type="button" data-act="look-earth">Look at Earth</button>' : ''}
      <button type="button" data-act="${lit ? 'sunset' : 'sunrise'}">Jump to ${lit ? 'sunset' : 'sunrise'}</button>
    </div>`;
}

function cardMoon() {
  const date = frameState.date;
  const sp = subPoints(date);
  const ph = moonPhase(date);
  const illum = Astronomy.Illumination(Astronomy.Body.Moon, Astronomy.MakeTime(date)).phase_fraction;
  const lib = Astronomy.Libration(Astronomy.MakeTime(date));
  const phaseName = ['New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'][Math.round(ph / 45) % 8];
  const obs = observerAt(date, { ...S.site, hM: 0 });
  const sunHere = solarSystem(obs).find((b) => b.id === 'sun');
  return `<h2>The whole Moon <small>${fmtNice(date)} UTC</small></h2>
    <p class="lead">Lit by the Sun exactly as it is at this moment. ${S.show.bright ? 'The night side is brightened so you can see it (turn off 💡 Bright view for real darkness).' : 'Real lighting: the night side is dark.'}</p>
    ${row('🌗', `<b>${phaseName}</b> as seen from Earth`, `${Math.round(illum * 100)}% of the side facing Earth is lit`)}
    ${row('☀', `<b>Sun overhead</b> at ${fmtLat(sp.sun.lat)} ${fmtLon(sp.sun.lon)}`, 'the ☀ marker; it is noon there')}
    ${row('🌍', `<b>Earth overhead</b> at ${fmtLat(sp.earth.lat)} ${fmtLon(sp.earth.lon)}`, `the 🌍 marker; it barely moves (libration ${lib.elon.toFixed(1)}°, ${lib.elat.toFixed(1)}°) · ${fmtKm(lib.dist_km)} away`)}
    ${row('📍', `<b>${esc(S.site.name)}</b>: ${sunHere.alt > 0 ? 'daytime' : 'night'} (Sun ${Math.round(sunHere.alt)}°)`, 'Click any spot on the Moon to stand there.')}
    <div class="acts"><button type="button" data-act="stand">🧍 Stand at ${esc(S.site.name.split(',')[0])}</button></div>`;
}

function cardObject() {
  const surf = S.view === 'surface';
  let title = '', lead = '', tech = [];
  const where = (alt, az) => (surf ? (alt > 0 ? ` ${Math.round(alt)}° up, towards the ${compass(az)}.` : ' Below the horizon right now.') : '');
  if (S.sel.kind === 'body') {
    const b = frameState.bodies.find((x) => x.id === S.sel.id);
    title = esc(b.name);
    if (b.id === 'sun') lead = `Our star, ${fmtKm(b.distKm)} away.${where(b.alt, b.az)}`;
    else if (b.id === 'earth') lead = `Home: ${Math.round(b.illum * 100)}% lit, ${fmtKm(b.distKm)} away. It looks about 3.7 times wider than the Moon does from Earth.${where(b.alt, b.az)}`;
    else lead = `A planet, magnitude ${b.mag.toFixed(1)}, ${fmtKm(b.distKm)} away.${where(b.alt, b.az)}`;
    tech = [['Magnitude', `${b.mag.toFixed(2)}${b.id === 'earth' ? ' (approx.)' : ''}`], ['RA/Dec (J2000)', `${hms(b.ra)} / ${dms(b.dec)}`]];
    if (surf) tech.push(['Az./Alt.', `${dms(b.az, false)} / ${dms(b.alt)}`]);
    tech.push(['Distance', fmtKm(b.distKm)], ['Apparent size', b.angDiamDeg > 0.1 ? dms(b.angDiamDeg, false) : `${(b.angDiamDeg * 3600).toFixed(1)}"`]);
    if (b.illum !== undefined) tech.push(['Phase angle', `${b.phaseAngle.toFixed(1)}°`], ['Illuminated', `${(b.illum * 100).toFixed(1)}%`]);
    if (b.id === 'earth') tech.push(['Facing you', `${fmtLat(b.subObserver.lat)} ${fmtLon(b.subObserver.lon)}`], ['Noon on Earth at', `${fmtLat(b.subSolar.lat)} ${fmtLon(b.subSolar.lon)}`]);
    if (surf && (b.id === 'sun' || b.id === 'earth')) {
      const rs = siteRiseSet(b.id);
      const nm = b.id === 'sun' ? 'Sun' : 'Earth';
      if (rs?.nextRise) tech.push([`Next ${nm.toLowerCase()}rise`, `${fmtNice(rs.nextRise.t)} UTC`]);
      if (rs?.nextSet) tech.push([`Next ${nm.toLowerCase()}set`, `${fmtNice(rs.nextSet.t)} UTC`]);
      if (rs && !rs.nextRise && !rs.nextSet) tech.push([nm, `stays ${rs.up ? 'up' : 'down'} for a month`]);
    }
  } else if (S.sel.kind === 'star') {
    const i = S.sel.i, st = sky.stars, n = st.names[st.hip[i]] ?? {};
    const cname = sky.constLabels.find((c) => c.id === n.c)?.name;
    const a = altAzOf(sky.starView(i));
    title = `${esc(n.name || n.desig || `HIP ${st.hip[i]}`)}${n.name && n.desig ? ` <small>${esc(n.desig)}</small>` : ''}`;
    lead = `A star of magnitude ${st.mag[i].toFixed(1)}${cname ? ` in ${esc(cname)}` : ''}.${where(a.alt, a.az)}`;
    tech = [['Magnitude', st.mag[i].toFixed(2)], ['Colour index (B-V)', st.bv[i].toFixed(2)], ['RA/Dec (J2000)', `${hms(st.ra[i])} / ${dms(st.dec[i])}`]];
    if (surf) tech.push(['Az./Alt.', `${dms(a.az, false)} / ${dms(a.alt)}`]);
    tech.push(['Catalogue', `HIP ${st.hip[i]}${n.hd ? ` · ${esc(n.hd)}` : ''}`]);
  } else {
    const c = sky.constLabels.find((x) => x.id === S.sel.id);
    const a = altAzOf(sky.viewOf(c.v));
    title = esc(c.name);
    lead = `A constellation.${where(a.alt, a.az)}`;
    tech = [['Centre RA/Dec', `${hms(c.ra)} / ${dms(c.dec)}`]];
  }
  return `<h2>${title}</h2><p class="lead">${lead}</p>
    <div class="acts">${surf ? '<button type="button" data-act="centre">Centre it</button><button type="button" data-act="zoom">Zoom in</button>' : ''}</div>
    <details ${S.techOpen ? 'open' : ''}><summary>Exact figures</summary><dl>${tech.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></details>`;
}

function renderCard() {
  if (!frameState || !surface) return;
  const html = S.sel ? cardObject() : S.view === 'surface' ? cardHere() : cardMoon();
  if (html !== renderCard.last) { $('cardBody').innerHTML = html; renderCard.last = html; }
  $('cardX').hidden = !S.sel;
}
$('cardX').addEventListener('click', () => select(null));
$('cardBody').addEventListener('toggle', (e) => { if (e.target.tagName === 'DETAILS') S.techOpen = e.target.open; }, true);
$('cardBody').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'look-sun') { select({ kind: 'body', id: 'sun' }); centerOnSelection(); }
  if (act === 'look-earth') { select({ kind: 'body', id: 'earth' }); centerOnSelection(); }
  if (act === 'sunrise' || act === 'sunset') jumpEvent(act);
  if (act === 'stand') setView('surface');
  if (act === 'centre') centerOnSelection();
  if (act === 'zoom') centerOnSelection(S.sel.kind === 'body' && S.sel.id === 'earth' ? 4 : Math.max(2, surface.view.fov / 4));
});

function renderTimeUi() {
  const d = new Date(S.t);
  $('dateTxt').textContent = fmtNice(d);
  $('placeName').textContent = S.view === 'surface' ? S.site.name : 'Whole Moon';
  $('clockTxt').textContent = fmtUTC(d);
  let sp;
  if (S.paused) sp = 'Paused';
  else if (S.rate === 1) sp = 'Real time';
  else { const a = Math.abs(S.rate); sp = `${S.rate < 0 ? 'Backwards' : 'Fast'}: 1 ${RATE_NAME[a]} per second`; }
  $('speedTxt').textContent = sp;
  $('tPlay').textContent = S.paused ? '▶' : '❚❚';
  $('tPlay').setAttribute('aria-label', S.paused ? 'Play' : 'Pause');
  if (!$('win-datetime').hidden && document.activeElement !== $('dtInput')) $('dtInput').value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ---------- views ----------
function orbitMarkers() {
  const sp = subPoints(new Date(S.t));
  globe.setMarkers([
    { lat: sp.sun.lat, lon: sp.sun.lon, icon: '☀', level: '', title: 'Sun overhead', label: true },
    { lat: sp.earth.lat, lon: sp.earth.lon, icon: '🌍', level: 'info', title: 'Earth overhead', label: true },
    { lat: S.site.lat, lon: S.site.lon, icon: '📍', level: 'ok', title: S.site.name.split(',')[0], label: true },
  ]);
}
function setView(view) {
  S.view = view;
  $('app').dataset.view = view;
  document.querySelectorAll('.seg [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  $('spot').hidden = true;
  if (view === 'surface') {
    globe.setMarkers(null);
    surface.setActive(true);
    for (const p of globe.pins) p.el.hidden = true;
    hint('Drag to look around · Scroll to zoom · Click any star, planet or Earth');
  } else {
    surface.setActive(false);
    globe.cam.enabled = true;
    globe.cam.flyTo({ target: llToWorld(S.site.lat, S.site.lon), dist: 2.2, tilt: 0, heading: 0, ms: 1600 });
    orbitMarkers();
    hint('Drag to turn the Moon · Scroll to zoom in · Click any spot to stand there');
  }
  select(null);
}
document.querySelectorAll('.seg [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function hint(text) {
  const h = $('hint');
  h.textContent = text;
  h.classList.remove('fade');
  clearTimeout(hint.timer);
  hint.timer = setTimeout(() => h.classList.add('fade'), 9000);
}

globe.onSurfaceClick = ({ lat, lon }) => spotPopup(lat, lon);
globe.onPick = (site) => spotPopup(site.lat, site.lon, site.name);
function spotPopup(lat, lon, name) {
  if (S.view !== 'orbit') return;
  const b = solarSystem(observerAt(new Date(S.t), { lat, lon, hM: 0 }));
  const sun = b.find((x) => x.id === 'sun'), earth = b.find((x) => x.id === 'earth');
  const el = $('spot');
  el.innerHTML = `<b>${esc(name ?? 'This spot')}</b>${fmtLat(lat)} ${fmtLon(lon)}
    <p>${sun.alt > 0 ? `☀ Daytime: Sun ${Math.round(sun.alt)}° up` : `🌙 Night: Sun ${Math.round(-sun.alt)}° below the horizon`}</p>
    <p>${earth.alt > 0 ? `🌍 Earth in the sky, ${Math.round(earth.alt)}° up` : '🌍 Earth never visible here (far side)'}</p>
    <div class="acts"><button type="button" class="primary">🧍 Stand here</button><button type="button" data-close>Close</button></div>`;
  const w = llToWorld(lat, lon, 1).project(globe.camera);
  el.style.left = `${Math.min(window.innerWidth - 270, Math.max(10, ((w.x + 1) / 2) * window.innerWidth + 12))}px`;
  el.style.top = `${Math.min(window.innerHeight - 220, Math.max(70, ((1 - w.y) / 2) * window.innerHeight + 12))}px`;
  el.hidden = false;
  el.querySelector('.primary').addEventListener('click', () => setSite({ name: name ?? `${fmtLat(lat)} ${fmtLon(lon)}`, lat, lon }, true));
  el.querySelector('[data-close]').addEventListener('click', () => { el.hidden = true; });
}

// ---------- place ----------
let siteJob = 0;
async function setSite(site, stand = false, look = true) {
  const job = ++siteJob;
  S.site = { name: site.name, lat: +site.lat, lon: +site.lon };
  store.set('site', S.site);
  select(null);
  closeWins();
  $('busy').hidden = false;
  $('busyTitle').textContent = `Going to ${S.site.name}`;
  $('busyText').textContent = 'Loading NASA terrain…';
  $('busyBar').style.width = '5%';
  try {
    await terrainReady;
    albedo ??= await loadAlbedo('textures/lroc_color_4k.jpg').catch(() => null);
    await surface.landscape.build(terrain, S.site, albedo, (f) => {
      $('busyBar').style.width = `${Math.round(f * 100)}%`;
      $('busyText').textContent = f < 0.62 ? 'Building the ground around you' : f < 0.8 ? 'Tracing the skyline out to 150 km' : 'Almost there';
    });
    if (job !== siteJob) return;
    S.siteH = surface.landscape.h0;
    lastLight = 0;
    if (stand && S.view !== 'surface') setView('surface');
    if (look) lookAround();
  } catch (err) {
    console.error(err);
    toast(`Could not load that place: ${err.message}`);
  } finally {
    if (job === siteJob) $('busy').hidden = true;
  }
}
// Face Earth if it is up, else the Sun, else the horizon.
function lookAround() {
  const b = solarSystem(observerAt(new Date(S.t), { ...S.site, hM: S.siteH + EYE_M }));
  const earth = b.find((x) => x.id === 'earth'), sun = b.find((x) => x.id === 'sun');
  const pick = earth.alt > -1 ? earth : sun.alt > -1 ? sun : null;
  if (pick) surface.lookAt(Math.min(35, Math.max(8, pick.alt * 0.55)), pick.az, Math.max(60, Math.min(100, pick.alt * 1.6 + 20)));
  else surface.lookAt(10, S.site.lat < 0 ? 0 : 180, 75);
}

// ---------- windows ----------
function closeWins() { document.querySelectorAll('.win').forEach((w) => { w.hidden = true; }); }
function openWin(name) {
  const w = $(`win-${name}`);
  const show = w.hidden;
  closeWins();
  w.hidden = !show;
  if (show && name === 'location') { syncLocationWindow(); $('locFilter').focus(); }
  if (show && name === 'datetime') renderTimeUi();
}
document.querySelectorAll('.win').forEach((w) => {
  w.querySelector('.x').addEventListener('click', () => { w.hidden = true; });
  const head = w.querySelector('header');
  let d = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.x')) return;
    const r = w.getBoundingClientRect();
    w.style.transform = 'none'; w.style.left = `${r.left}px`; w.style.top = `${r.top}px`;
    d = { x: e.clientX - r.left, y: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => { if (d) { w.style.left = `${Math.max(0, e.clientX - d.x)}px`; w.style.top = `${Math.max(0, e.clientY - d.y)}px`; } });
  head.addEventListener('pointerup', () => { d = null; });
});
$('placeBtn').addEventListener('click', () => openWin('location'));
$('dateBtn').addEventListener('click', () => openWin('datetime'));
$('moreBtn').addEventListener('click', () => openWin('sky'));
$('helpBtn').addEventListener('click', () => openWin('help'));

// Place window.
function syncLocationWindow() {
  placeMapMark($('locMark'), S.site.lat, S.site.lon);
  const sp = subPoints(new Date(S.t));
  placeMapMark($('locSun'), sp.sun.lat, sp.sun.lon);
  placeMapMark($('locEarth'), sp.earth.lat, sp.earth.lon);
  $('locLat').value = S.site.lat.toFixed(3);
  $('locLon').value = S.site.lon.toFixed(3);
  renderLocList();
}
function placeMapMark(el, lat, lon) { el.style.left = `${((lon + 180) / 360) * 100}%`; el.style.top = `${((90 - lat) / 180) * 100}%`; }
$('locMap').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const lon = ((e.clientX - r.left) / r.width) * 360 - 180, lat = 90 - ((e.clientY - r.top) / r.height) * 180;
  setSite({ name: `${fmtLat(lat)} ${fmtLon(lon)}`, lat, lon }, true);
});
function renderLocList() {
  const q = $('locFilter').value.trim().toLowerCase();
  let group = '', html = '';
  for (const p of ALL_PLACES.filter((x) => !q || x.name.toLowerCase().includes(q))) {
    if (p.group !== group) { group = p.group; html += `<li class="grp">${esc(group)}</li>`; }
    html += `<li data-id="${p.id}" class="${p.name === S.site.name ? 'sel' : ''}"><span>${esc(p.name)}</span><small>${fmtLat(p.lat)} ${fmtLon(p.lon)}</small></li>`;
  }
  $('locList').innerHTML = html || '<li class="grp">No match</li>';
}
$('locList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) { const p = ALL_PLACES.find((x) => x.id === li.dataset.id); setSite(p, true); }
});
$('locFilter').addEventListener('input', renderLocList);
$('locGo').addEventListener('click', () => {
  const lat = parseFloat($('locLat').value), lon = parseFloat($('locLon').value);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast('Latitude must be -90 to 90 and longitude -180 to 180.'); return; }
  setSite({ name: `${fmtLat(lat)} ${fmtLon(lon)}`, lat, lon }, true);
});

// Date window.
function setTime(t) { S.t = t; lastLight = 0; lastCard = 0; renderTimeUi(); }
$('dtInput').addEventListener('change', (e) => { const d = new Date(`${e.target.value}:00Z`); if (!Number.isNaN(d.getTime())) setTime(d.getTime()); });
document.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.jump === 'now') setNow(); else setTime(S.t + +b.dataset.jump);
}));
document.querySelectorAll('[data-event]').forEach((b) => b.addEventListener('click', () => jumpEvent(b.dataset.event)));
function jumpEvent(kind) {
  if (kind === 'fullearth' || kind === 'newearth') {
    // Full Earth is when the Moon is new as seen from Earth, and the other way round.
    const r = Astronomy.SearchMoonPhase(kind === 'fullearth' ? 0 : 180, Astronomy.MakeTime(new Date(S.t + 60e3)), 40);
    if (r) { setTime(r.date.getTime()); toast(`${kind === 'fullearth' ? 'Full Earth' : 'New Earth'}: ${fmtNice(r.date)} UTC`); }
    return;
  }
  const skyline = (az) => (S.show.ground ? surface.landscape.horizonAt(az) : 0);
  const rs = riseSet({ ...S.site, hM: S.siteH + EYE_M }, new Date(S.t), skyline, 'sun', 40);
  const ev = kind === 'sunrise' ? rs.nextRise : rs.nextSet;
  if (!ev) { toast(`No ${kind} here in the next 40 days: the Sun stays ${rs.up ? 'up' : 'down'}.`); return; }
  // Land just before a sunrise (to watch it) or just before a sunset.
  setTime(ev.t.getTime() - 20 * 60e3);
  S.paused = false; S.rate = 60;
  if (S.view === 'surface') { select({ kind: 'body', id: 'sun' }); centerOnSelection(60); }
  toast(`${kind === 'sunrise' ? 'Sunrise' : 'Sunset'} here at ${fmtNice(ev.t)} UTC: playing at 1 minute per second`);
}

// Display options window.
const OPTS = [
  ['Lighting', [['bright', 'Bright view (see the night side and the ground at night)'], ['shadows', 'Terrain shadows from the real Sun'], ['earthshine', 'Earthshine on the ground at night'], ['glare', 'Sun glare (hide faint stars in daylight)']]],
  ['Stars and planets', [['stars', 'Stars'], ['planetLabels', 'Names'], ['starLabels', 'Star names (when Names is on)'], ['planets', 'Planets'], ['magBoost', 'Show fainter stars', 'range', -3, 2, 0.1]]],
  ['Sky', [['constLines', 'Constellation lines'], ['constNames', 'Constellation names'], ['milkyWay', 'Milky Way'], ['mwBright', 'Milky Way brightness', 'range', 0, 3, 0.1]]],
  ['Guides', [['ground', 'Ground'], ['cardinals', 'Compass points (N, E, S, W)'], ['azGrid', 'Compass grid'], ['eqGrid', 'Star-chart grid (RA/Dec)'], ['ecliptic', 'Ecliptic (path of the Sun)'], ['night', 'Red night mode']]],
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
  document.querySelectorAll('[data-toggle]').forEach((b) => { b.classList.toggle('on', !!S.show[b.dataset.toggle]); b.setAttribute('aria-pressed', String(!!S.show[b.dataset.toggle])); });
  $('app').classList.toggle('night', S.show.night);
}
function changed(k) {
  store.set('show', S.show); store.set('magBoost', S.magBoost); store.set('mwBright', S.mwBright);
  if (k === 'shadows' || k === 'earthshine' || k === 'bright') { lastLight = 0; if (surface) surface.landscape.lastSun = null; }
  if (k === 'constLines' && S.show.constLines) S.show.constNames = true;
  lastCard = 0;
  syncOpts();
}
document.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('input', () => {
  const k = el.dataset.opt;
  if (k === 'magBoost') S.magBoost = +el.value; else if (k === 'mwBright') S.mwBright = +el.value; else S.show[k] = el.checked;
  changed(k);
}));
function toggle(k) { S.show[k] = !S.show[k]; changed(k); }
document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.toggle)));
$('fullBtn').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); });

// ---------- search in the top bar ----------
function searchItems() {
  const items = [];
  for (const b of frameState?.bodies ?? []) items.push({ label: b.name, sub: b.id === 'sun' ? 'the Sun' : b.id === 'earth' ? 'our planet' : 'planet', sel: { kind: 'body', id: b.id } });
  const st = sky.stars;
  for (let i = 0; i < st.hip.length; i++) {
    const n = st.names[st.hip[i]];
    if (n?.name) items.push({ label: n.name, sub: `star${n.desig ? ` · ${n.desig}` : ''}`, sel: { kind: 'star', i } });
  }
  for (const c of sky.constLabels) items.push({ label: c.name, sub: 'constellation', sel: { kind: 'const', id: c.id } });
  for (const p of ALL_PLACES) items.push({ label: p.name, sub: 'place on the Moon', place: p });
  return items;
}
let qActive = 0;
function renderQuick() {
  if (!sky) return;
  const box = $('quickSearch'), q = box.value.trim().toLowerCase();
  if (!q) { $('quickResults').hidden = true; return; }
  const c = parseCoords(box.value);
  let items = searchItems().filter((x) => x.label.toLowerCase().includes(q));
  items.sort((a, b) => a.label.toLowerCase().indexOf(q) - b.label.toLowerCase().indexOf(q));
  if (c) items = [{ label: `Stand at ${fmtLat(c.lat)} ${fmtLon(c.lon)}`, sub: 'position on the Moon', place: { name: `${fmtLat(c.lat)} ${fmtLon(c.lon)}`, ...c } }, ...items];
  items = items.slice(0, 12);
  renderQuick.items = items;
  $('quickResults').innerHTML = items.length ? items.map((x, i) => `<li data-i="${i}" class="${i === qActive ? 'sel' : ''}"><span>${esc(x.label)}</span><small>${esc(x.sub)}</small></li>`).join('') : '<li><small>No match</small></li>';
  $('quickResults').hidden = false;
}
function chooseQuick(x) {
  $('quickSearch').value = '';
  $('quickResults').hidden = true;
  $('quickSearch').blur();
  if (x.place) { setSite(x.place, true); return; }
  if (S.view !== 'surface') setView('surface');
  select(x.sel);
  centerOnSelection();
  const v = selView();
  if (v && hidden(v)) toast('It is below the horizon from here right now.');
}
$('quickSearch').addEventListener('input', () => { qActive = 0; renderQuick(); });
$('quickSearch').addEventListener('keydown', (e) => {
  const items = renderQuick.items ?? [];
  if (e.key === 'ArrowDown') { qActive = Math.min(items.length - 1, qActive + 1); renderQuick(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { qActive = Math.max(0, qActive - 1); renderQuick(); e.preventDefault(); }
  if (e.key === 'Enter' && items[qActive]) chooseQuick(items[qActive]);
  if (e.key === 'Escape') { $('quickResults').hidden = true; e.target.blur(); }
});
$('quickResults').addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); chooseQuick(renderQuick.items[+li.dataset.i]); } });
$('quickSearch').addEventListener('blur', () => setTimeout(() => { $('quickResults').hidden = true; }, 150));

function centerOnSelection(fov) {
  const v = selView();
  if (!v) return;
  if (S.view === 'surface') { const { alt, az } = altAzOf(v); surface.lookAt(alt, az, fov ?? surface.view.fov); }
}

// ---------- help ----------
$('helpBody').innerHTML = `
  <h3>Two ways to look</h3>
  <p><b>🧍 Stand on the Moon</b>: you are standing on the real ground at the chosen place. Drag to look around, scroll to zoom in, click a star, planet or Earth to learn about it. The card at the top left says what is happening here: day or night, where the Sun and Earth are, when the Sun rises or sets.</p>
  <p><b>🌕 Whole Moon</b>: the Moon lit by the Sun at the chosen time. ☀ is where the Sun is overhead, 🌍 where Earth is overhead. Click any spot, then <b>Stand here</b>.</p>
  <h3>Choosing where and when</h3>
  <p><b>📍 Place</b>: a map of the Moon and a list of landing sites and craters. <b>📅 Date</b>: any moment from 1600 to 2500, plus shortcuts to the next sunrise, sunset, full Earth or new Earth. At the bottom, ▶ plays time; ⏩ and ⏪ make it faster or run it backwards; <b>Now</b> comes back to the present.</p>
  <h3>Lighting</h3>
  <p><b>💡 Bright view</b> (on by default) lifts the dark so you can see the Moon's night side and the ground at night. Turn it off to see real darkness.</p>
  <h3>Keyboard</h3>
  <table>
    <tr><td><kbd>K</kbd> play/pause · <kbd>J</kbd> slower/backwards · <kbd>L</kbd> faster · <kbd>8</kbd> now · <kbd>-</kbd>/<kbd>=</kbd> a day back/forward</td></tr>
    <tr><td><kbd>C</kbd> constellations · <kbd>P</kbd> names · <kbd>G</kbd> ground · <kbd>Z</kbd> grid · <kbd>M</kbd> Milky Way · <kbd>B</kbd> bright view · <kbd>O</kbd> switch view</td></tr>
    <tr><td>Arrows look around · <kbd>Page Up</kbd>/<kbd>Page Down</kbd> zoom · <kbd>Esc</kbd> close</td></tr>
  </table>
  <h3>Where the data comes from</h3>
  <table>
    <tr><td>Sun, Earth, planets</td><td><a href="https://github.com/cosinekitty/astronomy" target="_blank" rel="noopener">astronomy-engine</a> (VSOP87, ELP/MPP02, IAU precession and nutation), under 1 arcminute</td></tr>
    <tr><td>Moon's orientation</td><td>IAU/WGCCRE lunar rotation model</td></tr>
    <tr><td>Lunar ground</td><td>NASA LRO LOLA heights (80 m near the south pole, ~950 m elsewhere) and LROC colour, <a href="https://svs.gsfc.nasa.gov/4720" target="_blank" rel="noopener">NASA SVS CGI Moon Kit</a> and <a href="https://pds-geosciences.wustl.edu/missions/lro/lola.htm" target="_blank" rel="noopener">PDS LOLA</a></td></tr>
    <tr><td>Earth</td><td><a href="https://svs.gsfc.nasa.gov/3615" target="_blank" rel="noopener">NASA Blue Marble Next Generation</a> (cloud-free), turned by sidereal time</td></tr>
    <tr><td>Stars</td><td>Hipparcos catalogue to magnitude 7.5 (25,723 stars), IAU star names, constellations and Milky Way via <a href="https://github.com/ofrohn/d3-celestial" target="_blank" rel="noopener">d3-celestial</a></td></tr>
  </table>
  <p>Checked against independent facts: the Moon's pole points into Draco, Earth stands ~66° up at Apollo 11, planets match their known positions to 0.1°, Earth's phase is the opposite of the Moon's, sunrise to sunrise is 29.53 days, Shackleton rim is 86% sunlit (published value).</p>
  <p><a href="simulator.html">Open the rover mission simulator →</a> · <button type="button" id="showWelcome">Show the welcome again</button></p>`;
$('showWelcome').addEventListener('click', () => { closeWins(); $('welcome').hidden = false; });

// ---------- time controls ----------
function setNow() { S.t = Date.now(); S.rate = 1; S.paused = false; lastLight = 0; lastCard = 0; renderTimeUi(); }
function faster(dir) {
  if (S.paused) { S.paused = false; S.rate = dir > 0 ? 1 : -1; return; }
  const i = RATES.indexOf(S.rate);
  S.rate = RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 5 : i) + dir))];
  renderTimeUi();
}
$('tSlower').addEventListener('click', () => faster(-1));
$('tFaster').addEventListener('click', () => faster(1));
$('tPlay').addEventListener('click', () => { S.paused = !S.paused; renderTimeUi(); });
$('tNow').addEventListener('click', setNow);

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key;
  const step = (ms) => setTime(S.t + ms);
  const map = {
    c: () => toggle('constLines'), p: () => toggle('planetLabels'), g: () => toggle('ground'), z: () => toggle('azGrid'), m: () => toggle('milkyWay'), b: () => toggle('bright'),
    o: () => setView(S.view === 'surface' ? 'orbit' : 'surface'),
    j: () => faster(-1), l: () => faster(1), k: () => $('tPlay').click(), 8: setNow,
    '-': () => step(-DAY), '=': () => step(DAY),
    ' ': () => centerOnSelection(),
    Escape: () => { if (!$('welcome').hidden) closeWelcome(); else if (document.querySelector('.win:not([hidden])')) closeWins(); else select(null); },
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

// Whole Moon: clicking the sky (not the Moon) picks stars and planets.
let downAt = null;
globe.canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
globe.canvas.addEventListener('pointerup', (e) => {
  if (S.view !== 'orbit' || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  if (!globe.pickPoint(e)) pickSky(e.clientX, e.clientY);
});

// ---------- welcome ----------
function closeWelcome() { $('welcome').hidden = true; store.set('welcomed', true); }
document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => {
  closeWelcome();
  const s = b.dataset.start;
  if (s === 'orbit') setView('orbit');
  if (s === 'place') openWin('location');
  if (s === 'surface' && S.site.name !== 'Apollo 11, Sea of Tranquillity') setSite({ name: 'Apollo 11, Sea of Tranquillity', lat: 0.674, lon: 23.473 }, true);
}));

// ---------- start ----------
(async () => {
  if (!store.get('welcomed', false)) $('welcome').hidden = false;
  const data = await loadSky('sky/');
  sky = new SkyLayer(data);
  surface = new SurfaceView(globe, sky);
  surface.onFrame = tick;
  surface.afterFrame = drawLabels;
  surface.onClick = (x, y) => pickSky(x, y);
  globe.onFrame = tick;
  globe.afterRender = drawLabels;
  globe.background = (r, cam) => sky.render(r, cam);
  window.lunaview = { globe, sky, surface, S, setSite, setView, select, setTime };
  syncOpts();
  setView('surface');
  await setSite(S.site, false, true);
})();
