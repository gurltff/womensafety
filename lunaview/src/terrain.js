// Terrain for the rover simulator: heights, slopes and horizons in the south polar region, from the
// LOLA 80 m polar DEM (tiles loaded around the route), falling back to coarser data further out.
// Positions are polar stereographic metres from the pole (x toward lon 90E, y toward lon 0), the
// LOLA convention, so 1 m on the map is ~1 m on the ground poleward of 80S (scale error < 0.8%).

export const R_M = 1737400;
const DEG = Math.PI / 180;

export function latLonToXY(lat, lon) {
  const rho = 2 * R_M * Math.tan(Math.PI / 4 + (lat * DEG) / 2);
  return { x: rho * Math.sin(lon * DEG), y: rho * Math.cos(lon * DEG) };
}

export function xyToLatLon(x, y) {
  return { lat: (2 * Math.atan(Math.hypot(x, y) / (2 * R_M))) / DEG - 90, lon: Math.atan2(x, y) / DEG };
}

// Unit vectors (in map coordinates) for local north and east at a point; north points away from the pole.
export function localAxes(x, y) {
  const r = Math.hypot(x, y) || 1;
  const north = { x: x / r, y: y / r };
  return { north, east: { x: north.y, y: -north.x } };
}

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

export class Terrain {
  // meta: terrain.json "sim" block; coarse(x, y) returns metres from coarser data, or NaN.
  constructor(meta, coarse, base = 'textures/') {
    this.meta = meta;
    this.coarse = coarse;
    this.base = base;
    this.tiles = new Map(); // "r_c" -> { heights, size } once loaded
    this.limitM = meta ? (meta.tile_px * meta.tiles * meta.scale_m) / 2 : 0;
  }

  covers(x, y) {
    return Math.abs(x) < this.limitM && Math.abs(y) < this.limitM;
  }

  tileOf(x, y) {
    const m = this.meta;
    const line = m.line_off - y / m.scale_m, sample = m.sample_off + x / m.scale_m;
    const r = Math.floor(line / m.tile_px), c = Math.floor(sample / m.tile_px);
    return { r, c, line: line - r * m.tile_px, sample: sample - c * m.tile_px };
  }

  // Load the 80 m tiles touching a set of points, each widened by marginM.
  async loadAround(points, marginM = 20000) {
    if (!this.meta) return;
    const want = new Set();
    for (const p of points) {
      for (const dx of [-marginM, 0, marginM]) {
        for (const dy of [-marginM, 0, marginM]) {
          if (!this.covers(p.x + dx, p.y + dy)) continue;
          const { r, c } = this.tileOf(p.x + dx, p.y + dy);
          if (r >= 0 && c >= 0 && r < this.meta.tiles && c < this.meta.tiles) want.add(`${r}_${c}`);
        }
      }
    }
    await Promise.all([...want].filter((k) => !this.tiles.has(k)).map(async (k) => {
      this.tiles.set(k, null);
      try {
        this.tiles.set(k, await decodeHeights(`${this.base}sim/s${k}.png`));
      } catch {
        this.tiles.delete(k);
      }
    }));
  }

  // Ground height in metres (relative to 1737.4 km) at map point x, y.
  height(x, y) {
    if (this.meta && this.covers(x, y)) {
      const { r, c, line, sample } = this.tileOf(x, y);
      const t = this.tiles.get(`${r}_${c}`);
      if (t) {
        const n = t.size;
        const l0 = Math.min(Math.max(Math.floor(line), 0), n - 2), s0 = Math.min(Math.max(Math.floor(sample), 0), n - 2);
        const fl = Math.min(Math.max(line - l0, 0), 1), fs = Math.min(Math.max(sample - s0, 0), 1);
        const H = t.heights, i = l0 * n + s0;
        return (H[i] * (1 - fs) + H[i + 1] * fs) * (1 - fl) + (H[i + n] * (1 - fs) + H[i + n + 1] * fs) * fl;
      }
    }
    return this.coarse ? this.coarse(x, y) : 0;
  }

  // True when the finest (80 m) data is loaded at this point.
  isFine(x, y) {
    if (!this.meta || !this.covers(x, y)) return false;
    const { r, c } = this.tileOf(x, y);
    return !!this.tiles.get(`${r}_${c}`);
  }

  // Slope (deg), and the upward surface normal in local east/north/up components, over +-step metres.
  surface(x, y, step = 80) {
    const { north, east } = localAxes(x, y);
    const hE = this.height(x + east.x * step, y + east.y * step) - this.height(x - east.x * step, y - east.y * step);
    const hN = this.height(x + north.x * step, y + north.y * step) - this.height(x - north.x * step, y - north.y * step);
    const dE = hE / (2 * step), dN = hN / (2 * step);
    const len = Math.hypot(dE, dN, 1);
    return { slope: Math.atan(Math.hypot(dE, dN)) / DEG, normal: { e: -dE / len, n: -dN / len, u: 1 / len } };
  }

  // Elevation angle (deg) of the skyline seen from (x, y) at observer height h0 (m), looking toward
  // azimuth az (deg from north through east). Includes the curvature of the Moon.
  horizon(x, y, az, h0, maxM = 150000) {
    const { north, east } = localAxes(x, y);
    const ca = Math.cos(az * DEG), sa = Math.sin(az * DEG);
    const dx = north.x * ca + east.x * sa, dy = north.y * ca + east.y * sa;
    let best = -90;
    // 80 m steps for the first 4 km, then growing steps out to 150 km.
    for (let d = 80; d <= maxM; d = d < 4000 ? d + 80 : d * 1.04) {
      const h = this.height(x + dx * d, y + dy * d);
      if (!Number.isFinite(h)) continue;
      const a = Math.atan2(h - h0 - (d * d) / (2 * R_M), d) / DEG;
      if (a > best) best = a;
    }
    return best;
  }
}
