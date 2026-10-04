'use strict';
/* =====================================================================
   SafeCircle India: modelled case counter.
   Projects NCRB yearly totals forward at their average daily rate.
   It is an awareness estimate, not a live feed of police data.
   ===================================================================== */
(function(){
const RAPE_PER_YEAR = 31516;   // NCRB Crime in India 2022: rape cases registered
const HAR_PER_YEAR = 85300;    // assault on women with intent to outrage modesty (approx.)
const RAPE_2014_22 = 299520;   // NCRB rape cases registered, 2014–2022 combined
const RAPE_DAY = RAPE_PER_YEAR/365, HAR_DAY = HAR_PER_YEAR/365;
const MS = 86400000, IST = 19800000;
const SINCE_2023 = Date.UTC(2023, 0, 1) - IST;
const fmt = (n, d = 0) => n.toLocaleString('en-IN', {minimumFractionDigits:d, maximumFractionDigits:d});
const card = $('stats-card');

function tick(){
  if(!card.classList.contains('open') || document.hidden) return;
  const now = Date.now(), dayStart = Math.floor((now + IST)/MS)*MS - IST;
  const sd = now - dayStart, sy = now - SINCE_2023;
  const rd = sd/MS*RAPE_DAY, hd = sd/MS*HAR_DAY;
  $('st-rape-all').textContent = fmt(RAPE_2014_22 + sy/MS*RAPE_DAY, 0);
  $('st-rape-day').textContent = fmt(rd, 1);
  $('st-har-day').textContent = fmt(hd, 1);
  $('st-har-all').textContent = fmt(sy/MS*HAR_DAY, 0);
  const left = (Math.ceil(rd) - rd)/RAPE_DAY*MS/1000, m = Math.floor(left/60), s = Math.floor(left%60);
  $('st-next').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
$('stats-toggle').addEventListener('click', () => {
  const open = card.classList.toggle('open');
  $('stats-toggle').setAttribute('aria-expanded', String(open));
  tick();
});
setInterval(tick, 1000);
})();
