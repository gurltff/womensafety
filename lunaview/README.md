# LunaView: a planetarium for the Moon

NASA Space Apps Challenge 2026 project. LunaView is to the Moon what Stellarium is to Earth: pick any place on
the Moon and any date and time (past or future), and see the sky and the ground exactly as they are there. All of
it is computed, not drawn: the Sun, the Earth (with its phase and the side facing you), the planets and 25,723
catalogue stars, over a landscape built from NASA's LOLA terrain and lit by the real Sun.

**Two views**

- **Standing on the surface** (default): you stand 1.7 m above the real terrain.
  - Drag to look around and scroll to zoom from 140° to 0.3°.
  - Click any object for Stellarium-style information: magnitude, RA/Dec, Az/Alt, distance, apparent size and
    phase.
  - For the Sun and Earth you also get the next rise and set over the real terrain skyline at that spot.
  - The ground carries the shadows its own hills and crater walls cast at that moment.
- **Orbit view**: the whole Moon lit by the real Sun.
  - ☀ marks where the Sun is overhead and 🌍 where Earth is overhead, with the Moon's phase as seen from Earth
    and its libration.
  - Click any spot and choose **Stand here**.

**Like Stellarium**

- Left bar (move the mouse to the left edge): Location (F6), Date and time (F5), Sky and viewing options (F4),
  Search (F3), Data and accuracy (F2), Help (F1).
- Bottom bar: constellation lines and names, equatorial and azimuthal grids, ecliptic, ground, cardinal points,
  Milky Way, labels, sunlight glare, orbit/surface view, night mode, full screen, and time controls.
- Same keys as Stellarium: J/K/L for time speed, 8 for now, -/= and [/] to step days and weeks, C, V, E, Z, G, Q, M
  and P for the displays.

The rover mission simulator is still there, as a second page (`simulator.html`, rover icon on the left bar).

## Run it

```bash
cd lunaview
npm install
npm run dev            # http://localhost:5173
npm test               # simulator, terrain and astronomy checks
npm run build          # static site in dist/ (deploy to Netlify)
```

## Site report (for crews)

The planetarium carries a go / no-go panel (top right) and a full site report (press R, or pick a
spot in orbit view and choose Site report). For the place and moment shown it gives:

- surface temperature now and over the next 30 days, from the LRO Diviner Global Cumulative
  Product (Williams et al. 2017): measured bolometric temperatures by local solar time, 0.5 deg
  bins at the named places and 2 deg bins elsewhere;
- rock cover from the Diviner rock abundance map (Bandfield et al. 2011), 60S to 60N;
- the slope underfoot and an 8 km slope and shadow map from LOLA / SLDEM2015 heights, with
  shadows ray-traced for the real Sun;
- sunrise, sunset, hours of sunlight, when Earth is in view for direct radio, and when the Moon
  is inside Earth's magnetotail;
- live space weather: GOES protons and X-rays from NOAA SWPC, flares, solar particle events and
  CMEs from NASA DONKI, and NOAA's three-day radiation storm forecast.

The go / no-go limits are illustrative planning values, stated in the report. Data are prepared by
`tools/fetch_diviner.py` (public/env/) and `tools/fetch_closeups.py` (public/textures/close/).

## Rover mission simulator (simulator.html)

The second page works like mission control over a 3D Moon, in three steps shown at the top.

