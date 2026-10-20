# LunaView: CLPS Lunar Mission Browser

NASA Space Apps Challenge 2026 prototype. Pick a landing site near the Moon's south pole, a landing date and
a mission length, and see whether the lander gets sunlight for power and keeps Earth in view for comms.

## Run it

```bash
cd lunaview
npm install
npm run dev            # http://localhost:5173
npm test               # astronomy + horizon-builder checks
npm run build          # static site in dist/ (deploy to Netlify)
npm run build:single   # one self-contained HTML file in dist-single/
```

## Screens

| Screen | Where |
|---|---|
| 1. 3D Moon | Opens on start. Drag to rotate, scroll to zoom, click a pin or a spot near the pole. |
| 2. Mission setup | Menu button or the site chip (bottom left). |
| 3. Mission report | **Run mission**. Score, power and comms timelines, warnings, and a suggested date shift. |
| 4. Stand on the Moon | **Stand** in the toolbar or from the report. Drag the slider to move the Sun and Earth. |
| 5. Compare | **Add to compare** in the report, then **Compare** in the toolbar (up to 3). |

The time chip (bottom right) moves the lighting on the globe to any date. **Play** runs time at 20,000×.

## How it works

- `src/astro.js`: Sun and Earth direction in the Moon-fixed frame (astronomy-engine + IAU lunar rotation model,
  about 1′ accuracy), converted to elevation and azimuth at the site. Earth parallax is included.
- `src/mission.js`: hour-by-hour timeline, shadows and comms gaps, warnings, score out of 100, and a ±7-day date search.
- `src/globe.js`: the 3D Moon. Real NASA LROC colour, real LOLA heights (vertex displacement + normal map),
  and a 334 km wide south-pole patch from the 80 m LOLA polar DEM that casts real-time shadows from the Sun.
  **Relief** switches between true scale and 5× height. **Close-up** flies to the selected site.
- `src/panorama.js`: 360° sky strip with the real skyline, Sun and Earth (with its phase), and their paths.
- `src/horizons/*.json`: 360° terrain skylines per site, from LOLA LDEM_875S_20M + LDEM_80S_80M out to 150 km.
- `tools/`: `fetch_textures.sh` downloads NASA data and rebuilds everything; `build_textures.py` makes the
  globe files; `build_horizon.py` makes skylines (for new sites too).

## How true to the real Moon is it?

| Part | Source | Detail |
|---|---|---|
| Size and shape | LOLA heights, 1737.4 km radius | Global ~1.9 km per sample; pole patch ~650 m per vertex; detail tiles ~145 m |
| Surface colour | LROC WAC mosaic: 8k globe, then 128 full-resolution tiles loaded where you zoom in | ~1.3 km, then ~400 m per pixel |
| Surface shading | LOLA ldem_64 in the same 128 tiles | ~470 m per pixel |
| Pole shading | LOLA 80 m DEM; LOLA 20 m DEM in 16 tiles within ~74 km of the pole, loaded as you zoom in | 80 m, then 18 m per pixel |
| Pole shadows | Real Sun position; shadow area shrinks to what is on screen | ~50 m per texel zoomed out, a few metres up close |
| Skylines for sites | LOLA 20 m + 80 m DEMs | 1° steps in azimuth, out to 150 km |
| Sun, Earth positions | astronomy-engine | ~1 arcminute |

Check: with real terrain, Shackleton rim comes out **86% sunlit over 2026–2027**, matching the published
value for that point (Bussey et al. 2010). This is a test in `test/astro.test.js`.

Zoom stops where the data runs out: about 35 km above the ground over most of the Moon, 5 km over the
80 m pole patch and 1 km over the 20 m pole tiles. Going sharper everywhere needs NASA's 100 m WAC mosaic and
118 m SLDEM2015 heights (several GB, so they need a real host such as Netlify rather than the preview link).

Not modelled: craters smaller than the DEM spacing, light scattered off nearby slopes, and the Sun's disc
being partly hidden (a site counts as lit once the Sun's centre clears the skyline).

## Site coordinates

Each site starts from a published point and is moved to the highest LOLA ground within 1 km, the way a lander
would aim for a ridge crest. Haworth was dropped: the published point sits low and came out 3% sunlit, so it
needs a better coordinate before it goes back in. Check all sites against the official challenge resources.

## NASA data

| Data | Used for |
|---|---|
| LRO LROC colour mosaic (CGI Moon Kit, SVS 4720) | Globe texture |
| LRO LOLA elevation, ldem_16 (CGI Moon Kit) | Global heights (displacement + normal map) |
| LOLA LDEM_80S_80M, LDEM_875S_20M (PDS Geosciences Node) | Pole patch, real shadows, site skylines |
| Planetary ephemerides (via astronomy-engine; DE440 for validation) | Sun and Earth positions |
| Artemis III candidate regions | Default sites |
