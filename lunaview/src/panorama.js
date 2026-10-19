// "Stand on the Moon": a 360-degree sky strip seen from the landing site, with the skyline,
// the Sun and the Earth (drawn at its real phase) and their paths over the mission.
const DEG = Math.PI / 180;

export class Panorama {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.centerAz = 180;
    this.span = 120; // degrees of azimuth across the screen
    this.vScale = 3; // vertical stretch so a 2-degree Sun height is readable
    this.horizon = null;
    this.track = [];
    this.state = null;
    this.stars = Array.from({ length: 700 }, (_, i) => {
      const r = Math.sin(i * 12.9898) * 43758.5453;
      const r2 = Math.sin(i * 78.233) * 12345.678;
      return { az: (r - Math.floor(r)) * 360, el: 1 + (r2 - Math.floor(r2)) * 40, b: Math.pow((i * 0.618) % 1, 3) };
    });
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, az: this.centerAz }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pxPerDeg = canvas.clientWidth / this.span;
      this.centerAz = (((drag.az - (e.clientX - drag.x) / pxPerDeg) % 360) + 360) % 360;
      this.draw();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.span = Math.max(40, Math.min(360, this.span * (e.deltaY > 0 ? 1.1 : 0.9)));
      this.draw();
    }, { passive: false });
    window.addEventListener('resize', () => this.draw());
  }

  set({ horizon, track, state }) {
    if (horizon !== undefined) this.horizon = horizon;
    if (track) this.track = track;
    if (state) this.state = state;
    this.draw();
  }

  lookAt(az) {
    this.centerAz = az;
    this.draw();
  }

  hz(az) {
    if (!this.horizon) return 0;
    const n = this.horizon.length, f = (((az % 360) + 360) % 360) / 360 * n;
    const i = Math.floor(f) % n, t = f - Math.floor(f);
    return this.horizon[i] * (1 - t) + this.horizon[(i + 1) % n] * t;
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pxPerDeg = W / this.span;
    const baseY = H * 0.6; // where elevation 0 sits
    const x = (az) => { let d = ((az - this.centerAz + 540) % 360) - 180; return W / 2 + d * pxPerDeg; };
    const y = (el) => baseY - el * pxPerDeg * this.vScale;

    // Sky: black with a faint glow toward the Sun when it is up.
    ctx.fillStyle = '#04060b';
    ctx.fillRect(0, 0, W, H);
    const st = this.state;
    if (st && st.sun.el > -1) {
      const g = ctx.createRadialGradient(x(st.sun.az), y(st.sun.el), 0, x(st.sun.az), y(st.sun.el), pxPerDeg * 25);
      g.addColorStop(0, 'rgba(255,220,150,0.18)');
      g.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    for (const s of this.stars) {
      const sx = x(s.az), sy = y(s.el);
      if (sx < 0 || sx > W || sy < 0) continue;
      ctx.fillStyle = `rgba(220,230,255,${0.25 + s.b * 0.7})`;
      ctx.fillRect(sx, sy, s.b > 0.6 ? 1.6 : 1, s.b > 0.6 ? 1.6 : 1);
    }

    // Elevation guide lines.
    ctx.strokeStyle = 'rgba(140,170,220,0.12)';
    ctx.fillStyle = 'rgba(160,180,220,0.55)';
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (let el = 2; el <= 12; el += 2) {
      const yy = y(el);
      if (yy < 10) break;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
      ctx.fillText(`${el}°`, 8, yy - 3);
    }

    // Sun and Earth paths over the mission.
    const path = (key, color) => {
      ctx.strokeStyle = color;
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let prev = null;
      for (const p of this.track) {
        const px = x(p[key + 'Az']), py = y(p[key + 'El']);
        if (prev && Math.abs(px - prev) < W / 2) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        prev = px;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    path('sun', 'rgba(242,193,78,0.45)');
    path('earth', 'rgba(110,170,255,0.45)');

    // Bodies.
    if (st) {
      const sunR = Math.max(5, 0.265 * pxPerDeg * this.vScale);
      const sx = x(st.sun.az), sy = y(st.sun.el);
      const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, sunR * 5);
      halo.addColorStop(0, 'rgba(255,240,200,0.9)');
      halo.addColorStop(0.25, 'rgba(255,210,120,0.35)');
      halo.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(sx, sy, sunR * 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff6dc';
      ctx.beginPath(); ctx.arc(sx, sy, sunR, 0, Math.PI * 2); ctx.fill();

      const er = Math.max(7, 0.95 * pxPerDeg * this.vScale);
      const ex = x(st.earth.az), ey = y(st.earth.el);
      ctx.fillStyle = '#0c1a33';
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
      // Lit part: a terminator ellipse on the side facing the Sun.
      const toSun = Math.sign(((st.sun.az - st.earth.az + 540) % 360) - 180) || 1;
      const k = 1 - 2 * st.earthLit; // +1 new, -1 full
      ctx.fillStyle = '#6fb2ff';
      ctx.beginPath();
      if (toSun > 0) ctx.arc(ex, ey, er, -Math.PI / 2, Math.PI / 2);
      else ctx.arc(ex, ey, er, Math.PI / 2, (3 * Math.PI) / 2);
      ctx.fill();
      // Crescent: cover the middle with shadow. Gibbous: extend the light past the middle.
      ctx.fillStyle = k > 0 ? '#0c1a33' : '#6fb2ff';
      ctx.beginPath(); ctx.ellipse(ex, ey, Math.abs(k) * er, er, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(140,190,255,0.6)';
      ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.stroke();
    }

    // Ground and skyline (drawn last so it hides anything below the horizon).
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let px = 0; px <= W; px += 2) {
      const az = this.centerAz + (px - W / 2) / pxPerDeg;
      ctx.lineTo(px, y(this.hz(az)));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    const ground = ctx.createLinearGradient(0, baseY - 40, 0, H);
    ground.addColorStop(0, '#2a2c33');
    ground.addColorStop(1, '#0d0e12');
    ctx.fillStyle = ground;
    ctx.fill();
    ctx.strokeStyle = st && st.sunlit ? 'rgba(255,214,140,0.85)' : 'rgba(170,180,200,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Compass.
    ctx.fillStyle = 'rgba(230,236,250,0.85)';
    ctx.font = '600 13px "Saira Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let az = 0; az < 360; az += 15) {
      const px = x(az);
      if (px < -20 || px > W + 20) continue;
      // Labels ride just under the skyline so the controls at the bottom never cover them.
      const gy = y(this.hz(az));
      ctx.fillRect(px - 0.5, gy + 4, 1, names[az] ? 8 : 4);
      ctx.fillText(names[az] ?? `${az}°`, px, gy + 26);
    }
    ctx.textAlign = 'left';
  }
}
