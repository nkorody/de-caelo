"""
Astro Engine — full-depth natal chart + transit/progression/solar-arc computation
Powered by the Swiss Ephemeris (JPL-derived .se1 data files, arcsecond precision).
"""
import swisseph as swe
import json, math, os

EPHE_PATH = os.path.join(os.path.dirname(__file__), 'ephe')
swe.set_ephe_path(EPHE_PATH)

SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces']
SIGN_GLYPH = ['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓']
ELEMENTS = {'Aries':'Fire','Leo':'Fire','Sagittarius':'Fire','Taurus':'Earth','Virgo':'Earth','Capricorn':'Earth',
            'Gemini':'Air','Libra':'Air','Aquarius':'Air','Cancer':'Water','Scorpio':'Water','Pisces':'Water'}
MODALITIES = {'Aries':'Cardinal','Cancer':'Cardinal','Libra':'Cardinal','Capricorn':'Cardinal',
              'Taurus':'Fixed','Leo':'Fixed','Scorpio':'Fixed','Aquarius':'Fixed',
              'Gemini':'Mutable','Virgo':'Mutable','Sagittarius':'Mutable','Pisces':'Mutable'}

# Modern + traditional rulership tables
RULER_MODERN = {'Aries':'Mars','Taurus':'Venus','Gemini':'Mercury','Cancer':'Moon','Leo':'Sun','Virgo':'Mercury',
                 'Libra':'Venus','Scorpio':'Pluto','Sagittarius':'Jupiter','Capricorn':'Saturn','Aquarius':'Uranus','Pisces':'Neptune'}
RULER_TRAD = {'Aries':'Mars','Taurus':'Venus','Gemini':'Mercury','Cancer':'Moon','Leo':'Sun','Virgo':'Mercury',
              'Libra':'Venus','Scorpio':'Mars','Sagittarius':'Jupiter','Capricorn':'Saturn','Aquarius':'Saturn','Pisces':'Jupiter'}
EXALTATION = {'Aries':('Sun',19),'Taurus':('Moon',3),'Cancer':('Jupiter',15),'Virgo':('Mercury',15),
              'Libra':('Saturn',21),'Capricorn':('Mars',28),'Pisces':('Venus',27),'Gemini':('North Node', 3),
              'Leo':(None,None),'Scorpio':(None,None),'Sagittarius':(None,None),'Aquarius':(None,None)}
FALL_SIGN = {'Libra':'Sun','Scorpio':'Moon','Capricorn':'Jupiter','Pisces':'Mercury','Aries':'Saturn','Cancer':'Mars','Virgo':'Venus'}
DETRIMENT = {s: RULER_TRAD[SIGNS[(i+6)%12]] for i,s in enumerate(SIGNS)}  # ruler of opposite sign

# Triplicity rulers (day, night, participating) — Dorothean/traditional
TRIPLICITY = {
    'Fire': ('Sun','Jupiter','Saturn'),
    'Earth': ('Venus','Moon','Mars'),
    'Air': ('Saturn','Mercury','Jupiter'),
    'Water': ('Venus','Mars','Moon'),
}

# Egyptian terms (degrees are UPPER bound of each term, ruler applies up to that degree)
TERMS = {
 'Aries':[(6,'Jupiter'),(12,'Venus'),(20,'Mercury'),(25,'Mars'),(30,'Saturn')],
 'Taurus':[(8,'Venus'),(14,'Mercury'),(22,'Jupiter'),(27,'Saturn'),(30,'Mars')],
 'Gemini':[(6,'Mercury'),(12,'Jupiter'),(17,'Venus'),(24,'Mars'),(30,'Saturn')],
 'Cancer':[(7,'Mars'),(13,'Venus'),(19,'Mercury'),(26,'Jupiter'),(30,'Saturn')],
 'Leo':[(6,'Saturn'),(11,'Mercury'),(18,'Venus'),(24,'Jupiter'),(30,'Mars')],
 'Virgo':[(7,'Mercury'),(17,'Venus'),(21,'Saturn'),(28,'Jupiter'),(30,'Mars')],
 'Libra':[(6,'Saturn'),(14,'Mercury'),(21,'Jupiter'),(28,'Venus'),(30,'Mars')],
 'Scorpio':[(7,'Mars'),(11,'Venus'),(19,'Mercury'),(24,'Jupiter'),(30,'Saturn')],
 'Sagittarius':[(12,'Jupiter'),(17,'Venus'),(21,'Mercury'),(26,'Saturn'),(30,'Mars')],
 'Capricorn':[(7,'Mercury'),(14,'Jupiter'),(22,'Venus'),(26,'Saturn'),(30,'Mars')],
 'Aquarius':[(7,'Mercury'),(13,'Venus'),(20,'Jupiter'),(25,'Mars'),(30,'Saturn')],
 'Pisces':[(12,'Venus'),(16,'Jupiter'),(19,'Mercury'),(28,'Mars'),(30,'Saturn')],
}

