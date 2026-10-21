// The sky drawn behind everything: catalogue stars, constellations, the Milky Way, grids, the Sun,
// the Earth (textured, turned by sidereal time and lit with its real phase) and the planets.
// Everything sits on a sphere of radius R around the camera; positions come from ephem.js in J2000
// equatorial coordinates and are turned into the view frame with one matrix.
import * as THREE from 'three';
import { raDecToEqj } from './ephem.js';

const R = 1000;
const DEG = Math.PI / 180;

// B-V colour index -> RGB, via the star's temperature (Ballesteros 2012) and a black body.
function bvToRgb(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = t / 100;
  let r, g, b;
  if (k <= 66) { r = 255; g = 99.47 * Math.log(k) - 161.1; b = k <= 19 ? 0 : 138.5 * Math.log(k - 10) - 305.0; }
  else { r = 329.7 * (k - 60) ** -0.1332; g = 288.1 * (k - 60) ** -0.0755; b = 255; }
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  // Halfway to white: the eye sees star colours as pale tints.
  return [0.5 + 0.5 * c(r), 0.5 + 0.5 * c(g), 0.5 + 0.5 * c(b)];
}

const STAR_VS = `
attribute float mag;
attribute vec3 tint;
uniform float magLimit;
uniform float px;
uniform float fade;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = magLimit - mag;
  gl_PointSize = clamp(px * 1.15 * pow(1.33, d), 0.0, px * 18.0);
  vAlpha = clamp(d * 0.55 + 0.1, 0.0, 1.0) * fade;
  vTint = tint;
}`;
const STAR_FS = `
varying vec3 vTint;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = exp(-r * r * 6.0);
  float halo = exp(-r * r * 1.6) * 0.35;
  gl_FragColor = vec4(vTint * (core + halo) + vec3(core * 0.4), (core + halo) * vAlpha);
}`;

