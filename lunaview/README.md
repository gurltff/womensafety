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
- `src/globe.js`: Three.js globe. The light is placed where the Sun really is for the selected time.
- `src/panorama.js`: 360° sky strip with skyline, Sun and Earth (with its phase), and their paths.
- `tools/build_horizon.py`: builds a 360-value terrain skyline for a site from a LOLA polar DEM.

## Make it real (what the team still needs to do)

1. **Moon imagery.** The repo ships a 1k placeholder map. Run `tools/fetch_textures.sh` (needs ImageMagick) to pull
   NASA's CGI Moon Kit into `public/textures/`. The globe picks it up automatically.
2. **Terrain horizons.** Without them every site uses a flat horizon, so shadows from nearby mountains are missing
   and polar sites look sunnier than they really are. Download a LOLA south-polar DEM (e.g. `LDEM_875S_20M` or
   `LDEM_80S_80M` with its `.LBL`) and run, for each site:
   ```bash
   python tools/build_horizon.py --dem LDEM_80S_80M.LBL --site shackleton-rim --lat -89.68 --lon -166.0
   ```
   This writes `public/horizons/shackleton-rim.json`, which the app loads for that site.
3. **Site coordinates** in `src/sites.js` are approximate. Check them against the official challenge resources.
4. **Validation.** Cross-check a few timelines against skyfield + DE440 (with the lunar `moon_pa_de440_200625.bpc`
   frame kernel) and against published Shackleton-rim illumination studies.

## NASA data

| Data | Used for |
|---|---|
| LRO LROC colour mosaic (CGI Moon Kit, SVS 4720) | Globe texture |
| LRO LOLA elevation (CGI Moon Kit, and polar DEMs from the LOLA PDS archive / PGDA) | Bump map, terrain horizons |
| Planetary ephemerides (via astronomy-engine; DE440 for validation) | Sun and Earth positions |
| Artemis III candidate regions | Default sites |
