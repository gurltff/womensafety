import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Terrain, latLonToXY } from '../src/terrain.js';
import { ephemeris, environment } from '../src/sim.js';
import { readHeights } from './png.js';

const meta = JSON.parse(readFileSync(new URL('../public/textures/terrain.json', import.meta.url))).sim;
function realTerrain() {
  const t = new Terrain(meta, () => NaN);
  for (let r = 0; r < meta.tiles; r++) for (let c = 0; c < meta.tiles; c++) {
    t.tiles.set(`${r}_${c}`, readHeights(new URL(`../public/textures/sim/s${r}_${c}.png`, import.meta.url).pathname));
  }
  return t;
}
const terrain = realTerrain();
const shack = JSON.parse(readFileSync(new URL('../src/horizons/shackleton-rim.json', import.meta.url)));

test('Simulator skyline at Shackleton rim matches the separately built LOLA horizon', () => {
  const p = latLonToXY(shack.lat, shack.lon);
  const h0 = terrain.height(p.x, p.y) + 2;
  const diffs = [];
  for (let az = 0; az < 360; az += 5) diffs.push(Math.abs(terrain.horizon(p.x, p.y, az, h0) - shack.horizon[az]));
  diffs.sort((a, b) => a - b);
  // The reference uses the 20 m DEM next to the site, so the crater-side directions differ a little.
  assert.ok(diffs[Math.floor(diffs.length / 2)] < 0.1, `median ${diffs[Math.floor(diffs.length / 2)].toFixed(2)} deg`);
  assert.ok(diffs[Math.floor(diffs.length * 0.9)] < 0.5, `90th percentile ${diffs[Math.floor(diffs.length * 0.9)].toFixed(2)} deg`);
});

test('Simulator lighting at Shackleton rim gives the published ~86% sunlight', () => {
  const p = latLonToXY(shack.lat, shack.lon);
  const h = terrain.height(p.x, p.y);
  const eph = ephemeris(6 * 3600e3);
  let lit = 0, n = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 12 * 3600e3, n++) {
    if (environment(terrain, eph, p.x, p.y, h, t, 2).sunVis > 0.5) lit++;
  }
  const pct = (100 * lit) / n;
  assert.ok(pct > 78 && pct < 93, `${pct.toFixed(1)}%`);
});
