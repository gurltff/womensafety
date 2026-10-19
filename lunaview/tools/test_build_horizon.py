"""Check the horizon builder on a synthetic DEM: a 1 km-high ridge due 'east' of a site must show up
near azimuth 90 at the expected angle. Run: python tools/test_build_horizon.py"""
import math

import numpy as np

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build_horizon import R_MOON, horizon_profile, latlon_to_pixel

lab = {"scale_m": 100.0, "line_off": 1000.0, "sample_off": 1000.0}
dem = np.zeros((2001, 2001), dtype=np.float32)

site = (-89.0, 0.0)  # on the lon 0 meridian; east points toward +x in polar stereographic
line0, sample0 = latlon_to_pixel(*site, lab)
ridge_dx_m = 10_000.0
dem[:, int(round(sample0 + ridge_dx_m / lab["scale_m"]))] = 1000.0

hz, _ = horizon_profile(dem, lab, *site, max_km=60, observer_m=0.0)
peak_az = int(np.argmax(hz))
expected = math.degrees(math.atan2(1000.0 - ridge_dx_m ** 2 / (2 * R_MOON), ridge_dx_m))

assert 85 <= peak_az <= 95, peak_az
assert abs(hz[peak_az] - expected) < 0.3, (hz[peak_az], expected)
assert abs(hz[270]) < 0.05, hz[270]  # flat to the west, only curvature
print(f"ok: peak at az {peak_az}, {hz[peak_az]:.2f} deg (expected {expected:.2f})")
