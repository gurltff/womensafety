// Terrain for the rover simulator, anywhere on the Moon: heights, slopes and skylines.
// Sources, finest first: the LOLA 80 m south polar DEM (poleward of 80S), then whole-Moon LOLA
// tiles at ~950 m (16 x 8 tiles of 22.5 deg, 721 samples a side), then the coarse globe data.
// Positions are latitude/longitude in degrees; directions in the Moon-fixed frame
// (+X lon 0, +Y lon 90E, +Z north).

export const R_M = 1737400;
const DEG = Math.PI / 180;

// ---------- coordinates ----------

export function latLonToXY(lat, lon) {
  const rho = 2 * R_M * Math.tan(Math.PI / 4 + (lat * DEG) / 2);
  return { x: rho * Math.sin(lon * DEG), y: rho * Math.cos(lon * DEG) };
}

export function xyToLatLon(x, y) {
  return { lat: (2 * Math.atan(Math.hypot(x, y) / (2 * R_M))) / DEG - 90, lon: Math.atan2(x, y) / DEG };
}

export function toVec(lat, lon) {
  const cl = Math.cos(lat * DEG);
  return { x: cl * Math.cos(lon * DEG), y: cl * Math.sin(lon * DEG), z: Math.sin(lat * DEG) };
}

export function toLatLon(v) {
  const r = Math.hypot(v.x, v.y, v.z);
  return { lat: Math.asin(v.z / r) / DEG, lon: Math.atan2(v.y, v.x) / DEG };
}

// Local east and north unit vectors at a point.
export function localFrame(lat, lon) {
  const la = lat * DEG, lo = lon * DEG;
  return {
    up: toVec(lat, lon),
    east: { x: -Math.sin(lo), y: Math.cos(lo), z: 0 },
    north: { x: -Math.sin(la) * Math.cos(lo), y: -Math.sin(la) * Math.sin(lo), z: Math.cos(la) },
  };
}

// Point reached by going `metres` from (lat, lon) along azimuth az (deg from north through east).
export function offset(lat, lon, az, metres) {
  const { up, east, north } = localFrame(lat, lon);
  const a = metres / R_M, ca = Math.cos(az * DEG), sa = Math.sin(az * DEG);
  const dx = north.x * ca + east.x * sa, dy = north.y * ca + east.y * sa, dz = north.z * ca + east.z * sa;
  return toLatLon({ x: up.x * Math.cos(a) + dx * Math.sin(a), y: up.y * Math.cos(a) + dy * Math.sin(a), z: up.z * Math.cos(a) + dz * Math.sin(a) });
}

// Great-circle distance (m) and initial azimuth (deg) from a to b.
export function distance(a, b) {
  const p = toVec(a.lat, a.lon), q = toVec(b.lat, b.lon);
  return R_M * Math.acos(Math.min(1, Math.max(-1, p.x * q.x + p.y * q.y + p.z * q.z)));
}

