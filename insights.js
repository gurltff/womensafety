'use strict';
/* =====================================================================
   SafeCircle India: visuals.
   - Hero: auto-swaying globe + live HUD readouts on the sign-in screen
   - Insights screen: interactive globe, NCRB trend, city signal bars,
     community report heatmap and categories. Every chart has a table view.
   ===================================================================== */

/* NCRB Crime in India: rape cases registered per year (sums to 2,99,520 for 2014–2022) */
const NCRB_RAPE = [[2014, 36735], [2015, 34651], [2016, 38947], [2017, 32559], [2018, 33356], [2019, 32033], [2020, 28046], [2021, 31677], [2022, 31516]];
const HEAT_RAMP = ['#6A3A16', '#93501A', '#BC661E', '#E37D25', '#FFA04F']; // validated sequential ramp (dark surface)
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TODS = ['morning', 'afternoon', 'evening', 'night'];
const fmtIN = n => Math.round(n).toLocaleString('en-IN');
const zoneCode = z => z.name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();

function zoneSpikes(){
  return ZONES.map(z => {
    const sig = zoneSignal(z);
    return {id:z.id, lat:z.lat, lng:z.lng, h:sig.score/100, level:sig.level, color:LEVEL_COLOR[sig.level], code:zoneCode(z), label:z.name};
  });
}
function arcOrigin(){
  if(state.center){
    const near = [...ZONES].sort((a, b) => distanceMeters(state.center, a) - distanceMeters(state.center, b))[0];
    if(near && distanceMeters(state.center, near) < 300000) return near;
  }
  return ZONE_BY_ID.delhi || ZONES[0];
}

/* ===================== HERO (sign-in screen) ===================== */
let heroGlobe = null;
function initHero(){
  const c = $('hero-globe');
  if(!c || heroGlobe) return;
  // A close-up "horizon" view: a big globe, centred a little south of India so India sits mid-frame.
  const wide = () => window.matchMedia('(min-width:768px)').matches;
  const fit = g => Object.assign(g.o, wide() ? {scale:.6, cy:.64} : {scale:.86, cy:.94});
  heroGlobe = new SCGlobe.Globe(c, {screen:'screen-auth', focus:{lat:-3, lng:80}, sway:true, labels:true, beam:'delhi', spike:.16, cx:.5});
  fit(heroGlobe);
  heroGlobe.setSpikes(zoneSpikes(), arcOrigin());
  window.addEventListener('resize', () => fit(heroGlobe));
  // ticker of city codes + scores, like a terminal status bar
  const tk = $('hero-ticker');
  tk.innerHTML = '';
  ZONES.forEach(z => {
    const sig = zoneSignal(z);
    const s = document.createElement('span');
    s.innerHTML = '<i></i><b></b><em></em>';
    s.querySelector('i').style.background = LEVEL_COLOR[sig.level];
    s.querySelector('b').textContent = zoneCode(z);
    s.querySelector('em').textContent = String(sig.score).padStart(2, '0');
    tk.appendChild(s);
  });
  const clock = () => {
    const now = new Date();
    $('hero-clock').textContent = 'IST ' + now.toLocaleTimeString('en-GB', {timeZone:'Asia/Kolkata', hour12:false});
    $('hero-date').textContent = now.toLocaleDateString('en-GB', {timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric'}).toUpperCase();
  };
  clock();
  setInterval(() => { if(currentScreen === 'auth') clock(); }, 1000);
  SCGlobe.sync();
}

/* ===================== INSIGHTS ===================== */
let insGlobe = null;
const tip = $('ins-tip');
function showTip(value, label, x, y){
  tip.querySelector('b').textContent = value;
  tip.querySelector('span').textContent = label;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width/2));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function hideTip(){ tip.hidden = true; }

function initInsights(){
  const c = $('ins-globe');
  insGlobe = new SCGlobe.Globe(c, {
    screen:'screen-insights', interactive:true, focus:{lat:18, lng:79}, sway:true, scale:.43, spike:.24,
    onHover:(s, x, y) => {
      if(!s){ hideTip(); return; }
      const z = ZONE_BY_ID[s.id], r = c.getBoundingClientRect(), sig = zoneSignal(z);
      showTip(sig.score + '/100', `${z.name} · ${LEVEL_LABEL[sig.level]} · tap to open`, r.left + x, r.top + y);
    },
    onPick:s => { hideTip(); openZoneSheet(s.id); }
  });
  document.querySelectorAll('[data-table-toggle]').forEach(b => b.addEventListener('click', () => {
    const panel = b.closest('.panel');
    const on = panel.classList.toggle('show-table');
    b.textContent = on ? 'Chart' : 'Table';
    b.setAttribute('aria-pressed', String(on));
  }));
  if('ResizeObserver' in window){
    let lastW = 0;
    new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width);
      if(w && w !== lastW){ lastW = w; if(currentScreen === 'insights') renderTrend(); }
    }).observe($('chart-trend'));
  }
  $('screen-insights').querySelector('.scroll').addEventListener('scroll', hideTip, {passive:true});
}

