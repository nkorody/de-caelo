import json, sys
sys.path.insert(0, '/home/claude')
from astro_engine import *

# ---- Birth data ----
BIRTH = dict(year=1991, month=4, day=17, hour=10, minute=41, utc_offset=-7,  # PDT
             lat=34.0195, lon=-118.4912, place='Santa Monica, CA')

jd_ut = jd_from_local(BIRTH['year'], BIRTH['month'], BIRTH['day'], BIRTH['hour'], BIRTH['minute'], BIRTH['utc_offset'])

# ---- Bodies ----
raw = {name: calc_body(jd_ut, code) for name, code in BODIES.items()}
lons = {name: raw[name]['lon'] for name in raw}
lons['South Node'] = norm360(lons['North Node'] + 180)
raw['South Node'] = {'lon': lons['South Node'], 'lat': -raw['North Node']['lat'], 'dist': raw['North Node']['dist'], 'speed_lon': raw['North Node']['speed_lon']}

# ---- Houses & angles (Placidus + Whole Sign) ----
cusps_p, ascmc_p = get_houses(jd_ut, BIRTH['lat'], BIRTH['lon'], b'P')
cusps_w, ascmc_w = get_houses(jd_ut, BIRTH['lat'], BIRTH['lon'], b'W')
ASC, MC, ARMC, VERTEX = ascmc_p[0], ascmc_p[1], ascmc_p[2], ascmc_p[3]
DSC = norm360(ASC + 180)
IC = norm360(MC + 180)
lons['Ascendant'] = ASC
lons['Midheaven'] = MC
lons['Descendant'] = DSC
lons['Imum Coeli'] = IC
lons['Vertex'] = VERTEX

# ---- Sect ----
sun_house = house_of(lons['Sun'], cusps_p)
is_day = sun_house >= 7  # above horizon
sect_light = 'Sun' if is_day else 'Moon'

# ---- House placements for all bodies ----
houses = {name: house_of(lon, cusps_p) for name, lon in lons.items() if name not in ('Ascendant','Midheaven','Descendant','Imum Coeli','Vertex')}
houses_whole = {name: house_of(lon, cusps_w) for name, lon in lons.items() if name not in ('Ascendant','Midheaven','Descendant','Imum Coeli','Vertex')}

# ---- Sign placements ----
placements = {name: deg_to_sign(lon) for name, lon in lons.items()}

# ---- Essential dignities (traditional 7) ----
TRAD7 = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn']
dignities = {}
for name in TRAD7:
    p = placements[name]
    score, tags = essential_dignity(name, p['sign'], p['sign_lon'], is_day)
    dignities[name] = {'score': score, 'tags': tags}

# ---- Aspects (natal, all bodies + angles) ----
aspect_points = {k: v for k, v in lons.items() if k not in ('Imum Coeli',)}
aspects = find_aspects(aspect_points)

# ---- Dispositor chains (modern + traditional) ----
def build_chains(ruler_table):
    disposits_to = {}
    for p in TRAD7 + ['Uranus','Neptune','Pluto']:
        sign = placements[p]['sign']
        disposits_to[p] = ruler_table[sign]
    chains = {}
    for p in disposits_to:
        chain = [p]
        cur = p
        seen = set([p])
        while True:
            nxt = disposits_to.get(cur)
            if nxt is None:
                break
            if nxt == cur:
                chain.append(nxt)
                break
            if nxt in seen:
                chain.append(nxt)
                break
            chain.append(nxt)
            seen.add(nxt)
            cur = nxt
        chains[p] = chain
    return disposits_to, chains

disp_modern, chains_modern = build_chains(RULER_MODERN)
disp_trad, chains_trad = build_chains(RULER_TRAD)

# ---- Fixed stars conjunct planets/angles (orb 1.2 deg, applies to longitude only) ----
star_hits = []
check_points = {**{k:v for k,v in lons.items() if k in list(BODIES.keys())+['South Node']}, 'Ascendant': ASC, 'Midheaven': MC}
for star in FIXED_STARS:
    try:
        res = swe.fixstar2_ut(star, jd_ut)
        star_lon = res[0][0]
        star_name = res[1]
        for pname, plon in check_points.items():
            sep = angular_sep(star_lon, plon)
            if sep <= 1.5:
                star_hits.append({'star': star_name.split(',')[0], 'point': pname, 'orb': round(sep,3), 'star_lon': round(star_lon,3)})
    except Exception as e:
        pass

# ---- Arabic parts ----
parts = arabic_parts(ASC, lons['Sun'], lons['Moon'], lons['Mercury'], lons['Venus'], lons['Mars'], lons['Jupiter'], lons['Saturn'], is_day)
parts_placements = {k: deg_to_sign(v) for k, v in parts.items()}
parts_houses = {k: house_of(v, cusps_p) for k, v in parts.items()}
parts_houses_whole = {k: house_of(v, cusps_w) for k, v in parts.items()}

