// Rover mission simulator. Steps through the mission (default every 15 minutes) at the rover's
// real position on real terrain and tracks sunlight, surface temperature, battery, Earth contact and
// driving. A Monte Carlo wrapper repeats the run with realistic uncertainty to give a success rate.
import { bodyVectors, localAngles } from './astro.js';
import { distance, between, toVec, toLatLon } from './terrain.js';

const DEG = Math.PI / 180;
const SIGMA = 5.670e-8;
const SOLAR_CONST = 1361; // W/m2 at 1 AU
const AU_KM = 149597870.7;
const ALBEDO = 0.12, EMISSIVITY = 0.95; // lunar regolith
const NIGHT_K = 95; // regolith settles near 95 K through the lunar night (Diviner)
const HOUR = 3600 * 1000;

// ---------- route ----------

// Sample the route every `step` metres (default: 80 m where the 80 m polar data is, else 200 m):
// position, distance along route, height, slope, grade and the terrain detail used.
export function prepareRoute(terrain, waypoints, step) {
  step ??= waypoints.every((w) => w.lat < -80) ? 80 : 200;
  const pts = [];
  let dist = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    if (!b) { pts.push({ lat: a.lat, lon: a.lon, d: dist }); break; }
    const len = distance(a, b);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) pts.push({ ...between(a, b, k / n), d: dist + (len * k) / n });
    dist += len;
  }
  for (const p of pts) {
    p.h = terrain.height(p.lat, p.lon);
    p.slope = terrain.surface(p.lat, p.lon).slope;
    p.res = terrain.resolution(p.lat, p.lon);
    p.v = toVec(p.lat, p.lon);
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const run = b.d - a.d;
    pts[i].grade = run > 0 ? Math.atan2(b.h - a.h, run) / DEG : 0; // + uphill along the route
  }
  const steepest = pts.reduce((m, p) => (p.slope > m.slope ? p : m), pts[0]);
  const coarsest = pts.reduce((m, p) => Math.max(m, p.res ?? 2000), 0);
  return { pts, length: dist, steepest, coarsest, climb: pts.reduce((s, p, i) => s + Math.max(0, i ? p.h - pts[i - 1].h : 0), 0) };
}

export function pointAt(route, d) {
  const pts = route.pts;
  if (d <= 0) return { ...pts[0], i: 0 };
  if (d >= route.length) return { ...pts[pts.length - 1], i: pts.length - 1 };
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].d <= d) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi], f = (d - a.d) / (b.d - a.d || 1);
  const ll = toLatLon({ x: a.v.x + (b.v.x - a.v.x) * f, y: a.v.y + (b.v.y - a.v.y) * f, z: a.v.z + (b.v.z - a.v.z) * f });
  return { ...ll, h: a.h + (b.h - a.h) * f, slope: Math.max(a.slope, b.slope), grade: a.grade, i: lo };
}

// ---------- ephemeris cache ----------

export function ephemeris(stepMs) {
  const cache = new Map();
  return (t) => {
    const k = Math.round(t / stepMs);
    let v = cache.get(k);
    if (!v) { v = bodyVectors(new Date(k * stepMs)); cache.set(k, v); }
    return v;
  };
}

// ---------- environment at one place and time ----------

export function environment(terrain, eph, lat, lon, h, t, mastM = 1.5) {
  const v = eph(t);
  const site = { lat, lon };
  const sun = localAngles(site, v.sun);
  const earth = localAngles(site, v.earth, v.earthDistKm);
  const h0 = h + mastM;
  // Skip tracing the skyline when the answer is clear: Sun well below the horizon (night), or Earth
  // high in the sky.
  const sunHz = sun.el < -2 ? 0 : terrain.horizon(lat, lon, sun.az, h0);
  const earthHz = earth.el < -2 ? 0 : earth.el > 25 ? -90 : terrain.horizon(lat, lon, earth.az, h0);
  // Fraction of the Sun's 0.53 deg disc above the skyline.
  const sunVis = Math.min(1, Math.max(0, (sun.el - sunHz) / 0.53 + 0.5));
  const surf = terrain.surface(lat, lon);
  const se = Math.cos(sun.el * DEG);
  const sunDir = { e: se * Math.sin(sun.az * DEG), n: se * Math.cos(sun.az * DEG), u: Math.sin(sun.el * DEG) };
  const cosI = Math.max(0, sunDir.e * surf.normal.e + sunDir.n * surf.normal.n + sunDir.u * surf.normal.u);
  const flux = SOLAR_CONST * (AU_KM / v.sunDistKm) ** 2;
  // Radiative-equilibrium temperature of the sunlit ground; NIGHT_K in shadow.
  const teq = Math.max(NIGHT_K, ((1 - ALBEDO) * flux * sunVis * cosI / (EMISSIVITY * SIGMA)) ** 0.25);
  return { sun, earth, sunHz, earthHz, sunVis, earthVis: earth.el > earthHz, cosI, flux, teq, slope: surf.slope };
}

