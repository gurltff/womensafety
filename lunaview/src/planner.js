// Route planner: finds a path between two points that stays in sunlight over the mission window
// and avoids slopes the rover cannot climb. It builds a sunlight map on a grid around the straight
// line (share of time each cell sees the Sun, sampled every few hours) and runs Dijkstra on it.
import { localAngles } from './astro.js';
import { xyToLatLon } from './terrain.js';

export async function sunlightMap(terrain, eph, { x0, y0, x1, y1, cell }, start, days, { everyH = 6, onProgress } = {}) {
  const nx = Math.max(2, Math.round((x1 - x0) / cell) + 1), ny = Math.max(2, Math.round((y1 - y0) / cell) + 1);
  const lit = new Float32Array(nx * ny), slope = new Float32Array(nx * ny), h = new Float32Array(nx * ny);
  const times = [];
  for (let t = start.getTime(); t <= start.getTime() + days * 86400e3; t += everyH * 3600e3) times.push(t);
  const suns = times.map((t) => eph(t).sun);
  for (let j = 0; j < ny; j++) {
    if (j % 4 === 3) { onProgress?.(j / ny); await new Promise((r) => setTimeout(r, 0)); }
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell, y = y0 + j * cell, k = j * nx + i;
      h[k] = terrain.height(x, y);
      slope[k] = terrain.surface(x, y).slope;
      const { lat, lon } = xyToLatLon(x, y);
      let n = 0;
      for (const sv of suns) {
        const sun = localAngles({ lat, lon }, sv);
        if (sun.el > -2 && sun.el - terrain.horizon(x, y, sun.az, h[k] + 1.5) > 0) n++;
      }
      lit[k] = n / suns.length;
    }
  }
  return { x0, y0, cell, nx, ny, lit, slope, h };
}

// Cheapest path from a to b. Each step costs its length, more in places that are often in shadow
// (shadeWeight) and on slopes; cells steeper than maxSlope cannot be entered.
export function planRoute(map, a, b, { maxSlope, shadeWeight = 6 }) {
  const { x0, y0, cell, nx, ny, lit, slope } = map;
  const idx = (p) => Math.min(ny - 1, Math.max(0, Math.round((p.y - y0) / cell))) * nx + Math.min(nx - 1, Math.max(0, Math.round((p.x - x0) / cell)));
  const s = idx(a), g = idx(b);
  const dist = new Float64Array(nx * ny).fill(Infinity), prev = new Int32Array(nx * ny).fill(-1);
  dist[s] = 0;
  // Binary heap of [cost, cell].
  const heap = [[0, s]];
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
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
      const len = cell * Math.hypot(di, dj);
      const cost = len * (1 + shadeWeight * (1 - lit[n]) + (2 * slope[n]) / maxSlope);
      if (c + cost < dist[n]) { dist[n] = c + cost; prev[n] = k; push([dist[n], n]); }
    }
  }
  if (!Number.isFinite(dist[g])) return null;
  const path = [];
  for (let k = g; k !== -1; k = prev[k]) path.push({ x: x0 + (k % nx) * cell, y: y0 + ((k / nx) | 0) * cell });
  path.reverse();
  path[0] = { ...a };
  path[path.length - 1] = { ...b };
  return simplify(path, cell * 0.6);
}

// Drop points that lie almost on the line between their neighbours (Douglas-Peucker).
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const dd = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / L;
    if (dd > worst) { worst = dd; at = i; }
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

// Grid box around a straight line from a to b, widened by margin metres.
export function boxAround(a, b, margin, cell) {
  return {
    x0: Math.min(a.x, b.x) - margin, x1: Math.max(a.x, b.x) + margin,
    y0: Math.min(a.y, b.y) - margin, y1: Math.max(a.y, b.y) + margin, cell,
  };
}