# ---- Harmonics (5H, 7H, 9H) ----
harmonic_lons_base = {k: v for k, v in lons.items() if k in list(BODIES.keys()) + ['South Node','Ascendant','Midheaven']}
harmonics = {}
for h in [5, 7, 9]:
    hp = harmonic_positions(harmonic_lons_base, h)
    harmonics[h] = {k: deg_to_sign(v) for k, v in hp.items()}
    harmonics[f'{h}_aspects'] = find_aspects(hp)

# ---- Element / modality balance ----
elem_count = {'Fire':0,'Earth':0,'Air':0,'Water':0}
mod_count = {'Cardinal':0,'Fixed':0,'Mutable':0}
WEIGHTED = PERSONAL + SOCIAL + OUTER + ['Ascendant']
for p in WEIGHTED:
    sign = placements[p]['sign']
    elem_count[ELEMENTS[sign]] += 1
    mod_count[MODALITIES[sign]] += 1

# ---- Chart ruler (ruler of Ascendant sign) ----
asc_sign = placements['Ascendant']['sign']
chart_ruler_modern = RULER_MODERN[asc_sign]
chart_ruler_trad = RULER_TRAD[asc_sign]

natal = {
    'birth': BIRTH,
    'jd_ut': jd_ut,
    'sect': {'is_day': is_day, 'light': sect_light, 'sun_house': sun_house},
    'points': {name: {'lon': round(lons[name],5), **placements[name],
                        'house_placidus': houses.get(name), 'house_whole_sign': houses_whole.get(name),
                        'speed': round(raw.get(name,{}).get('speed_lon',0),5) if name in raw else None,
                        'retrograde': (raw.get(name,{}).get('speed_lon',0) < 0) if name in raw else False}
               for name in lons},
    'houses_placidus': {'cusps': [round(c,4) for c in cusps_p[:12]]},
    'houses_whole_sign': {'cusps': [round(c,4) for c in cusps_w[:12]]},
    'angles': {'ASC': round(ASC,4), 'MC': round(MC,4), 'DSC': round(DSC,4), 'IC': round(IC,4), 'Vertex': round(VERTEX,4)},
    'chart_ruler': {'modern': chart_ruler_modern, 'traditional': chart_ruler_trad, 'asc_sign': asc_sign},
    'dignities': dignities,
    'aspects': aspects,
    'dispositors': {'modern': {'map': disp_modern, 'chains': chains_modern},
                     'traditional': {'map': disp_trad, 'chains': chains_trad}},
    'fixed_stars': star_hits,
    'arabic_parts': {k: {**parts_placements[k], 'house': parts_houses[k],
                          'house_placidus': parts_houses[k], 'house_whole_sign': parts_houses_whole[k]} for k in parts},
    'harmonics': {str(h): {'positions': harmonics[h], 'aspects': harmonics[f'{h}_aspects']} for h in [5,7,9]},
    'balance': {'elements': elem_count, 'modalities': mod_count},
}

# ---- Current progressions & solar arc (as of "today") ----
import datetime
today = datetime.date(2026, 8, 19)
prog_lons, prog_jd, age_years = secondary_progressions(jd_ut, (today.year, today.month, today.day), BIRTH['lat'], BIRTH['lon'])
directed_lons, solar_arc, _ = solar_arc_directions(lons, jd_ut, (today.year, today.month, today.day))

natal['current_snapshot'] = {
    'as_of': today.isoformat(),
    'age_years': round(age_years, 4),
    'progressions': {name: {'lon': round(v,4), **deg_to_sign(v)} for name, v in prog_lons.items()},
    'progressed_aspects_to_natal': [a for a in find_aspects({**{f'P_{k}':v for k,v in prog_lons.items()}, **{f'N_{k}':v for k,v in lons.items()}}) if a['p1'][:2] != a['p2'][:2]],
    'solar_arc_deg': round(solar_arc, 5),
    'solar_arc_directed': {name: {'lon': round(v,4), **deg_to_sign(v)} for name, v in directed_lons.items()},
}

with open('/home/claude/natal_data.json', 'w') as f:
    json.dump(natal, f, indent=2)

print("Sect:", sect_light, "| Day chart:", is_day, "| Sun house:", sun_house)
print("Ascendant:", fmt_dms(ASC), "| MC:", fmt_dms(MC))
print("Chart ruler (modern):", chart_ruler_modern, "| (trad):", chart_ruler_trad)
print("\n-- Dignities --")
for k,v in dignities.items():
    print(f"  {k}: {v['score']:+d}  {v['tags']}")
print("\n-- Fixed star hits (orb <=1.2deg) --")
for h in star_hits:
    print(f"  {h['point']} conjunct {h['star']} (orb {h['orb']}\u00b0)")
print("\n-- Arabic Parts --")
for k,v in parts_placements.items():
    print(f"  {k}: {v['deg']}\u00b0{v['min']:02d}' {v['sign']}  (house {parts_houses[k]})")
print(f"\nTotal aspects found: {len(aspects)}")
print("Elements:", elem_count, "Modalities:", mod_count)
