#!/usr/bin/env python3
"""Measured surface temperatures and rock abundance from LRO Diviner, for the site report.

Temperature: the Diviner Global Cumulative Product (Williams et al. 2017, Icarus 283), the bolometric
temperature of every 0.5 x 0.5 deg bin in 0.25 h steps of local solar time, from all nadir
observations 2009-2015. It is a text table on the PDS Geosciences Node, 113 bytes per row, ordered by
longitude, then latitude, then local time, so the 96 local times of one bin are one 10.8 kB range.
  - public/env/temp_global.png: one 0.5 deg bin every 2 deg (the bin nearest the centre of each
    2 x 2 deg cell), 48 local times (0.5 h, the mean of two 0.25 h bins), as kelvin / 2 in 8 bits.
    Layout: x = lon cell * 48 + local time step, y = lat cell (row 0 = 88-90N).
  - public/env/temp_places.json: the full 96 local times of the bin holding each named place.

Rock abundance: the Diviner rock abundance map (Bandfield et al. 2011, JGR 116), the fraction of
the surface covered by rocks larger than about 1 m, 32 px/deg between 60S and 60N.
  - public/env/rocks.png: averaged to 4 px/deg, per mille in 8 bits (255 = 25.5% or more).
  - the rock fraction at each named place is added to temp_places.json.

Run: python3 tools/fetch_diviner.py
"""
import json
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'env'
CACHE = ROOT / 'data' / 'diviner'
D1 = 'https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1'
GCP = D1 + '/data_derived_gcp/global_cumul_avg_cyl_{band}_002.tab'
RA = D1 + '/data_derived_gdr_l3/cylindrical/img/dgdr_ra_avg_cyl_032_img.img'
ROW = 113

_local = threading.local()


def fetch(url, start, length):
    sess = getattr(_local, 'sess', None) or requests.Session()
    _local.sess = sess
    for attempt in range(10):
        try:
            r = sess.get(url, headers={'Range': f'bytes={start}-{start + length - 1}'}, timeout=120)
            if r.status_code == 206 and len(r.content) == length:
                return r.content
        except Exception:
            sess = _local.sess = requests.Session()
        time.sleep(1 + attempt * 2)
    raise RuntimeError(f'could not read {url} at {start}')


def band_of(lat):
    lo = math.floor(lat / 10) * 10
    hi = lo + 10
    tag = lambda v, upper: f'{abs(v):02d}' + ('n' if v > 0 or (v == 0 and not upper) else 's')
    return f'{tag(lo, False)}{tag(hi, True)}', lo


