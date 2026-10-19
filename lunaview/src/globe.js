// 3D Moon globe built from NASA data: LROC colour, LOLA heights (displacement + normal map) and a
// high-detail south-pole patch from the LOLA 80 m polar DEM that casts real shadows from the real Sun.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import fallbackTexture from './assets/moon_1024.jpg';

// Moon-fixed frame (+X lon 0, +Y lon 90E, +Z north) -> three.js world (+Y up).
// With SphereGeometry's UV layout an equirectangular map centred on lon 0 lands on +X.
export const toWorld = (v) => new THREE.Vector3(v.x, v.z, -v.y);

const DEG = Math.PI / 180;
const R_M = 1737400;
const llToWorld = (lat, lon, r = 1) =>
  new THREE.Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), -Math.cos(lat * DEG) * Math.sin(lon * DEG)).multiplyScalar(r);

// Built by tools/build_textures.py from NASA's CGI Moon Kit and LOLA polar data.
const TEX = 'textures/';

export class Globe {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.relief = 1;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.maxTex = this.renderer.capabilities.maxTextureSize;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.00002, 200);
    this.camera.position.copy(llToWorld(-40, 8, 5.2));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.1;
    this.controls.maxDistance = 9;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 1.2;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.flight = null; });

    this.sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.position.copy(llToWorld(-90, 0, 1));
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -0.1; sc.right = sc.top = 0.1; sc.near = 0.05; sc.far = 1.2;
    this.sun.shadow.mapSize.setScalar(Math.min(4096, this.maxTex));
    this.sun.shadow.bias = -0.00002;
    this.sun.shadow.normalBias = 0.0004;
    this.scene.add(this.sun);
    this.earthshine = new THREE.AmbientLight(0x9ab8ff, 0.14);
    this.scene.add(this.earthshine);
    this.fullLight = false;

    this.buildStars();
    this.buildMoon();
    this.buildGrid();
    this.buildPolarRing();

    this.pins = [];
    this.onPick = null;
    this.raycaster = new THREE.Raycaster();
    canvas.addEventListener('pointerdown', (e) => { this.down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (this.down && Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 5) this.pickAt(e);
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  buildStars() {
    // Decorative backdrop: seeded random stars with a brightness distribution like the real sky.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 4500;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = 80;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3);
      const b = Math.pow(rnd(), 3.2) * 0.9 + 0.1;
      const warm = rnd();
      col.set([b * (0.85 + 0.15 * warm), b * 0.92, b * (1.05 - 0.2 * warm)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false });
    this.scene.add(new THREE.Points(g, m));
  }

  buildMoon() {
    const loader = new THREE.TextureLoader();
    const fallback = loader.load(fallbackTexture);
    fallback.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshStandardMaterial({ map: fallback, bumpMap: fallback, bumpScale: 0.7, roughness: 1, metalness: 0 });
    this.cutY = { value: -2 }; // the sphere is cut away where the polar patch takes over
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.cutY = this.cutY;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vMoonY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMoonY = normalize(position).y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vMoonY;\nuniform float cutY;')
        .replace('void main() {', 'void main() {\n  if (vMoonY < cutY) discard;');
    };
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 720, 360), this.material);
    this.scene.add(this.moon);
    this.textureSource = 'placeholder';

    const big = this.maxTex >= 8192 && Math.min(window.innerWidth, window.innerHeight) > 700;
    const load = (name) => new Promise((ok, fail) => loader.load(TEX + name, ok, undefined, fail));
    load(big ? 'lroc_color.jpg' : 'lroc_color_4k.jpg').then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.material.map = tex;
      this.material.bumpMap = null;
      this.material.needsUpdate = true;
      this.textureSource = 'NASA LROC';
      this.onTextures?.();
    }).catch(() => {});

    fetch(TEX + 'terrain.json').then((r) => (r.ok ? r.json() : Promise.reject())).then(async (meta) => {
      this.terrain = meta;
      const [height, normal] = await Promise.all([
        load('ldem_height.png'),
        this.maxTex >= 8192 ? load('ldem_normal.jpg') : Promise.resolve(null),
      ]);
      this.material.displacementMap = height;
      if (normal) {
        normal.colorSpace = THREE.NoColorSpace;
        this.material.normalMap = normal;
      }
      this.material.bumpMap = null;
      this.material.needsUpdate = true;
      await this.buildPolarPatch(meta.polar, load);
      this.setRelief(this.relief);
      this.onTextures?.();
    }).catch(() => {});
  }

  // Heights are packed losslessly in a PNG: metres = red * 256 + green - 32768.
  async loadHeights(url) {
    const img = await new Promise((ok, fail) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = fail;
      im.src = url;
    });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const heights = new Int16Array(img.width * img.height);
    for (let i = 0; i < heights.length; i++) heights[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
    return { heights, size: img.width };
  }

  // A terrain mesh on a polar stereographic grid. x, y are metres from the pole (y toward lon 0).
  // Vertex normals point straight up; slopes come from the normal map so detail survives at any zoom.
  terrainMesh({ x0, x1, y0, y1, n, heightAt, keep, skirtM = 0, material }) {
    const ring = skirtM > 0 ? 4 * (n - 1) : 0;
    const count = n * n + ring;
    const base = new Float32Array(count * 3);
    const h = new Float32Array(count);
    const uv = new Float32Array(count * 2);
    const pxy = new Float32Array(count * 2);
    const put = (k, x, y, hm, u, v) => {
      const lat = (2 * Math.atan(Math.hypot(x, y) / (2 * R_M))) / DEG - 90;
      const d = llToWorld(lat, Math.atan2(x, y) / DEG, 1);
      base.set([d.x, d.y, d.z], k * 3);
      h[k] = hm;
      uv.set([u, v], k * 2);
      pxy.set([x, y], k * 2);
    };
    const X = (j) => x0 + ((x1 - x0) * j) / (n - 1);
    const Y = (i) => y0 + ((y1 - y0) * i) / (n - 1);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) put(i * n + j, X(j), Y(i), heightAt(i, j), j / (n - 1), 1 - i / (n - 1));
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        if (keep && !(keep(i, j) && keep(i + 1, j) && keep(i, j + 1) && keep(i + 1, j + 1))) continue;
        const a = i * n + j, b = a + 1, c = a + n, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }
    if (ring) {
      // A skirt hanging below the tile edge hides cracks where it meets coarser terrain.
      const edge = [];
      for (let j = 0; j < n - 1; j++) edge.push([0, j]);
      for (let i = 0; i < n - 1; i++) edge.push([i, n - 1]);
      for (let j = n - 1; j > 0; j--) edge.push([n - 1, j]);
      for (let i = n - 1; i > 0; i--) edge.push([i, 0]);
      edge.forEach(([i, j], e) => put(n * n + e, X(j), Y(i), heightAt(i, j) - skirtM, j / (n - 1), 1 - i / (n - 1)));
      for (let e = 0; e < ring; e++) {
        const [i, j] = edge[e], [i2, j2] = edge[(e + 1) % ring];
        const a = i * n + j, b = i2 * n + j2, a2 = n * n + e, b2 = n * n + ((e + 1) % ring);
        idx.push(a, b, b2, a, b2, a2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(base.slice(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('pxy', new THREE.BufferAttribute(pxy, 2));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.terrain = { base, h };
    this.placeTerrain(mesh);
    this.scene.add(mesh);
    return mesh;
  }

  placeTerrain(mesh) {
    const { base, h } = mesh.userData.terrain;
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < h.length; i++) {
      const r = 1 + (h[i] / R_M) * this.relief;
      p.setXYZ(i, base[i * 3] * r, base[i * 3 + 1] * r, base[i * 3 + 2] * r);
    }
    p.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }

  regolith(normalMap) {
    // Plain regolith grey: photo mosaics of the pole have shadows baked in, which would fight
    // with the real-time shadows cast here by the Sun at the chosen time.
    normalMap.colorSpace = THREE.NoColorSpace;
    normalMap.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return new THREE.MeshStandardMaterial({
      color: 0x8f8b84, roughness: 1, metalness: 0, normalMap, normalScale: new THREE.Vector2(this.relief, this.relief),
    });
  }

  async buildPolarPatch(meta, load) {
    const [{ heights, size: G }, normal] = await Promise.all([
      this.loadHeights(TEX + 'polar_height.png'),
      load('polar_normal.jpg'),
    ]);
    const half = meta.half_m, step = 2, n = Math.floor((G - 1) / step) + 1;
    const material = this.regolith(normal);
    // Where a 20 m detail tile is showing, the coarse patch steps aside (bit r*4+c of tileMask).
    const det = meta.detail;
    this.tileMask = { value: 0 };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.tileMask = this.tileMask;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 pxy;\nvarying vec2 vPxy;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPxy = pxy;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vPxy;\nuniform int tileMask;`)
        .replace('void main() {', `void main() {
  if (tileMask != 0 && abs(vPxy.x) < ${det.half_m.toFixed(1)} && abs(vPxy.y) < ${det.half_m.toFixed(1)}) {
    float sz = ${((2 * det.half_m) / det.tiles).toFixed(3)};
    int c = int((vPxy.x + ${det.half_m.toFixed(1)}) / sz);
    int r = int((${det.half_m.toFixed(1)} - vPxy.y) / sz);
    if (((tileMask >> (r * ${det.tiles} + c)) & 1) == 1) discard;
  }`);
    };
    this.patch = this.terrainMesh({
      x0: -half, x1: half, y0: half, y1: -half, n,
      heightAt: (i, j) => heights[i * step * G + j * step],
      // Keep only the round cap inside the patch's latitude limit so it meets the sphere cleanly.
      keep: (i, j) => Math.hypot(-half + (2 * half * j) / (n - 1), half - (2 * half * i) / (n - 1)) <= half,
      material,
    });
    this.cutY.value = Math.sin((meta.limit_lat - 0.15) * DEG);
    this.detail = { ...det, load, size: (2 * det.half_m) / det.tiles, tiles: new Map() };
  }

  // Load 20 m detail tiles near the camera and show them in place of the coarse patch.
  updateDetail() {
    const d = this.detail;
    if (!d) return;
    const cam = this.camera.position;
    let mask = 0;
    const N = this.terrain.polar.detail.tiles;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const key = `${r}_${c}`;
        const cx = -d.half_m + (c + 0.5) * d.size, cy = d.half_m - (r + 0.5) * d.size;
        const lat = (2 * Math.atan(Math.hypot(cx, cy) / (2 * R_M))) / DEG - 90;
        const centre = llToWorld(lat, Math.atan2(cx, cy) / DEG, 1);
        const near = cam.distanceTo(centre) < 0.045; // ~80 km
        let t = d.tiles.get(key);
        if (near && !t) {
          t = { mesh: null };
          d.tiles.set(key, t);
          Promise.all([this.loadHeights(`${TEX}tiles/t${key}_h.png`), d.load(`tiles/t${key}_n.jpg`)]).then(([{ heights, size: G }, normal]) => {
            const x0 = -d.half_m + c * d.size, y0 = d.half_m - r * d.size;
            t.mesh = this.terrainMesh({
              x0, x1: x0 + d.size, y0, y1: y0 - d.size, n: G,
              heightAt: (i, j) => heights[i * G + j], skirtM: 400, material: this.regolith(normal),
            });
            t.mesh.material.side = THREE.DoubleSide;
          }).catch(() => d.tiles.delete(key));
        }
        if (t?.mesh) {
          t.mesh.visible = near || cam.distanceTo(centre) < 0.055;
          if (t.mesh.visible) mask |= 1 << (r * N + c);
        }
      }
    }
    this.tileMask.value = mask;
  }

  // Vertical exaggeration of the terrain. 1 = true scale.
  setRelief(k) {
    this.relief = k;
    const t = this.terrain;
    if (t) {
      const { min_m: lo, max_m: hi } = t.height_png;
      this.material.displacementScale = ((hi - lo) / R_M) * k;
      this.material.displacementBias = (lo / R_M) * k;
      this.material.normalScale.set(k, k);
    }
    const meshes = [this.patch, ...(this.detail ? [...this.detail.tiles.values()].map((x) => x.mesh) : [])];
    for (const m of meshes) {
      if (!m) continue;
      this.placeTerrain(m);
      m.material.normalScale.set(k, k);
    }
    for (const pin of this.pins) pin.mesh.position.copy(this.sitePoint(pin.site, 0.0004));
  }

  sitePoint(s, lift = 0) {
    return llToWorld(s.lat, s.lon, 1 + ((s.heightM ?? 0) / R_M) * this.relief + lift);
  }

  buildGrid() {
    const pts = [];
    const r = 1.006;
    for (let lat = -80; lat <= 80; lat += 10) {
      for (let lon = 0; lon < 360; lon += 3) pts.push(llToWorld(lat, lon, r), llToWorld(lat, lon + 3, r));
    }
    for (let lon = 0; lon < 360; lon += 15) {
      for (let lat = -90; lat < 90; lat += 3) pts.push(llToWorld(lat, lon, r), llToWorld(lat + 3, lon, r));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7fa7d9, transparent: true, opacity: 0.22 }));
    this.grid.visible = false;
    this.scene.add(this.grid);
  }

  buildPolarRing() {
    // Highlight the south polar region (poleward of 84 S) where CLPS and Artemis are heading.
    const pts = [];
    for (let lon = 0; lon <= 360; lon += 2) pts.push(llToWorld(-84, lon, 1.006));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.polarRing = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf2c14e, dashSize: 0.01, gapSize: 0.008, transparent: true, opacity: 0.8 }));
    this.polarRing.computeLineDistances();
    this.scene.add(this.polarRing);
  }

  setSites(sites, selectedId) {
    this.labelLayer.textContent = '';
    for (const p of this.pins) this.scene.remove(p.mesh);
    this.pins = sites.map((s) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
      mesh.position.copy(this.sitePoint(s, 0.0004));
      mesh.userData.site = s;
      this.scene.add(mesh);
      const el = document.createElement('button');
      el.className = 'pin-label';
      el.type = 'button';
      el.innerHTML = `<span class="pin-dot"></span><span class="pin-name"></span>`;
      el.querySelector('.pin-name').textContent = s.name;
      el.addEventListener('click', () => this.onPick?.(s));
      this.labelLayer.appendChild(el);
      return { site: s, mesh, el };
    });
    this.select(selectedId);
  }

  select(id) {
    this.selectedId = id;
    for (const p of this.pins) {
      const on = p.site.id === id;
      p.el.classList.toggle('selected', on);
      p.mesh.material.color.set(on ? 0xffffff : 0xf2c14e);
    }
  }

  pickAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.patch ? [this.patch, this.moon] : [this.moon])[0];
    if (!hit) return;
    const p = hit.point.clone().normalize();
    const lat = Math.asin(p.y) / DEG;
    const lon = Math.atan2(-p.z, p.x) / DEG;
    this.onSurfaceClick?.({ lat, lon });
  }

  setSunDirection(dirMoonFixed) {
    const first = !this.sunDir;
    this.sunDir = toWorld(dirMoonFixed).normalize();
    // On first load, face the sunlit side with the south pole tilted toward the viewer.
    if (first) {
      const lon = Math.atan2(-this.sunDir.z, this.sunDir.x) / DEG;
      this.homeLon = lon - 35;
      this.camera.position.copy(llToWorld(-42, this.homeLon, 5.2));
    }
    this.applyLight();
  }

  setFullLight(on) {
    this.fullLight = on;
    this.applyLight();
  }

  applyLight() {
    // The light sits just beyond the area it shadows, so its shadow camera covers what is on screen.
    const dir = this.fullLight ? this.camera.position.clone().normalize() : this.sunDir;
    if (!dir) return;
    const size = this.shadowSize ?? 0.1;
    this.sun.position.copy(this.sunTarget.position).addScaledVector(dir, size * 3 + 0.01);
    this.earthshine.intensity = this.fullLight ? 0.6 : 0.14;
  }

  // Shrink the shadow map to the area being looked at, so shadows sharpen as you zoom in.
  fitShadow() {
    const t = this.controls.target;
    const centre = t.lengthSq() > 0.25 ? t : this.poleCentre ?? (this.poleCentre = llToWorld(-90, 0, 1));
    const size = THREE.MathUtils.clamp(this.camera.position.distanceTo(centre) * 0.9, 0.003, 0.1);
    if (size === this.shadowSize && this.sunTarget.position.equals(centre)) return;
    this.shadowSize = size;
    this.sunTarget.position.copy(centre);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -size; sc.right = sc.top = size;
    sc.near = 0; sc.far = size * 6 + 0.02;
    sc.updateProjectionMatrix();
    this.sun.shadow.normalBias = size * 0.004;
    this.applyLight();
  }

  // Close-up: orbit around the site, looking at it from 2 degrees equatorward and ~50 km up.
  flyTo(site) {
    const target = this.sitePoint(site);
    const cam = llToWorld(site.lat + 2.2, site.lon, 1.03 + ((site.heightM ?? 0) / R_M) * this.relief);
    this.startFlight(cam, target, 0.0005);
  }

  flyHome() {
    this.startFlight(llToWorld(-42, this.homeLon ?? 8, 5.2), new THREE.Vector3(), 1.1);
  }

  startFlight(pos, target, minDistance) {
    this.controls.autoRotate = false;
    this.controls.minDistance = Math.min(this.controls.minDistance, minDistance);
    this.flight = {
      from: this.camera.position.clone(), to: pos,
      tFrom: this.controls.target.clone(), tTo: target, minDistance, t0: performance.now(),
    };
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < 640 ? 50 : 35;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (performance.now() - f.t0) / 1800);
      const k = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      // Slerp the direction and lerp the distance so the camera arcs around the Moon.
      const a = f.from.clone().normalize(), b = f.to.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(a, b);
      const dir = a.applyQuaternion(new THREE.Quaternion().slerp(q, k));
      this.camera.position.copy(dir.multiplyScalar(THREE.MathUtils.lerp(f.from.length(), f.to.length(), k)));
      this.controls.target.lerpVectors(f.tFrom, f.tTo, k);
      if (t >= 1) { this.flight = null; this.controls.minDistance = f.minDistance; }
    }
    this.controls.update();
    if ((this.frameNo = (this.frameNo ?? 0) + 1) % 8 === 0) this.updateDetail();
    this.fitShadow();
    if (this.fullLight) this.applyLight();
    this.camera.updateMatrixWorld();
    this.updatePins();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }

  updatePins() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const cam = this.camera.position;
    // Sites sit within a few degrees of the pole, so names overlap until the camera is close.
    const showNames = cam.length() < 3;
    this.polarRing.visible = this.showRing !== false && cam.length() > 1.6;
    for (const p of this.pins) {
      const d = cam.distanceTo(p.mesh.position);
      p.mesh.scale.setScalar(d * (p.site.id === this.selectedId ? 0.0026 : 0.0016));
      p.el.classList.toggle('compact', !showNames && !p.el.classList.contains('selected'));
      // Hidden behind the limb when the camera is below the pin's local horizon.
      const n = p.mesh.position.clone().normalize();
      const visible = cam.clone().sub(p.mesh.position).dot(n) > 0;
      const s = p.mesh.position.clone().project(this.camera);
      p.el.hidden = !visible || s.z > 1;
      if (!p.el.hidden) p.el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px)`;
    }
  }
}