function renderInsights(){
  if(!insGlobe) return;
  insGlobe.setSpikes(zoneSpikes(), arcOrigin());
  SCGlobe.sync();
  renderKpis();
  renderTrend();
  renderCities();
  renderHeat();
  renderCats();
}
function refreshVisuals(){
  if(heroGlobe) heroGlobe.setSpikes(zoneSpikes(), arcOrigin());
  if(currentScreen === 'insights') renderInsights();
}

function renderKpis(){
  const sigs = ZONES.map(zoneSignal);
  const high = sigs.filter(s => s.level === 'red').length;
  const reports = allReports().filter(r => Date.now() - r.ts < 180*DAY);
  const shared = reports.filter(r => r.shared).length;
  const last = NCRB_RAPE[NCRB_RAPE.length - 1], prev = NCRB_RAPE[NCRB_RAPE.length - 2];
  const delta = (last[1] - prev[1])/prev[1]*100;
  $('kpi-cases').textContent = fmtIN(last[1]);
  $('kpi-cases-sub').textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}% vs ${prev[0]} · NCRB ${last[0]}`;
  $('kpi-high').textContent = `${high} of ${ZONES.length}`;
  $('kpi-reports').textContent = fmtIN(reports.length);
  $('kpi-reports-sub').textContent = shared ? `${shared} shared by others · last 180 days` : 'on this device · last 180 days';
}

/* ---------- B: NCRB trend (single series: line + 10% area, crosshair) ---------- */
function svgEl(tag, attrs = {}, parent){
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  if(parent) parent.appendChild(el);
  return el;
}
function renderTrend(){
  const host = $('chart-trend');
  const W = Math.max(280, host.clientWidth || 600), H = 230;
  const m = {l:52, r:58, t:26, b:30};
  const n = NCRB_RAPE.length, yMax = 40000, ticks = [0, 10000, 20000, 30000, 40000];
  const xs = i => m.l + i*(W - m.l - m.r)/(n - 1);
  const ys = v => m.t + (1 - v/yMax)*(H - m.t - m.b);
  host.innerHTML = '';
  const svg = svgEl('svg', {width:W, height:H, viewBox:`0 0 ${W} ${H}`, class:'chart-svg', tabindex:'0', role:'img',
    'aria-label':'Line chart of rape cases registered in India per year, 2014 to 2022, from NCRB. Use the arrow keys to read each year.'}, host);
  ticks.forEach(t => {
    svgEl('line', {x1:m.l, x2:W - m.r, y1:ys(t), y2:ys(t), class:'grid'}, svg);
    svgEl('text', {x:m.l - 8, y:ys(t) + 4, 'text-anchor':'end', class:'axis'}, svg).textContent = fmtIN(t);
  });
  NCRB_RAPE.forEach(([yr], i) => {
    if(W < 440 && i % 2) return;
    svgEl('text', {x:xs(i), y:H - 8, 'text-anchor':'middle', class:'axis'}, svg).textContent = yr;
  });
  const pts = NCRB_RAPE.map(([, v], i) => [xs(i), ys(v)]);
  svgEl('path', {d:`M${pts.map(p => p.join(',')).join('L')}L${xs(n - 1)},${ys(0)}L${xs(0)},${ys(0)}Z`, class:'area'}, svg);
  svgEl('path', {d:'M' + pts.map(p => p.join(',')).join('L'), class:'line'}, svg);
  // selective labels: the peak and the latest year
  const peakI = NCRB_RAPE.reduce((b, d, i) => d[1] > NCRB_RAPE[b][1] ? i : b, 0);
  [[peakI, `Peak ${fmtIN(NCRB_RAPE[peakI][1])}`, 'middle', 0, -12], [n - 1, fmtIN(NCRB_RAPE[n - 1][1]), 'start', 9, 4]].forEach(([i, label, anchor, dx, dy]) => {
    svgEl('circle', {cx:pts[i][0], cy:pts[i][1], r:4, class:'dot'}, svg);
    svgEl('text', {x:pts[i][0] + dx, y:pts[i][1] + dy, 'text-anchor':anchor, class:'label'}, svg).textContent = label;
  });
  const cross = svgEl('g', {class:'cross', visibility:'hidden'}, svg);
  const cl = svgEl('line', {y1:m.t - 6, y2:H - m.b, class:'cross-line'}, cross);
  const cd = svgEl('circle', {r:5, class:'dot hover'}, cross);
  const hit = svgEl('rect', {x:m.l - 20, y:0, width:W - m.l - m.r + 40, height:H, fill:'transparent'}, svg);
  let cur = -1;
  const show = i => {
    cur = Math.max(0, Math.min(n - 1, i));
    const [x, y] = pts[cur];
    cross.setAttribute('visibility', 'visible');
    cl.setAttribute('x1', x); cl.setAttribute('x2', x); cd.setAttribute('cx', x); cd.setAttribute('cy', y);
    const r = svg.getBoundingClientRect();
    showTip(fmtIN(NCRB_RAPE[cur][1]), `${NCRB_RAPE[cur][0]} · rape cases registered`, r.left + x, r.top + y);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); hideTip(); };
  hit.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
    show(Math.round((x - m.l)/((W - m.l - m.r)/(n - 1))));
  });
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(cur < 0 ? n - 1 : cur));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', e => {
    if(e.key === 'ArrowLeft' || e.key === 'ArrowRight'){ e.preventDefault(); show(cur + (e.key === 'ArrowRight' ? 1 : -1)); }
  });
  // table view
  const tb = $('table-trend');
  tb.innerHTML = '<thead><tr><th>Year</th><th>Rape cases registered</th></tr></thead><tbody></tbody>';
  NCRB_RAPE.forEach(([yr, v]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td>';
    tr.children[0].textContent = yr; tr.children[1].textContent = fmtIN(v);
    tb.tBodies[0].appendChild(tr);
  });
}

/* ---------- C: city signal bars (status colour + text label) ---------- */
function renderCities(){
  const host = $('chart-cities');
  host.innerHTML = '';
  const tb = $('table-cities');
  tb.innerHTML = '<thead><tr><th>City</th><th>Signal</th><th>Level</th><th>NCRB baseline</th><th>Reports</th></tr></thead><tbody></tbody>';
  ZONES.map(z => ({z, sig:zoneSignal(z)})).sort((a, b) => b.sig.score - a.sig.score).forEach(({z, sig}) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bar-row';
    b.innerHTML = '<span class="bar-name"></span><span class="bar-track"><i></i></span><span class="bar-val"></span><span class="bar-lvl"><i></i><em></em></span>';
    b.querySelector('.bar-name').textContent = z.name;
    const fill = b.querySelector('.bar-track i');
    fill.style.width = Math.max(2, sig.score) + '%'; fill.style.background = LEVEL_COLOR[sig.level];
    b.querySelector('.bar-val').textContent = sig.score;
    b.querySelector('.bar-lvl i').style.background = LEVEL_COLOR[sig.level];
    b.querySelector('.bar-lvl em').textContent = SEV_LABEL[sig.level];
    b.setAttribute('aria-label', `${z.name}: signal ${sig.score} out of 100, ${LEVEL_LABEL[sig.level]}. Open on map.`);
    const tipOn = () => { const r = fill.getBoundingClientRect(); showTip(sig.score + '/100', `${z.name} · ${sig.evidence} recent report${sig.evidence === 1 ? '' : 's'} · baseline ${SEV_LABEL[z.level].toLowerCase()}`, r.right, r.top); };
    b.addEventListener('pointerenter', tipOn); b.addEventListener('focus', tipOn);
    b.addEventListener('pointerleave', hideTip); b.addEventListener('blur', hideTip);
    b.addEventListener('click', () => { hideTip(); showScreen('map'); if(map) map.flyTo([z.lat, z.lng], 9, {duration:1}); openZoneSheet(z.id); });
    host.appendChild(b);
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
    [z.name, sig.score, LEVEL_LABEL[sig.level], LEVEL_LABEL[z.level], sig.evidence].forEach((v, i) => { tr.children[i].textContent = v; });
    tb.tBodies[0].appendChild(tr);
  });
}

/* ---------- D: reports by day × time of day (sequential dot matrix) ---------- */
function todOf(r){
  if(TODS.includes(r.tod)) return r.tod;
  const h = new Date(r.ts).getHours();
  return h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}
function renderHeat(){
  const host = $('chart-heat');
  const reports = allReports();
  const counts = DAYS.map(() => TODS.map(() => 0));
  reports.forEach(r => { const d = (new Date(r.ts).getDay() + 6) % 7; counts[d][TODS.indexOf(todOf(r))]++; });
  const max = Math.max(0, ...counts.flat());
  host.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'heat-grid';
  grid.innerHTML = '<span></span>' + TODS.map(t => `<span class="heat-col">${TOD_LABEL[t]}</span>`).join('');
  DAYS.forEach((day, d) => {
    const lab = document.createElement('span'); lab.className = 'heat-row'; lab.textContent = day; grid.appendChild(lab);
    TODS.forEach((t, k) => {
      const v = counts[d][k];
      const cell = document.createElement('button');
      cell.type = 'button'; cell.className = 'heat-cell' + (v ? '' : ' zero');
      if(v) cell.style.setProperty('--hc', HEAT_RAMP[Math.min(4, Math.ceil(v/max*5) - 1)]);
      const label = `${v} report${v === 1 ? '' : 's'}`, where = `${day} · ${TOD_LABEL[t].toLowerCase()}`;
      cell.setAttribute('aria-label', `${where}: ${label}`);
      const on = () => { const r = cell.getBoundingClientRect(); showTip(label, where, r.left + r.width/2, r.top); };
      cell.addEventListener('pointerenter', on); cell.addEventListener('focus', on);
      cell.addEventListener('pointerleave', hideTip); cell.addEventListener('blur', hideTip);
      grid.appendChild(cell);
    });
  });
  host.appendChild(grid);
  $('heat-empty').hidden = reports.length > 0;
  const tb = $('table-heat');
  tb.innerHTML = '<thead><tr><th>Day</th>' + TODS.map(t => `<th>${TOD_LABEL[t]}</th>`).join('') + '</tr></thead><tbody>' +
    DAYS.map((day, d) => `<tr><td>${day}</td>${counts[d].map(v => `<td>${v}</td>`).join('')}</tr>`).join('') + '</tbody>';
}

/* ---------- E: what people reported (single colour bars) ---------- */
function renderCats(){
  const host = $('chart-cats');
  const counts = {};
  allReports().forEach(r => (r.cats || []).forEach(c => { if(CAT_LABEL[c]) counts[c] = (counts[c] || 0) + 1; }));
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  host.innerHTML = '';
  $('cats-empty').hidden = rows.length > 0;
  const max = rows.length ? rows[0][1] : 1;
  rows.forEach(([c, v]) => {
    const row = document.createElement('div');
    row.className = 'bar-row static';
    row.innerHTML = '<span class="bar-name"></span><span class="bar-track"><i></i></span><span class="bar-val"></span>';
    row.querySelector('.bar-name').textContent = CAT_LABEL[c];
    row.querySelector('.bar-track i').style.width = Math.max(3, v/max*100) + '%';
    row.querySelector('.bar-val').textContent = v;
    host.appendChild(row);
  });
}
