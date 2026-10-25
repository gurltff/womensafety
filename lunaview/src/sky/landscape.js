// The ground around an observer standing on the Moon, built from NASA LOLA heights out to 150 km
// (and the finest LOLA / SLDEM2015 heights close to the named places),
// with the Moon's curvature, coloured by the LROC albedo map and lit by the real Sun. Terrain shadows
// are ray-marched toward the Sun through a local height grid, so ridges and crater walls cast the
// shadows they really cast at that moment.
//
// Frame: observer's eye at the origin, x east, y up, z south (-z north), metres.
import * as THREE from 'three';
import { offset, decodeHeights } from '../terrain.js';

const R_M = 1737400;
const DEG = Math.PI / 180;
export const EYE_M = 1.7;
const FAR_M = 150000;
const NAZ = 360;
const NAZ_NEAR = 1024; // azimuth steps of the dense mesh close to the observer
const NEAR_R = 1500; // m, extent of the dense mesh
const FINE_R = 800; // m, half-size of the fine height grid that carries the small craters
const MICRO_R = FINE_R; // m, small craters out to here
const ROCK_R = 250; // m, rocks out to here

export class Landscape {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.ambient = new THREE.AmbientLight(0x9fb4ff, 0.04);
    scene.add(this.sun, this.ambient, this.sun.target);
    const patch = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float shade;\nvarying float vShade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = shade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vShade;')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= vShade;');
    };
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.material.onBeforeCompile = patch;
    this.rockMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.rockMaterial.onBeforeCompile = patch;
    this.meshes = [];
    this.mesh = null;
    this.rocks = null;
    this.skyline = new Float32Array(NAZ * 2); // terrain horizon every 0.5 deg
  }

  // Elevation (deg) of the skyline at azimuth az.
  horizonAt(az) {
    const n = this.skyline.length, f = ((((az % 360) + 360) % 360) / 360) * n;
    const i = Math.floor(f) % n, t = f - Math.floor(f);
    return this.skyline[i] * (1 - t) + this.skyline[(i + 1) % n] * t;
  }

  // close: optional finer height patch around a named place ({ half, at(x, y) } in local metres).
  async build(terrain, site, albedo, onProgress, close = null) {
    this.ready = false;
    await terrain.loadAround([site], FAR_M);
    await albedo?.prepare?.(site.lat, site.lon, FAR_M);
    const tH0 = terrain.height(site.lat, site.lon);
    this.site = site;
    this.close = close;
    const res = close ? close.res : terrain.resolution(site.lat, site.lon) ?? 2000;
    this.res = res;
    const drop = (d) => (d * d) / (2 * R_M);
    // Heights relative to the ground under the observer: the close-up patch near the place, blended
    // into the global LOLA heights before its edge.
    const cH0 = close ? close.at(0, 0) : 0;
    const blend0 = close ? close.half * 0.8 : 0, blend1 = close ? close.half * 0.97 : 0;
    const base = (x, y) => {
      const d = Math.hypot(x, y);
      if (close && d < blend1) {
        const near = close.at(x, y) - cH0;
        if (d <= blend0) return near;
        const p = offset(site.lat, site.lon, Math.atan2(x, y) / DEG, d);
        const w = (d - blend0) / (blend1 - blend0);
        return near * (1 - w) + (terrain.height(p.lat, p.lon) - tH0) * w;
      }
      const p = offset(site.lat, site.lon, Math.atan2(x, y) / DEG, d);
      return terrain.height(p.lat, p.lon) - tH0;
    };
    this.h0 = close ? cH0 : tH0;

    // Detail too small for any orbital height map: craters and rocks drawn from the measured lunar
    // size-frequency distributions, seeded by the place so they are the same on every visit.
    const micro = new MicroRelief(site.lat, site.lon);
    this.micro = micro;
    const m0 = micro.height(0, 0);
    const ground = (x, y) => {
      const d = Math.hypot(x, y);
      return base(x, y) + (d < MICRO_R ? micro.height(x, y) - m0 : 0) - drop(d);
    };

    // Coarse grid (shadows and skyline) and a fine grid near the observer that includes the craters.
    const N = 512, Rg = close ? close.half * 0.97 : res <= 100 ? 30000 : 120000, cell = (2 * Rg) / N;
    const grid = new Float32Array(N * N);
    let maxH = -Infinity;
    for (let i = 0; i < N; i++) {
      const y = Rg - (i + 0.5) * cell;
      for (let j = 0; j < N; j++) {
        const x = -Rg + (j + 0.5) * cell;
        const h = Math.hypot(x, y) < 1 ? 0 : base(x, y) - drop(Math.hypot(x, y));
        grid[i * N + j] = h;
        if (h > maxH) maxH = h;
      }
      if (i % 64 === 63) { onProgress?.(0.05 + (0.35 * i) / N); await new Promise((r) => setTimeout(r, 0)); }
    }
    this.grid = { N, Rg, cell, h: grid, maxH };
    const FN = 512, FR = FINE_R, fcell = (2 * FR) / FN;
    const fine = new Float32Array(FN * FN);
    let fMax = -Infinity;
    for (let i = 0; i < FN; i++) {
      const y = FR - (i + 0.5) * fcell;
      for (let j = 0; j < FN; j++) {
        const x = -FR + (j + 0.5) * fcell;
        const h = ground(x, y);
        fine[i * FN + j] = h;
        if (h > fMax) fMax = h;
      }
      if (i % 64 === 63) { onProgress?.(0.4 + (0.2 * i) / FN); await new Promise((r) => setTimeout(r, 0)); }
    }
    this.fine = { N: FN, Rg: FR, cell: fcell, h: fine, maxH: fMax };

    // Skyline from the eye: near part from the grids, far part traced out to 150 km.
    this.farSky = new Float32Array(NAZ * 2);
    for (let k = 0; k < NAZ * 2; k++) {
      const az = k / 2, sx = Math.sin(az * DEG), cy = Math.cos(az * DEG);
      let best = -90, far = -90;
      for (let d = 1; d < FR; d += fcell) best = Math.max(best, Math.atan2(this.fineAt(d * sx, d * cy) - EYE_M, d) / DEG);
      for (let d = FR; d < Rg; d += cell) best = Math.max(best, Math.atan2(this.gridAt(d * sx, d * cy) - EYE_M, d) / DEG);
      for (let d = Rg; d <= FAR_M; d *= 1.015) {
        const p = offset(site.lat, site.lon, az, d);
        far = Math.max(far, Math.atan2(terrain.height(p.lat, p.lon) - tH0 - drop(d) - EYE_M, d) / DEG);
      }
      this.farSky[k] = far;
      this.skyline[k] = Math.max(best, far);
    }
    onProgress?.(0.75);

    // Two meshes of rings around the observer: a dense one close in, a coarser one out to 150 km.
    const a0 = albedo ? albedo(site.lat, site.lon) : [0.55, 0.53, 0.5];
    const height = (x, y, d) => (d < FR * 0.99 ? this.fineAt(x, y) : d < Rg * 0.98 ? this.gridAt(x, y) : ground(x, y));
    const nearRings = [];
    for (let d = 0.6; d < NEAR_R; d *= 1.035) nearRings.push(d);
    nearRings.push(NEAR_R);
    const farRings = [];
    for (let d = NEAR_R; d < FAR_M; d *= 1.05) farRings.push(d);
    farRings.push(FAR_M);
    for (const m of this.meshes) { this.group.remove(m); m.geometry.dispose(); }
    this.meshes = [
      this.ringMesh(site, nearRings, NAZ_NEAR, true, height, albedo, a0, micro),
      this.ringMesh(site, farRings, NAZ, false, height, albedo, a0, micro),
    ];
    for (const m of this.meshes) this.group.add(m);
    this.mesh = this.meshes[0];
    // Index the near ground by 2 m cells so each rock can find the ground its shadow falls on.
    const np = this.mesh.geometry.attributes.position.array;
    this.vhash = new Map();
    for (let v = 0; v < np.length / 3; v++) {
      const x = np[v * 3], y = -np[v * 3 + 2];
      if (Math.abs(x) > ROCK_R + 40 || Math.abs(y) > ROCK_R + 40) continue;
      const k = Math.floor(x / 2) * 100003 + Math.floor(y / 2);
      let a = this.vhash.get(k);
      if (!a) this.vhash.set(k, (a = []));
      a.push(v);
    }
    onProgress?.(0.9);

    // Rocks near the observer.
    if (this.rocks) { this.group.remove(this.rocks); this.rocks.geometry.dispose(); this.rocks = null; }
    const list = micro.rocks(ROCK_R);
    if (list.length) {
      const geo = rockGeometry();
      geo.setAttribute('shade', new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1));
      const rocks = new THREE.InstancedMesh(geo, this.rockMaterial, list.length);
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
      list.forEach((r, i) => {
        const h = this.fineAt(r.x, r.y);
        e.set(r.tilt, r.spin, r.tilt * 0.6);
        q.setFromEuler(e);
        // Rocks sit partly buried in the regolith.
        mtx.compose(new THREE.Vector3(r.x, h - EYE_M + r.d * 0.18, -r.y), q, new THREE.Vector3(r.d * r.sx, r.d * 0.62 * r.sy, r.d));
        rocks.setMatrixAt(i, mtx);
        const c = albedo ? albedo(site.lat, site.lon) : a0;
        col.setRGB(c[0] * r.tone, c[1] * r.tone, c[2] * r.tone);
        rocks.setColorAt(i, col);
      });
      rocks.frustumCulled = false;
      rocks.userData.list = list;
      this.rocks = rocks;
      this.group.add(rocks);
    }
    this.lastSun = null;
    this.ready = true;
    onProgress?.(1);
  }

  ringMesh(site, rings, naz, centre, height, albedo, a0, micro) {
    const nv = (centre ? 1 : 0) + rings.length * naz;
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), shade = new Float32Array(nv).fill(1);
    let v0 = 0;
    if (centre) { pos.set([0, -EYE_M, 0], 0); col.set(a0, 0); v0 = 1; }
    let lastLL = null, lastC = a0;
    rings.forEach((d, r) => {
      for (let k = 0; k < naz; k++) {
        const az = (k * 360) / naz;
        const sx = Math.sin(az * DEG), cz = Math.cos(az * DEG);
        const x = d * sx, y = d * cz;
        const v = v0 + r * naz + k;
        pos.set([x, height(x, y, d) - EYE_M, -y], v * 3);
        // The albedo map is 399 m/px: sample it every few hundred metres, not at every vertex.
        let c = lastC;
        if (!albedo) c = a0;
        else if (d > 150 || !lastLL || k % 8 === 0) { const p = offset(site.lat, site.lon, az, d); c = albedo(p.lat, p.lon); lastC = c; lastLL = p; }
        const t = d < MICRO_R ? micro.tone(x, y) : 1;
        col.set([c[0] * t, c[1] * t, c[2] * t], v * 3);
      }
    });
    const idx = [];
    if (centre) for (let k = 0; k < naz; k++) idx.push(0, 1 + ((k + 1) % naz), 1 + k);
    for (let r = 0; r < rings.length - 1; r++) {
      for (let k = 0; k < naz; k++) {
        const a = v0 + r * naz + k, b = v0 + r * naz + ((k + 1) % naz), c = a + naz, e = b + naz;
        idx.push(a, b, c, b, e, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('shade', new THREE.BufferAttribute(shade, 1));
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.frustumCulled = false;
    return mesh;
  }

  gridAt(x, y) { return sampleGrid(this.grid, x, y); }
  // Slope (deg) of the measured ground (no statistical craters) at a point, over one grid cell.
  slopeAt(x, y) {
    const c = this.grid.cell;
    const dE = (this.gridAt(x + c, y) - this.gridAt(x - c, y)) / (2 * c), dN = (this.gridAt(x, y + c) - this.gridAt(x, y - c)) / (2 * c);
    return Math.atan(Math.hypot(dE, dN)) / DEG;
  }
  fineAt(x, y) { return sampleGrid(this.fine, x, y); }

  // Light the ground for the Sun at (alt, az) and Earth (earthshine) with its phase and altitude.
  // minAmbient: a floor for the ambient light so the ground can be seen at night ("bright view").
  light(sun, earth, { earthshine = true, minAmbient = 0 } = {}) {
    if (!this.mesh) return;
    // Bright view at night: a soft light from Earth's direction (where earthshine really comes from,
    // or from high in the sky if Earth is down) so the relief of the ground can be seen.
    const fill = minAmbient > 0.1 && sun.alt < -1;
    const src = fill ? (earth.alt > 10 ? earth : { alt: 50, az: (sun.az + 180) % 360 }) : sun;
    const dir = new THREE.Vector3(Math.cos(src.alt * DEG) * Math.sin(src.az * DEG), Math.sin(src.alt * DEG), -Math.cos(src.alt * DEG) * Math.cos(src.az * DEG));
    this.sun.position.copy(dir).multiplyScalar(1000);
    this.sun.target.position.set(0, 0, 0);
    // Exposure as the eye (or an Apollo Hasselblad) sets it for sunlit regolith.
    this.sun.intensity = fill ? 3.2 : sun.alt > -1 ? 6.5 : 0;
    this.sun.color.set(fill ? 0xd0dcf4 : 0xffffff);
    // Earthshine is ~1/10000 of sunlight; shown brighter, as a dark-adapted eye would see it.
    const eUp = Math.max(0, Math.sin(Math.max(0, earth.alt) * DEG));
    // In daylight Bright view only softens the shadows a little, so the relief still reads.
    this.ambient.intensity = fill ? 0.7 : Math.max(minAmbient * (sun.alt > -1 ? 0.3 : 1), 0.03 + (earthshine ? 0.55 * earth.illum * Math.sqrt(eUp) : 0));
    this.ambient.color.set(minAmbient > 0.1 ? 0xc4cde0 : 0x9fb4ff);

    const key = fill ? 'fill' : `${sun.alt.toFixed(2)},${sun.az.toFixed(2)}`;
    if (key === this.lastSun) return;
    this.lastSun = key;
    const dark = !fill && sun.alt < -1;
    const shadeOf = (x, y, h) => (fill ? 1 : dark ? 0 : this.sunlit(x, y, h, sun));
    for (const m of this.meshes) {
      const attr = m.geometry.attributes.shade, pos = m.geometry.attributes.position.array, s = attr.array;
      for (let v = 0; v < s.length; v++) s[v] = shadeOf(pos[v * 3], -pos[v * 3 + 2], pos[v * 3 + 1] + EYE_M);
      attr.needsUpdate = true;
    }
    if (this.rocks) {
      const attr = this.rocks.geometry.attributes.shade;
      this.rocks.userData.list.forEach((r, i) => { attr.array[i] = shadeOf(r.x, r.y, this.fineAt(r.x, r.y) + r.d * 0.5); });
      attr.needsUpdate = true;
      if (!fill && !dark && sun.alt > 0.3) this.rockShadows(sun);
    }
  }

  // Shadows the rocks cast on the near ground: each rock is treated as a mound of its own width and
  // height, and the ground behind it (away from the Sun) is dark for as far as its shadow reaches.
  rockShadows(sun) {
    const attr = this.mesh.geometry.attributes.shade, pos = this.mesh.geometry.attributes.position.array, s = attr.array;
    const ux = -Math.sin(sun.az * DEG), uy = -Math.cos(sun.az * DEG), tanEl = Math.tan(sun.alt * DEG);
    for (const r of this.rocks.userData.list) {
      const rad = r.d * 0.45 * r.sx, top = r.d * 0.62 * r.sy * 0.75;
      const L = Math.min(top / tanEl, r.d * 25);
      const gz = this.fineAt(r.x, r.y);
      const x0 = Math.min(r.x, r.x + ux * L) - rad, x1 = Math.max(r.x, r.x + ux * L) + rad;
      const y0 = Math.min(r.y, r.y + uy * L) - rad, y1 = Math.max(r.y, r.y + uy * L) + rad;
      for (let cx = Math.floor(x0 / 2); cx <= Math.floor(x1 / 2); cx++) {
        for (let cy = Math.floor(y0 / 2); cy <= Math.floor(y1 / 2); cy++) {
          const list = this.vhash.get(cx * 100003 + cy);
          if (!list) continue;
          for (const v of list) {
            const dx = pos[v * 3] - r.x, dy = -pos[v * 3 + 2] - r.y;
            const along = dx * ux + dy * uy, across = Math.abs(dx * uy - dy * ux);
            if (along < -rad * 0.3 || along > L + rad) continue;
            // The shadow narrows toward its tip, like the shadow of a rounded boulder.
            const w = rad * Math.sqrt(Math.max(0, 1 - Math.max(0, along) / (L + rad)));
            if (across > w * 1.35) continue;
            // Ground that rises toward the Sun comes out of the shadow sooner.
            const lift = pos[v * 3 + 1] + EYE_M - gz;
            if (lift > top - Math.max(0, along) * tanEl) continue;
            // Soft edges, so the coarser ground mesh further out does not show the shadow as steps.
            s[v] = Math.min(s[v], Math.max(0, Math.min(1, (across - w * 0.65) / (w * 0.7))));
          }
        }
      }
    }
    attr.needsUpdate = true;
  }

  // Fraction of the Sun's disc seen from a point (local metres, height above the observer's ground):
  // march toward the Sun through the fine grid, then the coarse grid, then the far skyline.
  sunlit(x, y, h, sun) {
    const { Rg, cell, maxH } = this.grid, F = this.fine;
    const sx = Math.sin(sun.az * DEG), sy = Math.cos(sun.az * DEG), tanEl = Math.tan(sun.alt * DEG);
    const top = Math.max(maxH, F.maxH) + 1;
    let block = -90;
    const d0 = Math.hypot(x, y);
    if (d0 >= Rg * 0.98) block = this.farSkyAt(sun.az) - 0.5;
    else {
      let t = 0;
      for (;;) {
        const px = x + sx * t, py = y + sy * t;
        const inFine = Math.abs(px) < F.Rg && Math.abs(py) < F.Rg;
        t += inFine ? F.cell : cell;
        const qx = x + sx * t, qy = y + sy * t;
        if (Math.abs(qx) >= Rg || Math.abs(qy) >= Rg) { block = Math.max(block, this.farSkyAt(sun.az)); break; }
        if (tanEl > 0 && h + tanEl * t > top) break;
        const g = inFine && Math.abs(qx) < F.Rg && Math.abs(qy) < F.Rg ? this.fineAt(qx, qy) : this.gridAt(qx, qy);
        const a = Math.atan2(g - h, t) / DEG;
        if (a > block) block = a;
      }
    }
    // The Sun's disc is 0.53 deg across: partial light as it clears the ridge.
    return Math.max(0, Math.min(1, (sun.alt - block) / 0.53 + 0.5));
  }

  farSkyAt(az) {
    const n = this.farSky.length, f = ((((az % 360) + 360) % 360) / 360) * n;
    return this.farSky[Math.floor(f) % n];
  }
}

function sampleGrid({ N, Rg, cell, h }, x, y) {
  const fj = (x + Rg) / cell - 0.5, fi = (Rg - y) / cell - 0.5;
  const j0 = Math.max(0, Math.min(N - 2, Math.floor(fj))), i0 = Math.max(0, Math.min(N - 2, Math.floor(fi)));
  const tx = Math.max(0, Math.min(1, fj - j0)), ty = Math.max(0, Math.min(1, fi - i0));
  const k = i0 * N + j0;
  return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + N] * (1 - tx) + h[k + N + 1] * tx) * ty;
}