# Chaldean decan/face order starting from Mars for Aries decan 1
CHALDEAN_ORDER = ['Mars','Sun','Venus','Mercury','Moon','Saturn','Jupiter']
def face_ruler(sign, deg_in_sign):
    sign_idx = SIGNS.index(sign)
    decan = int(deg_in_sign // 10)  # 0,1,2
    start_index = (sign_idx * 3) % 7
    return CHALDEAN_ORDER[(start_index + decan) % 7]

BODIES = {
    'Sun': swe.SUN, 'Moon': swe.MOON, 'Mercury': swe.MERCURY, 'Venus': swe.VENUS, 'Mars': swe.MARS,
    'Jupiter': swe.JUPITER, 'Saturn': swe.SATURN, 'Uranus': swe.URANUS, 'Neptune': swe.NEPTUNE, 'Pluto': swe.PLUTO,
    'Chiron': swe.CHIRON, 'Ceres': swe.CERES, 'Pallas': swe.PALLAS, 'Juno': swe.JUNO, 'Vesta': swe.VESTA,
    'North Node': swe.TRUE_NODE, 'Black Moon Lilith': swe.OSCU_APOG,
}
PERSONAL = ['Sun','Moon','Mercury','Venus','Mars']
SOCIAL = ['Jupiter','Saturn']
OUTER = ['Uranus','Neptune','Pluto']

ASPECTS = [
    ('Conjunction', 0, 8), ('Opposition', 180, 8), ('Trine', 120, 7), ('Square', 90, 7), ('Sextile', 60, 5),
    ('Quincunx', 150, 3), ('Semisextile', 30, 2), ('Semisquare', 45, 2), ('Sesquiquadrate', 135, 2),
    ('Quintile', 72, 1.5), ('Biquintile', 144, 1.5),
]
HARD_SOFT = {'Conjunction':'neutral','Opposition':'hard','Square':'hard','Trine':'soft','Sextile':'soft',
             'Quincunx':'tense','Semisextile':'minor','Semisquare':'minor','Sesquiquadrate':'minor',
             'Quintile':'creative','Biquintile':'creative'}

FIXED_STARS = ['Aldebaran','Regulus','Antares','Fomalhaut','Spica','Algol','Sirius','Alcyone','Vindemiatrix',
               'Rigel','Betelgeuse','Vega','Capella','Arcturus','Deneb Algedi','Zosma','Praesepe','Facies',
               'Bellatrix','Pollux','Castor','Denebola','Alphecca','Al Niyat','Sabik','Zuben Elgenubi',
               'Zuben Eschamali','Markab','Scheat','Alpheratz','Menkar','Hamal','Wasat','Acumen','Ancha',
               'Alderamin','Terebellum','Sadalsuud','Sadalmelik','Deneb Adige','Altair','Achernar','Canopus',
               'Alphard','Alkaid','Dubhe','Mirach','Diadem','Toliman','Agena','Unukalhai','Yed Prior']

def norm360(x):
    x = x % 360
    return x + 360 if x < 0 else x

def deg_to_sign(lon):
    lon = norm360(lon)
    idx = int(lon // 30)
    pos = lon % 30
    d = int(pos)
    m = int((pos - d) * 60)
    s = round((((pos - d) * 60) - m) * 60)
    return {'sign': SIGNS[idx], 'glyph': SIGN_GLYPH[idx], 'deg': d, 'min': m, 'sec': s, 'abs_lon': lon, 'sign_lon': pos}

def fmt_dms(lon):
    p = deg_to_sign(lon)
    return f"{p['deg']}\u00b0{p['min']:02d}'{p['sign']}"

def jd_from_local(year, month, day, hour, minute, utc_offset_hours):
    ut_hour = hour + minute/60 - utc_offset_hours
    return swe.julday(year, month, day, ut_hour)

def calc_body(jd_ut, code, flag=swe.FLG_SWIEPH | swe.FLG_SPEED):
    pos, ret = swe.calc_ut(jd_ut, code, flag)
    return {'lon': pos[0], 'lat': pos[1], 'dist': pos[2], 'speed_lon': pos[3]}

def get_houses(jd_ut, lat, lon, system=b'P'):
    cusps, ascmc = swe.houses(jd_ut, lat, lon, system)
    return list(cusps), list(ascmc)

def house_of(lon, cusps):
    lon = norm360(lon)
    c = [norm360(x) for x in cusps[:12]]  # cusps[0..11] = house 1..12 cusps
    for i in range(12):
        start = c[i]
        end = c[(i+1) % 12]
        if start < end:
            if start <= lon < end:
                return i+1
        else:
            if lon >= start or lon < end:
                return i+1
    return 12

def sect_is_day(sun_lon, asc, mc):
    # day chart if Sun is above horizon: between ASC(rising, house1 cusp) and DSC, on the upper half.
    # simplified: sun house 7-12 = day (above horizon), 1-6 = night. We'll compute via house_of with full cusps later.
    return None  # computed after houses built

def essential_dignity(planet, sign, deg_in_sign, is_day):
    score = 0
    tags = []
    if RULER_TRAD[sign] == planet:
        score += 5; tags.append('Domicile (+5)')
    ex_planet, ex_deg = EXALTATION.get(sign, (None,None))
    if ex_planet == planet:
        score += 4; tags.append('Exaltation (+4)')
    element = ELEMENTS[sign]
    day_r, night_r, part_r = TRIPLICITY[element]
    trip_ruler = day_r if is_day else night_r
    if trip_ruler == planet or part_r == planet:
        score += 3; tags.append('Triplicity (+3)')
    for upper, ruler in TERMS[sign]:
        if deg_in_sign < upper:
            if ruler == planet:
                score += 2; tags.append('Term (+2)')
            break
    if face_ruler(sign, deg_in_sign) == planet:
        score += 1; tags.append('Face (+1)')
    if DETRIMENT.get(sign) == planet:
        score -= 5; tags.append('Detriment (-5)')
    if FALL_SIGN.get(sign) == planet:
        score -= 4; tags.append('Fall (-4)')
    return score, tags

def angular_sep(a, b):
    d = abs(norm360(a) - norm360(b))
    return min(d, 360-d)

def find_aspects(points):
    """points: dict name -> lon. Returns list of aspect dicts among all pairs."""
    names = list(points.keys())
    out = []
    for i in range(len(names)):
        for j in range(i+1, len(names)):
            n1, n2 = names[i], names[j]
            sep = angular_sep(points[n1], points[n2])
            for asp_name, asp_angle, orb in ASPECTS:
                delta = abs(sep - asp_angle)
                if delta <= orb:
                    out.append({
                        'p1': n1, 'p2': n2, 'aspect': asp_name, 'angle': asp_angle,
                        'orb': round(delta, 3), 'exact_sep': round(sep, 3),
                        'nature': HARD_SOFT[asp_name],
                    })
                    break
    return out

def harmonic_positions(natal_lons, n):
    return {k: norm360(v * n) for k, v in natal_lons.items()}

def secondary_progressions(birth_jd_ut, target_date_ymd, lat, lon):
    """1 day after birth = 1 year of life (Ptolemaic 'day for a year')."""
    from datetime import date
    y,m,d = target_date_ymd
    birth_y, birth_m, birth_d, birth_ut = swe.revjul(birth_jd_ut)
    age_years = (date(y,m,d) - date(int(birth_y), int(birth_m), int(birth_d))).days / 365.2425
    prog_jd = birth_jd_ut + age_years  # advance by that many days
    prog = {name: calc_body(prog_jd, code) for name, code in BODIES.items()}
    lons = {name: prog[name]['lon'] for name in prog}
    cusps, ascmc = get_houses(prog_jd, lat, lon, b'P')
    lons['Ascendant'] = ascmc[0]
    lons['Midheaven'] = ascmc[1]
    return lons, prog_jd, age_years

def solar_arc_directions(natal_lons, birth_jd_ut, target_date_ymd):
    """Solar arc = progressed Sun's motion from natal Sun; apply uniformly to all natal points."""
    prog_lons, prog_jd, age_years = secondary_progressions(birth_jd_ut, target_date_ymd, 0, 0)
    arc = norm360(prog_lons['Sun'] - natal_lons['Sun'])
    directed = {k: norm360(v + arc) for k, v in natal_lons.items()}
    return directed, arc, age_years

def transiting_positions(jd_ut):
    out = {name: calc_body(jd_ut, code)['lon'] for name, code in BODIES.items()}
    return out

def arabic_parts(asc, sun, moon, mercury, venus, mars, jupiter, saturn, is_day):
    """The seven Hermetic Lots (Valens), day/night reversed, plus Marriage."""
    def L(a, b, c):
        # generic day formula ASC + b - c; reversed at night
        return norm360(asc + b - c) if is_day else norm360(asc + c - b)
    fortune = L('Fortune', moon, sun)
    spirit = L('Spirit', sun, moon)
    parts = {
        'Part of Fortune': fortune,
        'Part of Spirit': spirit,
        'Part of Eros': norm360(asc + venus - spirit) if is_day else norm360(asc + spirit - venus),
        'Part of Necessity': norm360(asc + fortune - mercury) if is_day else norm360(asc + mercury - fortune),
        'Part of Courage': norm360(asc + mars - fortune) if is_day else norm360(asc + fortune - mars),
        'Part of Victory': norm360(asc + jupiter - spirit) if is_day else norm360(asc + spirit - jupiter),
        'Part of Nemesis': norm360(asc + saturn - fortune) if is_day else norm360(asc + fortune - saturn),
        'Part of Marriage': norm360(asc + venus - saturn) if is_day else norm360(asc + saturn - venus),
    }
    return parts
