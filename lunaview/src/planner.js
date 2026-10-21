// Route planner: finds a path between two points that stays in sunlight over the mission window
// and avoids slopes the rover cannot climb. It builds a sunlight map on a grid around the straight
// line (share of time each cell sees the Sun, sampled every few hours) and runs Dijkstra on it.
// The grid lies on the local tangent plane, so it works anywhere on the Moon.
import { localAngles } from './astro.js';
import { toLatLon, localFrame, distance, R_M } from './terrain.js';

// Grid box around the line from a to b, widened by margin metres, with square cells of `cell` m.
export function boxAround(a, b, margin, cell) {
  const c = toLatLon({ ...sum(localFrame(a.lat, a.lon).up, localFrame(b.lat, b.lon).up) });
  const { up, east, north } = localFrame(c.lat, c.lon);
  const toXY = (p) => {
    const v = localFrame(p.lat, p.lon).up;
    const k = 1 / (v.x * up.x + v.y * up.y + v.z * up.z); // gnomonic projection onto the tangent plane
    return { x: R_M * k * (v.x * east.x + v.y * east.y + v.z * east.z), y: R_M * k * (v.x * north.x + v.y * north.y + v.z * north.z) };
  };
  const pa = toXY(a), pb = toXY(b);
  return {
    centre: c, frame: { up, east, north }, cell,
    x0: Math.min(pa.x, pb.x) - margin, x1: Math.max(pa.x, pb.x) + margin,
    y0: Math.min(pa.y, pb.y) - margin, y1: Math.max(pa.y, pb.y) + margin,
  };
}

function sum(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }

// Latitude/longitude of tangent-plane point (x, y) metres in a box.
function cellLatLon(box, x, y) {
  const { up, east, north } = box.frame;
  return toLatLon({
    x: up.x + (east.x * x + north.x * y) / R_M,
    y: up.y + (east.y * x + north.y * y) / R_M,
    z: up.z + (east.z * x + north.z * y) / R_M,
  });
}

export async function sunlightMap(terrain, eph, box, start, days, { everyH = 6, onProgress } = {}) {
  const { x0, y0, x1, y1, cell } = box;
  const nx = Math.max(2, Math.round((x1 - x0) / cell) + 1), ny = Math.max(2, Math.round((y1 - y0) / cell) + 1);
  const lit = new Float32Array(nx * ny), slope = new Float32Array(nx * ny), h = new Float32Array(nx * ny);
  const ll = new Array(nx * ny);
  const times = [];
  for (let t = start.getTime(); t <= start.getTime() + days * 86400e3; t += everyH * 3600e3) times.push(t);
  const suns = times.map((t) => eph(t).sun);
  for (let j = 0; j < ny; j++) {
    if (j % 4 === 3) { onProgress?.(j / ny); await new Promise((r) => setTimeout(r, 0)); }
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const p = cellLatLon(box, x0 + i * cell, y0 + j * cell);
      ll[k] = p;
      h[k] = terrain.height(p.lat, p.lon);
      slope[k] = terrain.surface(p.lat, p.lon).slope;
      let n = 0;
      for (const sv of suns) {
        const sun = localAngles(p, sv);
        if (sun.el > -1 && sun.el - terrain.horizon(p.lat, p.lon, sun.az, h[k] + 1.5) > 0) n++;
      }
      lit[k] = n / suns.length;
    }
  }
  return { ...box, nx, ny, lit, slope, h, ll };
}

// Cheapest path from a to b. Each step costs its length, more in places that are often in shadow
// (shadeWeight) and on slopes; cells steeper than maxSlope cannot be entered.
export function planRoute(map, a, b, { maxSlope, shadeWeight = 6 }) {
  const { nx, ny, lit, slope, cell, ll } = map;
  const nearest = (p) => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < ll.length; k++) { const dd = distance(p, ll[k]); if (dd < bd) { bd = dd; best = k; } }
    return best;
  };
  const s = nearest(a), g = nearest(b);
  const dist = new Float64Array(nx * ny).fill(Infinity), prev = new Int32Array(nx * ny).fill(-1);
  dist[s] = 0;
  const heap = [[0, s]];
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.length) {
    const [c, k] = pop();
    if (c > dist[k]) continue;
    if (k === g) break;
    const i = k % nx, j = (k / nx) | 0;
    for (const [di, dj] of steps) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const n = nj * nx + ni;
      if (slope[n] > maxSlope && n !== g) continue;
      const cost = cell * Math.hypot(di, dj) * (1 + shadeWeight * (1 - lit[n]) + (2 * slope[n]) / maxSlope);
      if (c + cost < dist[n]) { dist[n] = c + cost; prev[n] = k; push([dist[n], n]); }
    }
  }
  if (!Number.isFinite(dist[g])) return null;
  const path = [];
  for (let k = g; k !== -1; k = prev[k]) path.push({ i: k % nx, j: (k / nx) | 0 });
  path.reverse();
  const keep = simplify(path, 0.6);
  const out = keep.map((q) => ll[q.j * nx + q.i]);
  out[0] = { lat: a.lat, lon: a.lon };
  out[out.length - 1] = { lat: b.lat, lon: b.lon };
  return out;
}

// Drop grid points that lie almost on the line between their neighbours (Douglas-Peucker, in cells).
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let worst = 0, at = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k], dx = b.i - a.i, dy = b.j - a.j, L = Math.hypot(dx, dy) || 1;
    const dd = Math.abs(dy * p.i - dx * p.j + b.i * a.j - b.j * a.i) / L;
    if (dd > worst) { worst = dd; at = k; }
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}
