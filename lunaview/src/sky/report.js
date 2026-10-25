// Site report: what a crew needs to know about one spot at one moment, and the month around it.
//
// Every number comes from measured data or from the ephemeris:
//  - surface temperature: LRO Diviner bolometric temperatures by local solar time (Williams et al.
//    2017), 0.5 deg bins at the named places, 2 deg bins elsewhere (tools/fetch_diviner.py);
//  - rocks: Diviner rock abundance, the share of the ground covered by rocks larger than about 1 m
//    (Bandfield et al. 2011), between 60S and 60N;
//  - slopes, shadows and the skyline: LOLA / SLDEM2015 heights (the landscape);
//  - Sun and Earth: astronomy-engine;
//  - space weather: NOAA SWPC GOES proton and X-ray feeds and NASA DONKI events, fetched live.
import { subPoints, moonPhase } from './ephem.js';

const DEG = Math.PI / 180;
const DAY = 86400e3;
const K0 = 273.15;

// ---------- data ----------
async function imageBytes(url) {
  const img = await new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = url; });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return { data: out, w: img.width, h: img.height };
}

let envPromise = null;
export function loadEnv(base = 'env/') {
  envPromise ??= Promise.all([
    imageBytes(`${base}temp_global.png`).catch(() => null),
    imageBytes(`${base}rocks.png`).catch(() => null),
    fetch(`${base}temp_places.json`).then((r) => r.json()).catch(() => ({})),
  ]).then(([temp, rocks, places]) => ({ temp, rocks, places }));
  return envPromise;
}

const placeOf = (env, lat, lon) => Object.entries(env.places).find(([, p]) => Math.abs(p.lat - lat) < 1e-4 && Math.abs(p.lon - lon) < 1e-4)?.[1];

// Local solar time (hours, 0-24) at a longitude: noon where the Sun is overhead.
export function localHour(date, lon, sp = subPoints(date)) {
  return ((((12 + (lon - sp.sun.lon) / 15) % 24) + 24) % 24);
}

// Diviner surface temperature (K) for a place at a local solar time, and the source used.
export function temperatureK(env, lat, lon, hour) {
  const p = placeOf(env, lat, lon);
  if (p) {
    const f = (hour / 24) * 96 - 0.5, i = Math.floor(f), t = f - i, n = 96;
    const a = p.temp_k[((i % n) + n) % n], b = p.temp_k[(((i + 1) % n) + n) % n];
    return { k: a * (1 - t) + b * t, src: `Diviner 0.5° bin at ${p.bin[0].toFixed(2)}°, ${p.bin[1].toFixed(2)}°` };
  }
  if (!env.temp) return null;
  const { data, w } = env.temp;
  const i = Math.min(89, Math.max(0, Math.floor((90 - lat) / 2)));
  const j = Math.min(179, Math.max(0, Math.floor((((lon + 180) % 360) + 360) % 360 / 2)));
  const f = (hour / 24) * 48 - 0.5, s = Math.floor(f), t = f - s;
  const at = (k) => data[i * w + j * 48 + (((k % 48) + 48) % 48)] * 2;
  return { k: at(s) * (1 - t) + at(s + 1) * t, src: 'Diviner, 2° bin' };
}

// Diviner rock abundance (fraction of the surface), or null outside 60S-60N.
export function rockFraction(env, lat, lon) {
  const p = placeOf(env, lat, lon);
  if (p && p.rock_fraction != null) return p.rock_fraction;
  if (!env.rocks || Math.abs(lat) >= 60) return null;
  const { data, w } = env.rocks;
  const v = data[Math.floor((60 - lat) * 4) * w + (Math.floor((((lon % 360) + 360) % 360) * 4) % w)];
  return v ? v / 1000 : null;
}

