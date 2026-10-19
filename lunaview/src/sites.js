// Candidate south-pole landing sites. Coordinates are approximate and taken from published
// illumination studies and NASA's Artemis III candidate-region list; check them against the
// official challenge resources before the demo.
export const SITES = [
  { id: 'shackleton-rim', name: 'Shackleton rim', lat: -89.68, lon: -166.0, note: 'Bussey et al. 2010, point A' },
  { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.45, lon: -137.3, note: 'Ridge between Shackleton and de Gerlache' },
  { id: 'de-gerlache-rim', name: 'de Gerlache rim', lat: -88.71, lon: -68.7, note: 'Artemis III candidate region' },
  { id: 'haworth', name: 'Haworth', lat: -86.9, lon: -2.0, note: 'Artemis III candidate region' },
  { id: 'malapert-massif', name: 'Malapert Massif', lat: -86.0, lon: 2.9, note: 'Artemis III candidate region' },
  { id: 'mons-mouton', name: 'Mons Mouton', lat: -84.4, lon: 30.0, note: 'Artemis III candidate region' },
];

const horizonCache = new Map();

// Terrain horizon from public/horizons/<id>.json (built by tools/build_horizon.py).
// Returns null when no file exists, which means a flat horizon.
export async function loadHorizon(site) {
  // The single-file build has no horizon files next to it.
  if (!site.id || import.meta.env?.MODE === 'single') return null;
  if (horizonCache.has(site.id)) return horizonCache.get(site.id);
  let horizon = null;
  try {
    const res = await fetch(`horizons/${site.id}.json`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.horizon) && data.horizon.length >= 36) horizon = data.horizon;
    }
  } catch {
    // No horizon file served here; fall back to a flat horizon.
  }
  horizonCache.set(site.id, horizon);
  return horizon;
}

export function parseCoords(text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?[\s,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i);
  if (!m) return null;
  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[3]);
  if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
  if (lon > 180) lon -= 360;
  return { lat, lon };
}
