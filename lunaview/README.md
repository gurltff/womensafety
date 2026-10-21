# LunaView: lunar rover mission simulator

NASA Space Apps Challenge 2026 project. Before a company sends a rover to the Moon's south pole, LunaView
simulates the mission on real NASA terrain and the real sky: where the Sun and Earth will be, which ground will be
in shadow, how cold it gets, how the battery holds up and whether the rover can climb the slopes. It runs the
mission many times with realistic uncertainty and reports the **chance of success**, **why missions fail** and
**what would improve the odds** (another landing date, a bigger battery, heaters, a sunnier route).

## Run it

```bash
cd lunaview
npm install
npm run dev            # http://localhost:5173
npm test               # simulator, terrain and astronomy checks
npm run build          # static site in dist/ (deploy to Netlify)
```

## Using it

1. **Rover**: pick a preset or enter your own specifications (mass, solar array, battery, power draws, speed,
   steepest slope, insulation, heaters, temperature limits, whether it needs Earth in view to drive).
2. **Route**: pick a landing site, then **Draw on map** and click the ground to add points (poleward of 80°S).
   **Find the sunniest route** plans a path that stays in sunlight and avoids slopes the rover can't climb.
   **Sun map** shows how much of the mission each spot is sunlit.
3. **When**: landing date, mission length, how many days the landing could slip, and how many runs.
4. **Simulate mission**: the forecast shows the success rate, why runs failed, an hour-by-hour chart of battery,
   ground temperature, sunlight, Earth contact and rover activity, a mission log, and tested suggestions.
   **Replay on the Moon** drives the rover along the route on the 3D Moon; **Stand where the rover is** shows
   its sky; **Compare** lines up to three forecasts.

## The simulation

Every 15 minutes of mission time, at the rover's current position:

| What | How |
|---|---|
| Terrain, slope | NASA LOLA 80 m south polar DEM (LDEM_80S_80M), slopes over 160 m |
| Sun and Earth | astronomy-engine positions; skyline in their direction traced over the DEM out to 150 km, with lunar curvature |
| Sunlight on the panels | Share of the Sun's 0.53° disc above the skyline × panel angle (vertical sun-tracking or flat) × distance to the Sun |
| Ground temperature | Radiative balance of sunlit regolith on the local slope (albedo 0.12, emissivity 0.95); cools toward ~95 K in shadow, with lag |
| Heaters | Run in shadow: heat leak (W/K) × (minimum inside temperature − ground temperature), minus radioisotope heaters |
| Battery | Solar in minus avionics, driving (plus climbing work), heaters; hibernation power in the dark |
| Driving | Slower on slopes; slopes over the rover's limit block the route |
| Earth contact | Earth above the true skyline; optionally required to drive |

The rover follows simple operating rules: it waits in sunlight if the route ahead is in shadow, unless the battery
can carry it across with its reserve intact; when its own spot goes dark it drives to the nearest sunlight along the
route, forward or back; it hibernates while waiting in the dark.

**Monte Carlo**: each run draws a landing-time slip (± the days you set), solar output 85–100%, driving power
90–125%, speed 70–105%, battery capacity 85–100%, heat leak 90–130% and avionics power 95–115%.

**Checks** (`npm test`): the simulator's skyline at Shackleton rim matches a separately built LOLA horizon (median
difference under 0.1°); its lighting gives Shackleton rim ~86% sunlight over 2026–2027, the published value
(Bussey et al. 2010); synthetic cases (flat sunlit ground, a permanently shadowed site, a 30° slope) behave as expected.

**Limits**: rover presets are illustrative. Slopes are measured over 80 m, so boulders and small craters are not
seen. Temperatures are a first-order model, not a thermal simulation of your rover. The simulated area is the south
polar region poleward of 80°S. The operating rules are simpler than a real operations team.

## How it works

- `src/astro.js`: Sun and Earth direction in the Moon-fixed frame (astronomy-engine + IAU lunar rotation model,
  about 1′ accuracy), converted to elevation and azimuth at the site. Earth parallax is included.
- `src/sim.js`: the rover simulator (one mission, and the Monte Carlo wrapper).
- `src/terrain.js`: heights, slopes and skylines from the 80 m polar DEM tiles (`public/textures/sim/`).
- `src/planner.js`: sunlight map over the mission window and the sunniest-route planner.
- `src/rovers.js`: rover presets and the specification fields.
- `src/mission.js`: the earlier fixed-lander analysis (power and comms timelines), kept for its tests.
- `src/globe.js`: the 3D Moon. Real NASA LROC colour, real LOLA heights (vertex displacement + normal map),
  and a 334 km wide south-pole patch from the 80 m LOLA polar DEM that casts real-time shadows from the Sun.
  **Relief** switches between true scale and 5× height. **Close-up** flies to the selected site.
- `src/panorama.js`: 360° sky from the rover's position with the real skyline, Sun and Earth (with its phase), and their paths.
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
