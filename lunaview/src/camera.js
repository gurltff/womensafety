// Map-style camera for the Moon, like a digital globe: it looks at a point on the ground from a
// distance, a tilt (0 = straight down) and a direction of view. Drag moves the ground under the
// cursor, right-drag (or Ctrl/Shift-drag, or two fingers) turns and tilts, the wheel zooms toward the
// cursor. Every input moves a goal and the view eases toward it, so motion is smooth, and the view
// is checked against the drawn ground every frame, so the camera never goes underground.
//
// The view direction is kept as a vector along the ground that is carried along as the target moves
// (no compass reference), so nothing flips or spins near the poles.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const R_M = 1737400;
const MAX_DIST = 9;

const tangent = (v, up) => v.clone().addScaledVector(up, -v.dot(up));

// Turn `fwd` along with a target moving from direction a to b (both unit vectors).
function carry(fwd, a, b) {
  const q = new THREE.Quaternion().setFromUnitVectors(a, b);
  const f = fwd.clone().applyQuaternion(q);
  const t = tangent(f, b);
  return t.lengthSq() > 1e-12 ? t.normalize() : anyTangent(b);
}

function anyTangent(up) {
  const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return tangent(ref, up).normalize();
}

// North along the ground at a direction; at the poles, any direction.
export function northAt(up) {
  const n = tangent(new THREE.Vector3(0, 1, 0), up);
  return n.lengthSq() > 1e-10 ? n.normalize() : anyTangent(up);
}

export class GeoCamera {
  // heightAt(dir) -> metres of the drawn ground under a unit direction; relief() -> vertical scale;
  // pick(clientX, clientY) -> unit direction of the ground under the cursor, or null.
  // minDistAt(dir) -> closest allowed distance (world units) over a spot, where the data runs out.
  constructor(camera, dom, { heightAt, relief = () => 1, pick, minDistAt = () => 0.00006 }) {
    this.camera = camera;
    this.dom = dom;
    this.heightAt = heightAt;
    this.relief = relief;
    this.pick = pick;
    this.minDistAt = minDistAt;
    const target = new THREE.Vector3(0, -0.6, 0.8).normalize();
    this.cur = { target, fwd: northAt(target), dist: 4.2, tilt: 0 };
    this.goal = this.copy(this.cur);
    this.tR = 1; // radius of the ground at the target, eased so tile loads don't jolt the view
    this.flight = null;
    this.follow = null; // { get: () => ({ dir, heading vector | null }) }
    this.spin = true; // slow turn of the globe until the first touch
    this.pointers = new Map();
    this.lastT = performance.now();
    this.listen();
  }

  copy(s) { return { target: s.target.clone(), fwd: s.fwd.clone(), dist: s.dist, tilt: s.tilt }; }

  // Steepest tilt allowed at a distance: straight down from far away, up to 82 deg near the ground.
  maxTilt(dist) {
    const f = THREE.MathUtils.clamp((Math.log(0.6) - Math.log(dist)) / (Math.log(0.6) - Math.log(0.015)), 0, 1);
    return f * 82 * DEG;
  }

