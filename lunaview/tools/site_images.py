#!/usr/bin/env python3
"""Real images of the named places for the site report, from NASA's Scientific Visualization Studio.

Each image is downloaded from svs.gsfc.nasa.gov, cropped where the original is a comparison or
has a blank margin, resized to at most 1000 px and saved to public/sites/ with its credit in
public/sites/index.json. Orbital photos (LRO narrow angle camera, Lunar Orbiter 2) are marked
'photo'; perspective views NASA rendered from LRO heights and images are marked 'render'.
Every spot also gets the LRO wide angle camera mosaic in the app itself.

Run: python3 tools/site_images.py
"""
import io
import json
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'sites'
SVS = 'https://svs.gsfc.nasa.gov/vis/'

# (place ids, svs path, crop box as fractions (l, t, r, b) or None, kind, caption, credit)
IMAGES = [
    (['apollo-11'], 'a010000/a010500/a010595/LRO_A11_lg.jpg', None, 'photo',
     'The Apollo 11 landing site from 50 km up: the descent stage left on the surface, and West crater to the east.',
     'NASA/GSFC/Arizona State University, LRO Narrow Angle Camera (SVS 10595)'),
    (['apollo-14'], 'a010000/a010500/a010595/LRO_A14_lg.png', None, 'photo',
     'The Apollo 14 site at Fra Mauro: the Antares descent stage, the ALSEP experiments and Cone crater, with the astronauts\' foot trails.',
     'NASA/GSFC/Arizona State University, LRO Narrow Angle Camera (SVS 10595)'),
    (['lunokhod-1'], 'a010000/a010500/a010595/LRO_lunakhod1_lg.jpg', None, 'photo',
     'Lunokhod 1 (arrow), the Soviet rover found again by LRO in 2010, 40 years after it landed.',
     'NASA/GSFC/Arizona State University, LRO Narrow Angle Camera (SVS 10595)'),
    (['copernicus'], 'a030000/a030100/a030128/2162_H3_crop_8bit.jpg', None, 'photo',
     'Inside Copernicus crater, photographed by Lunar Orbiter 2 in November 1966: the "picture of the century".',
     'NASA / Lunar Orbiter Image Recovery Project, Lunar Orbiter 2 frame 2162 H3 (SVS 30128)'),
    (['apollo-15'], 'a000000/a004900/a004918/pan.0885_print.jpg', None, 'render',
     'Hadley Rille and the Apennine front around the Apollo 15 landing site, with Hadley Delta on the left.',
     'NASA Goddard SVS, rendered from LRO LOLA heights and LROC images (SVS 4918)'),
    (['apollo-16'], 'a000000/a004900/a004989/apollo16.1800_print.jpg', None, 'render',
     'The Apollo 16 site in the Descartes highlands, with the astronauts\' traverses and North Ray crater.',
     'NASA Goddard SVS, rendered from LRO data (SVS 4989)'),
    (['apollo-17'], 'a000000/a004600/a004619/compare_taurus_littrow.tif', (0, 0, 1, 0.5), 'render',
     'The Taurus-Littrow valley of Apollo 17, with the routes driven on the lunar rover.',
     'NASA Goddard SVS, Tour of the Moon, from LRO data (SVS 4619)'),
    (['tycho'], 'a000000/a004600/a004619/compare_tycho.tif', (0, 0, 1, 0.5), 'render',
     'Tycho crater, 85 km across, with its central peak, seen obliquely.',
     'NASA Goddard SVS, Tour of the Moon, from LRO data (SVS 4619)'),
    (['shackleton-rim', 'connecting-ridge', 'de-gerlache-rim', 'malapert-massif', 'mons-mouton'], 'a000000/a004700/a004770/sp_illum_1deg.tif', None, 'map',
     'How often each part of the south pole is sunlit (white: almost always, black: never). Shackleton crater is the round black floor at the centre.',
     'NASA Goddard SVS, LOLA average illumination (SVS 4770)'),
    (['shackleton-rim'], 'a000000/a004900/a004944/shackleton_earth.0001_print.jpg', None, 'render',
     'Earth low on the horizon above the Shackleton rim, as it always stays from the south pole.',
     'NASA Goddard SVS, rendered from LOLA heights (SVS 4944)'),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for ids, path, crop, kind, caption, credit in IMAGES:
        name = Path(path).stem.replace('.', '_') + '.jpg'
        r = requests.get(SVS + path, timeout=180)
        r.raise_for_status()
        im = Image.open(io.BytesIO(r.content)).convert('RGB')
        if crop:
            w, h = im.size
            im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
        im.thumbnail((1000, 1000))
        im.save(OUT / name, quality=84, optimize=True)
        for pid in ids:
            index.setdefault(pid, []).append({'file': name, 'kind': kind, 'caption': caption, 'credit': credit,
                                              'source': SVS + path})
        print(name, im.size)
    (OUT / 'index.json').write_text(json.dumps(index, indent=1))


if __name__ == '__main__':
    main()
