import sys, json
sys.path.insert(0, '/home/claude')
from astro_engine import *

BIRTH = dict(year=1991, month=4, day=17, hour=10, minute=41, utc_offset=-7, lat=34.0195, lon=-118.4912)
birth_jd = jd_from_local(BIRTH['year'], BIRTH['month'], BIRTH['day'], BIRTH['hour'], BIRTH['minute'], BIRTH['utc_offset'])

PROG_BODIES = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto']
MAX_AGE = 105

offsets = list(range(0, MAX_AGE + 1))
lon_table = {b: [] for b in PROG_BODIES}
asc_table = []
mc_table = []

for off in offsets:
    jd = birth_jd + off
    for b in PROG_BODIES:
        pos = calc_body(jd, BODIES[b])
        lon_table[b].append(round(pos['lon'], 4))
    cusps, ascmc = get_houses(jd, BIRTH['lat'], BIRTH['lon'], b'P')
    asc_table.append(round(ascmc[0], 4))
    mc_table.append(round(ascmc[1], 4))

out = {'birth_jd_ut': birth_jd, 'max_age': MAX_AGE, 'age_offsets': offsets,
       'lon': lon_table, 'ascendant': asc_table, 'midheaven': mc_table}

with open('/home/claude/progressions_table.json', 'w') as f:
    json.dump(out, f, separators=(',',':'))

import os
print(f"Size: {os.path.getsize('/home/claude/progressions_table.json')/1024:.1f} KB, {len(offsets)} age points")
