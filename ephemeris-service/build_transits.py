import sys, json, datetime
sys.path.insert(0, '/home/claude')
from astro_engine import *

START = datetime.date(2024, 1, 1)
END = datetime.date(2034, 12, 31)
TRANSIT_BODIES = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto','Chiron','North Node']

dates = []
series = {b: [] for b in TRANSIT_BODIES}
speed_series = {b: [] for b in TRANSIT_BODIES}

d = START
while d <= END:
    jd = swe.julday(d.year, d.month, d.day, 12.0)  # noon UT snapshot per day
    dates.append(d.isoformat())
    for b in TRANSIT_BODIES:
        pos = calc_body(jd, BODIES[b])
        series[b].append(round(pos['lon'], 3))
        speed_series[b].append(round(pos['speed_lon'], 4))
    d += datetime.timedelta(days=1)

out = {
    'start': START.isoformat(), 'end': END.isoformat(), 'bodies': TRANSIT_BODIES,
    'dates': dates, 'lon': series, 'speed': speed_series,
}
with open('/home/claude/transit_window.json', 'w') as f:
    json.dump(out, f, separators=(',',':'))

import os
sz = os.path.getsize('/home/claude/transit_window.json')
print(f"Days: {len(dates)}  |  File size: {sz/1024:.1f} KB")
