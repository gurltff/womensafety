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

// Well-known places to start a mission anywhere on the Moon (approximate published coordinates).
export const PLACES = [
  { id: 'apollo-11', name: 'Apollo 11, Sea of Tranquillity', lat: 0.674, lon: 23.473 },
  { id: 'apollo-12', name: 'Apollo 12, Ocean of Storms', lat: -3.012, lon: -23.422 },
  { id: 'apollo-14', name: 'Apollo 14, Fra Mauro', lat: -3.645, lon: -17.471 },
  { id: 'apollo-15', name: 'Apollo 15, Hadley Rille', lat: 26.132, lon: 3.634 },
  { id: 'apollo-16', name: 'Apollo 16, Descartes Highlands', lat: -8.973, lon: 15.5 },
  { id: 'apollo-17', name: 'Apollo 17, Taurus-Littrow', lat: 20.191, lon: 30.772 },
  { id: 'lunokhod-1', name: 'Lunokhod 1, Sea of Rains', lat: 38.24, lon: -35.0 },
  { id: 'lunokhod-2', name: 'Lunokhod 2, Le Monnier crater', lat: 25.85, lon: 30.45 },
  { id: 'change-3', name: "Chang'e 3 / Yutu, Sea of Rains", lat: 44.12, lon: -19.51 },
  { id: 'change-4', name: "Chang'e 4 / Yutu-2, Von Kármán (far side)", lat: -45.44, lon: 177.6 },
  { id: 'chandrayaan-3', name: 'Chandrayaan-3 / Pragyan, near south pole', lat: -69.37, lon: 32.32 },
  { id: 'slim', name: 'SLIM, Shioli crater', lat: -13.32, lon: 25.25 },
  { id: 'copernicus', name: 'Copernicus crater', lat: 9.62, lon: -20.08 },
  { id: 'tycho', name: 'Tycho crater', lat: -43.31, lon: -11.36 },
];