// Is the Sun up over the skyline at route sample i at time t? Cached per route, because every
// Monte Carlo run passes the same places at the same 15-minute marks.
function sunlitAt(terrain, eph, route, i, t) {
  const cache = (route.sunCache ??= new Map());
  const key = i * 1e7 + Math.round(t / 900000);
  let v = cache.get(key);
  if (v === undefined) {
    const q = route.pts[i];
    const sun = localAngles(q, eph(t).sun);
    v = sun.el > -1 && sun.el - terrain.horizon(q.lat, q.lon, sun.az, q.h + 1.5) > 0;
    cache.set(key, v);
  }
  return v;
}

// ---------- one mission ----------

const STATES = { drive: 'Driving', retreat: 'Driving back to sunlight', park: 'Parked', charge: 'Charging', hibernate: 'Hibernating', done: 'Arrived', dead: 'Lost' };

export function simulate({ terrain, eph, rover, route, start, days, stepMin = 15, perturb = {}, record = true, mustSurvive = true }) {
  const p = { solar: 1, drive: 1, speed: 1, battery: 1, heat: 1, idle: 1, ...perturb };
  const dt = stepMin * 60 * 1000;
  const dtH = stepMin / 60;
  const t0 = start.getTime() + (p.slipDays ?? 0) * 24 * HOUR;
  const steps = Math.round((days * 24 * 60) / stepMin);
  const cap = rover.batteryWh * p.battery;
  let soc = cap * 0.95; // lands nearly full
  let d = 0;
  let tSurf = null;
  let state = 'park';
  const stationary = route.length < 1;
  const timeline = [];
  const events = [];
  const note = (t, level, text) => events.push({ t: new Date(t), level, text });
  let result = null, shadowStart = null, longestShadowH = 0, lowSoc = 1, drivenH = 0, commsSteps = 0, sunSteps = 0;
  let lowWarned = false, coldWarned = false, reachedAt = null;

  for (let s = 0; s <= steps; s++) {
    const t = t0 + s * dt;
    const pos = pointAt(route, d);
    const env = environment(terrain, eph, pos.lat, pos.lon, pos.h, t);
    // Ground temperature follows equilibrium with lag: warms in ~2 h, cools over ~10 h.
    tSurf = tSurf === null ? env.teq : tSurf + (env.teq - tSurf) * (1 - Math.exp(-dtH / (env.teq > tSurf ? 2 : 10)));
    const sunlit = env.sunVis > 0.5;
    if (sunlit) sunSteps++;
    if (env.earthVis) commsSteps++;
    if (!sunlit && shadowStart === null) shadowStart = t;
    if (sunlit && shadowStart !== null) {
      const hrs = (t - shadowStart) / HOUR;
      if (hrs > longestShadowH) longestShadowH = hrs;
      if (hrs >= 6) note(t, 'info', `Sun back after ${Math.round(hrs)} h of shadow.`);
      shadowStart = null;
    }

    // Power in.
    const panel = rover.panel === 'horizontal' ? Math.max(0, Math.sin(env.sun.el * DEG)) : Math.max(0, Math.cos(env.sun.el * DEG));
    const gen = rover.solarW * p.solar * (env.flux / SOLAR_CONST) * env.sunVis * panel;
    // In sunlight the rover's own sunlit body keeps it warm. In shadow it loses heat to the cold
    // ground and sky, and heaters must keep the inside above its minimum; RHUs cover part of it.
    const heater = sunlit ? 0 : Math.max(0, rover.heatWperK * p.heat * (rover.minTempC + 273.15 - tSurf) - (rover.rhuW ?? 0));

    // Decide what to do this step.
    const arrived = reachedAt !== null;
    // Operating rules, as a rover team would plan them: don't drive into shadow unless the battery is
    // well charged, drive out of shadow when possible, hibernate while waiting in the dark.
    const reasonsNotToDrive = [];
    // Energy (Wh) to drive `metres` through shadow, with heaters working against cold ground.
    const crossWh = (metres) => {
      const coldW = Math.max(0, rover.heatWperK * p.heat * (rover.minTempC + 273.15 - 120) - (rover.rhuW ?? 0));
      return (rover.idleW * p.idle + rover.driveW * p.drive + coldW) * (metres / (rover.speedMh * p.speed * 0.7));
    };
    const reserve = cap * rover.reservePct / 100;
    let dir = 0; // +1 drive on along the route, -1 drive back
    if (!arrived && !stationary) {
      const last = route.pts.length - 1;
      if (sunlit) {
        // Before setting off, look along the route (up to 3 km) for shadow. Only drive into it if the
        // battery can carry the rover across with its reserve intact.
        let shadowFrom = null, shadowTo = null;
        const reach = Math.max(240, rover.speedMh * p.speed);
        for (let i = pos.i + 1; i <= last && route.pts[i].d - d <= 3000; i += route.pts[i].d - d < reach ? 1 : 2) {
          const dark = !sunlitAt(terrain, eph, route, i, t);
          if (dark && shadowFrom === null) shadowFrom = route.pts[i].d - d;
          if (!dark && shadowFrom !== null) { shadowTo = route.pts[i].d - d; break; }
          if (shadowFrom === null && route.pts[i].d - d > reach) break;
          if (i === last && shadowFrom !== null) shadowTo = route.pts[i].d - d;
        }
        const blocked = shadowFrom !== null && shadowFrom <= reach && (shadowTo === null || soc - crossWh(shadowTo - shadowFrom) < reserve);
        if (soc < reserve) reasonsNotToDrive.push('battery reserve');
        if (blocked) reasonsNotToDrive.push('waiting for sunlight ahead');
        if (!reasonsNotToDrive.length) dir = 1;
      } else {
        dir = escape();
        if (!dir) reasonsNotToDrive.push('shadow');
      }
      if (dir && rover.needsComms && !env.earthVis) { reasonsNotToDrive.push('no Earth contact'); dir = 0; }
      if (dir && tSurf - 273.15 > rover.maxTempC) { reasonsNotToDrive.push('too hot'); dir = 0; }
    } else if (arrived && !sunlit) {
      // At the destination and the Sun has gone: move to the nearest sunlight along the route.
      dir = escape();
      if (dir && rover.needsComms && !env.earthVis) dir = 0;
    }
    function escape() {
      // The rover's own spot is dark: head for the nearest sunlit ground along the route, either
      // way, if the battery can get it there. Otherwise hibernate and wait for the Sun.
      const last = route.pts.length - 1;
      let best = null;
      for (const sgn of [1, -1]) {
        for (let i = pos.i + sgn; i >= 0 && i <= last && Math.abs(route.pts[i].d - d) <= 3000; i += sgn) {
          if (sunlitAt(terrain, eph, route, i, t)) {
            const m = Math.abs(route.pts[i].d - d);
            if (!best || m < best.m) best = { m, sgn };
            break;
          }
        }
      }
      return best && soc - crossWh(best.m) > cap * 0.05 ? best.sgn : 0;
    }
    let load, move = 0;
    if (state === 'dead') break;
    if ((arrived || stationary) && !dir) {
      state = !sunlit ? 'hibernate' : arrived ? 'done' : 'park';
      load = (state === 'hibernate' ? rover.hibernateW : rover.idleW * p.idle) + heater;
    } else if (dir) {
      // Slower on slopes; a slope beyond the rover's limit blocks the route.
      const ahead = pointAt(route, d + dir * Math.max(40, rover.speedMh * p.speed * dtH));
      if (ahead.slope > rover.maxSlopeDeg) {
        result = { success: false, cause: 'slope', text: `Route blocked: ${ahead.slope.toFixed(0)}° slope at km ${(d / 1000).toFixed(1)} is steeper than the rover's ${rover.maxSlopeDeg}° limit.` };
        note(t, 'critical', result.text);
        state = 'park';
        break;
      }
      const v = rover.speedMh * p.speed * Math.max(0.3, 1 - (0.6 * ahead.slope) / rover.maxSlopeDeg);
      move = dir * v * dtH;
      const uphill = Math.max(0, dir * ahead.grade);
      const climbW = (rover.massKg * 1.62 * (v / 3600) * Math.sin(uphill * DEG)) / 0.5;
      load = rover.idleW * p.idle + rover.driveW * p.drive + climbW + heater;
      state = dir > 0 ? 'drive' : 'retreat';
      drivenH += dtH;
    } else {
      // In the dark, sleep to save power; in sunlight, stay awake and charge.
      state = sunlit ? (gen > 0 ? 'charge' : 'park') : 'hibernate';
      load = (state === 'hibernate' ? rover.hibernateW : rover.idleW * p.idle) + heater;
    }

    soc = Math.min(cap, soc + (gen - load) * dtH);
    d = Math.min(route.length, Math.max(0, d + move));
    if (!stationary && d >= route.length && reachedAt === null) {
      reachedAt = t;
      note(t, 'ok', `Reached the destination (${(route.length / 1000).toFixed(1)} km) on day ${Math.floor((t - t0) / (24 * HOUR)) + 1}.`);
      if (!mustSurvive) {
        if (record) timeline.push({ t, d, soc: Math.max(0, soc) / cap, gen, load, heater, tSurfC: tSurf - 273.15, sunVis: env.sunVis, earthVis: env.earthVis, sunEl: env.sun.el, sunAz: env.sun.az, earthEl: env.earth.el, earthAz: env.earth.az, state: 'done', lat: route.pts[route.pts.length - 1].lat, lon: route.pts[route.pts.length - 1].lon, h: route.pts[route.pts.length - 1].h, why: '' });
        break;
      }
    }
    lowSoc = Math.min(lowSoc, Math.max(0, soc) / cap);
    if (soc / cap < 0.2 && !lowWarned) { lowWarned = true; note(t, 'warning', `Battery below 20% (${env.sunVis > 0.5 ? 'in sunlight' : 'in shadow'}).`); }
    if (heater > rover.idleW && !coldWarned) { coldWarned = true; note(t, 'warning', `Heaters now draw ${Math.round(heater)} W to survive ${Math.round(tSurf - 273.15)} °C ground.`); }

    if (record) {
      timeline.push({
        t, d, soc: Math.max(0, soc) / cap, gen, load, heater, tSurfC: tSurf - 273.15, sunVis: env.sunVis, earthVis: env.earthVis,
        sunEl: env.sun.el, sunAz: env.sun.az, earthEl: env.earth.el, earthAz: env.earth.az, state, lat: pos.lat, lon: pos.lon, h: pos.h,
        why: state === 'park' || state === 'charge' || state === 'hibernate' ? reasonsNotToDrive.join(', ') : state === 'retreat' ? 'heading back to sunlight' : '',
      });
    }
    if (soc <= 0) {
      const inShadow = shadowStart !== null ? ` after ${Math.round((t - shadowStart) / HOUR)} h of shadow` : '';
      const after = reachedAt !== null ? `Reached the destination on day ${Math.floor((reachedAt - t0) / (24 * HOUR)) + 1}, but the battery` : 'Battery';
      result = { success: false, cause: 'battery', text: `${after} ran out on day ${Math.floor((t - t0) / (24 * HOUR)) + 1}${inShadow}; heaters needed ${Math.round(heater)} W at ${Math.round(tSurf - 273.15)} °C.` };
      note(t, 'critical', result.text);
      state = 'dead';
      if (record) timeline[timeline.length - 1].state = 'dead';
      break;
    }
  }
  if (shadowStart !== null) longestShadowH = Math.max(longestShadowH, (t0 + steps * dt - shadowStart) / HOUR);
  if (!result) {
    if (stationary || reachedAt !== null) {
      const day = reachedAt !== null ? Math.floor((reachedAt - t0) / (24 * HOUR)) + 1 : null;
      result = { success: true, cause: null, text: stationary ? `Survives all ${days} days.` : mustSurvive ? `Reaches the destination on day ${day} and survives to day ${days}.` : `Reaches the destination on day ${day}.` };
    } else {
      result = { success: false, cause: 'time', text: `Out of time: covered ${(d / 1000).toFixed(1)} of ${(route.length / 1000).toFixed(1)} km in ${days} days.` };
    }
  }
  return {
    ...result, start: new Date(t0), days, stepMin, distance: d, routeLength: route.length, minSoc: lowSoc,
    longestShadowH, drivenH, commsFrac: commsSteps / (steps + 1), sunFrac: sunSteps / (steps + 1), timeline, events, perturb: p, states: STATES,
  };
}

