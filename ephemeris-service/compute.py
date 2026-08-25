"""
De Caelo — chart computation, factored out of app.py so it can be shared by
the public web service (POST /compute-chart) and the cron-only refresh
script (refresh_transits.py), without the cron script importing FastAPI or
opening a port it doesn't need.

Ports build_natal.py / build_transits.py / build_progressions.py (see
README.md for handoff notes) into parameterized, side-effect-free functions.
astro_engine.py itself is untouched.
"""
import datetime

from timezonefinder import TimezoneFinder
from zoneinfo import ZoneInfo

from astro_engine import *  # noqa: F401,F403 — brings in swe, BODIES, jd_from_local, etc.

TRANSIT_BODIES = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn",
                   "Uranus", "Neptune", "Pluto", "Chiron", "North Node"]
PROG_BODIES = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn",
                "Uranus", "Neptune", "Pluto"]
TRAD7 = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]
# 1950, not 2024: the frontend's "echoes" feature (Horoscope tab) looks back
# through this same shared window for a person's own prior exact hit of an
# upcoming transit -- Saturn/Uranus/Neptune/Pluto cycles run 7-42+ years, so
# a window that only starts at "now" can never surface those, only retrograde
# repeats within a year or two. 1950 covers essentially any living user's
# whole life. Computing the wider window is cheap (~2s, ~6MB of JSON) --
# verified locally before choosing this date, not a guess.
DEFAULT_WINDOW_START = datetime.date(1950, 1, 1)
DEFAULT_WINDOW_END = datetime.date(2034, 12, 31)
MAX_PROGRESSION_AGE = 105

_tf = TimezoneFinder()


def _ensure_ephe_path():
    # pyswisseph's ephemeris path is thread-local, not process-global: astro_engine.py's
    # module-level swe.set_ephe_path() only takes effect in the thread that imported it.
    # FastAPI runs sync endpoint functions in a worker-thread pool, so each request lands
    # in a fresh thread that never called it — silently falls back to swisseph's compiled-in
    # default search paths, which don't have our files, and fails with a "file not found"
    # error that (confusingly) names those defaults, not our actual configured path. Cheap
    # and idempotent, so just call it at the top of every entry point.
    swe.set_ephe_path(EPHE_PATH)


def resolve_utc_offset(year, month, day, hour, minute, lat, lon, utc_offset=None):
    if utc_offset is not None:
        return utc_offset
    tz_name = _tf.timezone_at(lat=lat, lng=lon)
    if tz_name is None:
        raise ValueError("could not resolve a timezone for the given lat/lon; supply utc_offset directly")
    local_dt = datetime.datetime(year, month, day, hour, minute, tzinfo=ZoneInfo(tz_name))
    offset = local_dt.utcoffset()
    return offset.total_seconds() / 3600