// Altitude and azimuth (deg) of a direction given by its sub-point, seen from (lat, lon). Ignores
// parallax: under 0.3 deg for Earth, nothing for the Sun.
function altAzFrom(lat, lon, sub) {
  const p = lat * DEG, ps = sub.lat * DEG, dl = (sub.lon - lon) * DEG;
  const alt = Math.asin(Math.sin(p) * Math.sin(ps) + Math.cos(p) * Math.cos(ps) * Math.cos(dl)) / DEG;
  const az = Math.atan2(Math.sin(dl) * Math.cos(ps), Math.cos(p) * Math.sin(ps) - Math.sin(p) * Math.cos(ps) * Math.cos(dl)) / DEG;
  return { alt, az: (az + 360) % 360 };
}

// The Moon spends about 6 days of each month inside Earth's magnetotail, centred on full Moon,
// where the solar wind is cut off and the dust charges differently.
export const inMagnetotail = (date) => Math.abs(moonPhase(date) - 180) < 22;

// ---------- one month at a site ----------
// skyline(az): the terrain horizon (deg) when the landscape for this site is built, else flat.
export function timeline(env, site, start, { days = 30, stepH = 1, skyline = () => 0 } = {}) {
  const out = [];
  for (let t = start.getTime(); t <= start.getTime() + days * DAY; t += stepH * 3600e3) {
    const d = new Date(t);
    const sp = subPoints(d);
    const sun = altAzFrom(site.lat, site.lon, sp.sun), earth = altAzFrom(site.lat, site.lon, sp.earth);
    const sunUp = sun.alt + 0.27 > skyline(sun.az), earthUp = earth.alt + 0.95 > skyline(earth.az);
    const temp = temperatureK(env, site.lat, site.lon, localHour(d, site.lon, sp));
    out.push({ t, sunAlt: sun.alt, sunUp, earthAlt: earth.alt, earthUp, tempK: temp?.k ?? null, tail: inMagnetotail(d) });
  }
  return out;
}

// ---------- live space weather ----------
// NOAA SWPC GOES feeds (protons >= 10 MeV in pfu, X-rays 0.1-0.8 nm in W/m2) and NASA DONKI events.
let swCache = null;
export async function spaceWeather() {
  if (swCache && Date.now() - swCache.at < 5 * 60e3) return swCache.v;
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
  const day = (d) => d.toISOString().slice(0, 10);
  const from = day(new Date(Date.now() - 7 * DAY)), to = day(new Date());
  const [protons, xrays, flares, seps, cmes, forecast] = await Promise.allSettled([
    get('https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json'),
    get('https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json'),
    get(`https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/FLR?startDate=${from}&endDate=${to}`),
    get(`https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/SEP?startDate=${from}&endDate=${to}`),
    get(`https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CME?startDate=${from}&endDate=${to}`),
    fetch('https://services.swpc.noaa.gov/text/3-day-forecast.txt').then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))),
  ]);
  const v = { ok: false };
  if (protons.status === 'fulfilled') {
    const p = protons.value.filter((x) => x.energy === '>=10 MeV');
    const last = p[p.length - 1];
    if (last) { v.protons = last.flux; v.protonsAt = last.time_tag; v.protonsMax = Math.max(...p.map((x) => x.flux)); v.ok = true; }
  }
  if (xrays.status === 'fulfilled') {
    const x = xrays.value.filter((e) => e.energy === '0.1-0.8nm');
    const last = x[x.length - 1];
    if (last) { v.xray = last.flux; v.xrayMax = Math.max(...x.map((e) => e.flux)); v.ok = true; }
  }
  if (flares.status === 'fulfilled') v.flares = flares.value.map((f) => ({ cls: f.classType, at: f.peakTime ?? f.beginTime })).filter((f) => /^[MX]/.test(f.cls));
  if (seps.status === 'fulfilled') v.seps = seps.value.map((s) => s.eventTime);
  if (cmes.status === 'fulfilled') v.cmes = cmes.value.length;
  if (forecast.status === 'fulfilled') {
    // "S1 or greater    1%     1%     1%" in the Solar Radiation Storm Forecast section.
    const m = forecast.value.match(/S1 or greater\s+(\d+)%\s+(\d+)%\s+(\d+)%/);
    if (m) v.s1Next3 = [+m[1], +m[2], +m[3]];
  }
  swCache = { at: Date.now(), v };
  return v;
}