// ---------- small craters and rocks ----------
// Orbital height maps resolve nothing smaller than about 60 m (5 m near the south pole), so the
// metre-scale ground is filled in statistically:
//  - craters 3 to 120 m across at the saturation density measured on the maria, cumulative
//    N(>D) = 10^-1.1 D^-2 per km^2 with D in km (Gault 1970), with depths from fresh (0.2 D) to
//    worn down (0.05 D), since most small lunar craters are old and shallow;
//  - rocks 0.15 to 2 m across from the Surveyor and Apollo counts on the maria, N(>D) = 0.003 D^-2.5 per m^2
//    with D in metres (Shoemaker and Morris 1969; Golombek and Rapp 1997), fewer than a few
//    per square metre and most of them small.
// They are typical of the Moon, not a map of the actual rocks and craters at the place.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MicroRelief {
  constructor(lat, lon) {
    this.seed = Math.floor((lat + 90) * 1e4) * 7919 + Math.floor((lon + 360) * 1e4);
    const rnd = mulberry32(this.seed);
    this.rnd = rnd;
    // Craters: sample D from the cumulative power law between Dmin and Dmax.
    const Dmin = 3, Dmax = 120, area = Math.PI * (MICRO_R / 1000) ** 2;
    const n = Math.round(10 ** -1.1 * (Dmin / 1000) ** -2 * area * (1 - (Dmin / Dmax) ** 2));
    this.cs = 40;
    this.cells = new Map();
    for (let i = 0; i < n; i++) {
      const u = rnd();
      const D = Dmin / Math.sqrt(1 - u * (1 - (Dmin / Dmax) ** 2));
      const r = MICRO_R * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI;
      const x = r * Math.sin(a), y = r * Math.cos(a);
      if (Math.hypot(x, y) < D * 0.6 + 2) continue; // not right under the observer's feet
      const fresh = rnd() ** 3; // most small craters are old and worn
      const c = { x, y, R: D / 2, depth: D * (0.05 + 0.15 * fresh), rim: D * 0.035 * fresh, fresh };
      const reach = c.R * 2;
      for (let gx = Math.floor((x - reach) / this.cs); gx <= Math.floor((x + reach) / this.cs); gx++) {
        for (let gy = Math.floor((y - reach) / this.cs); gy <= Math.floor((y + reach) / this.cs); gy++) {
          const k = gx * 100003 + gy;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k).push(c);
        }
      }
    }
  }

  craters(x, y) { return this.cells.get(Math.floor(x / this.cs) * 100003 + Math.floor(y / this.cs)) ?? []; }

  height(x, y) {
    let h = 0;
    for (const c of this.craters(x, y)) {
      const q = Math.hypot(x - c.x, y - c.y) / c.R;
      if (q < 1) h += -c.depth * (1 - q * q) + c.rim * q ** 6;
      else if (q < 2) h += c.rim * Math.exp(-(((q - 1) * 4) ** 2) * 0.6) * (2 - q);
    }
    // Gentle undulation of the regolith at a few metres scale.
    h += 0.25 * (valueNoise(x / 9, y / 9, this.seed) - 0.5) + 0.08 * (valueNoise(x / 2.5, y / 2.5, this.seed + 1) - 0.5);
    const d = Math.hypot(x, y);
    return d < MICRO_R * 0.75 ? h : h * Math.max(0, (MICRO_R - d) / (MICRO_R * 0.25));
  }

  // Fresh craters have brighter rims and floors (less space weathering); speckle of the regolith.
  tone(x, y) {
    let t = 1;
    for (const c of this.craters(x, y)) {
      const q = Math.hypot(x - c.x, y - c.y) / c.R;
      if (q < 1.6) t += 0.22 * c.fresh * (1 - q / 1.6);
    }
    return t * (0.93 + 0.14 * valueNoise(x / 3, y / 3, this.seed + 2));
  }

  rocks(radius) {
    const rnd = mulberry32(this.seed + 99);
    const out = [];
    const Dmin = 0.15, Dmax = 2.0;
    const n = Math.round(0.003 * Dmin ** -2.5 * Math.PI * radius * radius * (1 - (Dmin / Dmax) ** 2.5));
    for (let i = 0; i < n && out.length < 6000; i++) {
      const u = rnd();
      const d = Dmin / (1 - u * (1 - (Dmin / Dmax) ** 2.5)) ** (1 / 2.5);
      // Density falls with distance so the count stays manageable; tiny rocks far away are invisible anyway.
      const r = radius * rnd() ** 0.75, a = rnd() * 2 * Math.PI;
      if (r < 3 || d / r < 0.0015) continue;
      out.push({ x: r * Math.sin(a), y: r * Math.cos(a), d, sx: 0.7 + 0.6 * rnd(), sy: 0.7 + 0.6 * rnd(), tilt: (rnd() - 0.5) * 0.8, spin: rnd() * 6.28, tone: 0.75 + 0.35 * rnd() });
    }
    return out;
  }
}

