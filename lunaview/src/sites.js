// Candidate south-pole landing sites. Each starts from a published point (illumination studies or
// NASA's Artemis III region list) and is moved to the highest LOLA ground within 1 km, the way a
// lander would aim for a ridge crest (tools/build_horizon.py --snap-km 1). Check them against the
// official challenge resources before the demo.
export const SITES = [
  { id: 'shackleton-rim', name: 'Shackleton rim', lat: -89.687, lon: -162.635, note: 'Bussey et al. 2010, point A' },
  { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.443, lon: -138.454, note: 'Bussey et al. 2010, point B' },
  { id: 'de-gerlache-rim', name: 'de Gerlache rim', lat: -88.678, lon: -68.382, note: 'Bussey et al. 2010, point C; Artemis III region' },
  { id: 'malapert-massif', name: 'Malapert Massif', lat: -85.991, lon: 2.771, note: 'Artemis III candidate region' },
  { id: 'mons-mouton', name: 'Mons Mouton', lat: -84.384, lon: 30.290, note: 'Artemis III candidate region' },
];

// Terrain horizons built from LOLA polar DEMs by tools/build_horizon.py, bundled with the app.
const files = import.meta.glob('./horizons/*.json', { eager: true, import: 'default' });
const HORIZONS = Object.fromEntries(Object.values(files).map((h) => [h.site, h]));
for (const s of SITES) s.heightM = HORIZONS[s.id]?.site_height_m ?? 0;

// 360 skyline elevations (deg) for a known site, or null for a custom spot (flat horizon).
export function loadHorizon(site) {
  const h = site.id && HORIZONS[site.id];
  return Promise.resolve(h && Array.isArray(h.horizon) ? h.horizon : null);
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