def compute_natal(birth: dict, utc_offset: float) -> tuple[dict, float]:
    _ensure_ephe_path()
    jd_ut = jd_from_local(birth["year"], birth["month"], birth["day"], birth["hour"], birth["minute"], utc_offset)

    raw = {name: calc_body(jd_ut, code) for name, code in BODIES.items()}
    lons = {name: raw[name]["lon"] for name in raw}
    lons["South Node"] = norm360(lons["North Node"] + 180)
    raw["South Node"] = {
        "lon": lons["South Node"], "lat": -raw["North Node"]["lat"],
        "dist": raw["North Node"]["dist"], "speed_lon": raw["North Node"]["speed_lon"],
    }

    cusps_p, ascmc_p = get_houses(jd_ut, birth["lat"], birth["lon"], b"P")
    cusps_w, ascmc_w = get_houses(jd_ut, birth["lat"], birth["lon"], b"W")
    ASC, MC, VERTEX = ascmc_p[0], ascmc_p[1], ascmc_p[3]
    DSC = norm360(ASC + 180)
    IC = norm360(MC + 180)
    lons["Ascendant"] = ASC
    lons["Midheaven"] = MC
    lons["Descendant"] = DSC
    lons["Imum Coeli"] = IC
    lons["Vertex"] = VERTEX

    sun_house = house_of(lons["Sun"], cusps_p)
    is_day = sun_house >= 7
    sect_light = "Sun" if is_day else "Moon"

    angle_names = ("Ascendant", "Midheaven", "Descendant", "Imum Coeli", "Vertex")
    houses = {name: house_of(lon, cusps_p) for name, lon in lons.items() if name not in angle_names}
    houses_whole = {name: house_of(lon, cusps_w) for name, lon in lons.items() if name not in angle_names}

    placements = {name: deg_to_sign(lon) for name, lon in lons.items()}

    dignities = {}
    for name in TRAD7:
        p = placements[name]
        score, tags = essential_dignity(name, p["sign"], p["sign_lon"], is_day)
        dignities[name] = {"score": score, "tags": tags}

    aspect_points = {k: v for k, v in lons.items() if k not in ("Imum Coeli",)}
    aspects = find_aspects(aspect_points)

    def build_chains(ruler_table):
        disposits_to = {}
        for p in TRAD7 + ["Uranus", "Neptune", "Pluto"]:
            sign = placements[p]["sign"]
            disposits_to[p] = ruler_table[sign]
        chains = {}
        for p in disposits_to:
            chain = [p]
            cur = p
            seen = {p}
            while True:
                nxt = disposits_to.get(cur)
                if nxt is None:
                    break
                if nxt == cur or nxt in seen:
                    chain.append(nxt)
                    break
                chain.append(nxt)
                seen.add(nxt)
                cur = nxt
            chains[p] = chain
        return disposits_to, chains

    disp_modern, chains_modern = build_chains(RULER_MODERN)
    disp_trad, chains_trad = build_chains(RULER_TRAD)

    star_hits = []
    check_points = {**{k: v for k, v in lons.items() if k in list(BODIES.keys()) + ["South Node"]},
                     "Ascendant": ASC, "Midheaven": MC}
    for star in FIXED_STARS:
        try:
            res = swe.fixstar2_ut(star, jd_ut)
            star_lon = res[0][0]
            star_name = res[1]
            for pname, plon in check_points.items():
                sep = angular_sep(star_lon, plon)
                if sep <= 1.5:
                    star_hits.append({"star": star_name.split(",")[0], "point": pname,
                                       "orb": round(sep, 3), "star_lon": round(star_lon, 3)})
        except Exception:
            pass

    parts = arabic_parts(ASC, lons["Sun"], lons["Moon"], lons["Mercury"], lons["Venus"],
                          lons["Mars"], lons["Jupiter"], lons["Saturn"], is_day)
    parts_placements = {k: deg_to_sign(v) for k, v in parts.items()}
    parts_houses = {k: house_of(v, cusps_p) for k, v in parts.items()}

    harmonic_lons_base = {k: v for k, v in lons.items() if k in list(BODIES.keys()) + ["South Node", "Ascendant", "Midheaven"]}
    harmonics = {}
    for h in (5, 7, 9):
        hp = harmonic_positions(harmonic_lons_base, h)
        harmonics[h] = {k: deg_to_sign(v) for k, v in hp.items()}
        harmonics[f"{h}_aspects"] = find_aspects(hp)

    elem_count = {"Fire": 0, "Earth": 0, "Air": 0, "Water": 0}
    mod_count = {"Cardinal": 0, "Fixed": 0, "Mutable": 0}
    for p in PERSONAL + SOCIAL + OUTER + ["Ascendant"]:
        sign = placements[p]["sign"]
        elem_count[ELEMENTS[sign]] += 1
        mod_count[MODALITIES[sign]] += 1

    asc_sign = placements["Ascendant"]["sign"]

    # Alt/Az for the sky visualizer (§ "natal sky visualizer"). Ascendant/Midheaven
    # get no special-casing: feeding their ecliptic longitude through the same
    # ECL2HOR call (latitude=0, since both are defined as points on the ecliptic)
    # geometrically produces Alt≈0 for the Ascendant and a meridian position for
    # the Midheaven automatically, rather than needing separate formulas.
    def altaz_for(name):
        ecl_lat = raw.get(name, {}).get("lat", 0.0)
        dist = raw.get(name, {}).get("dist", 1.0)
        az, true_alt, _ = swe.azalt(jd_ut, swe.ECL2HOR, (birth["lon"], birth["lat"], 0), 0, 0, (lons[name], ecl_lat, dist))
        return round((az + 180) % 360, 3), round(true_alt, 3)  # az converted: swe's south-based-westward -> north-based-eastward

    points = {}
    for name in lons:
        az, alt = altaz_for(name)
        points[name] = {
            "lon": round(lons[name], 5), **placements[name],
            "house_placidus": houses.get(name), "house_whole_sign": houses_whole.get(name),
            "speed": round(raw.get(name, {}).get("speed_lon", 0), 5) if name in raw else None,
            "retrograde": (raw.get(name, {}).get("speed_lon", 0) < 0) if name in raw else False,
            "az": az, "alt": alt,
        }

    natal = {
        "birth": {**birth, "utc_offset": utc_offset},
        "jd_ut": jd_ut,
        "sect": {"is_day": is_day, "light": sect_light, "sun_house": sun_house},
        "points": points,
        "houses_placidus": {"cusps": [round(c, 4) for c in cusps_p[:12]]},
        "houses_whole_sign": {"cusps": [round(c, 4) for c in cusps_w[:12]]},
        "angles": {"ASC": round(ASC, 4), "MC": round(MC, 4), "DSC": round(DSC, 4), "IC": round(IC, 4), "Vertex": round(VERTEX, 4)},
        "chart_ruler": {"modern": RULER_MODERN[asc_sign], "traditional": RULER_TRAD[asc_sign], "asc_sign": asc_sign},
        "dignities": dignities,
        "aspects": aspects,
        "dispositors": {"modern": {"map": disp_modern, "chains": chains_modern},
                          "traditional": {"map": disp_trad, "chains": chains_trad}},
        "fixed_stars": star_hits,
        "arabic_parts": {k: {**parts_placements[k], "house": parts_houses[k]} for k in parts},
        "harmonics": {str(h): {"positions": harmonics[h], "aspects": harmonics[f"{h}_aspects"]} for h in (5, 7, 9)},
        "balance": {"elements": elem_count, "modalities": mod_count},
    }
    return natal, jd_ut


