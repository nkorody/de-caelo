"""
De Caelo — ephemeris service, public web app.

Only endpoint that matters here: POST /compute-chart, birth data in,
{natal, progressions} out. Called once per user at onboarding (§4.5).

This process never holds the Supabase service-role key. Populating the
shared sky_snapshots table is refresh_transits.py's job — a separate,
non-HTTP script meant to run as a Render Cron Job with no public route at
all, not a route on this app. See ephemeris-service/README.md.
"""
import os

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from compute import compute_natal, compute_progressions, resolve_utc_offset

app = FastAPI(title="De Caelo ephemeris service")

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["Content-Type", "X-Ephemeris-Key"],
)

EPHEMERIS_ACCESS_KEY = os.environ.get("EPHEMERIS_ACCESS_KEY", "")


class BirthData(BaseModel):
    year: int
    month: int
    day: int
    hour: int
    minute: int
    lat: float
    lon: float
    place: str
    utc_offset: float | None = Field(
        default=None,
        description="Hours east of UTC. If omitted, derived from lat/lon + date via timezonefinder + zoneinfo, "
                    "which handles historical DST (including irregular cases like US War Time) correctly. "
                    "Provide it directly only if the lookup is wrong for a given birthplace/date.",
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/compute-chart")
def compute_chart(birth: BirthData, x_ephemeris_key: str | None = Header(default=None)):
    if EPHEMERIS_ACCESS_KEY and x_ephemeris_key != EPHEMERIS_ACCESS_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")
    utc_offset = resolve_utc_offset(birth.year, birth.month, birth.day, birth.hour, birth.minute,
                                     birth.lat, birth.lon, birth.utc_offset)
    natal, jd_ut = compute_natal(birth.model_dump(exclude={"utc_offset"}), utc_offset)
    progressions = compute_progressions(jd_ut, birth.lat, birth.lon)
    return {"natal": natal, "progressions": progressions}
