"""
De Caelo — shared transit window refresh.

Standalone script, not an HTTP endpoint. Meant to run as a Render Cron Job
(or any scheduler that can run "python refresh_transits.py" with the two
env vars below set) — deliberately not reachable over the public internet,
since the service-role key it holds bypasses Row Level Security entirely.
Recomputes build_transits.py's calendar-only window and upserts it into
Supabase's sky_snapshots singleton row (§4.2). Run on a slow cadence
(monthly is plenty); the window itself only needs to move when window_end
approaches.
"""
import datetime
import os
import sys

import httpx

from compute import DEFAULT_WINDOW_END, DEFAULT_WINDOW_START, compute_transits

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def main():
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
        sys.exit(1)

    transits = compute_transits(DEFAULT_WINDOW_START, DEFAULT_WINDOW_END)
    row = {
        "id": 1,
        "transit_json": transits,
        "window_start": transits["start"],
        "window_end": transits["end"],
        "computed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    resp = httpx.post(
        f"{SUPABASE_URL}/rest/v1/sky_snapshots?on_conflict=id",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        json=row,
        timeout=60,
    )
    if resp.status_code >= 300:
        print(f"Supabase write failed: {resp.status_code} {resp.text[:500]}", file=sys.stderr)
        sys.exit(1)

    print(f"sky_snapshots refreshed: {row['window_start']} to {row['window_end']}, computed_at {row['computed_at']}")


if __name__ == "__main__":
    main()