def bin_series(lat, lon):
    """The 96 local-time temperatures (K, NaN where unobserved) of the 0.5 deg bin holding lat, lon."""
    lat = min(89.99, max(-89.99, lat))
    band, lo = band_of(lat)
    ilon = min(719, int((lon + 180) % 360 // 0.5))
    ilat = min(19, int((lat - lo) // 0.5))
    start = ROW * (1 + (ilon * 20 + ilat) * 96)
    text = fetch(GCP.format(band=band), start, ROW * 96).decode()
    rows = [r.split(',') for r in text.strip().split('\n')]
    clon, clat = float(rows[0][0]), float(rows[0][1])
    assert abs(clon - (-179.75 + ilon * 0.5)) < 1e-3 and abs(abs(clat) - abs(lo + 0.25 + ilat * 0.5)) < 1e-3, (band, clon, clat)
    t = np.array([float(r[10]) for r in rows])
    t[t < 0] = np.nan
    return t, clat, clon


def fill_circular(t):
    """Fill unobserved local times by linear interpolation around the day (wrapping at midnight)."""
    t = t.copy()
    ok = ~np.isnan(t)
    if ok.sum() == 0:
        return t
    n = len(t)
    x = np.arange(n)
    xs = np.concatenate([x[ok] - n, x[ok], x[ok] + n])
    ys = np.concatenate([t[ok]] * 3)
    return np.interp(x, xs, ys)


def places():
    src = (ROOT / 'src' / 'sites.js').read_text()
    pat = re.compile(r"\{ id: '([^']+)', name: (?:'[^']*'|\"[^\"]*\"), lat: (-?[\d.]+), lon: (-?[\d.]+)")
    return [(m[1], float(m[2]), float(m[3])) for m in pat.finditer(src)]


def rock_map():
    CACHE.mkdir(parents=True, exist_ok=True)
    raw_path = CACHE / 'dgdr_ra_avg_cyl_032_img.img'
    size = 3840 * 11520 * 2
    if not raw_path.exists() or raw_path.stat().st_size != size:
        chunk = 8 << 20
        with ThreadPoolExecutor(4) as ex:
            parts = list(ex.map(lambda s: fetch(RA, s, min(chunk, size - s)), range(0, size, chunk)))
        raw_path.write_bytes(b''.join(parts))
    ra = np.fromfile(raw_path, '<i2').reshape(3840, 11520).astype(np.float32)
    ra[ra == -32768] = np.nan
    ra *= 0.001  # fraction of the surface
    return ra  # row 0 = 60N, column 0 = 0E


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # Named places: full series and rock fraction.
    ra = rock_map()
    info = {}
    for pid, lat, lon in places():
        t, clat, clon = bin_series(lat, lon)
        rock = None
        if abs(lat) < 60:
            line = int((60 - lat) * 32)
            samp = int(((lon % 360) * 32)) % 11520
            win = ra[max(0, line - 1):line + 2, max(0, samp - 1):samp + 2]
            rock = None if np.all(np.isnan(win)) else round(float(np.nanmean(win)), 4)
        info[pid] = {'lat': lat, 'lon': lon, 'bin': [clat, clon], 'observed': int((~np.isnan(t)).sum()),
                     'temp_k': [round(float(v), 1) for v in fill_circular(t)], 'rock_fraction': rock}
        print(f'{pid:18s} bin {clat:7.2f} {clon:8.2f}  {info[pid]["observed"]}/96 observed  '
              f'min {np.nanmin(t):5.0f} K max {np.nanmax(t):5.0f} K  rocks {rock}', flush=True)
    (OUT / 'temp_places.json').write_text(json.dumps(info))

    # Rock map at 4 px/deg.
    small = np.nanmean(ra.reshape(480, 8, 1440, 8), axis=(1, 3))
    q = np.where(np.isnan(small), 0, np.clip(np.round(small * 1000), 1, 255)).astype(np.uint8)
    Image.fromarray(q, 'L').save(OUT / 'rocks.png', optimize=True)
    print('rocks.png', q.shape, flush=True)

    # Global temperature grid: 180 x 90 cells of 2 deg, 48 half-hour steps.
    cells = [(j, i) for i in range(90) for j in range(180)]
    def cell(ji):
        j, i = ji
        lat = 89 - 2 * i - 0.1  # the 0.5 deg bin just south-west of the cell centre
        lon = -179 + 2 * j - 0.1
        t, _, _ = bin_series(lat, lon)
        return ji, t
    grid = np.full((90, 180, 96), np.nan)
    done = 0
    with ThreadPoolExecutor(8) as ex:
        for (j, i), t in ex.map(cell, cells):
            grid[i, j] = t
            done += 1
            if done % 1000 == 0:
                print(f'temperature cells {done}/{len(cells)}', flush=True)
    np.save(CACHE / 'temp_grid.npy', grid)
    half = np.nanmean(grid.reshape(90, 180, 48, 2), axis=3)
    filled = np.stack([np.stack([fill_circular(half[i, j]) for j in range(180)]) for i in range(90)])
    # Bins never observed at any local time: take the mean of their neighbours along the latitude row.
    for i in range(90):
        row = filled[i]
        bad = np.isnan(row).any(axis=1)
        if bad.any() and (~bad).any():
            good = np.where(~bad)[0]
            for j in np.where(bad)[0]:
                k = good[np.argmin(np.minimum(abs(good - j), 180 - abs(good - j)))]
                row[j] = row[k]
    q = np.clip(np.round(np.nan_to_num(filled, nan=0) / 2), 0, 255).astype(np.uint8)
    Image.fromarray(q.reshape(90, 180 * 48), 'L').save(OUT / 'temp_global.png', optimize=True)
    print('temp_global.png done', flush=True)


if __name__ == '__main__':
    main()
