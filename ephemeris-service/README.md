# Ephemeris scripts — handoff notes

These are the original scripts that produced the data embedded in `dc.html`. They still run as-is (verified before handing off). Two things worth knowing before wrapping them into `POST /compute-chart` per §4.6 of the master reference:

## What's hardcoded right now that needs to become a parameter

`build_natal.py` currently has the birth data hardcoded near the top:

```python
BIRTH = dict(year=1991, month=4, day=17, hour=10, minute=41, utc_offset=-7,
             lat=34.0195, lon=-118.4912, place='Santa Monica, CA')
```

For the real service, this needs to come from the request body instead (whatever the friend entered during onboarding), not be baked into the file. `utc_offset` specifically is worth a decision: right now it's supplied directly rather than derived from an IANA timezone name + date (which would handle DST automatically). If the onboarding form collects a place name rather than a raw UTC offset, you'll want a timezone lookup (e.g. `timezonefinder` + `pytz`/`zoneinfo`) to convert place + date into the correct historical offset, since DST rules and even timezone boundaries have changed over the decades some of these friends were born in.

`build_transits.py` and `build_progressions.py` don't depend on birth data for their date ranges (transits run a fixed 2024–2034 calendar window regardless of who's asking; progressions run age-offsets 0–105 from whatever `birth_jd` they're given), so those two mostly just need `birth_jd_ut` and the birth lat/lon threaded through as parameters instead of recomputed from the hardcoded `BIRTH` dict.

## What doesn't change

`astro_engine.py` (the actual astrological logic — dignities, aspects, dispositors, Arabic parts, harmonics) doesn't need to change at all. It already takes parameters cleanly; it's only the three `build_*.py` driver scripts that currently assume one hardcoded person.

## The `ephe/` folder

154 files, ~105MB. This is the actual Swiss Ephemeris data: the JPL-derived planetary position files plus the fixed-star catalog (`sefstars.txt`). `astro_engine.py` points `swe.set_ephe_path()` at this folder relative to its own location. It needs to ship with the service (in the container image, or mounted), not be treated as optional. Without it, `pyswisseph` falls back to a lower-precision built-in model and fixed-star lookups fail outright.

## Suggested shape for `app.py`

A single endpoint that takes birth data in, runs the three build steps against it (in-memory, not writing to disk the way the original scripts do for local testing), and returns the combined JSON:

```
POST /compute-chart
{ "year": 1994, "month": 3, "day": 12, "hour": 14, "minute": 5,
  "utc_offset": -5, "lat": 40.71, "lon": -74.01, "place": "New York, NY" }

→ { "natal": {...}, "transits": {...}, "progressions": {...} }
```
