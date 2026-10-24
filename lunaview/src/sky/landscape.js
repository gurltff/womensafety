// The ground around an observer standing on the Moon, built from NASA LOLA heights out to 150 km,
// with the Moon's curvature, coloured by the LROC albedo map and lit by the real Sun. Terrain shadows
// are ray-marched toward the Sun through a local height grid, so ridges and crater walls cast the
// shadows they really cast at that moment.
//
// Frame: observer's eye at the origin, x east, y up, z south (-z north), metres.
import * as THREE from 'three';
import { offset } from '../terrain.js';

const R_M = 1737400;
const DEG = Math.PI / 180;
export const EYE_M = 1.7;
const FAR_M = 150000;
const NAZ = 360;

export class Landscape {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.ambient = new THREE.AmbientLight(0x9fb4ff, 0.04);
    scene.add(this.sun, this.ambient, this.sun.target);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float shade;\nvarying float vShade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = shade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vShade;')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= vShade;');
    };
    this.mesh = null;
    this.skyline = new Float32Array(NAZ * 2); // terrain horizon every 0.5 deg
  }

  // Elevation (deg) of the skyline at azimuth az.
  horizonAt(az) {
    const n = this.skyline.length, f = ((((az % 360) + 360) % 360) / 360) * n;
    const i = Math.floor(f) % n, t = f - Math.floor(f);
    return this.skyline[i] * (1 - t) + this.skyline[(i + 1) % n] * t;
  }

  async build(terrain, site, albedo, onProgress) {
    await terrain.loadAround([site], FAR_M);
    await albedo?.prepare?.(site.lat, site.lon, FAR_M);
    const h0 = terrain.height(site.lat, site.lon);
    this.site = site;
    this.h0 = h0;
    const res = terrain.resolution(site.lat, site.lon) ?? 2000;
    this.res = res;
    const drop = (d) => (d * d) / (2 * R_M);
    const ground = (az, d) => { const p = offset(site.lat, site.lon, az, d); return { p, h: terrain.height(p.lat, p.lon) - h0 - drop(d) }; };

    // Local height grid (metres relative to the ground under the observer) for shadows.
    const N = 512, Rg = res <= 100 ? 30000 : 120000, cell = (2 * Rg) / N;
    const grid = new Float32Array(N * N);
    let maxH = -Infinity;
    for (let i = 0; i < N; i++) {
      const y = Rg - (i + 0.5) * cell;
      for (let j = 0; j < N; j++) {
        const x = -Rg + (j + 0.5) * cell;
        const d = Math.hypot(x, y);
        const h = d < 1 ? 0 : ground(Math.atan2(x, y) / DEG, d).h;
        grid[i * N + j] = h;
        if (h > maxH) maxH = h;
      }
      if (i % 64 === 63) { onProgress?.(0.1 + (0.5 * i) / N); await new Promise((r) => setTimeout(r, 0)); }
    }
    this.grid = { N, Rg, cell, h: grid, maxH };

    // Skyline from the eye: near part from the grid, far part traced out to 150 km.
    this.farSky = new Float32Array(NAZ * 2);
    for (let k = 0; k < NAZ * 2; k++) {
      const az = k / 2;
      let best = -90, far = -90;
      for (let d = cell; d < Rg; d += cell) best = Math.max(best, Math.atan2(this.gridAt(d * Math.sin(az * DEG), d * Math.cos(az * DEG)) - EYE_M, d) / DEG);
      for (let d = Rg; d <= FAR_M; d *= 1.015) {
        const h = ground(az, d).h;
        far = Math.max(far, Math.atan2(h - EYE_M, d) / DEG);
      }
      this.farSky[k] = far;
      this.skyline[k] = Math.max(best, far);
    }
    onProgress?.(0.75);

    // Mesh: rings around the observer, finer close in, out to 150 km.
    const rings = [];
    for (let d = 1.2; d < FAR_M; d *= 1.05) rings.push(d);
    rings.push(FAR_M);
    const nv = 1 + rings.length * NAZ;
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), shade = new Float32Array(nv).fill(1);
    const ll = new Float32Array(nv * 2);
    pos.set([0, -EYE_M, 0], 0);
    const a0 = albedo ? albedo(site.lat, site.lon) : [0.55, 0.53, 0.5];
    col.set(a0, 0);
    rings.forEach((d, r) => {
      for (let k = 0; k < NAZ; k++) {
        const az = (k * 360) / NAZ;
        const sx = Math.sin(az * DEG), cz = Math.cos(az * DEG);
        const p = offset(site.lat, site.lon, az, d);
        const h = d < Rg * 0.98 ? this.gridAt(d * sx, d * cz) : terrain.height(p.lat, p.lon) - h0 - drop(d);
        const v = 1 + r * NAZ + k;
        pos.set([d * sx, h - EYE_M, -d * cz], v * 3);
        col.set(albedo ? albedo(p.lat, p.lon) : a0, v * 3);
        ll.set([p.lat, p.lon], v * 2);
      }
    });
    const idx = [];
    for (let k = 0; k < NAZ; k++) idx.push(0, 1 + ((k + 1) % NAZ), 1 + k);
    for (let r = 0; r < rings.length - 1; r++) {
      for (let k = 0; k < NAZ; k++) {
        const a = 1 + r * NAZ + k, b = 1 + r * NAZ + ((k + 1) % NAZ), c = a + NAZ, e = b + NAZ;
        idx.push(a, b, c, b, e, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('shade', new THREE.BufferAttribute(shade, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.rings = rings;
    this.lastSun = null;
    onProgress?.(1);
  }

  gridAt(x, y) {
    const { N, Rg, cell, h } = this.grid;
    const fj = (x + Rg) / cell - 0.5, fi = (Rg - y) / cell - 0.5;
    const j0 = Math.max(0, Math.min(N - 2, Math.floor(fj))), i0 = Math.max(0, Math.min(N - 2, Math.floor(fi)));
    const tx = Math.max(0, Math.min(1, fj - j0)), ty = Math.max(0, Math.min(1, fi - i0));
    const k = i0 * N + j0;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + N] * (1 - tx) + h[k + N + 1] * tx) * ty;
  }

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
    this.ambient.intensity = fill ? 0.7 : Math.max(minAmbient, 0.03 + (earthshine ? 0.55 * earth.illum * Math.sqrt(eUp) : 0));
    this.ambient.color.set(minAmbient > 0.1 ? 0xc4cde0 : 0x9fb4ff);

    const key = fill ? 'fill' : `${sun.alt.toFixed(2)},${sun.az.toFixed(2)}`;
    if (key === this.lastSun) return;
    this.lastSun = key;
    const attr = this.mesh.geometry.attributes.shade;
    const pos = this.mesh.geometry.attributes.position.array;
    const s = attr.array;
    if (fill || sun.alt < -1) { s.fill(fill ? 1 : 0); attr.needsUpdate = true; return; }
    const { Rg, cell, maxH } = this.grid;
    const sx = Math.sin(sun.az * DEG), sy = Math.cos(sun.az * DEG), tanEl = Math.tan(sun.alt * DEG);
    const farBlock = this.farSkyAt(sun.az);
    for (let v = 0; v < s.length; v++) {
      const x = pos[v * 3], h = pos[v * 3 + 1] + EYE_M, y = -pos[v * 3 + 2];
      const d = Math.hypot(x, y);
      let block = -90;
      if (d < Rg * 0.98) {
        // March toward the Sun through the grid; stop once the ray clears the highest ground.
        for (let t = cell; ; t += cell) {
          const px = x + sx * t, py = y + sy * t;
          if (Math.abs(px) >= Rg || Math.abs(py) >= Rg) { block = Math.max(block, farBlock); break; }
          const need = h + tanEl * t;
          if (need > maxH + 1 && tanEl > 0) break;
          const a = Math.atan2(this.gridAt(px, py) - h, t) / DEG;
          if (a > block) block = a;
        }
      } else {
        block = this.farSkyAt(sun.az) - 0.5;
      }
      // The Sun's disc is 0.53 deg across: partial light as it clears the ridge.
      s[v] = Math.max(0, Math.min(1, (sun.alt - block) / 0.53 + 0.5));
    }
    attr.needsUpdate = true;
  }

  farSkyAt(az) {
    const n = this.farSky.length, f = ((((az % 360) + 360) % 360) / 360) * n;
    return this.farSky[Math.floor(f) % n];
  }
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
