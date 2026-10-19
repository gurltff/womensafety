import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyVectors, subPoint, skyAt } from '../src/astro.js';
import { analyze } from '../src/mission.js';

test('Earth stays near lon 0, lat 0 as seen from the Moon (libration under 8 deg)', () => {
  for (let d = 0; d < 30; d += 3) {
    const e = subPoint(bodyVectors(new Date(Date.UTC(2026, 10, 1 + d))).earth);
    assert.ok(Math.abs(e.lat) < 8 && Math.abs(e.lon) < 9, JSON.stringify(e));
  }
});

test('Sub-solar point sits near lon 0 at full Moon (2026-10-26)', () => {
  const s = subPoint(bodyVectors(new Date('2026-10-26T04:00Z')).sun);
  assert.ok(Math.abs(s.lon) < 8, JSON.stringify(s));
  assert.ok(Math.abs(s.lat) < 1.6, JSON.stringify(s));
});

test('At the south pole the Sun never climbs more than ~2 deg', () => {
  const site = { lat: -89.68, lon: -166 };
  for (let h = 0; h < 24 * 30; h += 7) {
    const s = skyAt(site, new Date(Date.UTC(2026, 10, 14) + h * 3600e3), null);
    assert.ok(Math.abs(s.sun.el) < 2.2, `${s.sun.el}`);
  }
});

test('A 3 deg ridge all round puts a polar site in permanent shadow and fails the battery', () => {
  const r = analyze({ lat: -89.68, lon: -166 }, new Date('2026-11-14T00:00Z'), 5, 40, new Array(360).fill(3));
  assert.equal(r.sunFrac, 0);
  assert.ok(r.fatal.length > 0);
  assert.ok(r.score <= 45);
});

test('Shackleton rim with real LOLA terrain is sunlit ~86% of the time (Bussey et al. 2010, point A)', async () => {
  const fs = await import('node:fs');
  const h = JSON.parse(fs.readFileSync(new URL('../src/horizons/shackleton-rim.json', import.meta.url)));
  let lit = 0, n = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 6 * 3600e3, n++) {
    if (skyAt({ lat: h.lat, lon: h.lon }, new Date(t), h.horizon).sunlit) lit++;
  }
  const pct = (100 * lit) / n;
  assert.ok(pct > 80 && pct < 92, `${pct.toFixed(1)}%`);
});