// ---------- Monte Carlo ----------

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Realistic spread in what actually happens versus the plan.
export function drawPerturbation(rnd, slipDays) {
  const u = (a, b) => a + (b - a) * rnd();
  return {
    slipDays: Math.round(u(-slipDays, slipDays) * 4) / 4, // launch/landing date slips in 6 h steps
    solar: u(0.85, 1.0), // dust, temperature and degradation of the arrays
    drive: u(0.9, 1.25), // soil and wheel slip raise driving power
    speed: u(0.7, 1.05), // hazard checks and slip slow the traverse
    battery: u(0.85, 1.0), // capacity after cold cycles and ageing
    heat: u(0.9, 1.3), // heat leak uncertainty
    idle: u(0.95, 1.15),
  };
}

export async function monteCarlo(args, { runs = 50, slipDays = 2, seed = 7, onProgress } = {}) {
  const rnd = mulberry32(seed);
  const results = [];
  for (let i = 0; i < runs; i++) {
    results.push(simulate({ ...args, perturb: drawPerturbation(rnd, slipDays), record: false }));
    if (i % 5 === 4) { onProgress?.((i + 1) / runs); await new Promise((r) => setTimeout(r, 0)); }
  }
  const ok = results.filter((r) => r.success).length;
  const causes = {};
  for (const r of results) if (!r.success) (causes[r.cause] ??= []).push(r);
  return { runs, successes: ok, rate: ok / runs, causes, results };
}
