import test from 'node:test';
import assert from 'node:assert/strict';
import * as Astronomy from 'astronomy-engine';
import { observerAt, altAz, solarSystem, eqjToRaDec, subPoints, riseSet } from '../src/sky/ephem.js';
import { bodyVectors, localAngles } from '../src/astro.js';

const date = new Date('2026-11-20T00:00:00Z');
const sep = (a, b) => {
  const r = Math.PI / 180;
  const c = Math.sin(a.dec * r) * Math.sin(b.dec * r) + Math.cos(a.dec * r) * Math.cos(b.dec * r) * Math.cos((a.ra - b.ra) * r);
  return Math.acos(Math.min(1, c)) / r;
};

test('Zenith at the lunar north pole is the Moon\'s pole in Draco (RA ~270, Dec ~66.5)', () => {
  const obs = observerAt(date, { lat: 90, lon: 0 });
  const z = eqjToRaDec(obs.up);
  assert.ok(Math.abs(z.ra - 270) < 3 && Math.abs(z.dec - 66.5) < 2, JSON.stringify(z));
});

test('Earth hangs about 66 deg up at Apollo 11 (0.67N 23.47E), within lunar libration', () => {
  for (const d of ['2026-01-05', '2026-04-11', '2026-08-20']) {
    const earth = solarSystem(observerAt(new Date(`${d}T00:00Z`), { lat: 0.674, lon: 23.473 })).find((b) => b.id === 'earth');
    assert.ok(earth.alt > 56 && earth.alt < 76, `${d}: ${earth.alt}`);
  }
});

test('Earth is overhead at the sub-Earth point and on the horizon 90 deg away', () => {
  const sp = subPoints(date);
  const at = (lat, lon) => solarSystem(observerAt(date, { lat, lon })).find((b) => b.id === 'earth').alt;
  assert.ok(at(sp.earth.lat, sp.earth.lon) > 89, `${at(sp.earth.lat, sp.earth.lon)}`);
  assert.ok(Math.abs(at(sp.earth.lat, sp.earth.lon + 90)) < 2.5);
});

test('Planets seen from the Moon are within parallax (< 0.1 deg for Mars and beyond) of their geocentric place', () => {
  const sky = solarSystem(observerAt(date, { lat: 0, lon: 0 }));
  for (const name of ['Mars', 'Jupiter', 'Saturn']) {
    const geo = Astronomy.Equator(Astronomy.Body[name], Astronomy.MakeTime(date), new Astronomy.Observer(0, 0, 0), false, true);
    const p = sky.find((b) => b.name === name);
    assert.ok(sep(p, { ra: geo.ra * 15, dec: geo.dec }) < 0.1, `${name} ${sep(p, { ra: geo.ra * 15, dec: geo.dec })}`);
  }
});

test('Sun altitude agrees with the independent Moon-fixed calculation used by the simulator', () => {
  for (const site of [{ lat: -89.687, lon: -162.635 }, { lat: 26.13, lon: 3.63 }]) {
    const a = solarSystem(observerAt(date, site)).find((b) => b.id === 'sun');
    const b = localAngles(site, bodyVectors(date).sun);
    assert.ok(Math.abs(a.alt - b.el) < 0.05 && Math.abs(((a.az - b.az + 540) % 360) - 180) < 0.2, `${a.alt} ${b.el} ${a.az} ${b.az}`);
  }
});

test('Earth phase from the Moon is the complement of the Moon phase from Earth', () => {
  const earth = solarSystem(observerAt(date, { lat: 0, lon: 0 })).find((b) => b.id === 'earth');
  const moon = Astronomy.Illumination(Astronomy.Body.Moon, Astronomy.MakeTime(date)).phase_fraction;
  assert.ok(Math.abs(earth.illum - (1 - moon)) < 0.02, `${earth.illum} vs ${1 - moon}`);
  assert.ok(earth.angDiamDeg > 1.8 && earth.angDiamDeg < 2.0);
});

test('Sunrise and sunset at Apollo 11 come about 29.5 days apart over a flat horizon', () => {
  const ev = riseSet({ lat: 0.674, lon: 23.473 }, date, () => 0, 'sun', 40);
  assert.ok(ev.nextRise && ev.nextSet);
  const r1 = ev.nextRise.t.getTime();
  const ev2 = riseSet({ lat: 0.674, lon: 23.473 }, new Date(r1 + 86400e3), () => 0, 'sun', 40);
  const days = (ev2.nextRise.t.getTime() - r1) / 86400e3;
  assert.ok(Math.abs(days - 29.53) < 0.6, `${days}`);
});

test('The Earth sphere is turned so the centre of its visible disc is the point on Earth facing the observer', async () => {
  const THREE = await import('three');
  const { earthMatrix } = await import('../src/sky/skylayer.js');
  const { horizonMatrix } = await import('../src/sky/ephem.js');
  for (const [d, site] of [['2026-10-21T18:36:24Z', { lat: 0.674, lon: 23.473 }], ['2027-03-02T05:00:00Z', { lat: -89.7, lon: -162.6 }]]) {
    const obs = observerAt(new Date(d), site);
    const R9 = horizonMatrix(obs);
    const earth = solarSystem(obs).find((b) => b.id === 'earth');
    const M = earthMatrix(R9, earth, 900, 10);
    const v = new THREE.Vector3(R9[0] * earth.dir.x + R9[1] * earth.dir.y + R9[2] * earth.dir.z, R9[3] * earth.dir.x + R9[4] * earth.dir.y + R9[5] * earth.dir.z, R9[6] * earth.dir.x + R9[7] * earth.dir.y + R9[8] * earth.dir.z);
    // Point of the sphere nearest the observer, back in the sphere's own coordinates.
    const p = v.clone().multiplyScalar(900 - 10).applyMatrix4(M.clone().invert());
    const lat = Math.asin(p.y) / (Math.PI / 180), lon = Math.atan2(-p.z, p.x) / (Math.PI / 180);
    assert.ok(Math.abs(lat - earth.subObserver.lat) < 0.2 && Math.abs(((lon - earth.subObserver.lon + 540) % 360) - 180) < 0.2,
      `${d}: disc centre ${lat.toFixed(2)},${lon.toFixed(2)} vs ${earth.subObserver.lat.toFixed(2)},${earth.subObserver.lon.toFixed(2)}`);
  }
});

test('Sub-solar point on Earth matches the Sun\'s declination and the equation of time', () => {
  const earth = solarSystem(observerAt(new Date('2026-10-21T18:36:24Z'), { lat: 0, lon: 0 })).find((b) => b.id === 'earth');
  // Sun's declination on 21 Oct is about -10.9 deg; equation of time about +15.5 min.
  assert.ok(Math.abs(earth.subSolar.lat + 10.9) < 0.3, `${earth.subSolar.lat}`);
  const expectedLon = -((18 + 36.4 / 60 - 12) * 15 + 15.5 / 4);
  assert.ok(Math.abs(earth.subSolar.lon - expectedLon) < 0.5, `${earth.subSolar.lon} vs ${expectedLon}`);
});
