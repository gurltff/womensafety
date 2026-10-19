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
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.0002, 200);
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
      await this.buildPolarPatch(meta.polar);
      this.setRelief(this.relief);
      this.onTextures?.();
    }).catch(() => {});
  }

  async buildPolarPatch(meta) {
    // Heights are packed losslessly in a PNG: metres = red * 256 + green - 32768.
    const img = await new Promise((ok, fail) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = fail;
      im.src = TEX + 'polar_height.png';
    });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const heights = new Int16Array(img.width * img.height);
    for (let i = 0; i < heights.length; i++) heights[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
    const G = meta.grid, step = 2, n = Math.floor((G - 1) / step) + 1;
    const half = meta.half_m;
    const pos = new Float32Array(n * n * 3);
    this.patchData = { n, half, base: new Float32Array(n * n * 3), h: new Float32Array(n * n) };
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const k = i * n + j;
        const x = -half + (2 * half * j) / (n - 1);
        const y = half - (2 * half * i) / (n - 1);
        const rho = Math.hypot(x, y);
        const lat = (2 * Math.atan(rho / (2 * R_M))) / DEG - 90;
        const lon = Math.atan2(x, y) / DEG;
        const d = llToWorld(lat, lon, 1);
        this.patchData.base.set([d.x, d.y, d.z], k * 3);
        this.patchData.h[k] = heights[i * step * G + j * step];
      }
    }
    // Keep only the round cap inside the patch's latitude limit so it meets the sphere cleanly.
    const idx = [];
    const inside = (i, j) => Math.hypot(-half + (2 * half * j) / (n - 1), half - (2 * half * i) / (n - 1)) <= half;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        if (!(inside(i, j) && inside(i + 1, j) && inside(i, j + 1) && inside(i + 1, j + 1))) continue;
        const a = i * n + j, b = a + 1, c = a + n, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    // Plain regolith grey: photo mosaics of the pole have shadows baked in, which would fight
    // with the real-time shadows cast here by the Sun at the chosen time.
    this.patch = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8f8b84, roughness: 1, metalness: 0 }));
    this.patch.castShadow = true;
    this.patch.receiveShadow = true;
    this.scene.add(this.patch);
    this.cutY.value = Math.sin((meta.limit_lat - 0.15) * DEG);
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
    if (this.patch) {
      const { base, h } = this.patchData;
      const p = this.patch.geometry.attributes.position;
      for (let i = 0; i < h.length; i++) {
        const r = 1 + (h[i] / R_M) * k;
        p.setXYZ(i, base[i * 3] * r, base[i * 3 + 1] * r, base[i * 3 + 2] * r);
      }
      p.needsUpdate = true;
      this.patch.geometry.computeVertexNormals();
      this.patch.geometry.computeBoundingSphere();
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
    // The light sits just beyond the polar patch so its shadow camera covers the pole.
    const dir = this.fullLight ? this.camera.position.clone().normalize() : this.sunDir;
    if (!dir) return;
    this.sun.position.copy(this.sunTarget.position).addScaledVector(dir, 0.6);
    this.earthshine.intensity = this.fullLight ? 0.6 : 0.14;
  }

  // Close-up: orbit around the site, looking at it from 2 degrees equatorward and ~50 km up.
  flyTo(site) {
    const target = this.sitePoint(site);
    const cam = llToWorld(site.lat + 2.2, site.lon, 1.03 + ((site.heightM ?? 0) / R_M) * this.relief);
    this.startFlight(cam, target, 0.002);
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
