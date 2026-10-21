#!/bin/sh
# Download the sky sources used by tools/build_sky.py.
set -e
cd "$(dirname "$0")/../data/sky_src" 2>/dev/null || { mkdir -p "$(dirname "$0")/../data/sky_src"; cd "$(dirname "$0")/../data/sky_src"; }
D3=https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data
for f in stars.8.json starnames.json constellations.json constellations.lines.json mw.json; do curl -sSfo "$f" "$D3/$f"; done
curl -sSfo flat_earth_Largest_still.0330.jpg https://svs.gsfc.nasa.gov/vis/a000000/a003600/a003615/flat_earth_Largest_still.0330.jpg
