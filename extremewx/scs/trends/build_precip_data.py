#!/usr/bin/env python3
"""
build_precip_data.py
--------------------
Heavy-precipitation days from PRISM, on PRISM's native ~4 km grid.

Input is the daily grid as delivered by the RCC-ACIS GridData service
(grid 21 = PRISM), either as the wide CSV that get_PRISM_data.py writes
(Date,Pcpn,Lat,Lon) or, far more efficiently, as monthly exceedance counts
fetched directly from ACIS -- see fetch_precip_acis.py.

Output is the same sparse columnar shape the county and station hazards use:
counts of days at or above each threshold per grid cell x year x month.

Why counts and not daily values: the card only ever needs "how many days in
this month at this cell cleared 1/2/3 inches". Storing that instead of 9,131
daily fields is a ~30x reduction before compression, and it is what makes
PRISM at full resolution practical in a browser.

Note on zeros: a PRISM cell exists every day of every year, so a year with no
heavy rain is a real zero and IS counted -- the same rule as the county maps,
and the opposite of the station hazards. The original Indiana scripts averaged
with `annual_counts.groupby(["Lat","Lon"])["HEAVY_DAYS"].mean()`, which silently
drops years a cell never reached the threshold; that inflates the mean, badly
so at 3 inches where most cell-years are zero.
"""

import gzip
import json
import os
import sys
from collections import defaultdict

THRESHOLDS = [
    {"key": "p1", "label": "≥ 1.00 inch", "short": "≥1″", "min": 1.0},
    {"key": "p2", "label": "≥ 2.00 inch", "short": "≥2″", "min": 2.0},
    {"key": "p3", "label": "≥ 3.00 inch", "short": "≥3″", "min": 3.0},
]
NOTE = ("Days on which PRISM's ~4 km analysis put at least this much precipitation on a "
        "grid cell. PRISM is the reference gridded product for the contiguous US; a daily "
        "value is the 24 hours ending at 1200 UTC. Source: RCC-ACIS GridData, grid 21.")


def parse_csv(path, y0, y1):
    """Stream the wide daily CSV, counting exceedance days per cell/year/month."""
    mins = [t["min"] for t in THRESHOLDS]
    nlev = len(mins)
    cells = {}           # (lat,lon) -> index
    lats, lons = [], []
    counts = defaultdict(lambda: [0] * nlev)
    rows = kept = 0

    with open(path) as fh:
        fh.readline()
        for line in fh:
            rows += 1
            i1 = line.find(",")
            i2 = line.find(",", i1 + 1)
            v = line[i1 + 1:i2]
            # every threshold is >= 1 inch, so anything starting with "0" or a
            # non-digit (missing "M") can be rejected without float conversion
            if not v or v[0] == "0" or not v[0].isdigit():
                continue
            try:
                val = float(v)
            except ValueError:
                continue
            if val < mins[0]:
                continue
            yr = int(line[:4])
            if yr < y0 or yr > y1:
                continue
            mo = int(line[5:7])
            ll = line[i2 + 1:].rstrip()
            j = ll.find(",")
            key = (ll[:j], ll[j + 1:])
            ci = cells.get(key)
            if ci is None:
                ci = cells[key] = len(lats)
                lats.append(float(key[0])); lons.append(float(key[1]))
            arr = counts[(ci, yr, mo)]
            for i in range(nlev):
                if val >= mins[i]:
                    arr[i] += 1
            kept += 1
            if rows % 10_000_000 == 0:
                print(f"    {rows:,} rows, {kept:,} heavy-precip cell-days,"
                      f" {len(counts):,} cells so far", flush=True)

    print(f"    {rows:,} rows read, {kept:,} heavy-precip cell-days,"
          f" {len(lats):,} grid cells")
    return lats, lons, counts


def main():
    src = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    state = sys.argv[3] if len(sys.argv) > 3 else "IN"
    y0, y1 = 2000, 2024
    os.makedirs(outdir, exist_ok=True)

    print(f"== precip / {state}")
    lats, lons, counts = parse_csv(src, y0, y1)

    # regular grid description, so the browser can place cells without a lookup
    ulat = sorted(set(lats)); ulon = sorted(set(lons))
    dlat = min(b - a for a, b in zip(ulat, ulat[1:])) if len(ulat) > 1 else 1
    dlon = min(b - a for a, b in zip(ulon, ulon[1:])) if len(ulon) > 1 else 1

    keys = sorted(counts)
    out = {
        "meta": {
            "hazard": "precip", "label": "Heavy Precipitation", "unit": "in",
            "kind": "grid", "note": NOTE, "thresholds": THRESHOLDS,
            "year0": y0, "year1": y1, "state": state,
            "source": "PRISM via RCC-ACIS GridData (grid 21)",
            "ncell": len(keys), "npoint": len(lats),
            "grid": {"dlat": round(dlat, 6), "dlon": round(dlon, 6)},
        },
        "lat": [round(x, 4) for x in lats],
        "lon": [round(x, 4) for x in lons],
        "ci": [k[0] for k in keys],
        "yi": [k[1] - y0 for k in keys],
        "mi": [k[2] for k in keys],
        "v": [[counts[k][i] for k in keys] for i in range(len(THRESHOLDS))],
    }
    p = os.path.join(outdir, f"precip_{state}.json.gz")
    with gzip.open(p, "wt", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    mb = os.path.getsize(p) / 1e6
    print(f"  wrote {p}  ({mb:.2f} MB gz, {len(lats):,} cells, {len(keys):,} cell-months)")


if __name__ == "__main__":
    main()
