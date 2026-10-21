import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoute, ephemeris, simulate, monteCarlo } from '../src/sim.js';
import { offset, distance } from '../src/terrain.js';
import { ROVERS } from '../src/rovers.js';

// Synthetic terrain with the same interface as Terrain: flat ground, a fixed skyline and slope.
const start = { lat: -89.4, lon: -140 };
const fake = ({ skyline = -2, slope = 0, rampFromM = Infinity } = {}) => ({
  height: () => 0,
  resolution: () => 80,
  surface: (lat, lon) => ({ slope: distance(start, { lat, lon }) > rampFromM ? 30 : slope, normal: { e: 0, n: 0, u: 1 } }),
  horizon: () => skyline,
});
const end = offset(start.lat, start.lon, 90, 2000);
const base = (terrain, rover = ROVERS[1]) => ({
  terrain, eph: ephemeris(15 * 60 * 1000), rover,
  route: prepareRoute(terrain, [start, end]), start: new Date('2026-11-20T00:00Z'), days: 5,
});

test('Sunlit flat ground: a mid-size rover drives 2 km and survives', () => {
  const r = simulate(base(fake()));
  assert.equal(r.success, true, r.text);
  assert.ok(Math.abs(r.distance - 2000) < 1);
});

test('A 3 deg ridge all round keeps the site dark and the battery runs out', () => {
  const r = simulate(base(fake({ skyline: 3 })));
  assert.equal(r.success, false);
  assert.equal(r.cause, 'battery', r.text);
});

test('A 30 deg slope on the route blocks a rover rated for 20 deg', () => {
  const r = simulate(base(fake({ rampFromM: 1000 })));
  assert.equal(r.cause, 'slope', r.text);
  assert.ok(r.distance > 850 && r.distance < 1100, `${r.distance}`);
});

test('Monte Carlo returns a success rate and groups failures by cause', async () => {
  const mc = await monteCarlo(base(fake({ skyline: 1.2 })), { runs: 20, slipDays: 3 });
  assert.ok(mc.rate >= 0 && mc.rate <= 1);
  assert.equal(mc.results.length, 20);
  const failed = Object.values(mc.causes).reduce((n, a) => n + a.length, 0);
  assert.equal(failed, 20 - mc.successes);
});

test('Routes crossing the 180 deg meridian are sampled the short way round', () => {
  const t = fake();
  const r = prepareRoute(t, [{ lat: 10, lon: 179.9 }, { lat: 10, lon: -179.9 }]);
  assert.ok(Math.abs(r.length - distance({ lat: 10, lon: 179.9 }, { lat: 10, lon: -179.9 })) < 1);
  assert.ok(r.length < 7000, `${r.length}`);
  for (const p of r.pts) assert.ok(Math.abs(p.lon) > 179.8, `${p.lon}`);
});

test('A small solar rover at the equator does not survive the lunar night', () => {
  const site = { lat: 0.674, lon: 23.473 }; // Apollo 11
  const flat = { height: () => 0, resolution: () => 950, surface: () => ({ slope: 0, normal: { e: 0, n: 0, u: 1 } }), horizon: () => 0 };
  const r = simulate({ terrain: flat, eph: ephemeris(15 * 60 * 1000), rover: ROVERS[0], route: prepareRoute(flat, [site]), start: new Date('2026-12-01T00:00Z'), days: 30 });
  assert.equal(r.success, false, r.text);
  assert.equal(r.cause, 'battery');
});
