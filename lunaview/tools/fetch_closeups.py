#!/usr/bin/env python3
"""Close-up terrain for the named places: the finest LOLA heights around each one.

For every place in src/sites.js this reads, with HTTP range requests, only the rows it needs from
the LOLA gridded DEMs on the PDS Geosciences Node, and resamples them onto a local east/north grid
centred on the place (heights in metres above the 1737.4 km reference sphere):

  between 60S and 60N   SLDEM2015 tiles, 512 px/deg (about 59 m; LOLA merged with Kaguya stereo,
                        which fills the gaps between LOLA tracks that striped the LDEM_1024 grids)
  south of 87.5S        LDEM_875S_5M  (5 m)
  85S to 87.5S          LDEM_85S_10M  (10 m)
  80S to 85S            LDEM_80S_20M  (20 m)
  60S to 80S            LDEM_60S_60M  (60 m)

Output: public/textures/close/<id>.png (heights as quarter-metres in red/green) and public/textures/close/index.json.
Run: python3 tools/fetch_closeups.py
"""
import json
import time
import math
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

R_MOON = 1737400.0
BASE = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data'
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'textures' / 'close'
HALF_M = 8000.0  # the grid covers 16 km x 16 km around the place

POLAR = [  # (poleward of, file, metres per pixel, pixels per side, projection offset)
    (-87.5, 'ldem_875s_5m', 5, 30336, 15167.5),
    (-85.0, 'ldem_85s_10m', 10, 30336, 15167.5),
    (-80.0, 'ldem_80s_20m', 20, 30400, 15199.5),
    (-60.0, 'ldem_60s_60m', 60, 31040, 15519.5),
]


def places():
    src = (ROOT / 'src' / 'sites.js').read_text()
    pat = re.compile(r"\{ id: '([^']+)', name: (?:'[^']*'|\"[^\"]*\"), lat: (-?[\d.]+), lon: (-?[\d.]+)")
    return [(m[1], float(m[2]), float(m[3])) for m in pat.finditer(src)]


_local = threading.local()


def fetch(url, start, length):
    # One keep-alive connection per thread: opening a new TLS connection per row is slow and flaky.
    sess = getattr(_local, 'sess', None) or requests.Session()
    _local.sess = sess
    for attempt in range(8):
        try:
            r = sess.get(url, headers={'Range': f'bytes={start}-{start + length - 1}'}, timeout=120)
            if r.status_code == 206 and len(r.content) == length:
                return r.content
        except Exception:
            sess = _local.sess = requests.Session()
        time.sleep(1 + attempt * 2)
    raise RuntimeError(f'could not read {url} at {start}')


