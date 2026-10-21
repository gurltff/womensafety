// Where everything in the sky is, seen from a point on the Moon at a given moment.
//
// Positions come from astronomy-engine: VSOP87 for the planets and the Earth-Sun vector, ELP/MPP02
// for the Moon (accurate to well under an arcminute over centuries), and the IAU/WGCCRE rotation
// model for the Moon's orientation. Everything is computed in J2000 equatorial coordinates (EQJ,
// the frame star catalogues use) and then turned into the observer's horizon frame on the Moon.
import * as Astronomy from 'astronomy-engine';

export const MOON_R_KM = 1737.4;
export const EARTH_R_KM = 6378.137;
export const SUN_R_KM = 695700;
const AU = Astronomy.KM_PER_AU;
const DEG = Math.PI / 180;

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => { const l = len(a); return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });

// Moon body-fixed axes (IAU model) in EQJ: x toward lon 0 on the equator, z north.
export function moonAxes(time) {
  const axis = Astronomy.RotationAxis(Astronomy.Body.Moon, time);
  const z = norm(axis.north);
  const node = norm(cross({ x: 0, y: 0, z: 1 }, z));
  const nodeQ = cross(z, node);
  const w = axis.spin * DEG;
  const x = add(mul(node, Math.cos(w)), mul(nodeQ, Math.sin(w)));
  return { x, y: cross(z, x), z };
}

export const raDecToEqj = (raDeg, decDeg) => {
  const r = raDeg * DEG, d = decDeg * DEG;
  return { x: Math.cos(d) * Math.cos(r), y: Math.cos(d) * Math.sin(r), z: Math.sin(d) };
};
export const eqjToRaDec = (v) => {
  const u = norm(v);
  let ra = Math.atan2(u.y, u.x) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, u.z))) / DEG };
};

// Observer at (lat, lon, height above the 1737.4 km sphere in metres) on the Moon at `date`.
// Returns the EQJ position (km, from Earth's centre) and the local east/north/up axes in EQJ.
export function observerAt(date, site) {
  const time = Astronomy.MakeTime(date);
  const ax = moonAxes(time);
  const la = site.lat * DEG, lo = site.lon * DEG;
  // Site direction in Moon-fixed coordinates, then in EQJ.
  const mf = { x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) };
  const toEqj = (v) => add(add(mul(ax.x, v.x), mul(ax.y, v.y)), mul(ax.z, v.z));
  const up = toEqj(mf);
  const east = toEqj({ x: -Math.sin(lo), y: Math.cos(lo), z: 0 });
  const north = toEqj({ x: -Math.sin(la) * Math.cos(lo), y: -Math.sin(la) * Math.sin(lo), z: Math.cos(la) });
  const moon = mul(Astronomy.GeoMoon(time), AU);
  const pos = add(moon, mul(up, MOON_R_KM + (site.hM ?? 0) / 1000));
  return { time, date, site, ax, up, east, north, moon, pos };
}

// Altitude and azimuth (deg, azimuth from north through east) of an EQJ direction.
export function altAz(obs, dir) {
  const d = norm(dir);
  const alt = Math.asin(Math.max(-1, Math.min(1, dot(d, obs.up)))) / DEG;
  let az = Math.atan2(dot(d, obs.east), dot(d, obs.north)) / DEG;
  if (az < 0) az += 360;
  return { alt, az };
}

// EQJ -> horizon frame used for drawing: x east, y up, z south (so -z is north).
export function horizonMatrix(obs) {
  const { east: e, up: u, north: n } = obs;
  // Row-major 3x3.
  return [e.x, e.y, e.z, u.x, u.y, u.z, -n.x, -n.y, -n.z];
}

// EQJ -> Moon-fixed (row-major 3x3).
export function moonFixedMatrix(obs) {
  const { x, y, z } = obs.ax;
  return [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z];
}

// Earth's orientation: Earth-fixed (x lon 0, y lon 90E, z north) -> EQJ, via true sidereal time
// and precession/nutation (astronomy-engine Rotation_EQD_EQJ).
export function earthFixedToEqj(time) {
  const gast = Astronomy.SiderealTime(time) * 15 * DEG;
  const rot = Astronomy.Rotation_EQD_EQJ(time);
  const toEqj = (v) => {
    const eqd = { x: v.x * Math.cos(gast) - v.y * Math.sin(gast), y: v.x * Math.sin(gast) + v.y * Math.cos(gast), z: v.z };
    const r = Astronomy.RotateVector(rot, new Astronomy.Vector(eqd.x, eqd.y, eqd.z, time));
    return { x: r.x, y: r.y, z: r.z };
  };
  return { x: toEqj({ x: 1, y: 0, z: 0 }), y: toEqj({ x: 0, y: 1, z: 0 }), z: toEqj({ x: 0, y: 0, z: 1 }) };
}

const toLatLon = (v) => ({ lat: Math.asin(Math.max(-1, Math.min(1, v.z))) / DEG, lon: Math.atan2(v.y, v.x) / DEG });

const PLANETS = [
  ['mercury', 'Mercury', 2439.7, '#b8b1a6'], ['venus', 'Venus', 6051.8, '#f3e6c4'], ['mars', 'Mars', 3389.5, '#e0805a'],
  ['jupiter', 'Jupiter', 69911, '#e8d3b0'], ['saturn', 'Saturn', 58232, '#e6cf96'], ['uranus', 'Uranus', 25362, '#bfe3e8'],
  ['neptune', 'Neptune', 24622, '#8fb0f0'],
];

