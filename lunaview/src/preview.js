// A small 3D stage for the rover models: a turntable in the planner, and still thumbnails.
import * as THREE from 'three';
import { roverModel } from './models.js';

function stage(renderer) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3328, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(-3, 5, 4);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x8fb4ff, 1.0);
  rim.position.set(4, 2, -5);
  scene.add(rim);
  // A disc of grey regolith that fades out at the edge.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const grd = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  grd.addColorStop(0, 'rgba(120,116,108,0.9)');
  grd.addColorStop(0.7, 'rgba(70,68,64,0.5)');
  grd.addColorStop(1, 'rgba(40,40,40,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { scene, camera, ground };
}

// Frame a model of size { x, y, z } metres from `yaw` (radians), a little from above, so it fills
// most of the view; `lift` moves it up the frame (to clear labels along the bottom).
function frame(camera, ground, size, yaw, aspect, lift = 0.12) {
  const r = Math.hypot(size.x, size.y, size.z) / 2;
  ground.scale.setScalar(Math.max(size.x, size.z) * 0.95);
  const fit = Math.tan((camera.fov * Math.PI) / 360) * Math.min(1, aspect);
  const d = (r / fit) * 1.05;
  const el = 0.32;
  camera.aspect = aspect;
  const cy = size.y * 0.45;
  camera.position.set(Math.sin(yaw) * Math.cos(el) * d, cy + Math.sin(el) * d, Math.cos(yaw) * Math.cos(el) * d);
  camera.lookAt(0, cy - lift * 2 * r, 0);
  camera.updateProjectionMatrix();
}

export class RoverStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    Object.assign(this, stage(this.renderer));
    this.yaw = 0.9;
    this.spin = 0.35; // rad/s
    this.model = null;
    this.job = 0;
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = e.clientX; canvas.setPointerCapture(e.pointerId); this.held = true; });
    canvas.addEventListener('pointermove', (e) => { if (drag !== null) { this.yaw -= (e.clientX - drag) * 0.012; drag = e.clientX; } });
    const up = () => { drag = null; this.held = false; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      if (!this.held && this.visible()) this.yaw += ((now - last) / 1000) * this.spin;
      last = now;
      if (this.visible()) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  visible() { return this.canvas.offsetParent !== null && this.canvas.clientWidth > 0; }

  async show(id) {
    const job = ++this.job;
    const m = await roverModel(id);
    if (job !== this.job) return;
    if (this.model) this.scene.remove(this.model.object);
    this.model = m;
    this.scene.add(m.object);
  }

  draw() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) this.renderer.setSize(w, h, false);
    if (this.model) frame(this.camera, this.ground, this.model.size, this.yaw, w / h, this.lift ?? 0.12);
    this.renderer.render(this.scene, this.camera);
  }
}

// Still pictures of each rover as data URLs, drawn with one shared offscreen renderer.
let thumbs = null;
export async function thumbnail(id, w = 240, h = 150) {
  thumbs ??= (() => {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    return { canvas, renderer, ...stage(renderer) };
  })();
  const m = await roverModel(id);
  const t = thumbs;
  t.renderer.setPixelRatio(2);
  t.renderer.setSize(w, h, false);
  t.scene.add(m.object);
  frame(t.camera, t.ground, m.size, 0.85, w / h, 0);
  t.renderer.render(t.scene, t.camera);
  t.scene.remove(m.object);
  return t.canvas.toDataURL('image/png');
}