1. **Plan route**
   - **Rover**: pick Micro, Mid-size or Large, or edit the specifications: mass, solar array, battery, power
     draws, speed, steepest slope, insulation, heaters, temperature limits, and whether it needs Earth in view.
   - **Route, anywhere on the Moon**: click the Moon to set the landing site, then keep clicking to add waypoints.
     You can also pick a known place (south-pole sites, Apollo, Lunokhod, Chang'e, Chandrayaan-3, SLIM) or search.
     - The route line is coloured by slope against the rover's limit.
     - The **route profile** shows the elevation along the way.
     - **Hazards spotted** lists steep stretches, slopes too steep to climb, crater floors and long climbs before
       you launch.
     - **Auto-route for sunlight** re-plans between your points to stay in sunlight.
   - **Mission window**: landing date, mission length, how many days the landing could slip, how many variations.
2. **Simulation**: **Launch simulation** runs the planned mission and dozens of variations, then the rover drives
   the route on the 3D Moon.
   - The camera chases the rover. You can also choose Orbit, Top or Free; drag to look around.
   - The real Sun and shadows move with mission time.
   - A telemetry panel shows the day, battery, ground temperature, solar power, power use, heaters, slope, Sun and
     Earth link, with live graphs.
   - The **mission log** fills in as hurdles happen, with a banner and a marker on the ground: nightfall, terrain
     shadow, lost Earth contact, ground too hot to drive, wheel slip, crater crossings, low battery, arrival and
     failure.
   - Drag the timeline to jump to any moment. Press Space to pause. **Sky** shows the rover's sky.
3. **Debrief**: chance of success and the result of the planned run.
   - **Key numbers**: distance, arrival day, coldest and hottest ground, lowest battery, energy in and used,
     heater energy, time in the dark, time without Earth contact, worst wheel slip.
   - **Every hurdle encountered**, with when, where, the temperature and battery at the time, and how the rover
     dealt with it. Each has a **Watch** button.
   - Also: the mission timeline chart, how all variations ended, tested suggestions to improve the odds, and
     **Download report** (Markdown).

**Camera**: drag to move the ground, right-drag (or Ctrl/Shift-drag, or two fingers) to turn and tilt, and scroll to
zoom toward the cursor. Double-click zooms in. The camera eases toward each move and is checked against the drawn
ground every frame, so it never goes underground or through a hill between it and the target.

## The simulation

Every 15 minutes of mission time, at the rover's current position:

| What | How |
|---|---|
| Terrain, slope | NASA LOLA 80 m south polar DEM (LDEM_80S_80M) poleward of 80°S; elsewhere LOLA global heights at ~950 m (from ldem_64) |
| Sun and Earth | astronomy-engine positions; skyline in their direction traced over the DEM out to 150 km, with lunar curvature |
| Sunlight on the panels | Share of the Sun's 0.53° disc above the skyline × panel angle (vertical sun-tracking or flat) × distance to the Sun |
| Ground temperature | Radiative balance of sunlit regolith on the local slope (albedo 0.12, emissivity 0.95); cools toward ~95 K in shadow, with lag |
| Heaters | Run in shadow: heat leak (W/K) × (minimum inside temperature − ground temperature), minus radioisotope heaters |
| Battery | Solar in minus avionics, driving (plus climbing work), heaters; hibernation power in the dark |
| Driving | Wheel slip rises with slope (~5% on the flat, ~50% near the rover's rated slope), cutting speed; slopes over the limit block the route |
| Hurdles | Spells of night, terrain shadow, no Earth contact, ground too hot to drive and waiting for sunlight, with their temperatures, battery and heater energy; steep stretches, crater floors (25 m+ depressions) and long climbs from the route profile |
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
seen. Temperatures are a first-order model, not a thermal simulation of your rover. Away from the south pole the terrain
is ~950 m per sample, so slopes are averaged over about 2 km and small craters, rilles and boulders are not seen;
the forecast says which detail each route used. The operating rules are simpler than a real operations team. In the
replay the rover model is drawn larger than life so it stays visible.

## How it works

Planetarium (`src/sky/`):

- `ephem.js`: the observer on the Moon at any date: position in J2000 equatorial coordinates (astronomy-engine:
  VSOP87, ELP/MPP02 lunar theory, IAU lunar rotation model), local east/north/up, and the Sun, Earth and planets
  seen from there.
  - For each body: altitude, azimuth, RA/Dec, distance, apparent size, magnitude and phase.
  - For Earth also: its orientation from sidereal time, precession and nutation, the point on Earth facing you,
    and where on Earth it is noon.
  - Sun and Earth rise and set over any skyline.
- `skylayer.js`: the sky: Hipparcos stars (size by magnitude, colour from B-V), constellation lines, the Milky Way,
  equatorial, ecliptic and azimuthal grids, the Sun with its true 0.53° disc, Earth as a textured sphere (NASA Blue
  Marble) turned and lit as it really is, and the planets.
- `landscape.js`: the ground around the observer from NASA LOLA heights out to 150 km.
  - Includes the Moon's curvature, coloured by the LROC mosaic (399 m tiles) and lit by the Sun.
  - Shadows are ray-marched toward the Sun through a local height grid, with the Sun's disc for soft edges.
  - Earthshine on the night side follows Earth's phase and altitude.
- `surface.js`: standing view (look around, zoom, pick); `app.js`: Stellarium-style interface, time machine,
  location, search, and orbit view (the 3D globe from `src/globe.js` with the real sky behind it).
- `tools/build_sky.py` (+ `fetch_sky.sh`, `mw_rings.mjs`): builds `public/sky/` from the Hipparcos catalogue and
  constellations (d3-celestial, BSD-3) and NASA's Blue Marble.

Rover simulator and globe:

- `src/astro.js`: Sun and Earth direction in the Moon-fixed frame (astronomy-engine + IAU lunar rotation model,
  about 1′ accuracy), converted to elevation and azimuth at the site. Earth parallax is included.
- `src/sim.js`: the rover simulator (one mission with its hurdles, terrain hazards on a route, and the Monte Carlo wrapper).
- `src/camera.js`: the map-style camera (pan, turn and tilt, zoom to cursor, follow the rover, ground collision).
- `src/terrain.js`: heights, slopes and skylines anywhere on the Moon, from the 80 m polar DEM tiles
  (`public/textures/sim/`) and the whole-Moon height tiles (`public/textures/globe/c*_h.png`, 721 samples per 22.5°).
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

## 3D rover models

| Rover class | Model | Licence |
|---|---|---|
| Micro | Rover by Quaternius | CC0 |
| Mid-size | Space rover by Poly by Google | CC BY 3.0 |
| Large | Curiosity Rover by Keen Chan | CC BY 3.0 |

They are in `public/models/` (from Poly Pizza), converted to JSON glTF by `tools/glb_to_json.mjs` so any static host serves them. `src/models.js` loads them and scales each to its rover class
(0.9 m, 1.8 m, 3 m long). They appear in the planner on a turntable and in the rover cards, and they drive on the
Moon in the simulation, drawn larger than life when the camera is far away so they stay visible.

## NASA data

| Data | Used for |
|---|---|
| LRO LROC colour mosaic (CGI Moon Kit, SVS 4720) | Globe texture |
| LRO LOLA elevation, ldem_16 (CGI Moon Kit) | Global heights (displacement + normal map) |
| LOLA LDEM_80S_80M, LDEM_875S_20M (PDS Geosciences Node) | Pole patch, real shadows, site skylines |
| Planetary ephemerides (via astronomy-engine; DE440 for validation) | Sun and Earth positions |
| Artemis III candidate regions | Default sites |
| NASA Blue Marble Next Generation (SVS 3615) | Earth as seen from the Moon |
| Hipparcos catalogue, IAU star names and constellations (via d3-celestial, BSD-3) | Stars, constellation lines and names, Milky Way outline |