// Everything in the sky that moves: Sun, Earth and the planets, seen from the observer.
export function solarSystem(obs) {
  const t = obs.time;
  const out = [];
  const body = (id, name, type, geoKm, radiusKm, extra = {}) => {
    const rel = sub(geoKm, obs.pos);
    const dist = len(rel);
    const dir = norm(rel);
    out.push({ id, name, type, dir, distKm: dist, radiusKm, angDiamDeg: (2 * Math.asin(Math.min(1, radiusKm / dist))) / DEG, ...altAz(obs, dir), ...eqjToRaDec(dir), ...extra });
  };
  const sunGeo = mul(Astronomy.GeoVector(Astronomy.Body.Sun, t, true), AU);
  body('sun', 'Sun', 'star', sunGeo, SUN_R_KM, { mag: -26.74, color: '#fff4d6' });

  // Earth: phase as seen from here, which side faces us, and where it is day.
  const toEarth = norm(sub({ x: 0, y: 0, z: 0 }, obs.pos));
  const earthToSun = norm(sunGeo);
  const phaseAngle = Math.acos(Math.max(-1, Math.min(1, dot(earthToSun, mul(toEarth, -1))))) / DEG;
  const illum = (1 + Math.cos(phaseAngle * DEG)) / 2;
  const E = earthFixedToEqj(t);
  const fromEqj = (v) => ({ x: dot(v, E.x), y: dot(v, E.y), z: dot(v, E.z) });
  const subObs = toLatLon(norm(fromEqj(mul(toEarth, -1))));
  const subSun = toLatLon(norm(fromEqj(earthToSun)));
  // Full Earth seen from the Moon is about magnitude -17.7 (Earth's albedo 0.30, 384 400 km);
  // dimmer with phase, by the Lambert phase function.
  const a = phaseAngle * DEG;
  const lambert = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
  const dist = len(obs.pos);
  const mag = -17.7 + 5 * Math.log10(dist / 384400) - 2.5 * Math.log10(Math.max(1e-4, lambert));
  body('earth', 'Earth', 'planet', { x: 0, y: 0, z: 0 }, EARTH_R_KM, {
    mag, phaseAngle, illum, subObserver: subObs, subSolar: subSun, earthAxes: E, color: '#9cc4ff',
  });

  for (const [id, name, r, color] of PLANETS) {
    const b = Astronomy.Body[name];
    const geo = mul(Astronomy.GeoVector(b, t, true), AU);
    const il = Astronomy.Illumination(b, t);
    body(id, name, 'planet', geo, r, { mag: il.mag, illum: il.phase_fraction, phaseAngle: il.phase_angle, color });
  }
  return out;
}

// Where the Sun and Earth are directly overhead on the Moon (sub-solar and sub-Earth points).
export function subPoints(date) {
  const time = Astronomy.MakeTime(date);
  const ax = moonAxes(time);
  const moon = mul(Astronomy.GeoMoon(time), AU);
  const sun = sub(mul(Astronomy.GeoVector(Astronomy.Body.Sun, time, true), AU), moon);
  const earth = mul(moon, -1);
  const mf = (v) => { const u = norm(v); return { x: dot(u, ax.x), y: dot(u, ax.y), z: dot(u, ax.z) }; };
  return { sun: toLatLon(mf(sun)), earth: toLatLon(mf(earth)), sunDirMf: mf(sun), earthDistKm: len(moon) };
}

// The Moon's phase as seen from Earth (0 new, 90 first quarter, 180 full, 270 last quarter).
export const moonPhase = (date) => Astronomy.MoonPhase(Astronomy.MakeTime(date));

// Next times (within `days`) that a body crosses the local skyline at a site, both ways.
// skyline(az) -> elevation (deg) of the terrain horizon. Body: 'sun' or 'earth'. Accounts for
// the Sun's disc (upper limb) for the Sun.
export function riseSet(site, date, skyline, id, days = 30) {
  const margin = (t) => {
    const obs = observerAt(new Date(t), site);
    const s = id === 'sun'
      ? sub(mul(Astronomy.GeoVector(Astronomy.Body.Sun, obs.time, true), AU), obs.pos)
      : mul(obs.pos, -1);
    const { alt, az } = altAz(obs, s);
    const semi = id === 'sun' ? 0.2666 : 0.95;
    return alt + semi - skyline(az);
  };
  const t0 = date.getTime(), stepMs = 30 * 60e3;
  const events = [];
  let prevT = t0 - days * 86400e3 / 6, prev = margin(prevT);
  for (let t = prevT + stepMs; t <= t0 + days * 86400e3; t += stepMs) {
    const m = margin(t);
    if ((prev <= 0) !== (m <= 0)) {
      let lo = t - stepMs, hi = t, mlo = prev;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2, mm = margin(mid);
        if ((mlo <= 0) === (mm <= 0)) { lo = mid; mlo = mm; } else hi = mid;
      }
      events.push({ t: new Date((lo + hi) / 2), kind: m > 0 ? 'rise' : 'set' });
    }
    prev = m;
  }
  const now = margin(t0);
  const next = (kind) => events.find((e) => e.kind === kind && e.t.getTime() > t0) ?? null;
  const last = (kind) => [...events].reverse().find((e) => e.kind === kind && e.t.getTime() <= t0) ?? null;
  return { up: now > 0, nextRise: next('rise'), nextSet: next('set'), lastRise: last('rise'), lastSet: last('set') };
}

export { dot, norm, sub, add, mul, len };
