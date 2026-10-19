"""Build a 360-degree terrain horizon for a lunar south-pole site from a LOLA polar DEM.

Output: public/horizons/<site-id>.json  ->  {"site": ..., "lat": ..., "lon": ..., "horizon": [360 floats, deg]}
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

    img_name = val("\\^IMAGE", str) or Path(lbl_path).with_suffix(".IMG").name
    return {
        "lines": val("LINES", int),
        "samples": val("LINE_SAMPLES", int),
        "bits": val("SAMPLE_BITS", int, 32),
        "sample_type": val("SAMPLE_TYPE", str, "PC_REAL"),
        "scale_m": val("MAP_SCALE") * 1000.0,  # label gives km/pixel
        "line_off": val("LINE_PROJECTION_OFFSET"),
        "sample_off": val("SAMPLE_PROJECTION_OFFSET"),
        "factor": val("SCALING_FACTOR", float, 1.0),
        "offset": val("OFFSET", float, 0.0),
        "img": Path(lbl_path).parent / img_name.strip("()\"'"),
    }


def load_dem(lbl_path):
    lab = read_pds_label(lbl_path)
    little = "LSB" in lab["sample_type"] or "PC" in lab["sample_type"]
    if lab["bits"] == 32:
        dtype = "<f4" if little else ">f4"
    else:
        dtype = "<i2" if little else ">i2"
    raw = np.fromfile(lab["img"], dtype=dtype, count=lab["lines"] * lab["samples"])
    dem = raw.reshape(lab["lines"], lab["samples"]).astype(np.float32) * lab["factor"] + lab["offset"]
    if lab["factor"] == 1.0 and lab["bits"] == 32 and np.nanmax(np.abs(dem)) < 50:
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


def horizon_profile(dem, lab, lat, lon, max_km=150.0, observer_m=2.0, n_az=360):
    """Elevation angle of the skyline for n_az azimuths, including lunar curvature."""
    line0, sample0 = latlon_to_pixel(lat, lon, lab)
    h0 = float(sample_bilinear(dem, np.array([line0]), np.array([sample0]))[0]) + observer_m
    step = lab["scale_m"]
    dists = np.concatenate([np.arange(step, 5000, step), np.geomspace(5000, max_km * 1000, 600)])
    out = []
    for i in range(n_az):
        az = i * 360.0 / n_az
        la, lo = destination(lat, lon, az, dists)
        ln, sm = latlon_to_pixel(la, lo, lab)
        h = sample_bilinear(dem, ln, sm)
        # The surface curves away by d^2 / 2R, which lowers distant peaks.
        drop = dists ** 2 / (2 * R_MOON)
        ang = np.degrees(np.arctan2(h - h0 - drop, dists))
        out.append(float(np.nanmax(ang)) if np.isfinite(ang).any() else 0.0)
    return out, h0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", required=True, help="PDS .LBL file of a LOLA south polar stereographic DEM")
    ap.add_argument("--site", required=True, help="site id, e.g. shackleton-rim")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--max-km", type=float, default=150.0)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public" / "horizons"))
    a = ap.parse_args()

    dem, lab = load_dem(a.dem)
    hz, h0 = horizon_profile(dem, lab, a.lat, a.lon, a.max_km)
    out = Path(a.out) / f"{a.site}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "site": a.site, "lat": a.lat, "lon": a.lon, "site_height_m": round(h0, 1),
        "source": Path(a.dem).name, "horizon": [round(v, 3) for v in hz],
    }))
    print(f"wrote {out}  (max skyline {max(hz):.2f} deg at az {hz.index(max(hz))})")


if __name__ == "__main__":
    main()