export function bearing(a, b) {
  const la1 = a.lat * DEG, la2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

// Point a fraction f of the way from a to b along the great circle.
export function between(a, b, f) {
  const p = toVec(a.lat, a.lon), q = toVec(b.lat, b.lon);
  const w = Math.acos(Math.min(1, Math.max(-1, p.x * q.x + p.y * q.y + p.z * q.z)));
  if (w < 1e-12) return { lat: a.lat, lon: a.lon };
  const s1 = Math.sin((1 - f) * w) / Math.sin(w), s2 = Math.sin(f * w) / Math.sin(w);
  return toLatLon({ x: p.x * s1 + q.x * s2, y: p.y * s1 + q.y * s2, z: p.z * s1 + q.z * s2 });
}

// ---------- height images ----------

// Heights are packed losslessly in a PNG: metres = red * 256 + green - 32768.
export async function decodeHeights(url) {
  const img = await new Promise((ok, fail) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = fail;
    im.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data;
  const heights = new Int16Array(img.width * img.height);
  for (let i = 0; i < heights.length; i++) heights[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
  return { heights, size: img.width };
}

// ---------- terrain ----------

export class Terrain {
  // meta: terrain.json { sim, globe }; coarse(lat, lon) gives metres from coarser data, or NaN;
  // decode(url) loads a height image (defaults to decodeHeights, swappable in tests).
  constructor(meta, coarse, { base = 'textures/', decode = decodeHeights } = {}) {
    this.polar = meta.sim ?? null;
    this.globe = meta.globe ?? null;
    this.coarse = coarse;
    this.base = base;
    this.decode = decode;
    this.tiles = new Map(); // "p:r_c" (80 m polar) or "g:r_c" (whole-Moon) -> { heights, size } | null
    this.polarHalf = this.polar ? (this.polar.tile_px * this.polar.tiles * this.polar.scale_m) / 2 : 0;
  }

  polarTile(lat, lon) {
    if (!this.polar || lat > -79.9) return null;
    const { x, y } = latLonToXY(lat, lon);
    if (Math.abs(x) >= this.polarHalf || Math.abs(y) >= this.polarHalf) return null;
    const m = this.polar;
    const line = m.line_off - y / m.scale_m, sample = m.sample_off + x / m.scale_m;
    const r = Math.floor(line / m.tile_px), c = Math.floor(sample / m.tile_px);
    return { key: `p:${r}_${c}`, url: `sim/s${r}_${c}.png`, line: line - r * m.tile_px, sample: sample - c * m.tile_px };
  }

  globeTile(lat, lon) {
    if (!this.globe) return null;
    const g = this.globe, span = 180 / g.rows;
    const L = ((lon + 180) % 360 + 360) % 360;
    const r = Math.min(g.rows - 1, Math.floor((90 - lat) / span)), c = Math.min(g.cols - 1, Math.floor(L / span));
    const n = g.grid - 1;
    return { key: `g:${r}_${c}`, url: `globe/c${r}_${c}_h.png`, line: ((90 - lat) / span - r) * n, sample: (L / span - c) * n };
  }

  // Load the tiles around a set of points (each widened by marginM) so heights there are exact.
  async loadAround(points, marginM = 20000) {
    const want = new Map();
    for (const p of points) {
      for (const az of [null, 0, 90, 180, 270]) {
        const q = az === null ? p : offset(p.lat, p.lon, az, marginM);
        for (const t of [this.polarTile(q.lat, q.lon), this.globeTile(q.lat, q.lon)]) if (t) want.set(t.key, t.url);
      }
    }
    await Promise.all([...want].filter(([k]) => !this.tiles.has(k)).map(async ([k, url]) => {
      this.tiles.set(k, null);
      try {
        this.tiles.set(k, await this.decode(`${this.base}${url}`));
      } catch {
        this.tiles.delete(k);
      }
    }));
  }

  sample(t, line, sample) {
    const n = t.size;
    const l0 = Math.min(Math.max(Math.floor(line), 0), n - 2), s0 = Math.min(Math.max(Math.floor(sample), 0), n - 2);
    const fl = Math.min(Math.max(line - l0, 0), 1), fs = Math.min(Math.max(sample - s0, 0), 1);
    const H = t.heights, i = l0 * n + s0;
    return (H[i] * (1 - fs) + H[i + 1] * fs) * (1 - fl) + (H[i + n] * (1 - fs) + H[i + n + 1] * fs) * fl;
  }

  // Ground height in metres (relative to 1737.4 km).
  height(lat, lon) {
    const p = this.polarTile(lat, lon);
    if (p) { const t = this.tiles.get(p.key); if (t) return this.sample(t, p.line, p.sample); }
    const g = this.globeTile(lat, lon);
    if (g) { const t = this.tiles.get(g.key); if (t) return this.sample(t, g.line, g.sample); }
    return this.coarse ? this.coarse(lat, lon) : 0;
  }

  // Spacing (m) of the finest data loaded here, or null if only the coarse globe data is available.
  resolution(lat, lon) {
    const p = this.polarTile(lat, lon);
    if (p && this.tiles.get(p.key)) return this.polar.scale_m;
    const g = this.globeTile(lat, lon);
    if (g && this.tiles.get(g.key)) return Math.round((2 * Math.PI * R_M) / (this.globe.cols * (this.globe.grid - 1)));
    return null;
  }

  // Slope (deg) and the upward surface normal in local east/north/up components.
  surface(lat, lon, step) {
    step ??= Math.max(80, this.resolution(lat, lon) ?? 1000);
    const e1 = offset(lat, lon, 90, step), e0 = offset(lat, lon, 270, step);
    const n1 = offset(lat, lon, 0, step), n0 = offset(lat, lon, 180, step);
    const dE = (this.height(e1.lat, e1.lon) - this.height(e0.lat, e0.lon)) / (2 * step);
    const dN = (this.height(n1.lat, n1.lon) - this.height(n0.lat, n0.lon)) / (2 * step);
    const len = Math.hypot(dE, dN, 1);
    return { slope: Math.atan(Math.hypot(dE, dN)) / DEG, normal: { e: -dE / len, n: -dN / len, u: 1 / len } };
  }

  // Elevation angle (deg) of the skyline seen from (lat, lon) at observer height h0 (m), looking
  // toward azimuth az (deg from north through east), out to maxM metres. Includes lunar curvature.
  horizon(lat, lon, az, h0, maxM = 150000) {
    const { up, east, north } = localFrame(lat, lon);
    const ca = Math.cos(az * DEG), sa = Math.sin(az * DEG);
    const dx = north.x * ca + east.x * sa, dy = north.y * ca + east.y * sa, dz = north.z * ca + east.z * sa;
    let best = -90;
    // 80 m steps for the first 4 km, then growing steps.
    for (let d = 80; d <= maxM; d = d < 4000 ? d + 80 : d * 1.04) {
      const a = d / R_M, c = Math.cos(a), s = Math.sin(a);
      const x = up.x * c + dx * s, y = up.y * c + dy * s, z = up.z * c + dz * s;
      const h = this.height(Math.asin(z) / DEG, Math.atan2(y, x) / DEG);
      if (!Number.isFinite(h)) continue;
      const ang = Math.atan2(h - h0 - (d * d) / (2 * R_M), d) / DEG;
      if (ang > best) best = ang;
    }
    return best;
  }
}
