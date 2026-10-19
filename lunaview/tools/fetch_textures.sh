#!/usr/bin/env bash
# Download NASA data and rebuild everything the app uses from it. Run from the lunaview/ folder.
#   - CGI Moon Kit (LROC colour + LOLA ldem_16), https://svs.gsfc.nasa.gov/4720
#   - LOLA south polar DEMs LDEM_80S_80M and LDEM_875S_20M (PDS Geosciences Node)
# Needs: curl, python3 with numpy, pillow, tifffile, imagecodecs  (pip install numpy pillow tifffile imagecodecs)
# The results are committed, so the team only needs this to change resolution or add sites.
set -euo pipefail

KIT=https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720
PDS=https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img
mkdir -p .cache

get() { [ -s ".cache/$2" ] || curl -fL -o ".cache/$2" "$1"; }
get "$KIT/lroc_color_poles_8k.tif" lroc_color_poles_8k.tif
get "$KIT/ldem_16.tif" ldem_16.tif
for f in ldem_80s_80m ldem_875s_20m; do
  get "$PDS/$f.lbl" "$f.lbl"
  get "$PDS/$f.img" "$f.img"
done

python3 tools/build_textures.py

# Terrain skylines. Start points are published coordinates; --snap-km moves each to the local high point.
hz() { python3 tools/build_horizon.py --dem .cache/ldem_875s_20m.lbl --dem .cache/ldem_80s_80m.lbl --snap-km 1 --site "$1" --lat "$2" --lon "$3"; }
hz shackleton-rim   -89.68 -166.0
hz connecting-ridge -89.44 -141.8
hz de-gerlache-rim  -88.71  -68.7
hz malapert-massif  -86.0     2.9
hz mons-mouton      -84.4    30.0
echo "Done. Copy the snapped lat/lon printed above into src/sites.js if they changed."