const EARTH_VS = `
varying vec2 vUv;
varying vec3 vN;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const EARTH_FS = `
uniform sampler2D map;
uniform vec3 sunDir;
varying vec2 vUv;
varying vec3 vN;
void main() {
  vec3 c = texture2D(map, vUv).rgb;
  float l = dot(normalize(vN), normalize(sunDir));
  float lit = smoothstep(-0.03, 0.12, l);
  // Day side: the Blue Marble; a thin blue haze along the lit limb; night side nearly black.
  vec3 day = c * (0.25 + 0.95 * max(l, 0.0)) * 1.15;
  gl_FragColor = vec4(mix(c * 0.025, day, lit) + vec3(0.06, 0.1, 0.22) * lit * 0.35, 1.0);
}`;

function glowTexture(stops) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function lineSegments(pairs, color, opacity) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pairs, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false }));
}

export class SkyLayer {
  constructor({ stars, constellations, textures }) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 1, 5 * R);
    this.eqj = new THREE.Group(); // EQJ-fixed things
    this.eqj.matrixAutoUpdate = false;
    this.local = new THREE.Group(); // horizon-fixed things (surface view only)
    this.scene.add(this.eqj, this.local);
    this.R9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.show = { stars: true, constLines: true, constNames: true, milkyWay: true, eqGrid: false, azGrid: false, ecliptic: false, planets: true };

    // ---- stars ----
    const n = stars.ra.length;
    const pos = new Float32Array(n * 3), mag = new Float32Array(n), tint = new Float32Array(n * 3);
    this.starVec = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = raDecToEqj(stars.ra[i], stars.dec[i]);
      this.starVec.set([v.x, v.y, v.z], i * 3);
      pos.set([v.x * R, v.y * R, v.z * R], i * 3);
      mag[i] = stars.mag[i];
      tint.set(bvToRgb(stars.bv[i]), i * 3);
    }
    this.stars = stars;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    sg.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    this.starUniforms = { magLimit: { value: 6.5 }, px: { value: Math.min(window.devicePixelRatio || 1, 2) }, fade: { value: 1 } };
    this.starPoints = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.starUniforms, vertexShader: STAR_VS, fragmentShader: STAR_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.starPoints.frustumCulled = false;
    this.starPoints.renderOrder = 2;
    this.eqj.add(this.starPoints);

    // ---- constellations ----
    const cl = [];
    for (const s of constellations.lines) {
      for (let k = 1; k < s.p.length; k++) {
        const a = raDecToEqj(s.p[k - 1][0], s.p[k - 1][1]), b = raDecToEqj(s.p[k][0], s.p[k][1]);
        cl.push(a.x * R, a.y * R, a.z * R, b.x * R, b.y * R, b.z * R);
      }
    }
    this.constLines = lineSegments(cl, 0x3f78b5, 0.55);
    this.constLines.renderOrder = 1;
    this.eqj.add(this.constLines);
    this.constLabels = constellations.labels.map((c) => ({ ...c, v: raDecToEqj(c.ra, c.dec) }));

    // ---- Milky Way (rasterised from the catalogue outlines) ----
    const mwGeo = new THREE.BufferGeometry();
    const mp = [], uv = [], idx = [];
    const NA = 180, ND = 90;
    for (let j = 0; j <= ND; j++) {
      for (let i = 0; i <= NA; i++) {
        const ra = (i / NA) * 360, dec = 90 - (j / ND) * 180;
        const v = raDecToEqj(ra, dec);
        mp.push(v.x * R * 1.2, v.y * R * 1.2, v.z * R * 1.2);
        uv.push(i / NA, 1 - j / ND);
      }
    }
    for (let j = 0; j < ND; j++) for (let i = 0; i < NA; i++) { const a = j * (NA + 1) + i; idx.push(a, a + NA + 1, a + 1, a + 1, a + NA + 1, a + NA + 2); }
    mwGeo.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mwGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    mwGeo.setIndex(idx);
    this.milkyWay = new THREE.Mesh(mwGeo, new THREE.MeshBasicMaterial({
      map: textures.milkyWay, color: 0x8f9fc4, transparent: true, opacity: 0.32, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.milkyWay.renderOrder = 0;
    this.milkyWay.frustumCulled = false;
    this.eqj.add(this.milkyWay);

    // ---- grids ----
    const eqg = [];
    const circle = (fn, steps = 180) => { for (let k = 0; k < steps; k++) { const a = fn(k / steps), b = fn((k + 1) / steps); eqg.push(a.x * R, a.y * R, a.z * R, b.x * R, b.y * R, b.z * R); } };
    for (let dec = -80; dec <= 80; dec += 10) circle((f) => raDecToEqj(f * 360, dec));
    for (let ra = 0; ra < 360; ra += 15) { const s = []; for (let k = 0; k < 90; k++) { const a = raDecToEqj(ra, -90 + k * 2), b = raDecToEqj(ra, -88 + k * 2); s.push(a.x * R, a.y * R, a.z * R, b.x * R, b.y * R, b.z * R); } eqg.push(...s); }
    this.eqGrid = lineSegments(eqg, 0x2f7f9f, 0.35);
    this.eqj.add(this.eqGrid);
    // Ecliptic (J2000 obliquity 23.4393 deg).
    const ecl = [], eps = 23.4393 * DEG;
    for (let k = 0; k < 360; k++) {
      const l1 = k * DEG, l2 = (k + 1) * DEG;
      const p = (l) => new THREE.Vector3(Math.cos(l), Math.sin(l) * Math.cos(eps), Math.sin(l) * Math.sin(eps)).multiplyScalar(R);
      ecl.push(...p(l1).toArray(), ...p(l2).toArray());
    }
    this.ecliptic = lineSegments(ecl, 0xb59a3f, 0.6);
    this.eqj.add(this.ecliptic);
    // Azimuthal grid in the horizon frame (x east, y up, z south).
    const azg = [];
    const hz = (alt, az) => new THREE.Vector3(Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG), -Math.cos(alt * DEG) * Math.cos(az * DEG)).multiplyScalar(R);
    for (let alt = -80; alt <= 80; alt += 10) for (let az = 0; az < 360; az += 2) azg.push(...hz(alt, az).toArray(), ...hz(alt, az + 2).toArray());
    for (let az = 0; az < 360; az += 15) for (let alt = -88; alt < 88; alt += 2) azg.push(...hz(alt, az).toArray(), ...hz(alt + 2, az).toArray());
    this.azGrid = lineSegments(azg, 0xa0603a, 0.35);
    this.local.add(this.azGrid);

    // ---- Sun ----
    // Glare around the Sun: a dazzling core and a wide faint halo (there is no air to scatter light,
    // but the eye and any camera still flare).
    this.sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture([[0, 'rgba(255,248,230,0.55)'], [0.15, 'rgba(255,240,215,0.16)'], [0.5, 'rgba(255,230,200,0.04)'], [1, 'rgba(255,220,190,0)']]),
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.sunHalo.renderOrder = 5;
    this.scene.add(this.sunHalo);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture([[0, 'rgba(255,255,250,1)'], [0.12, 'rgba(255,250,235,0.85)'], [0.35, 'rgba(255,235,200,0.25)'], [1, 'rgba(255,210,160,0)']]),
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.sunDisc = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture([[0, '#ffffff'], [0.78, '#fff6e0'], [0.95, 'rgba(255,236,200,0.95)'], [1, 'rgba(255,230,190,0)']]),
      transparent: true, depthWrite: false, depthTest: false,
    }));
    this.sunGlow.renderOrder = 5;
    this.sunDisc.renderOrder = 6;
    this.scene.add(this.sunGlow, this.sunDisc);

    // ---- Earth ----
    this.earthUniforms = { map: { value: textures.earth }, sunDir: { value: new THREE.Vector3(1, 0, 0) } };
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({
      uniforms: this.earthUniforms, vertexShader: EARTH_VS, fragmentShader: EARTH_FS, depthTest: true, depthWrite: true,
    }));
    this.earth.matrixAutoUpdate = false;
    this.earth.renderOrder = 7;
    this.scene.add(this.earth);

    // ---- planets ----
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
    pg.setAttribute('mag', new THREE.BufferAttribute(new Float32Array(7), 1));
    pg.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
    this.planetPoints = new THREE.Points(pg, new THREE.ShaderMaterial({
      uniforms: this.starUniforms, vertexShader: STAR_VS, fragmentShader: STAR_FS,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.planetPoints.frustumCulled = false;
    this.planetPoints.renderOrder = 4;
    this.scene.add(this.planetPoints);
    this.bodies = [];
  }

  // R9: row-major EQJ -> view rotation. bodies: from ephem.solarSystem.
  update(R9, bodies) {
    this.R9 = R9;
    const m = new THREE.Matrix4().set(R9[0], R9[1], R9[2], 0, R9[3], R9[4], R9[5], 0, R9[6], R9[7], R9[8], 0, 0, 0, 0, 1);
    this.eqj.matrix.copy(m);
    this.eqj.matrixWorldNeedsUpdate = true;
    this.bodies = bodies;
    const toView = (d) => new THREE.Vector3(R9[0] * d.x + R9[1] * d.y + R9[2] * d.z, R9[3] * d.x + R9[4] * d.y + R9[5] * d.z, R9[6] * d.x + R9[7] * d.y + R9[8] * d.z);
    for (const b of bodies) b.view = toView(b.dir);

    const sun = bodies.find((b) => b.id === 'sun');
    const sunR = R * 0.99;
    const size = 2 * sunR * Math.tan((sun.angDiamDeg * DEG) / 2);
    this.sunDisc.position.copy(sun.view).multiplyScalar(sunR);
    this.sunDisc.scale.setScalar(size);
    this.sunGlow.position.copy(this.sunDisc.position);
    this.sunGlow.scale.setScalar(Math.max(size * 8, sunR * 0.035));
    this.sunHalo.position.copy(this.sunDisc.position);
    this.sunHalo.scale.setScalar(sunR * 0.5);

    const earth = bodies.find((b) => b.id === 'earth');
    const er = R * 0.9;
    const rr = er * Math.tan((earth.angDiamDeg * DEG) / 2);
    this.earth.matrix.copy(earthMatrix(R9, earth, er, rr));
    this.earth.matrixWorldNeedsUpdate = true;
    this.earthUniforms.sunDir.value.copy(sun.view);

    const planets = bodies.filter((b) => b.type === 'planet' && b.id !== 'earth');
    const pa = this.planetPoints.geometry.attributes;
    planets.forEach((p, i) => {
      pa.position.setXYZ(i, p.view.x * R * 0.98, p.view.y * R * 0.98, p.view.z * R * 0.98);
      pa.mag.setX(i, p.mag);
      const c = new THREE.Color(p.color);
      pa.tint.setXYZ(i, c.r, c.g, c.b);
    });
    pa.position.needsUpdate = pa.mag.needsUpdate = pa.tint.needsUpdate = true;

    this.starPoints.visible = this.show.stars;
    this.constLines.visible = this.show.constLines;
    this.milkyWay.visible = this.show.milkyWay;
    this.eqGrid.visible = this.show.eqGrid;
    this.ecliptic.visible = this.show.ecliptic;
    this.azGrid.visible = this.show.azGrid && this.local.visible;
    this.planetPoints.visible = this.show.planets;
  }

  // Faintest magnitude shown: like a dark-adapted eye at a 60 deg field, more stars as you zoom in.
  setMagLimit(m, fade = 1) {
    this.starUniforms.magLimit.value = m;
    this.starUniforms.fade.value = fade;
  }

  // Draw with the orientation and field of view of `cam` (its position is ignored: the sky is far).
  render(renderer, cam) {
    this.camera.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
    this.camera.fov = cam.fov;
    this.camera.aspect = cam.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    renderer.render(this.scene, this.camera);
  }

  // View-frame unit vector of star i.
  starView(i) {
    const R9 = this.R9, s = this.starVec;
    const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
    return new THREE.Vector3(R9[0] * x + R9[1] * y + R9[2] * z, R9[3] * x + R9[4] * y + R9[5] * z, R9[6] * x + R9[7] * y + R9[8] * z);
  }

  viewOf(v) {
    const R9 = this.R9;
    return new THREE.Vector3(R9[0] * v.x + R9[1] * v.y + R9[2] * v.z, R9[3] * v.x + R9[4] * v.y + R9[5] * v.z, R9[6] * v.x + R9[7] * v.y + R9[8] * v.z);
  }
}

// Model matrix that places and turns the Earth sphere: Earth-fixed axes -> J2000 -> view frame.
export function earthMatrix(R9, earth, dist, radius) {
  const m = new THREE.Matrix4().set(R9[0], R9[1], R9[2], 0, R9[3], R9[4], R9[5], 0, R9[6], R9[7], R9[8], 0, 0, 0, 0, 1);
  const E = earth.earthAxes;
  const ecefToEqj = new THREE.Matrix4().makeBasis(new THREE.Vector3(E.x.x, E.x.y, E.x.z), new THREE.Vector3(E.y.x, E.y.y, E.y.z), new THREE.Vector3(E.z.x, E.z.y, E.z.z));
  // Sphere geometry: three x -> Earth-fixed x (lon 0), three y -> north, three z -> -y (lon 90W).
  const local = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
  const v = earth.view ?? new THREE.Vector3(
    R9[0] * earth.dir.x + R9[1] * earth.dir.y + R9[2] * earth.dir.z,
    R9[3] * earth.dir.x + R9[4] * earth.dir.y + R9[5] * earth.dir.z,
    R9[6] * earth.dir.x + R9[7] * earth.dir.y + R9[8] * earth.dir.z,
  );
  return new THREE.Matrix4().makeTranslation(v.x * dist, v.y * dist, v.z * dist)
    .multiply(m).multiply(ecefToEqj).multiply(local).multiply(new THREE.Matrix4().makeScale(radius, radius, radius));
}

export async function loadSky(base = 'sky/') {
  const [stars, constellations] = await Promise.all([
    fetch(`${base}stars.json`).then((r) => r.json()),
    fetch(`${base}constellations.json`).then((r) => r.json()),
  ]);
  const loader = new THREE.TextureLoader();
  const tex = (url, srgb = true) => new Promise((ok) => loader.load(url, (t) => { if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; ok(t); }, undefined, () => ok(null)));
  const [earth, milkyWay] = await Promise.all([tex(`${base}earth.jpg`), tex(`${base}milkyway.png`, false)]);
  return { stars, constellations, textures: { earth, milkyWay } };
}
