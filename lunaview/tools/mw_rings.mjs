// Project the Milky Way outlines (d3-celestial mw.json) onto a 2048 x 1024 RA/Dec map with d3-geo,
// which handles polygons that wrap the sphere. Needs d3-geo: npm i --no-save d3-geo. Output: data/sky_src/mw_rings.json.
import fs from 'node:fs';
import { geoPath, geoEquirectangular } from 'd3-geo';
const W = 2048, H = 1024;
const mw = JSON.parse(fs.readFileSync('new URL("../data/sky_src/mw.json", import.meta.url)'));
// u = RA / 360: RA 0 at the left edge, 180 in the middle.
const proj = geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]).rotate([180, 0]);
const out = mw.features.map((f) => {
  const rings = [];
  let cur = null;
  const ctx = { moveTo(x, y) { cur = [[x, y]]; rings.push(cur); }, lineTo(x, y) { cur.push([x, y]); }, closePath() {}, arc() {} };
  geoPath(proj, ctx)(f);
  return rings;
});
fs.writeFileSync('new URL("../data/sky_src/mw_rings.json", import.meta.url)', JSON.stringify(out));
console.log(out.map((r) => r.length));
