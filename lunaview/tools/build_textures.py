"""Turn NASA's CGI Moon Kit and a LOLA south polar DEM into the files the globe loads.

Inputs (download with tools/fetch_textures.sh):
  .cache/lroc_color_poles_8k.tif   LROC colour mosaic, 8192x4096, centred on lon 0
  .cache/ldem_16.tif               LOLA elevation, 16 px/deg, km relative to 1737.4 km
  .cache/ldem_80s_80m.lbl/.img     LOLA south polar stereographic DEM, 80 m/px
  .cache/ldem_875s_20m.lbl/.img    LOLA south polar stereographic DEM, 20 m/px (poleward of 87.5 S)

Outputs in public/textures/:
  lroc_color.jpg (8k) and lroc_color_4k.jpg   globe colour
  ldem_normal.jpg                             tangent-space normal map from real heights
  ldem_height.png + terrain.json              8-bit height map for vertex displacement (+ its range)
  polar_height.png + polar_normal.jpg         south-pole patch heights (R*256+G-32768 metres) and shading
  tiles/t{row}_{col}_h.png + _n.jpg           20 m detail tiles near the pole, loaded when zoomed in
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
POLAR_NORMAL = 4096  # shading texture per side (~80 m per pixel)
DETAIL_HALF = 74000.0  # detail tiles cover +-74 km around the pole (inside the 20 m DEM)
DETAIL_TILES = 4       # 4 x 4 tiles, each 37 km across
DETAIL_GRID = 257      # vertices per tile side (~144 m)
DETAIL_NORMAL = 2048   # shading pixels per tile side (~18 m, the DEM's own resolution)


def grid_heights(dem, lab, x0, x1, y0, y1, n):
    """Sample a polar DEM on an n x n stereographic grid; row 0 is y0 (top), column 0 is x0."""
    X, Y = np.meshgrid(np.linspace(x0, x1, n), np.linspace(y0, y1, n))
    h = sample_bilinear(dem, lab["line_off"] - Y / lab["scale_m"], lab["sample_off"] + X / lab["scale_m"])
    return np.nan_to_num(h, nan=float(np.nanmedian(h)))


def save_heights(h, path):
    # Lossless: metres + 32768 split into a high byte (red) and low byte (green) of an 8-bit PNG.
    u = (np.clip(np.round(h), -32768, 32767) + 32768).astype(np.uint16)
    Image.fromarray(np.dstack([u >> 8, u & 255, np.zeros_like(u)]).astype(np.uint8)).save(path, optimize=True)


def save_normals(h, spacing, path, quality=90):
    """Tangent-space normals with +x along columns (u) and +y up the rows (v), from heights in metres."""
    dx = np.gradient(h, spacing, axis=1)
    dy = -np.gradient(h, spacing, axis=0)  # rows run toward -y
    n = np.dstack([-dx, -dy, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(((n * 0.5 + 0.5) * 255).round().astype(np.uint8)).save(path, quality=quality)


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
    hgt = grid_heights(dem, lab, -half, half, half, -half, POLAR_GRID)
    save_heights(hgt, OUT / "polar_height.png")
    fine = grid_heights(dem, lab, -half, half, half, -half, POLAR_NORMAL)
    save_normals(fine, 2 * half / (POLAR_NORMAL - 1), OUT / "polar_normal.jpg")
    return {"half_m": half, "grid": POLAR_GRID, "limit_lat": POLAR_LIMIT,
            "min_m": float(hgt.min()), "max_m": float(hgt.max())}


def detail_tiles():
    dem, lab = load_dem(CACHE / "ldem_875s_20m.lbl")
    (OUT / "tiles").mkdir(exist_ok=True)
    size = 2 * DETAIL_HALF / DETAIL_TILES
    for r in range(DETAIL_TILES):
        for c in range(DETAIL_TILES):
            x0 = -DETAIL_HALF + c * size
            y0 = DETAIL_HALF - r * size
            save_heights(grid_heights(dem, lab, x0, x0 + size, y0, y0 - size, DETAIL_GRID), OUT / "tiles" / f"t{r}_{c}_h.png")
            h = grid_heights(dem, lab, x0, x0 + size, y0, y0 - size, DETAIL_NORMAL)
            save_normals(h, size / (DETAIL_NORMAL - 1), OUT / "tiles" / f"t{r}_{c}_n.jpg", quality=85)
    return {"half_m": DETAIL_HALF, "tiles": DETAIL_TILES, "grid": DETAIL_GRID, "source": "LOLA LDEM_875S_20M"}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rgb = colour()
    lo, hi = global_terrain()
    polar = polar_patch()
    polar["detail"] = detail_tiles()
    meta = {"radius_m": R_MOON, "height_png": {"min_m": lo, "max_m": hi}, "polar": polar,
            "sources": ["NASA SVS CGI Moon Kit (LROC colour, LOLA ldem_16)", "LOLA LDEM_80S_80M"]}
    (OUT / "terrain.json").write_text(json.dumps(meta, indent=1))
    for f in sorted(p for p in OUT.rglob("*") if p.is_file()):
        print(f"{str(f.relative_to(OUT)):22s} {f.stat().st_size / 1e6:6.1f} MB")


if __name__ == "__main__":
    main()