  // ---------- input ----------
  listen() {
    const el = this.dom;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, mod: e.ctrlKey || e.shiftKey || e.altKey || e.metaKey });
      this.interrupt();
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        const orbit = p.button === 2 || p.button === 1 || p.mod || this.follow;
        if (orbit) this.orbit(dx, dy); else this.pan(dx, dy);
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.entries()];
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const before = { span: Math.hypot(p.x - other.x, p.y - other.y), ang: Math.atan2(p.y - other.y, p.x - other.x) };
        const after = { span: Math.hypot(e.clientX - other.x, e.clientY - other.y), ang: Math.atan2(e.clientY - other.y, e.clientX - other.x) };
        if (after.span > 10 && before.span > 10) this.zoomBy(before.span / after.span);
        this.orbit((after.ang - before.ang) / 0.006, (e.clientY - p.y) * 0.5);
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const up = (e) => { this.pointers.delete(e.pointerId); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.interrupt();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const k = Math.exp(THREE.MathUtils.clamp(px, -200, 200) * 0.0016);
      // Zoom toward the point under the cursor (unless locked onto the rover).
      if (k < 1 && !this.follow) {
        const hit = this.pick?.(e.clientX, e.clientY);
        if (hit) this.moveTarget(this.goal.target.clone().lerp(hit, 1 - k).normalize());
      }
      this.zoomBy(k);
    }, { passive: false });
  }

  interrupt() {
    this.spin = false;
    if (this.flight) { this.flight = null; this.goal = this.copy(this.cur); }
  }

  get minDist() { return this.follow ? 250 / 1737400 : this.minDistAt(this.goal.target); }

  zoomBy(k) {
    this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * k, Math.min(this.minDist, this.goal.dist), MAX_DIST);
  }

  moveTarget(to) {
    this.goal.fwd = carry(this.goal.fwd, this.goal.target, to);
    this.goal.target.copy(to);
  }

  // Drag the ground: it follows the cursor.
  pan(dx, dy) {
    const h = this.dom.clientHeight || 800;
    const perPx = (2 * this.goal.dist * Math.tan((this.camera.fov * DEG) / 2)) / h;
    const up = this.goal.target;
    const fwd = this.goal.fwd;
    const right = fwd.clone().cross(up).normalize();
    const stretch = 1 / Math.max(0.35, Math.cos(this.goal.tilt));
    const move = right.multiplyScalar(-dx * perPx).addScaledVector(fwd, dy * perPx * stretch);
    // Limit a single step so a fast drag far out can't fling the globe round.
    if (move.length() > 0.5) move.setLength(0.5);
    this.moveTarget(up.clone().add(move).normalize());
  }

  // Turn (heading) and tilt the view.
  orbit(dx, dy) {
    const q = new THREE.Quaternion().setFromAxisAngle(this.goal.target, -dx * 0.006);
    this.goal.fwd.applyQuaternion(q);
    this.goal.tilt = THREE.MathUtils.clamp(this.goal.tilt + dy * 0.005, 0, this.maxTilt(this.goal.dist));
  }

  // ---------- moves ----------

  // Fly to { target (unit vector), dist, tilt (rad), heading (deg from north, optional) }.
  flyTo({ target, dist = this.cur.dist, tilt = this.cur.tilt, heading = null, ms = 1800 }) {
    this.spin = false;
    const from = this.copy(this.cur);
    const t = target.clone().normalize();
    const fwdEnd = heading === null ? carry(from.fwd, from.target, t)
      : northAt(t).applyAxisAngle(t, -heading * DEG);
    const arc = from.target.angleTo(t);
    const peak = Math.max(from.dist, dist, Math.min(4, arc * 1.1));
    this.flight = { from, to: { target: t, fwd: tangent(fwdEnd, t).normalize(), dist: THREE.MathUtils.clamp(dist, this.minDist, MAX_DIST), tilt }, peak, t0: performance.now(), ms };
  }

  // Follow a moving point: get() returns { dir (unit vector), fwd (ground vector to face, or null) }.
  setFollow(get) {
    this.follow = get;
    if (get) this.spin = false;
  }

  // ---------- per frame ----------

  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.spin) this.moveTarget(this.goal.target.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.04));

    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.t0) / f.ms);
      const k = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      const q = new THREE.Quaternion().setFromUnitVectors(f.from.target, f.to.target);
      const target = f.from.target.clone().applyQuaternion(new THREE.Quaternion().slerp(q, k));
      // Turn the carried view direction toward the final one as the flight goes.
      const carried = carry(f.from.fwd, f.from.target, target);
      const end = carry(f.to.fwd, f.to.target, target);
      const ang = Math.atan2(carried.clone().cross(end).dot(target), carried.dot(end));
      const fwd = carried.applyAxisAngle(target, ang * k);
      // Distance: log-interpolate, rising over long hops so the Moon stays in view.
      const l0 = Math.log(f.from.dist), l1 = Math.log(f.to.dist), lp = Math.log(f.peak);
      const dist = Math.exp(THREE.MathUtils.lerp(l0, l1, k) + (lp - Math.max(l0, l1)) * Math.sin(Math.PI * k));
      this.cur = { target, fwd, dist, tilt: THREE.MathUtils.lerp(f.from.tilt, f.to.tilt, k) };
      this.goal = this.copy(this.cur);
      if (t >= 1) this.flight = null;
    } else {
      if (this.follow) {
        const g = this.follow();
        if (g?.dir) {
          this.moveTarget(g.dir.clone().normalize());
          if (g.fwd) {
            const want = tangent(g.fwd, this.goal.target).normalize();
            const ang = Math.atan2(this.goal.fwd.clone().cross(want).dot(this.goal.target), this.goal.fwd.dot(want));
            this.goal.fwd.applyAxisAngle(this.goal.target, ang * (1 - Math.exp(-dt * 1.5)));
          }
        }
      }
      // Moving off detailed ground backs the view off to where the data still looks sharp.
      if (!this.follow && this.goal.dist < this.minDist) this.goal.dist = this.minDist;
      // Ease toward the goal.
      const a = 1 - Math.exp(-dt * (this.follow ? 14 : 10));
      const c = this.cur, g = this.goal;
      const target = c.target.clone().lerp(g.target, a).normalize();
      c.fwd = carry(c.fwd, c.target, target);
      c.target = target;
      const ang = Math.atan2(c.fwd.clone().cross(g.fwd).dot(c.target), c.fwd.dot(g.fwd));
      c.fwd.applyAxisAngle(c.target, ang * a);
      c.dist = Math.exp(THREE.MathUtils.lerp(Math.log(c.dist), Math.log(g.dist), a));
      c.tilt = THREE.MathUtils.lerp(c.tilt, g.tilt, a);
    }
    // Zooming out straightens the view.
    const mt = this.maxTilt(this.cur.dist);
    if (this.cur.tilt > mt) this.cur.tilt = mt;
    if (this.goal.tilt > this.maxTilt(this.goal.dist)) this.goal.tilt = this.maxTilt(this.goal.dist);

    const rel = this.relief();
    const h = this.heightAt(this.cur.target);
    const want = 1 + (h / R_M) * rel;
    this.tR += (want - this.tR) * (Math.abs(want - this.tR) > 0.002 ? 1 : 0.25);
    this.place(rel);
  }

  // Put the camera in place, lowering the tilt (then backing off) if the ground or a hill in the
  // line of sight would be in the way.
  place(rel) {
    const c = this.cur;
    const base = c.target.clone().multiplyScalar(this.tR);
    const clearance = (12 + c.dist * R_M * 0.03) / R_M;
    let pos;
    for (let i = 0; i < 24; i++) {
      pos = this.positionFor(base, c.tilt, c.dist);
      if (!this.blocked(base, pos, rel, clearance)) break;
      if (c.tilt > 0.02) c.tilt *= 0.85;
      else c.dist *= 1.15;
    }
    if (this.goal.tilt > c.tilt + 0.05 && !this.flight) this.goal.tilt = Math.max(c.tilt, this.goal.tilt - 0.02);
    if (this.goal.dist < c.dist && !this.flight) this.goal.dist = Math.max(this.goal.dist, c.dist * 0.98);
    const back = pos.clone().sub(base).normalize();
    const camUp = tangent(c.fwd, back);
    this.camera.position.copy(pos);
    this.camera.up.copy(camUp.lengthSq() > 1e-12 ? camUp.normalize() : c.fwd);
    this.camera.lookAt(base);
    // Near and far planes follow the distance so depth stays precise from orbit down to the ground.
    const near = Math.max(1e-7, c.dist * 0.02), far = c.dist + 3;
    if (Math.abs(this.camera.near - near) > near * 0.1 || this.camera.far !== far) {
      this.camera.near = near; this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  positionFor(base, tilt, dist) {
    const up = this.cur.target;
    return base.clone().addScaledVector(up, dist * Math.cos(tilt)).addScaledVector(this.cur.fwd, -dist * Math.sin(tilt));
  }

  blocked(base, pos, rel, clearance) {
    for (const f of [1, 0.75, 0.5, 0.3]) {
      const p = base.clone().lerp(pos, f);
      const r = 1 + (this.heightAt(p) / R_M) * rel + (f === 1 ? clearance : clearance * 0.3);
      if (p.length() < r) return true;
    }
    return false;
  }

  // The point on the ground being looked at (world units).
  targetPoint() { return this.cur.target.clone().multiplyScalar(this.tR); }
}
