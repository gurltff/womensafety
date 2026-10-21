// Standing on the Moon: look around (drag), zoom the field of view (wheel), with the real ground
// in front of the real sky. Uses the globe's renderer and canvas while it is active.
import * as THREE from 'three';
import { Landscape } from './landscape.js';

const DEG = Math.PI / 180;

export const dirOf = (alt, az) => new THREE.Vector3(Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG), -Math.cos(alt * DEG) * Math.cos(az * DEG));
export const altAzOf = (v) => {
  const u = v.clone().normalize();
  let az = Math.atan2(u.x, -u.z) / DEG;
  if (az < 0) az += 360;
  return { alt: Math.asin(Math.max(-1, Math.min(1, u.y))) / DEG, az };
};

export class SurfaceView {
  constructor(globe, sky) {
    this.globe = globe;
    this.sky = sky;
    this.renderer = globe.renderer;
    this.canvas = globe.canvas;
    this.scene = new THREE.Scene();
    this.landscape = new Landscape(this.scene);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 400000);
    this.view = { az: 180, alt: 15, fov: 60 };
    this.goal = { ...this.view };
    this.showGround = true;
    this.active = false;
    this.listen();
  }

  listen() {
    const el = this.canvas;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      this.flight = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.active || !drag) return;
      const k = this.view.fov / (el.clientHeight || 800);
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      // Grab the sky: it follows the pointer.
      this.goal.az = this.view.az = (this.view.az - dx * k * 1.0 / Math.max(0.2, Math.cos(this.view.alt * DEG)) + 360) % 360;
      this.goal.alt = this.view.alt = Math.max(-89.9, Math.min(89.9, this.view.alt + dy * k));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const up = (e) => {
      if (!this.active || !drag) return;
      if (drag.moved < 5 && e.button === 0) this.onClick?.(e.clientX, e.clientY);
      drag = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', () => { drag = null; });
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoom(Math.exp(Math.max(-200, Math.min(200, px)) * 0.0012));
    }, { passive: false });
  }

  zoom(k) { this.goal.fov = Math.max(0.3, Math.min(140, this.goal.fov * k)); }

  // Turn smoothly to look at (alt, az), optionally to a field of view.
  lookAt(alt, az, fov) {
    this.flight = { from: { ...this.view }, to: { alt, az, fov: fov ?? this.view.fov }, t0: performance.now() };
  }

  setActive(on) {
    this.active = on;
    this.globe.override = on ? () => this.frame() : null;
    this.globe.cam.enabled = !on;
  }

  update() {
    if (this.flight) {
      const f = this.flight, t = Math.min(1, (performance.now() - f.t0) / 1200), k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const daz = ((f.to.az - f.from.az + 540) % 360) - 180;
      this.view.az = (f.from.az + daz * k + 360) % 360;
      this.view.alt = f.from.alt + (f.to.alt - f.from.alt) * k;
      this.view.fov = Math.exp(Math.log(f.from.fov) + (Math.log(f.to.fov) - Math.log(f.from.fov)) * k);
      this.goal = { ...this.view };
      if (t >= 1) this.flight = null;
    } else {
      this.view.fov += (this.goal.fov - this.view.fov) * 0.25;
    }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.camera.aspect = w / h;
    this.camera.fov = this.view.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(dirOf(this.view.alt, this.view.az));
    this.camera.updateMatrixWorld();
  }

  frame() {
    this.onFrame?.();
    this.update();
    const r = this.renderer;
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    r.clear();
    this.sky.render(r, this.camera);
    r.clearDepth();
    if (this.showGround) r.render(this.scene, this.camera);
    r.autoClear = true;
    this.afterFrame?.();
  }

  // Screen position (CSS px) of a view-frame direction, or null if behind the camera.
  screenOf(v) {
    const p = v.clone().multiplyScalar(1000).project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }

  // View-frame direction under a screen point.
  dirAt(x, y) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return new THREE.Vector3((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5).unproject(this.camera).normalize();
  }
}
