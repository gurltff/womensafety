"""Turn NASA's CGI Moon Kit and a LOLA south polar DEM into the files the globe loads.

Inputs (download with tools/fetch_textures.sh):
  .cache/lroc_color_poles_8k.tif   LROC colour mosaic, 8192x4096, centred on lon 0
  .cache/ldem_16.tif               LOLA elevation, 16 px/deg, km relative to 1737.4 km
  .cache/ldem_80s_80m.lbl/.img     LOLA south polar stereographic DEM, 80 m/px

Outputs in public/textures/:
  lroc_color.jpg (8k) and lroc_color_4k.jpg   globe colour
  ldem_normal.jpg                             tangent-space normal map from real heights
  ldem_height.png + terrain.json              8-bit height map for vertex displacement (+ its range)
  polar_height.bin                            high-detail south-pole patch (int16 metres, row-major)
Run: python tools/build_textures.py
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from build_horizon import R_MOON, latlon_to_pixel, load_dem, sample_bilinear  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
OUT = ROOT / "public" / "textures"
Image.MAX_IMAGE_PIXELS = None

POLAR_LIMIT = -84.5  # the patch covers everything poleward of this latitude
POLAR_GRID = 1025    # vertices per side (heights file)


def colour():
    rgb = tifffile.imread(CACHE / "lroc_color_poles_8k.tif")
    img = Image.fromarray(rgb)
    img.save(OUT / "lroc_color.jpg", quality=86, optimize=True)
    img.resize((4096, 2048), Image.LANCZOS).save(OUT / "lroc_color_4k.jpg", quality=86, optimize=True)
    return rgb


def global_terrain():
    h = tifffile.imread(CACHE / "ldem_16.tif").astype(np.float64) * 1000.0  # metres
    rows, cols = h.shape
    # Normal map. Image rows run north to south, columns west to east (lon -180 .. 180).
    lat = 90.0 - (np.arange(rows) + 0.5) * 180.0 / rows
    dy = math.pi * R_MOON / rows
    dx = 2 * math.pi * R_MOON * np.maximum(np.cos(np.radians(lat)), 0.02) / cols
    dh_e = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2 * dx[:, None])
    up = np.vstack([h[:1], h[:-1]])
    down = np.vstack([h[1:], h[-1:]])
    dh_n = (up - down) / (2 * dy)
    n = np.dstack([-dh_e, -dh_n, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(((n * 0.5 + 0.5) * 255).round().astype(np.uint8)).save(OUT / "ldem_normal.jpg", quality=92)

    lo, hi = float(h.min()), float(h.max())
    small = Image.fromarray(((h - lo) / (hi - lo) * 255).round().astype(np.uint8)).resize((2880, 1440), Image.LANCZOS)
    small.save(OUT / "ldem_height.png", optimize=True)
    return lo, hi


def polar_patch():
    dem, lab = load_dem(CACHE / "ldem_80s_80m.lbl")
    half = 2 * R_MOON * math.tan(math.pi / 4 + math.radians(POLAR_LIMIT) / 2)  # metres from pole to patch edge
    # Heights on a regular stereographic grid (x east of lon 0 meridian -> +sample, y toward lon 0 -> -line).
    g = np.linspace(-half, half, POLAR_GRID)
    X, Y = np.meshgrid(g, -g)  # row 0 is +y (toward lon 0)
    lines = lab["line_off"] - Y / lab["scale_m"]
    samples = lab["sample_off"] + X / lab["scale_m"]
    hgt = sample_bilinear(dem, lines, samples)
    hgt = np.nan_to_num(hgt, nan=0.0)
    np.clip(hgt, -32768, 32767).astype("<i2").tofile(OUT / "polar_height.bin")

    return {"half_m": half, "grid": POLAR_GRID, "limit_lat": POLAR_LIMIT,
            "min_m": float(hgt.min()), "max_m": float(hgt.max())}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rgb = colour()
    lo, hi = global_terrain()
    polar = polar_patch()
    meta = {"radius_m": R_MOON, "height_png": {"min_m": lo, "max_m": hi}, "polar": polar,
            "sources": ["NASA SVS CGI Moon Kit (LROC colour, LOLA ldem_16)", "LOLA LDEM_80S_80M"]}
    (OUT / "terrain.json").write_text(json.dumps(meta, indent=1))
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:22s} {f.stat().st_size / 1e6:6.1f} MB")


if __name__ == "__main__":
    main()
