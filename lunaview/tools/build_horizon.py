"""Build a 360-degree terrain horizon for a lunar south-pole site from a LOLA polar DEM.

Output: src/horizons/<site-id>.json  ->  {"site": ..., "lat": ..., "lon": ..., "horizon": [360 floats, deg]}
horizon[i] is the elevation angle (degrees) of the skyline at azimuth i (0 = north, 90 = east).

Input DEM: a LOLA south polar stereographic product in PDS3 form (an .IMG file with its .LBL),
e.g. LDEM_80S_80M.IMG / LDEM_875S_20M.IMG from the LOLA PDS archive or NASA PGDA.
Heights are read as float32 (or int16 scaled, per the label) in metres relative to 1737.4 km.

Usage:
  python tools/build_horizon.py --dem LDEM_80S_80M.LBL --site shackleton-rim --lat -89.68 --lon -166.0
"""
import argparse
import json
import math
import re
from pathlib import Path

import numpy as np

R_MOON = 1737400.0  # metres


def read_pds_label(lbl_path):
    text = Path(lbl_path).read_text(errors="ignore")

    def val(key, cast=float, default=None):
        m = re.search(rf"^\s*{key}\s*=\s*\"?([^\s\"<]+)", text, re.M)
        return cast(m.group(1)) if m else default

    img_name = (val("\\^IMAGE", str) or Path(lbl_path).with_suffix(".IMG").name).strip("()\"'")
    # PDS file names are often upper case in the label but lower case on disk.
    folder = Path(lbl_path).parent
    img = next((p for p in folder.iterdir() if p.name.lower() == img_name.lower()), folder / img_name)
    scale_m = re.search(r"^\s*MAP_SCALE\s*=\s*([\d.]+)\s*<(\w+)/", text, re.M)
    return {
        "lines": val("LINES", int),
        "samples": val("LINE_SAMPLES", int),
        "bits": val("SAMPLE_BITS", int, 32),
        "sample_type": val("SAMPLE_TYPE", str, "PC_REAL"),
        "scale_m": float(scale_m.group(1)) * (1000.0 if scale_m.group(2).upper() == "KM" else 1.0),
        "line_off": val("LINE_PROJECTION_OFFSET"),
        "sample_off": val("SAMPLE_PROJECTION_OFFSET"),
        "factor": val("SCALING_FACTOR", float, 1.0),
        "offset": val("OFFSET", float, 0.0),
        "img": img,
    }


def load_dem(lbl_path):
    lab = read_pds_label(lbl_path)
    little = "LSB" in lab["sample_type"] or "PC" in lab["sample_type"]
    if lab["bits"] == 32:
        dtype = "<f4" if little else ">f4"
    else:
        dtype = "<i2" if little else ">i2"
    raw = np.fromfile(lab["img"], dtype=dtype, count=lab["lines"] * lab["samples"])
    # OFFSET in LOLA labels is the reference radius (1737.4 km), not part of the height.
    offset = 0.0 if abs(lab["offset"] - R_MOON) < 1.0 else lab["offset"]
    dem = raw.reshape(lab["lines"], lab["samples"]).astype(np.float32) * lab["factor"] + offset
    if lab["bits"] == 32 and np.nanmax(np.abs(dem)) < 50:
        dem *= 1000.0  # some products store km
    return dem, lab


def latlon_to_pixel(lat, lon, lab):
    """South polar stereographic (PDS convention) -> fractional (line, sample)."""
    rho = 2 * R_MOON * np.tan(np.pi / 4 + np.radians(lat) / 2)
    x = rho * np.sin(np.radians(lon))
    y = rho * np.cos(np.radians(lon))
    sample = lab["sample_off"] + x / lab["scale_m"]
    line = lab["line_off"] - y / lab["scale_m"]
    return line, sample


def destination(lat, lon, az_deg, dist_m):
    """Great-circle destination from (lat, lon) along azimuth (deg from north) for distances (m)."""
    p1, l1 = math.radians(lat), math.radians(lon)
    th = np.radians(az_deg)
    d = np.asarray(dist_m) / R_MOON
    p2 = np.arcsin(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(th))
    l2 = l1 + np.arctan2(np.sin(th) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), np.degrees(l2)


def sample_bilinear(dem, line, sample):
    h, w = dem.shape
    ok = (line >= 0) & (line < h - 1) & (sample >= 0) & (sample < w - 1)
    li = np.clip(np.floor(line).astype(int), 0, h - 2)
    si = np.clip(np.floor(sample).astype(int), 0, w - 2)
    fl, fs = line - li, sample - si
    v = (dem[li, si] * (1 - fl) * (1 - fs) + dem[li + 1, si] * fl * (1 - fs)
         + dem[li, si + 1] * (1 - fl) * fs + dem[li + 1, si + 1] * fl * fs)
    return np.where(ok, v, np.nan)


