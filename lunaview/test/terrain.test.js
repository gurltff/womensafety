import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Terrain } from '../src/terrain.js';
import { ephemeris, environment } from '../src/sim.js';
import { readHeights } from './png.js';

const meta = JSON.parse(readFileSync(new URL('../public/textures/terrain.json', import.meta.url)));
const base = new URL('../public/textures/', import.meta.url).pathname;
const terrain = new Terrain(meta, () => NaN, { base, decode: async (p) => readHeights(p) });
const shack = JSON.parse(readFileSync(new URL('../src/horizons/shackleton-rim.json', import.meta.url)));

test('Simulator skyline at Shackleton rim matches the separately built LOLA horizon', async () => {
  await terrain.loadAround([shack], 150000);
  assert.equal(terrain.resolution(shack.lat, shack.lon), 80);
  const h0 = terrain.height(shack.lat, shack.lon) + 2;
  const diffs = [];
  for (let az = 0; az < 360; az += 5) diffs.push(Math.abs(terrain.horizon(shack.lat, shack.lon, az, h0) - shack.horizon[az]));
  diffs.sort((a, b) => a - b);
  // The reference uses the 20 m DEM next to the site, so the crater-side directions differ a little.
  assert.ok(diffs[Math.floor(diffs.length / 2)] < 0.1, `median ${diffs[Math.floor(diffs.length / 2)].toFixed(2)} deg`);
  assert.ok(diffs[Math.floor(diffs.length * 0.9)] < 0.5, `90th percentile ${diffs[Math.floor(diffs.length * 0.9)].toFixed(2)} deg`);
});

test('Simulator lighting at Shackleton rim gives the published ~86% sunlight', async () => {
  await terrain.loadAround([shack], 150000);
  const h = terrain.height(shack.lat, shack.lon);
  const eph = ephemeris(6 * 3600e3);
  let lit = 0, n = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 12 * 3600e3, n++) {
    if (environment(terrain, eph, shack.lat, shack.lon, h, t, 2).sunVis > 0.5) lit++;
  }
  const pct = (100 * lit) / n;
  assert.ok(pct > 78 && pct < 93, `${pct.toFixed(1)}%`);
});

test('Whole-Moon terrain: Apollo 11 site is on flat mare, sunlit about half the time', async () => {
  const site = { lat: 0.674, lon: 23.473 };
  await terrain.loadAround([site], 150000);
  assert.ok(terrain.resolution(site.lat, site.lon) < 1000);
  const h = terrain.height(site.lat, site.lon);
  assert.ok(h < -1000, `mare floor should be low, got ${h} m`);
  assert.ok(terrain.surface(site.lat, site.lon).slope < 3);
  const eph = ephemeris(6 * 3600e3);
  let lit = 0, n = 0;
  for (let t = Date.UTC(2026, 11, 1); t < Date.UTC(2027, 0, 30); t += 6 * 3600e3, n++) {
    if (environment(terrain, eph, site.lat, site.lon, h, t, 2).sunVis > 0.5) lit++;
  }
  assert.ok(lit / n > 0.4 && lit / n < 0.6, `${(lit / n).toFixed(2)}`);
});