function hash2(i, j, s) {
  let h = (i * 374761393 + j * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// A lumpy, angular rock: an icosahedron with its corners pushed in and out.
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position;
  const rnd = mulberry32(7);
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, 0.75 + 0.45 * rnd());
    const k = seen.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

// Close-up heights for the named places (tools/fetch_closeups.py): a 16 km square of the finest
// LOLA / SLDEM2015 heights, on a local east/north grid centred on the place.
let closeIndex = null;
export async function loadCloseUp(place, base = 'textures/close/') {
  if (!place?.id) return null;
  closeIndex ??= fetch(`${base}index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const meta = (await closeIndex)[place.id];
  if (!meta || Math.abs(meta.lat - place.lat) > 1e-6 || Math.abs(meta.lon - place.lon) > 1e-6) return null;
  const { heights: raw, size: n } = await decodeHeights(`${base}${place.id}.png`);
  // decodeHeights reads red * 256 + green - 32768; the close-ups store quarter-metres above min_m.
  const h = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) h[i] = meta.min_m + (raw[i] + 32768) / 4;
  const cell = (2 * meta.half_m) / (n - 1);
  return {
    half: meta.half_m,
    res: meta.source.includes('5 m') ? 5 : meta.source.includes('10 m') ? 10 : meta.source.includes('20 m') ? 20 : 60,
    source: meta.source,
    at(x, y) {
      const fj = (x + meta.half_m) / cell, fi = (meta.half_m - y) / cell;
      const j0 = Math.max(0, Math.min(n - 2, Math.floor(fj))), i0 = Math.max(0, Math.min(n - 2, Math.floor(fi)));
      const tx = Math.max(0, Math.min(1, fj - j0)), ty = Math.max(0, Math.min(1, fi - i0));
      const k = i0 * n + j0;
      return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + n] * (1 - tx) + h[k + n + 1] * tx) * ty;
    },
  };
}

// Ground colour from the LROC WAC colour mosaic (NASA CGI Moon Kit): the 399 m/px tiles around the
// site where available, else the 4k global map. Poleward of 80 deg the mosaic has shadows baked in, so
// a uniform regolith grey is used there instead (the real lighting does the rest).
async function imageData(url) {
  const img = await new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = url; });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}
const lin = (c) => ((c / 255) ** 2.2) * 1.6 + 0.04;
const POLAR_GREY = [0.3, 0.29, 0.275];

export async function loadAlbedo(globalUrl, tileBase = 'textures/globe/') {
  const global = await imageData(globalUrl);
  const tiles = new Map();
  const pick = (d, x, y) => {
    const i = (Math.min(d.height - 1, Math.max(0, Math.floor(y))) * d.width + Math.min(d.width - 1, Math.max(0, Math.floor(x)))) * 4;
    return [lin(d.data[i]), lin(d.data[i + 1]), lin(d.data[i + 2])];
  };
  const sample = (lat, lon) => {
    if (lat < -80) return POLAR_GREY;
    const r = Math.min(7, Math.floor((90 - lat) / 22.5)), c = Math.min(15, Math.floor((((lon + 180) % 360) + 360) % 360 / 22.5));
    const t = tiles.get(`${r}_${c}`);
    if (t) return pick(t, ((((lon + 180) % 360 + 360) % 360) / 22.5 - c) * t.width, ((90 - lat) / 22.5 - r) * t.height);
    return pick(global, ((lon + 180) / 360) * global.width, ((90 - lat) / 180) * global.height);
  };
  // Load the detailed tiles covering a box around a site.
  sample.prepare = async (lat, lon, radiusM) => {
    const dLat = (radiusM / 1737400) * (180 / Math.PI), dLon = dLat / Math.max(0.05, Math.cos(lat * Math.PI / 180));
    const want = new Set();
    for (const la of [lat - dLat, lat, lat + dLat]) for (const lo of [lon - dLon, lon, lon + dLon]) {
      const L = Math.max(-89.9, Math.min(89.9, la));
      want.add(`${Math.min(7, Math.floor((90 - L) / 22.5))}_${Math.min(15, Math.floor((((lo + 180) % 360) + 360) % 360 / 22.5))}`);
    }
    await Promise.all([...want].filter((k) => !tiles.has(k)).map(async (k) => {
      try { tiles.set(k, await imageData(`${tileBase}c${k}_c.jpg`)); } catch { /* fall back to the global map */ }
    }));
  };
  return sample;
}
