'use strict';
/* =====================================================================
   SafeCircle India: dotted HUD globe (canvas, no libraries).
   Draws land as a dot screen, a graticule, zone "signal spikes" and arcs.
   Interactive mode: drag to rotate, hover and tap spikes.
   ===================================================================== */
const SCGlobe = (() => {
  const RAD = Math.PI/180;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const all = new Set();

  // Decode land dots once: base64 Int16 pairs [lat*10, lng*10]
  let LAND = null;
  function land(){
    if(LAND) return LAND;
    const bin = atob(window.SC_LAND_DOTS || '');
    const bytes = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ints = new Int16Array(bytes.buffer);
    const n = ints.length/2;
    LAND = {n, cosLat:new Float32Array(n), sinLat:new Float32Array(n), lng:new Float32Array(n)};
    for(let i = 0; i < n; i++){
      const la = ints[2*i]/10*RAD;
      LAND.cosLat[i] = Math.cos(la); LAND.sinLat[i] = Math.sin(la); LAND.lng[i] = ints[2*i + 1]/10*RAD;
    }
    return LAND;
  }

  class Globe{
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} o  screen: id of the screen it lives on; interactive; focus {lat,lng};
     *                    sway: oscillate around focus instead of spinning; beam: decorative signal line;
     *                    scale: radius as a share of the smaller side; onHover(spike|null, x, y); onPick(spike)
     */
    constructor(canvas, o = {}){
      this.c = canvas; this.ctx = canvas.getContext('2d'); this.o = o;
      this.lng0 = (o.focus ? o.focus.lng : 80)*RAD; this.lat0 = (o.focus ? o.focus.lat : 18)*RAD;
      this.baseLng = this.lng0;
      this.spikes = []; this.arcFrom = null;
      this.vel = 0; this.drag = null; this.idleAt = 0; this.hover = null;
      this.running = false; this.t0 = performance.now();
      this.resize = this.resize.bind(this); this.frame = this.frame.bind(this);
      if('ResizeObserver' in window) new ResizeObserver(this.resize).observe(canvas);
      else window.addEventListener('resize', this.resize);
      if(o.interactive) this.bindPointer();
      all.add(this);
      this.resize();
    }
    setSpikes(list, arcFrom){ this.spikes = list; this.arcFrom = arcFrom || null; if(!this.running) this.draw(performance.now()); }
    setFocus(lat, lng){ this.lat0 = lat*RAD; this.lng0 = this.baseLng = lng*RAD; }
    resize(){
      const r = this.c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = r.width; this.h = r.height; this.dpr = dpr;
      if(!r.width || !r.height) return;
      this.c.width = Math.round(r.width*dpr); this.c.height = Math.round(r.height*dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if(!this.running) this.draw(performance.now());
    }
    visible(){
      if(document.hidden) return false;
      if(this.o.screen){ const s = document.getElementById(this.o.screen); if(!s || !s.classList.contains('active')) return false; }
      return this.c.offsetParent !== null;
    }
    start(){
      if(this.running) return;
      if(!this.visible()) return;
      this.running = true;
      if(this.w === 0) this.resize();
      requestAnimationFrame(this.frame);
    }
    stop(){ this.running = false; }
    frame(now){
      if(!this.running) return;
      if(!this.visible()){ this.running = false; return; }
      this.step(now);
      this.draw(now);
      if(REDUCED && !this.drag && !this.vel){ this.running = false; return; } // static unless dragging
      requestAnimationFrame(this.frame);
    }
    step(now){
      if(this.drag) return;
      if(Math.abs(this.vel) > .00005){ this.lng0 += this.vel; this.vel *= .94; return; }
      this.vel = 0;
      if(REDUCED || now - this.idleAt < 2500) return;
      if(this.o.sway){
        const t = (now - this.t0)/1000;
        this.lng0 += ((this.baseLng + Math.sin(t*.18)*.55) - this.lng0)*.02;
      }else this.lng0 += .0016;
    }
    /** Rotated unit vector for lat/lng (radians). */
    rot(cosLat, sinLat, lng){
      const d = lng - this.lng0, cl0 = Math.cos(this.lat0), sl0 = Math.sin(this.lat0);
      const x = cosLat*Math.sin(d), y = sinLat, z = cosLat*Math.cos(d);
      return [x, y*cl0 - z*sl0, y*sl0 + z*cl0];
    }
    rotLL(lat, lng){ return this.rot(Math.cos(lat*RAD), Math.sin(lat*RAD), lng*RAD); }
    geom(){
      const s = this.o.scale || .4;
      const R = Math.min(this.w, this.h)*s;
      const cx = this.w*(this.o.cx ?? .5), cy = this.h*(this.o.cy ?? .5);
      return {R, cx, cy};
    }
    draw(now){
      const ctx = this.ctx, {w, h} = this;
      if(!w || !h) return;
      const {R, cx, cy} = this.geom();
      const t = (now - this.t0)/1000;
      ctx.clearRect(0, 0, w, h);

      // atmosphere + limb
      const g = ctx.createRadialGradient(cx, cy, R*.92, cx, cy, R*1.22);
      g.addColorStop(0, 'rgba(255,255,255,.07)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R*1.22, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(8,8,8,.92)'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.32)'; ctx.lineWidth = 1; ctx.stroke();

      // outer HUD ring with ticks
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.beginPath(); ctx.arc(cx, cy, R*1.12, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath();
      for(let a = 0; a < 360; a += 5){
        const r1 = R*1.12, r2 = R*(a % 30 === 0 ? 1.16 : 1.135), ar = a*RAD + t*.05;
        ctx.moveTo(cx + Math.cos(ar)*r1, cy + Math.sin(ar)*r1); ctx.lineTo(cx + Math.cos(ar)*r2, cy + Math.sin(ar)*r2);
      }
      ctx.stroke(); ctx.restore();

      // graticule
      ctx.lineWidth = .8;
      ctx.strokeStyle = 'rgba(255,255,255,.1)';
      ctx.beginPath();
      for(let lng = -180; lng < 180; lng += 20) this.path(ctx, cx, cy, R, la => [la, lng], -80, 80, 4);
      for(let lat = -60; lat <= 60; lat += 30) this.path(ctx, cx, cy, R, ln => [lat, ln], -180, 180, 4);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.beginPath(); this.path(ctx, cx, cy, R, ln => [0, ln], -180, 180, 3); ctx.stroke();

      // land dots, bucketed by depth so we change fillStyle only a few times
      const L = land(), scanY = Math.sin(t*.45)*.85;
      const ds = Math.min(2.4, Math.max(1.1, R/150));
      const buckets = [[], [], [], [], []];
      for(let i = 0; i < L.n; i++){
        const [x, y, z] = this.rot(L.cosLat[i], L.sinLat[i], L.lng[i]);
        if(z <= 0) continue;
        let b = z > .75 ? 3 : z > .45 ? 2 : z > .2 ? 1 : 0;
        if(!REDUCED && Math.abs(y - scanY) < .035) b = 4;
        buckets[b].push(cx + x*R, cy - y*R);
      }
      const alphas = [.22, .38, .58, .78, 1];
      buckets.forEach((pts, b) => {
        ctx.fillStyle = b === 4 ? 'rgba(255,170,100,.95)' : `rgba(235,235,235,${alphas[b]})`;
        for(let k = 0; k < pts.length; k += 2) ctx.fillRect(pts[k] - ds/2, pts[k+1] - ds/2, ds, ds);
      });

      // arcs from the focus city to flagged zones
      if(this.arcFrom){
        ctx.save();
        ctx.lineWidth = 1.1;
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = REDUCED ? 0 : -t*14;
        ctx.strokeStyle = 'rgba(255,138,43,.6)';
        this.spikes.forEach(s => { if(s.id !== this.arcFrom.id && s.level !== 'green') this.arc(ctx, cx, cy, R, this.arcFrom, s); });
        ctx.restore();
      }

      // spikes
      this.hits = [];
      const ordered = [...this.spikes].sort((a, b) => a.h - b.h);
      ordered.forEach(s => {
        const [x, y, z] = this.rotLL(s.lat, s.lng);
        if(z <= .02) return;
        const k = 1 + .06 + s.h*(this.o.spike || .3);
        const bx = cx + x*R, by = cy - y*R, tx = cx + x*R*k, ty = cy - y*R*k;
        const hov = this.hover && this.hover.id === s.id;
        const lg = ctx.createLinearGradient(bx, by, tx, ty);
        lg.addColorStop(0, s.color); lg.addColorStop(1, 'rgba(255,255,255,.0)');
        ctx.strokeStyle = lg; ctx.lineWidth = hov ? 3 : 2;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
        const pulse = REDUCED ? 0 : (t*.8 + s.h) % 1;
        ctx.strokeStyle = s.color; ctx.globalAlpha = (1 - pulse)*.8*z; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bx, by, 3 + pulse*12*(.6 + s.h), 0, Math.PI*2); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(bx, by, hov ? 4.5 : 3, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(tx, ty, hov ? 2.4 : 1.4, 0, Math.PI*2); ctx.fill();
        this.hits.push({s, bx, by, tx, ty, hov});
      });
      // labels last, tallest first, skipping any that would overlap one already drawn
      if(this.o.labels || this.hover){
        ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
        const boxes = [];
        [...this.hits].sort((a, b) => (b.hov - a.hov) || (b.s.h - a.s.h)).forEach(hh => {
          if(!this.o.labels && !hh.hov) return;
          const text = hh.s.code || hh.s.label, tw = ctx.measureText(text).width;
          const box = [hh.tx + 5, hh.ty - 12, hh.tx + 9 + tw, hh.ty + 2];
          if(boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
          boxes.push(box);
          ctx.fillStyle = hh.hov ? '#fff' : 'rgba(255,255,255,.75)';
          ctx.fillText(text, hh.tx + 5, hh.ty - 3);
        });
      }

      // decorative beam (hero only)
      if(this.o.beam){
        const d = this.spikes.find(s => s.id === this.o.beam);
        if(d){
          const [x, y, z] = this.rotLL(d.lat, d.lng);
          if(z > .1){
            const k = 1.4, tx = cx + x*R*k, ty = cy - y*R*k;
            const lg = ctx.createLinearGradient(tx, ty, w, 0);
            lg.addColorStop(0, 'rgba(255,59,78,.9)'); lg.addColorStop(1, 'rgba(255,59,78,0)');
            ctx.strokeStyle = lg; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(cx + x*R, cy - y*R); ctx.lineTo(w*.98, h*.02); ctx.stroke();
          }
        }
      }
    }
    /** Adds a front-hemisphere polyline for f(v) -> [lat, lng], v from a to b. */
    path(ctx, cx, cy, R, f, a, b, step){
      let pen = false;
      for(let v = a; v <= b; v += step){
        const [la, ln] = f(v);
        const [x, y, z] = this.rotLL(la, ln);
        if(z > 0){ pen ? ctx.lineTo(cx + x*R, cy - y*R) : ctx.moveTo(cx + x*R, cy - y*R); pen = true; }
        else pen = false;
      }
    }
    /** Lifted great-circle arc between two {lat,lng}. */
    arc(ctx, cx, cy, R, A, B){
      const v = (p) => { const la = p.lat*RAD, ln = p.lng*RAD; return [Math.cos(la)*Math.cos(ln), Math.sin(la), Math.cos(la)*Math.sin(ln)]; };
      const a = v(A), b = v(B);
      const dot = Math.min(1, Math.max(-1, a[0]*b[0] + a[1]*b[1] + a[2]*b[2])), om = Math.acos(dot);
      if(om < 1e-4) return;
      ctx.beginPath();
      let pen = false;
      for(let i = 0; i <= 32; i++){
        const f = i/32, s1 = Math.sin((1 - f)*om)/Math.sin(om), s2 = Math.sin(f*om)/Math.sin(om);
        const p = [a[0]*s1 + b[0]*s2, a[1]*s1 + b[1]*s2, a[2]*s1 + b[2]*s2];
        const lat = Math.asin(p[1])/RAD, lng = Math.atan2(p[2], p[0])/RAD;
        const lift = 1 + Math.sin(f*Math.PI)*Math.min(.25, om*.35);
        const [x, y, z] = this.rotLL(lat, lng);
        if(z > 0){ const X = cx + x*R*lift, Y = cy - y*R*lift; pen ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); pen = true; }
        else pen = false;
      }
      ctx.stroke();
    }
    pick(px, py){
      let best = null, bd = 22;
      (this.hits || []).forEach(hh => {
        // distance from point to the spike segment
        const dx = hh.tx - hh.bx, dy = hh.ty - hh.by, l2 = dx*dx + dy*dy || 1;
        const u = Math.max(0, Math.min(1, ((px - hh.bx)*dx + (py - hh.by)*dy)/l2));
        const d = Math.hypot(px - (hh.bx + u*dx), py - (hh.by + u*dy));
        if(d < bd){ bd = d; best = hh; }
      });
      return best;
    }
    bindPointer(){
      const c = this.c;
      let downX = 0, downY = 0, moved = false, lastX = 0, lastT = 0;
      c.addEventListener('pointerdown', e => {
        this.drag = {x:e.clientX, y:e.clientY, lng:this.lng0, lat:this.lat0};
        downX = lastX = e.clientX; downY = e.clientY; lastT = performance.now(); moved = false; this.vel = 0;
        c.setPointerCapture && c.setPointerCapture(e.pointerId);
        this.start();
      });
      c.addEventListener('pointermove', e => {
        const r = c.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        if(this.drag){
          const {R} = this.geom();
          const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
          if(Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
          this.lng0 = this.drag.lng - dx/R;
          this.lat0 = Math.max(-1.1, Math.min(1.1, this.drag.lat + dy/R));
          const now = performance.now();
          this.vel = -(e.clientX - lastX)/R*Math.min(1, 16/Math.max(1, now - lastT));
          lastX = e.clientX; lastT = now;
          this.idleAt = now;
          if(REDUCED) this.draw(now);
          return;
        }
        const hit = this.pick(px, py);
        const s = hit ? hit.s : null;
        if((s && s.id) !== (this.hover && this.hover.id)){
          this.hover = s;
          c.style.cursor = s ? 'pointer' : 'grab';
          if(!this.running) this.draw(performance.now());
        }
        this.o.onHover && this.o.onHover(s, hit ? hit.tx : 0, hit ? hit.ty : 0);
      });
      const end = e => {
        if(!this.drag) return;
        this.drag = null; this.idleAt = performance.now();
        if(!moved && e.type === 'pointerup'){
          const r = c.getBoundingClientRect();
          const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
          if(hit && this.o.onPick) this.o.onPick(hit.s);
        }
        this.start();
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => { if(!this.drag && this.hover){ this.hover = null; this.o.onHover && this.o.onHover(null); } });
      c.addEventListener('keydown', e => {
        const k = {ArrowLeft:-.12, ArrowRight:.12}[e.key];
        if(k){ e.preventDefault(); this.lng0 += k; this.idleAt = performance.now(); this.draw(performance.now()); }
      });
    }
  }
  /** Start globes on the active screen, stop the rest. Called on screen change. */
  function sync(){ all.forEach(g => g.visible() ? g.start() : g.stop()); }
  document.addEventListener('visibilitychange', sync);
  return {Globe, sync};
})();
