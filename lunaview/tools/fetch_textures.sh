#!/usr/bin/env bash
# Download NASA's CGI Moon Kit (LROC colour + LOLA elevation) and convert it for the globe.
# Source: https://svs.gsfc.nasa.gov/4720  (public domain, NASA Scientific Visualization Studio)
# Needs: curl and ImageMagick (`magick` or `convert`). Run from the lunaview/ folder.
set -euo pipefail

KIT=https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720
OUT=public/textures
SIZE=${SIZE:-8k}   # 2k, 4k, 8k or 16k. 8k is a good balance for laptops and phones.
mkdir -p "$OUT" .cache

curl -fL -o .cache/lroc_color.tif "$KIT/lroc_color_poles_${SIZE}.tif"
curl -fL -o .cache/ldem.tif "$KIT/ldem_16_uint.tif"

IM=$(command -v magick || command -v convert)
"$IM" .cache/lroc_color.tif -quality 88 "$OUT/lroc_color.jpg"
# Elevation as an 8-bit bump map, stretched to full contrast.
"$IM" .cache/ldem.tif -auto-level -depth 8 -resize 8192x4096 -quality 92 "$OUT/ldem.jpg"

echo "Wrote $OUT/lroc_color.jpg and $OUT/ldem.jpg. Restart 'npm run dev' to see them."