def site_height(dem, lab, lat, lon):
    line, sample = latlon_to_pixel(lat, lon, lab)
    return float(sample_bilinear(dem, np.array([line]), np.array([sample]))[0])


def pixel_to_latlon(line, sample, lab):
    x = (sample - lab["sample_off"]) * lab["scale_m"]
    y = (lab["line_off"] - line) * lab["scale_m"]
    lat = np.degrees(2 * np.arctan(np.hypot(x, y) / (2 * R_MOON))) - 90.0
    return float(lat), float(np.degrees(np.arctan2(x, y)))


def snap_to_high_point(dem, lab, lat, lon, radius_km):
    """Move the site to the highest DEM point within radius_km (landers aim for ridge crests)."""
    line, sample = latlon_to_pixel(lat, lon, lab)
    r = int(radius_km * 1000 / lab["scale_m"])
    l0, s0 = int(round(line)), int(round(sample))
    win = dem[max(l0 - r, 0):l0 + r + 1, max(s0 - r, 0):s0 + r + 1]
    yy, xx = np.mgrid[:win.shape[0], :win.shape[1]]
    dist = np.hypot(yy + max(l0 - r, 0) - l0, xx + max(s0 - r, 0) - s0)
    masked = np.where(dist <= r, win, -np.inf)
    i, j = np.unravel_index(np.argmax(masked), masked.shape)
    return pixel_to_latlon(i + max(l0 - r, 0), j + max(s0 - r, 0), lab)


def horizon_profile(dem, lab, lat, lon, max_km=150.0, observer_m=2.0, n_az=360, h0=None):
    """Elevation angle of the skyline for n_az azimuths, including lunar curvature.
    h0 (metres) overrides the site height so several DEMs can share one reference."""
    if h0 is None:
        h0 = site_height(dem, lab, lat, lon)
    h0 += observer_m
    step = lab["scale_m"]
    dists = np.concatenate([np.arange(step, 5000, step), np.geomspace(5000, max_km * 1000, 600)])
    drop = dists ** 2 / (2 * R_MOON)  # the surface curves away, which lowers distant peaks
    out = []
    for i in range(n_az):
        az = i * 360.0 / n_az
        la, lo = destination(lat, lon, az, dists)
        ln, sm = latlon_to_pixel(la, lo, lab)
        h = sample_bilinear(dem, ln, sm)
        ang = np.degrees(np.arctan2(h - h0 - drop, dists))
        out.append(float(np.nanmax(ang)) if np.isfinite(ang).any() else -90.0)
    return out, h0 - observer_m


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", required=True, action="append",
                    help="PDS .LBL of a LOLA south polar DEM; repeat to combine a fine local DEM with a wide one")
    ap.add_argument("--site", required=True, help="site id, e.g. shackleton-rim")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--snap-km", type=float, default=0.0, help="move the site to the highest point within this radius")
    ap.add_argument("--max-km", type=float, default=150.0)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "src" / "horizons"))
    a = ap.parse_args()

    dems = [load_dem(d) for d in a.dem]
    # Finest DEM that covers the site sets the site position and height.
    dems.sort(key=lambda d: d[1]["scale_m"])
    lat, lon = a.lat, a.lon
    fine = next(d for d in dems if np.isfinite(site_height(d[0], d[1], lat, lon)))
    if a.snap_km > 0:
        lat, lon = snap_to_high_point(fine[0], fine[1], lat, lon, a.snap_km)
    h0 = site_height(fine[0], fine[1], lat, lon)
    hz = None
    for dem, lab in dems:
        prof, _ = horizon_profile(dem, lab, lat, lon, a.max_km, h0=h0)
        hz = prof if hz is None else [max(p, q) for p, q in zip(hz, prof)]
    out = Path(a.out) / f"{a.site}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "site": a.site, "lat": round(lat, 4), "lon": round(lon, 4), "site_height_m": round(h0, 1),
        "source": [Path(d).name for d in a.dem], "horizon": [round(v, 3) for v in hz],
    }))
    print(f"{a.site}: {lat:.3f}, {lon:.3f}  height {h0:.0f} m  skyline max {max(hz):.2f} deg, min {min(hz):.2f} deg")


if __name__ == "__main__":
    main()