def read_window(url, row_bytes, l0, l1, s0, s1, dtype='<i2', scale=0.5):
    """Rows l0..l1 and samples s0..s1 (inclusive) of a raw image, as heights in metres."""
    size = np.dtype(dtype).itemsize
    width = s1 - s0 + 1
    if width * size * 4 > row_bytes:
        # The patch covers much of each row: read whole blocks of rows in a few large requests.
        block = max(1, (8 << 20) // row_bytes)
        def rows(b):
            n = min(block, l1 + 1 - b)
            raw = np.frombuffer(fetch(url, b * row_bytes, n * row_bytes), dtype).reshape(n, -1)
            return raw[:, s0:s1 + 1]
        with ThreadPoolExecutor(4) as ex:
            parts = list(ex.map(rows, range(l0, l1 + 1, block)))
        return np.concatenate(parts).astype(np.float64) * scale
    def row(l):
        return np.frombuffer(fetch(url, l * row_bytes + s0 * size, width * size), dtype)
    with ThreadPoolExecutor(8) as ex:
        out = list(ex.map(row, range(l0, l1 + 1)))
    return np.stack(out).astype(np.float64) * scale


def local_grid(lat, lon, n):
    """Lat/lon of each point of an n x n east/north grid (row 0 = north) centred on the place."""
    c = (np.arange(n) - (n - 1) / 2) * (2 * HALF_M / (n - 1))
    x, y = np.meshgrid(c, -c)
    d = np.hypot(x, y) / R_MOON
    th = np.arctan2(x, y)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = np.arcsin(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(th))
    l2 = l1 + np.arctan2(np.sin(th) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), np.degrees(l2)


def bilinear(img, line, sample):
    li = np.clip(np.floor(line).astype(int), 0, img.shape[0] - 2)
    si = np.clip(np.floor(sample).astype(int), 0, img.shape[1] - 2)
    fl, fs = line - li, sample - si
    return (img[li, si] * (1 - fl) * (1 - fs) + img[li + 1, si] * fl * (1 - fs)
            + img[li, si + 1] * (1 - fl) * fs + img[li + 1, si + 1] * fl * fs)


def sample_place(lat, lon):
    for limit, name, scale, size, off in POLAR:
        if lat <= limit:
            n = 1025 if scale <= 10 else 513
            glat, glon = local_grid(lat, lon, n)
            rho = 2 * R_MOON * np.tan(np.pi / 4 + np.radians(glat) / 2)
            line = off - rho * np.cos(np.radians(glon)) / scale
            sample = off + rho * np.sin(np.radians(glon)) / scale
            source = f'LOLA {name.upper()} ({scale} m/px)'
            url, row_bytes = f'{BASE}/lola_gdr/polar/img/{name}.img', size * 2
            break
    else:
        # SLDEM2015 tiles: 30 deg of latitude by 45 deg of longitude, east longitude 0-360, heights in km.
        n = 513
        glat, glon = local_grid(lat, lon, n)
        glon = np.mod(glon, 360)
        lo = math.floor(lat / 30) * 30
        hi = lo + 30
        w0 = math.floor((lon % 360) / 45) * 45
        # The equator is written 00n as a lower edge and 00s as an upper edge (00n_30n, 30s_00s).
        tag = lambda v, upper: f'{abs(v):02d}' + ('n' if v > 0 or (v == 0 and not upper) else 's')
        name = f'sldem2015_512_{tag(lo, False)}_{tag(hi, True)}_{w0:03d}_{w0 + 45:03d}_float'
        line = (hi - glat) * 512 - 0.5
        sample = (glon - w0) * 512 - 0.5
        source = 'SLDEM2015, LOLA + Kaguya (512 px/deg, about 59 m)'
        url, row_bytes = f'{BASE}/sldem2015/tiles/float_img/{name}.img', 23040 * 4
        if sample.min() < 0 or sample.max() > 23039 or line.min() < 0 or line.max() > 15359:
            raise RuntimeError(f'{name}: the patch crosses a tile edge')
        l0, l1 = int(np.floor(line.min())), int(np.ceil(line.max())) + 1
        s0, s1 = int(np.floor(sample.min())), int(np.ceil(sample.max())) + 1
        win = read_window(url, row_bytes, l0, l1, s0, s1, '<f4', 1000.0)
        return bilinear(win, line - l0, sample - s0), source, url
    l0, l1 = int(np.floor(line.min())), int(np.ceil(line.max())) + 1
    s0, s1 = int(np.floor(sample.min())), int(np.ceil(sample.max())) + 1
    win = read_window(url, row_bytes, l0, l1, s0, s1)
    h = bilinear(win, line - l0, sample - s0)
    return h, source, url


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / 'index.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    only = set(sys.argv[1:])
    for pid, lat, lon in places():
        if only and pid not in only:
            continue
        if pid in index and not only:
            continue
        h, source, url = sample_place(lat, lon)
        lo, hi = float(h.min()), float(h.max())
        # Lossless RGB PNG: quarter-metres above min_m = red * 256 + green (as the app's other height images).
        q = np.round((h - lo) * 4).astype(np.int64)
        assert q.max() < 65536, 'relief too large for quarter-metre steps'
        rgb = np.stack([q >> 8, q & 255, np.zeros_like(q)], -1).astype(np.uint8)
        Image.fromarray(rgb, 'RGB').save(OUT / f'{pid}.png', optimize=True)
        index[pid] = {'lat': lat, 'lon': lon, 'half_m': HALF_M, 'n': int(h.shape[0]), 'min_m': lo, 'max_m': hi,
                      'source': source, 'url': url}
        index_path.write_text(json.dumps(index, indent=1))
        print(f'{pid:18s} {source:40s} {h.shape[0]} px  relief {hi - lo:7.1f} m', flush=True)


if __name__ == '__main__':
    main()