export const sScale = (pfu) => (pfu >= 1e5 ? 5 : pfu >= 1e4 ? 4 : pfu >= 1e3 ? 3 : pfu >= 100 ? 2 : pfu >= 10 ? 1 : 0);
export function flareClass(w) {
  if (!(w > 0)) return '';
  const cls = ['A', 'B', 'C', 'M', 'X'];
  const e = Math.min(4, Math.max(0, Math.floor(Math.log10(w)) + 8));
  return `${cls[e]}${(w / 10 ** (e - 8)).toFixed(1)}`;
}

// ---------- go / no-go ----------
// Planning thresholds used here (illustrative, stated in the report, not an agency rule):
//  light: Sun up and not setting within 24 h; temperature: -100 to +100 C for a suited walk, with
//  margin to the -160 / +120 C limits; radiation: no proton storm (S1 is >= 10 pfu); contact:
//  Earth above the local skyline; ground: slope under 8 deg and rocks under 1% for landing.
export const level = { go: 'go', caution: 'caution', nogo: 'nogo', none: 'none' };
export function assess({ sunUp, sunAlt, setsInH, tempC, earthUp, earthAlt, earthMargin, slope, rocks, sw, live }) {
  const out = [];
  const signed = (v, d = 0) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
  out.push({ label: 'Sunlight', limit: 'up, >24 h to sunset',
    level: !sunUp ? level.nogo : setsInH != null && setsInH < 24 ? level.caution : sunAlt < 5 ? level.caution : level.go,
    reading: !sunUp ? `night (Sun ${signed(sunAlt, 1)}°)` : `el ${sunAlt.toFixed(1)}°${setsInH != null ? `, sets in ${setsInH < 48 ? `${setsInH.toFixed(0)} h` : `${(setsInH / 24).toFixed(1)} d`}` : ', no sunset in 30 d'}` });
  out.push({ label: 'Surface temp', limit: '-100 to +100 °C',
    level: tempC == null ? level.none : tempC < -160 || tempC > 120 ? level.nogo : tempC < -100 || tempC > 100 ? level.caution : level.go,
    reading: tempC == null ? 'no data' : `${signed(tempC)} °C` });
  let rad = level.none, radText = 'no live data for this date';
  if (live && sw?.ok) {
    const s = sScale(sw.protons ?? 0);
    rad = s >= 2 ? level.nogo : s === 1 || (sw.xray ?? 0) >= 1e-4 ? level.caution : level.go;
    radText = `${(sw.protons ?? 0).toFixed(1)} pfu${s ? ` (S${s} storm)` : ''}, X-ray ${flareClass(sw.xray)}`;
  } else if (live) radText = 'feed unreachable';
  out.push({ label: 'Radiation', limit: '<10 pfu (S1)', level: rad, reading: radText });
  out.push({ label: 'Earth link', limit: 'Earth above skyline',
    level: earthUp ? (earthMargin < 3 ? level.caution : level.go) : level.nogo,
    reading: earthUp ? `Earth el ${earthAlt.toFixed(1)}°` : `Earth hidden (${signed(earthAlt, 1)}°)` });
  out.push({ label: 'Ground', limit: 'slope <8°, rocks <1%',
    level: slope == null ? level.none : slope > 15 || (rocks ?? 0) > 0.03 ? level.nogo : slope > 8 || (rocks ?? 0) > 0.01 ? level.caution : level.go,
    reading: slope == null ? 'no data' : `${slope.toFixed(1)}°${rocks != null ? `, rocks ${(rocks * 100).toFixed(1)}%` : ''}` });
  const rank = { nogo: 3, caution: 2, go: 1, none: 0 };
  const worst = out.reduce((acc, r) => (rank[r.level] > rank[acc] ? r.level : acc), level.none);
  return { items: out, overall: worst };
}

