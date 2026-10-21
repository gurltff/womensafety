"""Build the sky data for the planetarium from d3-celestial (BSD-3, Olaf Frohn; stars from the
Hipparcos catalogue, constellation lines and Milky Way outlines) and NASA's Blue Marble.

Inputs (downloaded by fetch_sky.sh into data/sky_src/): stars.8.json, starnames.json,
constellations.json, constellations.lines.json, mw.json, flat_earth_Largest_still.0330.jpg.
Outputs in public/sky/: stars.json, constellations.json, milkyway.png, earth.jpg.
"""
import json, math, os
from PIL import Image, ImageDraw, ImageFilter

SRC = os.path.join(os.path.dirname(__file__), '..', 'data', 'sky_src')
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'sky')
os.makedirs(OUT, exist_ok=True)
MAG_LIMIT = 7.5

def load(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return json.load(f)

# ---- stars: flat arrays [ra, dec, mag, bv, hip] plus names for named stars ----
stars = load('stars.8.json')['features']
names = load('starnames.json')
ra, dec, mag, bv, hip = [], [], [], [], []
named = {}
for s in sorted(stars, key=lambda s: s['properties']['mag']):
    m = s['properties']['mag']
    if m is None or m > MAG_LIMIT:
        continue
    lon, lat = s['geometry']['coordinates']
    ra.append(round(lon % 360, 4)); dec.append(round(lat, 4)); mag.append(round(m, 2))
    try:
        bv.append(round(float(s['properties'].get('bv') or 0.6), 2))
    except ValueError:
        bv.append(0.6)
    hip.append(s['id'])
    n = names.get(str(s['id']))
    if n:
        desig = (n.get('bayer') or n.get('flam') or n.get('var') or '').strip()
        named[str(s['id'])] = {
            'name': n.get('name', ''), 'desig': f"{desig} {n.get('c', '')}".strip() if desig else '',
            'hd': n.get('hd', ''), 'c': n.get('c', ''),
        }
json.dump({'source': 'Hipparcos via d3-celestial', 'ra': ra, 'dec': dec, 'mag': mag, 'bv': bv, 'hip': hip, 'names': named},
          open(os.path.join(OUT, 'stars.json'), 'w'), separators=(',', ':'))
print('stars', len(ra), 'named', sum(1 for v in named.values() if v['name']))

# ---- constellations: line segments and label points ----
lines = []
for f in load('constellations.lines.json')['features']:
    for strip in f['geometry']['coordinates']:
        lines.append({'c': f['id'], 'p': [[round(p[0] % 360, 3), round(p[1], 3)] for p in strip]})
labels = [{'id': f['id'], 'name': f['properties']['name'], 'rank': int(f['properties'].get('rank', 3)),
           'ra': round(f['geometry']['coordinates'][0] % 360, 3), 'dec': round(f['geometry']['coordinates'][1], 3)}
          for f in load('constellations.json')['features']]
json.dump({'lines': lines, 'labels': labels}, open(os.path.join(OUT, 'constellations.json'), 'w'), separators=(',', ':'))
print('constellation strips', len(lines), 'labels', len(labels))

# ---- Milky Way: the five brightness levels, projected by tools/mw_rings.mjs, filled even-odd ----
from PIL import ImageChops
W, H = 2048, 1024
acc = Image.new('L', (W, H), 0)
for level, rings in enumerate(load('mw_rings.json')):
    layer = Image.new('1', (W, H), 0)
    for r in rings:
        m = Image.new('1', (W, H), 0)
        ImageDraw.Draw(m).polygon([tuple(p) for p in r], fill=1)
        layer = ImageChops.logical_xor(layer, m)
    acc = Image.composite(Image.new('L', (W, H), min(255, 40 + level * 45)), acc, layer.convert('L'))
acc = acc.filter(ImageFilter.GaussianBlur(5))
acc.save(os.path.join(OUT, 'milkyway.png'), optimize=True)
print('milky way map', acc.size)

# ---- Earth: NASA Blue Marble Next Generation (SVS 3615), 4096 x 2048 ----
Image.MAX_IMAGE_PIXELS = None
src = os.path.join(SRC, 'flat_earth_Largest_still.0330.jpg')
if os.path.exists(src):
    Image.open(src).convert('RGB').resize((4096, 2048), Image.LANCZOS).save(os.path.join(OUT, 'earth.jpg'), quality=88)
    print('earth texture written')
