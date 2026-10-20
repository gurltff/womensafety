import './styles.css';
import { Globe } from './globe.js';
import { Panorama } from './panorama.js';
import { bodyVectors, skyAt } from './astro.js';
import { analyze, suggestShift } from './mission.js';
import { SITES, loadHorizon, parseCoords } from './sites.js';

const $ = (id) => document.getElementById(id);
const HOUR = 3600 * 1000;

const state = {
  site: SITES[0],
  horizon: null,
  start: new Date(Date.UTC(2026, 10, 14, 0, 0)), // hackathon weekend
  days: 14,
  battery: 40,
  time: new Date(Date.UTC(2026, 10, 14, 0, 0)),
  playing: false,
  result: null,
  saved: [],
};

// ---------- formatting ----------
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
const fmtLatLon = (s) => `${fmtLat(s.lat)} ${fmtLon(s.lon)}`;
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const fromLocalInput = (s) => { const d = new Date(`${s}:00Z`); return Number.isNaN(d.getTime()) ? null : d; };
const fmtDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fmtDateTime = (d) => `${fmtDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
const fmtHours = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`);
const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}°`;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- globe ----------
const globe = new Globe($('globe'), $('labels'));
window.lunaview = { globe }; // handy for poking at the scene from the browser console
globe.setSites(SITES, state.site.id);
globe.onPick = (s) => selectSite(s, true);
globe.onSurfaceClick = ({ lat, lon }) => {
  if (lat > -80) { toast(`${fmtLat(lat)} ${fmtLon(lon)} is outside the south polar region. Pick a spot poleward of 80°S.`); return; }
  selectSite({ id: null, name: 'Custom site', lat, lon }, false);
  toast(`Custom site set at ${fmtLat(lat)} ${fmtLon(lon)}`);
};

async function selectSite(site, fly) {
  state.site = site;
  state.horizon = await loadHorizon(site);
  globe.select(site.id);
  $('siteName').textContent = site.name.toUpperCase();
  $('siteCoords').textContent = fmtLatLon(site);
  syncForm();
  updateSky();
  if (fly) globe.flyTo(site);
}

function updateSky() {
  const v = bodyVectors(state.time);
  globe.setSunDirection(v.sun);
  const s = skyAt(state.site, state.time, state.horizon);
  $('roSun').textContent = `Sun ${sign(s.sunMargin)} ${s.sunlit ? 'lit' : 'shadow'}`;
  $('roEarth').textContent = `Earth ${sign(s.earthMargin)} ${s.earthVisible ? 'in view' : 'hidden'}`;
  $('clock').textContent = `${pad(state.time.getUTCHours())}:${pad(state.time.getUTCMinutes())}:${pad(state.time.getUTCSeconds())}`;
  $('dateStr').textContent = `${fmtDate(state.time)} UTC`;
  if (document.activeElement !== $('timeInput')) $('timeInput').value = toLocalInput(state.time);
}

function setTime(d) {
  state.time = d;
  updateSky();
}

// ---------- search ----------
const search = $('search');
const results = $('results');
let active = 0;
function renderResults() {
  const q = search.value.trim().toLowerCase();
  const items = [];
  const c = parseCoords(search.value);
  if (c) items.push({ id: null, name: 'Go to coordinates', lat: c.lat, lon: c.lon });
  for (const s of SITES) if (!q || s.name.toLowerCase().includes(q)) items.push(s);
  results.textContent = '';
  items.forEach((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = s.name;
    li.lastChild.textContent = fmtLatLon(s);
    li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(s); });
    results.appendChild(li);
  });
  results.hidden = items.length === 0;
  renderResults.items = items;
}
function choose(s) {
  const site = s.id ? s : { id: null, name: 'Custom site', lat: s.lat, lon: s.lon };
  search.value = '';
  results.hidden = true;
  search.blur();
  selectSite(site, true);
}
search.addEventListener('focus', () => { active = 0; renderResults(); });
search.addEventListener('input', () => { active = 0; renderResults(); });
search.addEventListener('blur', () => { results.hidden = true; });
search.addEventListener('keydown', (e) => {
  const items = renderResults.items || [];
  if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); renderResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderResults(); e.preventDefault(); }
  if (e.key === 'Enter' && items[active]) choose(items[active]);
  if (e.key === 'Escape') search.blur();
});

// ---------- panels ----------
const panels = ['setup', 'report', 'stand', 'compare'];
function open(id) {
  if (id === 'setup') close('report');
  if (id === 'report') close('setup');
  $(id).hidden = false;
  if (id === 'setup') $('menuBtn').setAttribute('aria-expanded', 'true');
}
function close(id) {
  $(id).hidden = true;
  if (id === 'setup') $('menuBtn').setAttribute('aria-expanded', 'false');
  if (id === 'stand') stopStandPlay();
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(b.dataset.close)));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = [...panels].reverse().find((p) => !$(p).hidden);
  if (top) close(top);
  $('timePanel').hidden = true;
});
$('menuBtn').addEventListener('click', () => ($('setup').hidden ? open('setup') : close('setup')));
$('siteChip').addEventListener('click', () => open('setup'));

// ---------- setup form ----------
const fSite = $('fSite');
for (const s of SITES) fSite.add(new Option(s.name, s.id));
fSite.add(new Option('Custom coordinates', ''));
function syncForm() {
  fSite.value = state.site.id ?? '';
  $('fLat').value = state.site.lat.toFixed(2);
  $('fLon').value = state.site.lon.toFixed(2);
  $('fDate').value = toLocalInput(state.start);
  $('fDays').value = state.days;
  $('fBatt').value = state.battery;
  $('horizonNote').innerHTML = state.horizon
    ? '<b>Real terrain horizon</b> for this site, built from NASA LOLA elevation data.'
    : '<b>Flat horizon.</b> Custom spots have no terrain skyline yet, so nearby mountains are not counted. Build one with <code>tools/build_horizon.py</code>.';
}
fSite.addEventListener('change', () => {
  const s = SITES.find((x) => x.id === fSite.value);
  if (s) selectSite(s, true);
});
$('setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const lat = parseFloat($('fLat').value), lon = parseFloat($('fLon').value);
  const start = fromLocalInput($('fDate').value);
  const days = parseInt($('fDays').value, 10), batt = parseFloat($('fBatt').value);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 360)) return toast('Enter a latitude between −90 and 90 and a longitude between −180 and 360.');
  if (!start) return toast('Pick a landing date and time.');
  if (!(days >= 1 && days <= 60)) return toast('Mission length must be 1 to 60 days.');
  if (!(batt > 0)) return toast('Battery must be at least 1 hour.');
  const moved = Math.abs(lat - state.site.lat) > 0.005 || Math.abs(lon - state.site.lon) > 0.005;
  if (moved) {
    state.site = { id: null, name: 'Custom site', lat, lon: lon > 180 ? lon - 360 : lon };
    state.horizon = null;
    globe.select(null);
    $('siteName').textContent = 'CUSTOM SITE';
    $('siteCoords').textContent = fmtLatLon(state.site);
  }
  Object.assign(state, { start, days, battery: batt });
  runMission();
});
$('runBtn').addEventListener('click', () => runMission());

// ---------- mission report ----------
function runMission() {
  const r = analyze(state.site, state.start, state.days, state.battery, state.horizon);
  r.horizonFlat = !state.horizon;
  r.siteName = state.site.name;
  state.result = r;
  setTime(new Date(state.start));
  open('report');
  renderReport(r);
  // The date search runs after the report is on screen so the click feels instant.
  setTimeout(() => {
    const s = suggestShift(state.site, state.start, state.days, state.battery, state.horizon);
    if (state.result !== r) return;
    const box = $('suggest');
    if (!s) { box.innerHTML = 'Landing a few days earlier or later would not improve this score.'; return; }
    const when = `${Math.abs(s.shift)} day${Math.abs(s.shift) === 1 ? '' : 's'} ${s.shift < 0 ? 'earlier' : 'later'}`;
    box.innerHTML = `Land <b>${when}</b> to raise the score to about <b>${s.score}</b>. <button class="ghost" type="button" id="applyShift">Try it</button>`;
    $('applyShift').addEventListener('click', () => {
      state.start = new Date(state.start.getTime() + s.shift * 24 * HOUR);
      syncForm();
      runMission();
    });
  }, 30);
}

function scoreColor(score) {
  return score >= 75 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--crit)';
}

function renderReport(r) {
  const C = 2 * Math.PI * 48;
  const body = $('reportBody');
  body.innerHTML = `
    <p class="hint">${r.siteName} · ${fmtLatLon(r.site)}<br>Landing ${fmtDateTime(r.start)} · ${r.days} days · battery ${r.batteryHours} h</p>
    <div class="score-row">
      <div class="score-ring" role="img" aria-label="Mission score ${r.score} out of 100">
        <svg viewBox="0 0 112 112"><circle cx="56" cy="56" r="48" stroke="var(--shadow)" stroke-width="10"/>
          <circle cx="56" cy="56" r="48" stroke="${scoreColor(r.score)}" stroke-width="10" stroke-dasharray="${(C * r.score) / 100} ${C}"/></svg>
        <div class="num"><div>${r.score}<small>of 100</small></div></div>
      </div>
      <dl class="facts">
        <div><dt>Sunlit</dt><dd>${Math.round(r.sunFrac * 100)}%</dd></div>
        <div><dt>Earth in view</dt><dd>${Math.round(r.earthFrac * 100)}%</dd></div>
        <div><dt>Longest shadow</dt><dd style="color:${r.fatal.length ? 'var(--crit)' : 'inherit'}">${r.longestShadow ? fmtHours(r.longestShadow) : 'none'}</dd></div>
        <div><dt>Longest comms gap</dt><dd>${r.longestGap ? fmtHours(r.longestGap) : 'none'}</dd></div>
      </dl>
    </div>
    <h3>Timelines</h3>
    <div class="tl"><canvas id="tlCanvas" aria-label="Power and comms timelines. Click to see the sky at that hour."></canvas></div>
    <div class="legend">
      <span><i style="background:var(--sun)"></i>Sunlight</span>
      <span><i style="background:var(--earth)"></i>Earth in view</span>
      <span><i style="background:var(--shadow)"></i>Shadow / no contact</span>
      <span><i style="background:none;outline:2px solid var(--crit)"></i>Shadow longer than battery</span>
    </div>
    <h3>Warnings</h3>
    <ul class="warn-list">${r.warnings.map((w) => `<li class="warn"><span class="pill ${w.level}">${w.level === 'ok' ? 'All clear' : w.level}</span><span>${w.text}</span></li>`).join('')}</ul>
    <div class="suggest" id="suggest">Checking other landing dates…</div>
    ${r.horizonFlat ? '<p class="hint"><b>Flat horizon.</b> This custom spot has no terrain skyline, so nearby mountains are ignored and real shadows will be longer.</p>' : ''}
    <div class="report-actions">
      <button class="cta" type="button" id="toStand">Stand on the Moon</button>
      <button class="ghost" type="button" id="toCompare">Add to compare</button>
      <button class="ghost" type="button" id="toSetup">Edit mission</button>
    </div>`;
  drawTimeline($('tlCanvas'), r, { labels: true });
  $('tlCanvas').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left - 54) / (rect.width - 62);
    const idx = Math.round(Math.max(0, Math.min(1, f)) * (r.tl.length - 1));
    openStand(idx);
  });
  $('toStand').addEventListener('click', () => openStand(0));
  $('toCompare').addEventListener('click', () => addCompare(r));
  $('toSetup').addEventListener('click', () => open('setup'));
}

function drawTimeline(canvas, r, { labels }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const left = labels ? 54 : 0, right = labels ? 8 : 0;
  const w = W - left - right;
  const rows = labels ? [[8, 30], [46, 30]] : [[2, (H - 6) / 2], [H / 2 + 1, (H - 6) / 2]];
  const n = r.tl.length;
  const x = (i) => left + (i / (n - 1)) * w;
  ctx.clearRect(0, 0, W, H);
  [['sunlit', col('--sun')], ['earthVisible', col('--earth')]].forEach(([key, on], row) => {
    const [y0, h] = rows[row];
    ctx.fillStyle = col('--shadow');
    ctx.fillRect(left, y0, w, h);
    ctx.fillStyle = on;
    for (let i = 0; i < n - 1; i++) if (r.tl[i][key]) ctx.fillRect(x(i), y0, x(i + 1) - x(i) + 0.5, h);
  });
  // Outline shadows that outlast the battery.
  ctx.strokeStyle = col('--crit');
  ctx.lineWidth = 2;
  for (const s of r.fatal) {
    const x0 = x(s.startIdx), x1 = x(Math.min(n - 1, s.startIdx + s.hours / r.stepHours));
    ctx.strokeRect(x0 + 1, rows[0][0] + 1, Math.max(2, x1 - x0 - 2), rows[0][1] - 2);
  }
  if (!labels) return;
  ctx.fillStyle = col('--ink-dim');
  ctx.font = `500 11px ${col('--font-mono')}`;
  ctx.fillText('POWER', 0, rows[0][0] + 19);
  ctx.fillText('COMMS', 0, rows[1][0] + 19);
  const perDay = 24 / r.stepHours;
  const every = r.days > 20 ? 5 : r.days > 10 ? 2 : 1;
  for (let d = 0; d <= r.days; d += every) {
    const xi = x(Math.min(n - 1, d * perDay));
    ctx.fillRect(xi, 80, 1, 5);
    ctx.textAlign = d === r.days ? 'right' : d === 0 ? 'left' : 'center';
    ctx.fillText(d === 0 ? 'Land' : `D${d}`, xi, 100);
  }
  ctx.textAlign = 'left';
}

// ---------- stand on the Moon ----------
const pano = new Panorama($('pano'));
let standIdx = 0, standTimer = null;
function openStand(idx) {
  if (!state.result) runMission();
  const r = state.result;
  open('stand');
  $('standSite').textContent = `${r.siteName} · ${fmtLatLon(r.site)} · vertical scale ×${pano.vScale}`;
  $('standNote').textContent = r.horizonFlat
    ? 'Flat horizon shown. Custom spots have no terrain skyline yet.'
    : 'Skyline from NASA LOLA elevation data (LDEM 20 m and 80 m), out to 150 km.';
  const slider = $('standSlider');
  slider.max = r.tl.length - 1;
  pano.set({ horizon: state.horizon, track: r.tl.filter((_, i) => i % 2 === 0).map((p) => ({ sunAz: p.sunAz, sunEl: p.sunEl, earthAz: p.earthAz, earthEl: p.earthEl })) });
  setStandIdx(idx);
  pano.lookAt(skyAt(r.site, r.tl[idx].t, state.horizon).sun.az);
}
function setStandIdx(idx) {
  const r = state.result;
  standIdx = idx;
  $('standSlider').value = idx;
  const t = r.tl[idx].t;
  const s = skyAt(r.site, t, state.horizon);
  pano.set({ state: s });
  const day = Math.floor(idx * r.stepHours / 24) + 1;
  $('standTime').textContent = `Day ${day} · ${fmtDateTime(t)}`;
  $('standReadout').innerHTML = `<span class="sun-dot"></span>Sun ${s.sun.el.toFixed(2)}° at az ${s.sun.az.toFixed(0)}° · ${s.sunlit ? 'above skyline' : 'behind skyline'}
    <span class="earth-dot"></span>Earth ${s.earth.el.toFixed(2)}° at az ${s.earth.az.toFixed(0)}° · ${s.earthVisible ? 'in view' : 'hidden'} · ${Math.round(s.earthLit * 100)}% lit`;
  setTime(new Date(t));
}
$('standSlider').addEventListener('input', (e) => setStandIdx(+e.target.value));
function stopStandPlay() {
  clearInterval(standTimer); standTimer = null; $('standPlay').textContent = '▶'; $('standPlay').setAttribute('aria-label', 'Play');
}
$('standPlay').addEventListener('click', () => {
  if (standTimer) return stopStandPlay();
  $('standPlay').textContent = '❚❚'; $('standPlay').setAttribute('aria-label', 'Pause');
  standTimer = setInterval(() => {
    const max = state.result.tl.length - 1;
    setStandIdx(standIdx >= max ? 0 : standIdx + 1);
  }, 60);
});
$('lookSun').addEventListener('click', () => pano.lookAt(pano.state.sun.az));
$('lookEarth').addEventListener('click', () => pano.lookAt(pano.state.earth.az));

// ---------- compare ----------
function addCompare(r) {
  const key = `${r.site.lat},${r.site.lon},${r.start.getTime()},${r.days},${r.batteryHours}`;
  if (state.saved.some((s) => s.key === key)) { toast('This mission is already in compare.'); return openCompare(); }
  state.saved.push({ key, r });
  if (state.saved.length > 3) state.saved.shift();
  $('cmpCount').textContent = state.saved.length;
  openCompare();
}
function openCompare() {
  open('compare');
  const grid = $('cmpGrid');
  grid.textContent = '';
  if (!state.saved.length) {
    grid.innerHTML = '<p class="cmp-empty">Run a mission and choose <b>Add to compare</b>. You can line up to three site and date options side by side.</p>';
    return;
  }
  const best = Math.max(...state.saved.map((s) => s.r.score));
  state.saved.forEach(({ r }, i) => {
    const card = document.createElement('article');
    card.className = `cmp-card${r.score === best && state.saved.length > 1 ? ' best' : ''}`;
    card.innerHTML = `
      <header><div><strong></strong><div class="chip-sub"></div></div><div class="big" style="color:${scoreColor(r.score)}">${r.score}</div></header>
      <canvas></canvas>
      <dl class="facts">
        <div><dt>Longest shadow</dt><dd>${r.longestShadow ? fmtHours(r.longestShadow) : 'none'}</dd></div>
        <div><dt>Earth in view</dt><dd>${Math.round(r.earthFrac * 100)}%</dd></div>
      </dl>
      <div class="row"><button class="ghost" type="button" data-open>Open report</button><button class="ghost" type="button" data-remove>Remove</button></div>`;
    card.querySelector('strong').textContent = r.siteName;
    card.querySelector('.chip-sub').textContent = `${fmtDateTime(r.start)} · ${r.days} d · ${r.batteryHours} h battery`;
    grid.appendChild(card);
    drawTimeline(card.querySelector('canvas'), r, { labels: false });
    card.querySelector('[data-open]').addEventListener('click', () => { state.result = r; close('compare'); open('report'); renderReport(r); });
    card.querySelector('[data-remove]').addEventListener('click', () => { state.saved.splice(i, 1); $('cmpCount').textContent = state.saved.length; openCompare(); });
  });
}

// ---------- toolbar ----------
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  const toggle = () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); return on; };
  if (t === 'pins') { const on = toggle(); $('labels').hidden = !on; globe.pins.forEach((p) => { p.mesh.visible = on; }); }
  if (t === 'grid') globe.grid.visible = toggle();
  if (t === 'sun') { const on = toggle(); globe.setFullLight(!on); if (!on) toast('Showing the whole Moon evenly lit. Turn Sunlight back on to see real lighting for the chosen time.'); }
  if (t === 'relief') {
    const on = toggle();
    globe.setRelief(on ? 5 : 1);
    $('reliefLabel').textContent = on ? 'Relief ×5' : 'Relief ×1';
    toast(on ? 'Terrain heights exaggerated 5×.' : 'Terrain at true scale.');
  }
  if (t === 'fly') globe.flyTo(state.site);
  if (t === 'home') globe.flyHome();
  if (t === 'stand') openStand(0);
  if (t === 'compare') openCompare();
}));

// ---------- time ----------
$('timeChip').addEventListener('click', () => {
  const p = $('timePanel');
  p.hidden = !p.hidden;
  $('timeChip').setAttribute('aria-expanded', String(!p.hidden));
});
$('timeInput').addEventListener('change', (e) => { const d = fromLocalInput(e.target.value); if (d) setTime(d); });
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => setTime(new Date(state.time.getTime() + +b.dataset.step * HOUR))));
$('nowBtn').addEventListener('click', () => setTime(new Date()));
let last = performance.now();
$('playBtn').addEventListener('click', (e) => {
  state.playing = !state.playing;
  e.currentTarget.setAttribute('aria-pressed', String(state.playing));
  last = performance.now();
});
globe.onFrame = () => {
  const now = performance.now();
  if (state.playing) setTime(new Date(state.time.getTime() + (now - last) * 20000));
  last = now;
};

// ---------- start ----------
selectSite(state.site, false);
