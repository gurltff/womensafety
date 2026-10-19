// Mission analyzer: hour-by-hour power and comms timelines, plain-language warnings and a score.
import { skyAt } from './astro.js';

const HOUR = 3600 * 1000;

// Each entry: { t: Date, sunlit, earthVisible, sunEl, earthEl, ... }
export function timeline(site, start, days, horizon, stepHours = 1) {
  const out = [];
  const n = Math.round((days * 24) / stepHours);
  for (let i = 0; i <= n; i++) {
    const t = new Date(start.getTime() + i * stepHours * HOUR);
    const s = skyAt(site, t, horizon);
    out.push({
      t,
      sunlit: s.sunlit,
      earthVisible: s.earthVisible,
      sunEl: s.sun.el,
      sunAz: s.sun.az,
      earthEl: s.earth.el,
      earthAz: s.earth.az,
      sunMargin: s.sunMargin,
      earthMargin: s.earthMargin,
    });
  }
  return out;
}

// Contiguous runs where key is false, e.g. shadows or comms gaps. Lengths in hours.
function gaps(tl, key, stepHours) {
  const runs = [];
  let startIdx = -1;
  tl.forEach((p, i) => {
    if (!p[key] && startIdx < 0) startIdx = i;
    if ((p[key] || i === tl.length - 1) && startIdx >= 0) {
      const endIdx = p[key] ? i : i + 1;
      runs.push({ start: tl[startIdx].t, startIdx, hours: (endIdx - startIdx) * stepHours });
      startIdx = -1;
    }
  });
  return runs.sort((a, b) => b.hours - a.hours);
}

const fmtH = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Math.round(h)} hours`);
const dayOf = (t, start) => Math.floor((t - start) / (24 * HOUR)) + 1;

export function analyze(site, start, days, batteryHours, horizon, stepHours = 1) {
  const tl = timeline(site, start, days, horizon, stepHours);
  const sunFrac = tl.filter((p) => p.sunlit).length / tl.length;
  const earthFrac = tl.filter((p) => p.earthVisible).length / tl.length;
  const shadows = gaps(tl, 'sunlit', stepHours);
  const commGaps = gaps(tl, 'earthVisible', stepHours);
  const longestShadow = shadows[0]?.hours ?? 0;
  const longestGap = commGaps[0]?.hours ?? 0;
  const landing = tl[0];

  const warnings = [];
  const fatal = shadows.filter((s) => s.hours > batteryHours);
  for (const s of fatal.slice(0, 3)) {
    warnings.push({
      level: 'critical',
      text: `Day ${dayOf(s.start, start)}: shadow lasts ${fmtH(s.hours)}, longer than the ${batteryHours}-hour battery.`,
    });
  }
  if (!landing.sunlit) {
    warnings.push({ level: 'critical', text: 'The site is in shadow at touchdown. The lander starts on battery.' });
  } else if (landing.sunMargin < 1) {
    warnings.push({ level: 'warning', text: `Sun is only ${landing.sunMargin.toFixed(1)}° above the horizon at touchdown.` });
  }
  if (!landing.earthVisible) {
    warnings.push({ level: 'critical', text: 'Earth is below the horizon at touchdown. No direct link during landing.' });
  }
  for (const g of commGaps.slice(0, 2)) {
    if (g.hours >= 24) {
      warnings.push({
        level: 'warning',
        text: `Day ${dayOf(g.start, start)}: no Earth contact for ${fmtH(g.hours)}. Needs a relay satellite or stored data.`,
      });
    }
  }
  if (warnings.length === 0) {
    warnings.push({ level: 'ok', text: 'No shadow outlasts the battery and Earth stays in view enough for daily contact.' });
  }

  // Score out of 100. Power matters most because a shadow longer than the battery ends the mission.
  const powerPts = 35 * sunFrac;
  const batteryPts = longestShadow === 0 ? 25 : Math.max(0, 25 * (1 - longestShadow / Math.max(batteryHours, 1) / 2));
  const commsPts = 25 * earthFrac;
  const landingPts = (landing.sunlit ? 8 : 0) + (landing.earthVisible ? 7 : 0);
  let score = powerPts + (fatal.length ? 0 : batteryPts) + commsPts + landingPts;
  if (fatal.length) score = Math.min(score, 45);

  return {
    site, start, days, batteryHours, stepHours, tl,
    sunFrac, earthFrac, longestShadow, longestGap, shadows, commGaps, fatal,
    warnings, score: Math.round(score),
  };
}

// Try landing up to `range` days earlier or later and suggest the best shift.
export function suggestShift(site, start, days, batteryHours, horizon, range = 7) {
  const base = analyze(site, start, days, batteryHours, horizon, 2).score;
  let best = { shift: 0, score: base };
  for (let d = -range; d <= range; d++) {
    if (d === 0) continue;
    const s = analyze(site, new Date(start.getTime() + d * 24 * HOUR), days, batteryHours, horizon, 2).score;
    if (s > best.score + 2 || (s === best.score && Math.abs(d) < Math.abs(best.shift))) best = { shift: d, score: s };
  }
  return best.shift === 0 ? null : best;
}