def compute_progressions(birth_jd: float, lat: float, lon: float) -> dict:
    _ensure_ephe_path()
    offsets = list(range(0, MAX_PROGRESSION_AGE + 1))
    lon_table = {b: [] for b in PROG_BODIES}
    asc_table = []
    mc_table = []
    for off in offsets:
        jd = birth_jd + off
        for b in PROG_BODIES:
            pos = calc_body(jd, BODIES[b])
            lon_table[b].append(round(pos["lon"], 4))
        cusps, ascmc = get_houses(jd, lat, lon, b"P")
        asc_table.append(round(ascmc[0], 4))
        mc_table.append(round(ascmc[1], 4))
    return {"birth_jd_ut": birth_jd, "max_age": MAX_PROGRESSION_AGE, "age_offsets": offsets,
            "lon": lon_table, "ascendant": asc_table, "midheaven": mc_table}


def compute_transits(start: datetime.date, end: datetime.date) -> dict:
    _ensure_ephe_path()
    dates = []
    series = {b: [] for b in TRANSIT_BODIES}
    speed_series = {b: [] for b in TRANSIT_BODIES}
    d = start
    while d <= end:
        jd = swe.julday(d.year, d.month, d.day, 12.0)
        dates.append(d.isoformat())
        for b in TRANSIT_BODIES:
            pos = calc_body(jd, BODIES[b])
            series[b].append(round(pos["lon"], 3))
            speed_series[b].append(round(pos["speed_lon"], 4))
        d += datetime.timedelta(days=1)
    return {"start": start.isoformat(), "end": end.isoformat(), "bodies": TRANSIT_BODIES,
            "dates": dates, "lon": series, "speed": speed_series}
