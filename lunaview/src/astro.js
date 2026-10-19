// Sun and Earth geometry as seen from a point on the Moon.
// Uses astronomy-engine (VSOP87 / ELP + IAU rotation model); accuracy is about an arcminute,
// which is plenty for power and comms planning. The backend can later cross-check with skyfield + DE440.
import * as Astronomy from 'astronomy-engine';

const DEG = Math.PI / 180;
export const MOON_RADIUS_KM = 1737.4;

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z); return { x: a.x / l, y: a.y / l, z: a.z / l }; };

// Moon body-fixed axes (IAU model) expressed in J2000 equatorial coordinates.
function moonAxes(time) {
  const axis = Astronomy.RotationAxis(Astronomy.Body.Moon, time);
  const z = norm(axis.north);
  const node = norm(cross({ x: 0, y: 0, z: 1 }, z));
  const w = axis.spin * DEG;
  const nodeQ = cross(z, node);
  const x = {
    x: Math.cos(w) * node.x + Math.sin(w) * nodeQ.x,
    y: Math.cos(w) * node.y + Math.sin(w) * nodeQ.y,
    z: Math.cos(w) * node.z + Math.sin(w) * nodeQ.z,
  };
  return { x, y: cross(z, x), z };
}

const toBody = (v, ax) => ({ x: dot(v, ax.x), y: dot(v, ax.y), z: dot(v, ax.z) });

// Directions (unit vectors, Moon-fixed frame: +X = lon 0 on the equator, +Z = north pole)
// from the Moon's centre to the Sun and to the Earth, plus distances in km.
export function bodyVectors(date) {
  const time = Astronomy.MakeTime(date);
  const moon = Astronomy.GeoMoon(time); // Earth -> Moon, AU, J2000 equatorial
  const sun = Astronomy.GeoVector(Astronomy.Body.Sun, time, true); // Earth -> Sun
  const ax = moonAxes(time);
  const toSun = { x: sun.x - moon.x, y: sun.y - moon.y, z: sun.z - moon.z };
  const toEarth = { x: -moon.x, y: -moon.y, z: -moon.z };
  const AU_KM = Astronomy.KM_PER_AU;
  return {
    sun: norm(toBody(toSun, ax)),
    earth: norm(toBody(toEarth, ax)),
    sunDistKm: Math.hypot(toSun.x, toSun.y, toSun.z) * AU_KM,
    earthDistKm: Math.hypot(toEarth.x, toEarth.y, toEarth.z) * AU_KM,
  };
}

export function latLonToVector(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return { x: Math.cos(la) * Math.cos(lo), y: Math.cos(la) * Math.sin(lo), z: Math.sin(la) };
}

// Sub-point (lat, lon in degrees) of a direction in the Moon-fixed frame.
export function subPoint(v) {
  return { lat: Math.asin(v.z) / DEG, lon: Math.atan2(v.y, v.x) / DEG };
}

// Local elevation/azimuth (degrees, azimuth from north through east) of a direction
// seen from a surface site. The Sun and Earth are far enough away that the site's
// offset from the Moon's centre only matters for Earth (~0.26 deg parallax), so we include it.
export function localAngles(site, dir, distKm = Infinity) {
  const la = site.lat * DEG, lo = site.lon * DEG;
  const up = latLonToVector(site.lat, site.lon);
  const east = { x: -Math.sin(lo), y: Math.cos(lo), z: 0 };
  const north = { x: -Math.sin(la) * Math.cos(lo), y: -Math.sin(la) * Math.sin(lo), z: Math.cos(la) };
  let d = dir;
  if (Number.isFinite(distKm)) {
    const r = MOON_RADIUS_KM;
    d = norm({ x: dir.x * distKm - up.x * r, y: dir.y * distKm - up.y * r, z: dir.z * distKm - up.z * r });
  }
  const el = Math.asin(Math.max(-1, Math.min(1, dot(d, up)))) / DEG;
  let az = Math.atan2(dot(d, east), dot(d, north)) / DEG;
  if (az < 0) az += 360;
  return { el, az };
}

// Horizon elevation (deg) at a given azimuth from a 360-sample profile (index = whole degree).
export function horizonAt(horizon, az) {
  if (!horizon) return 0;
  const n = horizon.length;
  const f = (az / 360) * n;
  const i = Math.floor(f) % n;
  const t = f - Math.floor(f);
  return horizon[i] * (1 - t) + horizon[(i + 1) % n] * t;
}

// Sun/Earth state for one instant at a site.
export function skyAt(site, date, horizon) {
  const v = bodyVectors(date);
  const sun = localAngles(site, v.sun);
  const earth = localAngles(site, v.earth, v.earthDistKm);
  // Earth's phase as seen from the Moon: fraction of the Earth disc that is lit.
  const cosPhase = -(v.sun.x * v.earth.x + v.sun.y * v.earth.y + v.sun.z * v.earth.z);
  const earthLit = (1 - cosPhase) / 2;
  const sunHorizon = horizonAt(horizon, sun.az);
  const earthHorizon = horizonAt(horizon, earth.az);
  // The Sun's disc is 0.53 deg wide; count a site as powered once the centre clears the horizon.
  return {
    sun, earth, earthLit,
    sunHorizon, earthHorizon,
    sunlit: sun.el > sunHorizon,
    sunMargin: sun.el - sunHorizon,
    earthVisible: earth.el > earthHorizon,
    earthMargin: earth.el - earthHorizon,
  };
}
