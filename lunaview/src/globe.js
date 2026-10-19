// 3D Moon globe: textured sphere lit by the real Sun direction, star backdrop, site pins and grid.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import fallbackTexture from './assets/moon_1024.jpg';

// Moon-fixed frame (+X lon 0, +Y lon 90E, +Z north) -> three.js world (+Y up).
// With SphereGeometry's UV layout an equirectangular map centred on lon 0 lands on +X.
export const toWorld = (v) => new THREE.Vector3(v.x, v.z, -v.y);

const DEG = Math.PI / 180;
const llToWorld = (lat, lon, r = 1) =>
  new THREE.Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), -Math.cos(lat * DEG) * Math.sin(lon * DEG)).multiplyScalar(r);

// Hi-res NASA maps if the team has run tools/fetch_textures.sh, otherwise the bundled 1k map.
const HIRES_COLOR = 'textures/lroc_color.jpg';
const HIRES_BUMP = 'textures/ldem.jpg';

export class Globe {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    this.camera.position.copy(llToWorld(-40, 8, 5.2));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.15;
    this.controls.maxDistance = 9;
    this.controls.rotateSpeed = 0.5;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.flight = null; });

    this.buildStars();
    this.buildMoon();
    this.buildGrid();
    this.buildPolarRing();

    this.sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
    this.scene.add(this.sun);
    this.earthshine = new THREE.AmbientLight(0x9ab8ff, 0.05);
    this.scene.add(this.earthshine);
    this.fullLight = false;

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
    const tex = loader.load(fallbackTexture);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.material = new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 0.7, roughness: 1, metalness: 0 });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.material);
    this.scene.add(this.moon);

    // The single-file build ships only the bundled map.
    if (import.meta.env.MODE === 'single') return;
    loader.load(HIRES_COLOR, (hi) => {
      hi.colorSpace = THREE.SRGBColorSpace;
      hi.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.material.map = hi;
      this.material.needsUpdate = true;
      this.textureSource = 'NASA LROC';
    }, undefined, () => {});
    loader.load(HIRES_BUMP, (b) => {
      this.material.bumpMap = b;
      this.material.bumpScale = 6;
      this.material.needsUpdate = true;
    }, undefined, () => {});
  }

  buildGrid() {
    const pts = [];
    const r = 1.002;
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
    for (let lon = 0; lon <= 360; lon += 2) pts.push(llToWorld(-84, lon, 1.003));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.polarRing = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf2c14e, dashSize: 0.01, gapSize: 0.008, transparent: true, opacity: 0.8 }));
    this.polarRing.computeLineDistances();
    this.scene.add(this.polarRing);
  }

  setSites(sites, selectedId) {
    this.labelLayer.textContent = '';
    for (const p of this.pins) this.scene.remove(p.mesh);
    this.pins = sites.map((s) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
      mesh.position.copy(llToWorld(s.lat, s.lon, 1.004));
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
    for (const p of this.pins) {
      const on = p.site.id === id;
      p.el.classList.toggle('selected', on);
      p.mesh.material.color.set(on ? 0xffffff : 0xf2c14e);
      p.mesh.scale.setScalar(on ? 1.6 : 1);
    }
  }

  pickAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.moon)[0];
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
      this.camera.position.copy(llToWorld(-42, lon - 35, 5.2));
    }
    this.applyLight();
  }

  setFullLight(on) {
    this.fullLight = on;
    this.applyLight();
  }

  applyLight() {
    if (this.fullLight) {
      this.sun.position.copy(this.camera.position).normalize().multiplyScalar(10);
      this.earthshine.intensity = 0.6;
    } else if (this.sunDir) {
      this.sun.position.copy(this.sunDir).multiplyScalar(10);
      this.earthshine.intensity = 0.05;
    }
  }

  flyTo(lat, lon, dist = 2.7) {
    // Look at the site from slightly equatorward so the polar terrain is seen at an angle.
    const target = llToWorld(lat + 10, lon, dist);
    this.controls.autoRotate = false;
    this.flight = { from: this.camera.position.clone(), to: target, t0: performance.now() };
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
      f.t = Math.min(1, (performance.now() - f.t0) / 1400);
      const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      // Slerp the direction and lerp the distance so the camera arcs around the Moon.
      const a = f.from.clone().normalize(), b = f.to.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(a, b);
      const dir = a.applyQuaternion(new THREE.Quaternion().slerp(q, k));
      this.camera.position.copy(dir.multiplyScalar(THREE.MathUtils.lerp(f.from.length(), f.to.length(), k)));
      if (f.t >= 1) this.flight = null;
    }
    this.controls.update();
    if (this.fullLight) this.applyLight();
    this.camera.updateMatrixWorld();
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }

  updateLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const camDir = this.camera.position.clone().normalize();
    const camDist = this.camera.position.length();
    // Sites sit within a few degrees of the pole, so names overlap until the camera is close.
    const showNames = camDist < 3;
    for (const p of this.pins) {
      p.el.classList.toggle('compact', !showNames && !p.el.classList.contains('selected'));
      const n = p.mesh.position.clone().normalize();
      // Hidden behind the limb when the pin's normal faces away from the camera.
      const visible = n.dot(camDir) > 1 / camDist + 0.02;
      const s = p.mesh.position.clone().project(this.camera);
      p.el.hidden = !visible;
      if (visible) p.el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px)`;
    }
  }
}
