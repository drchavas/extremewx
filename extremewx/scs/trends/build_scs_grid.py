#!/usr/bin/env python3
"""
build_scs_grid.py
-----------------
Bin NOAA Storm Events severe-convective reports into a 2 deg x 2 deg grid over
the lower 48 and count HAZARD DAYS per cell: calendar dates on which a cell saw
at least one report meeting the chosen size or intensity threshold.  Same
quantity the county baseball card plots, just on a regular grid instead of
county polygons, so it can carry latitude and longitude profiles.

Report position
---------------
The county cards key off STATE_FIPS + CZ_FIPS, which is always present.  A grid
needs an actual position, and BEGIN_LAT/BEGIN_LON is NOT always populated.
Coverage is ~100% through 1992 and from 1996 on; 1993-1995 is a hole:

    hail     1990-92 100.0%   1993-95   0.0%   1996-2024 99.7%
    wind     1990-92 100.0%   1993-95   0.0%   1996-2024 99.5%
    tornado  1990-92 100.0%   1993-95  63.1%   1996-2024 99.6%

For hail and wind those three years carry NO coordinates at all; only tornado is
partial.  An earlier version of this note said "1990-1995, 42% for hail": that is
the six-year average, which both understates a total outage and misplaces it by
three years, and it omitted wind entirely despite the identical hole.  Left alone
this zeroes 1993, 1994 and 1995 outright.  So a report with no usable coordinate
falls back to the centroid of its county, which is far finer than a 2 deg cell
and recovers >99.8% of the gap rows.

Caveat on that centroid: it is the unweighted mean of the county polygon's
vertices, not an area centroid, computed on already-simplified geometry.  Median
offset from a true area centroid is 4 km, but 116 of 3,222 counties fall in a
different 2 deg box because of it.  End to end that moves ~0.3% of box-days, and
roughly 5% of box-days within 1993-1995 specifically.
"""

import gzip
import json
import math
import os
import sys
from collections import defaultdict

import pandas as pd

# lower-48 grid, aligned to even degrees
GRID = 2.0
LAT0, LAT1 = 24.0, 50.0
LON0, LON1 = -126.0, -66.0
NLAT = int(round((LAT1 - LAT0) / GRID))
NLON = int(round((LON1 - LON0) / GRID))

HAZARDS = {
    "hail": {
        "label": "Hail", "unit": "in", "magnitude": "inches",
        "csv": "Hail Days Baseball Card/hail_events_complete_years.csv",
        "thresholds": [
            {"k": "any",  "label": "Any hail report",                 "min": 0.0},
            {"k": "t100", "label": "≥ 1.00″ (severe)",                "min": 1.00},
            {"k": "t200", "label": "≥ 2.00″ (significant)",           "min": 2.00},
            {"k": "t300", "label": "≥ 3.00″ (giant)",                 "min": 3.00},
        ],
    },
    "tornado": {
        "label": "Tornado", "unit": "EF", "magnitude": "fscale",
        "csv": "Tornado Days Baseball Card/tornado_events_complete_years.csv",
        "thresholds": [
            {"k": "any", "label": "Any tornado (EF0+)",   "min": 0},
            {"k": "ef1", "label": "EF1+",                 "min": 1},
            {"k": "ef2", "label": "EF2+ (significant)",   "min": 2},
            {"k": "ef3", "label": "EF3+ (intense)",       "min": 3},
        ],
    },
    "wind": {
        "label": "Thunderstorm Wind", "unit": "kt", "magnitude": "knots",
        "csv": "Tstm Winds Baseball Card/wind_events_complete_years.csv",
        "thresholds": [
            {"k": "any", "label": "Any wind report",            "min": 0},
            {"k": "k50", "label": "≥ 50 kt (58 mph, severe)",   "min": 50},
            {"k": "k65", "label": "≥ 65 kt (significant)",      "min": 65},
            {"k": "k80", "label": "≥ 80 kt (92 mph)",           "min": 80},
        ],
    },
}

USECOLS = ["BEGIN_YEARMONTH", "BEGIN_DAY", "STATE_FIPS", "CZ_TYPE", "CZ_FIPS",
           "BEGIN_LAT", "BEGIN_LON", "MAGNITUDE", "TOR_F_SCALE"]


def county_centroids(topo_path):
    """GEOID -> (lat, lon), the mean of the polygon vertices."""
    topo = json.load(gzip.open(topo_path, "rt"))
    obj = topo["objects"][list(topo["objects"])[0]]
    tr, arcs = topo["transform"], topo["arcs"]
    sx, sy = tr["scale"]; tx, ty = tr["translate"]
    dec = []
    for a in arcs:
        x = y = 0; pts = []
        for dx, dy in a:
            x += dx; y += dy
            pts.append((x * sx + tx, y * sy + ty))
        dec.append(pts)
    out = {}
    for g in obj["geometries"]:
        ids = []
        def walk(a):
            for e in a:
                if isinstance(e, list): walk(e)
                else: ids.append(e)
        walk(g["arcs"])
        sxx = syy = 0.0; n = 0
        for i in ids:
            for px, py in dec[i if i >= 0 else ~i]:
                sxx += px; syy += py; n += 1
        if n:
            out[g["properties"]["GEOID"]] = (syy / n, sxx / n)
    return out


def fscale_num(s):
    return pd.to_numeric(s.astype(str).str.upper().str.extract(r"E?F(\d)", expand=False),
                         errors="coerce")


def build(hz, root, cents):
    spec = HAZARDS[hz]
    path = os.path.join(root, spec["csv"])
    if not os.path.exists(path):
        print(f"  !! missing {path}")
        return None
    nlev = len(spec["thresholds"])
    mins = [t["min"] for t in spec["thresholds"]]

    daymax = {}          # (cell, year, month, day) -> highest threshold level
    nrow = nll = nfall = ndrop = 0

    for chunk in pd.read_csv(path, usecols=USECOLS, dtype=str,
                             chunksize=400_000, low_memory=False):
        nrow += len(chunk)
        ym = pd.to_numeric(chunk["BEGIN_YEARMONTH"], errors="coerce")
        dd = pd.to_numeric(chunk["BEGIN_DAY"], errors="coerce")
        la = pd.to_numeric(chunk["BEGIN_LAT"], errors="coerce")
        lo = pd.to_numeric(chunk["BEGIN_LON"], errors="coerce")
        mag = (fscale_num(chunk["TOR_F_SCALE"]) if spec["magnitude"] == "fscale"
               else pd.to_numeric(chunk["MAGNITUDE"], errors="coerce"))

        # county centroid fallback where the report carries no usable position
        good = la.between(LAT0, LAT1) & lo.between(LON0, LON1)
        sf = pd.to_numeric(chunk["STATE_FIPS"], errors="coerce")
        cf = pd.to_numeric(chunk["CZ_FIPS"], errors="coerce")
        has_fips = sf.notna() & cf.notna() & (chunk["CZ_TYPE"] == "C")
        geoid = (sf.where(has_fips).astype("Int64").astype(str).str.zfill(2)
                 + cf.where(has_fips).astype("Int64").astype(str).str.zfill(3))

        la = la.to_numpy(dtype=float); lo = lo.to_numpy(dtype=float)
        good = good.to_numpy(); gid = geoid.to_numpy()
        for i in range(len(chunk)):
            if not good[i]:
                c = cents.get(gid[i])
                if c is None:
                    ndrop += 1; continue
                la[i], lo[i] = c
                if not (LAT0 <= la[i] <= LAT1 and LON0 <= lo[i] <= LON1):
                    ndrop += 1; continue
                nfall += 1
            else:
                nll += 1

        ymv = ym.to_numpy(); ddv = dd.to_numpy(); mg = mag.to_numpy(dtype=float)
        for i in range(len(chunk)):
            if not (good[i] or (gid[i] in cents)):
                continue
            if not (ymv[i] == ymv[i]) or not (ddv[i] == ddv[i]):
                continue
            if not (LAT0 <= la[i] <= LAT1 and LON0 <= lo[i] <= LON1):
                continue
            ila = int((la[i] - LAT0) // GRID); ilo = int((lo[i] - LON0) // GRID)
            if ila < 0 or ila >= NLAT or ilo < 0 or ilo >= NLON:
                continue
            ci = ila * NLON + ilo
            y = int(ymv[i]) // 100; m = int(ymv[i]) % 100; d = int(ddv[i])
            lev = 0
            v = mg[i]
            if v == v:
                for j in range(1, nlev):
                    if v >= mins[j]: lev = j
            k = (ci, y, m, d)
            if lev > daymax.get(k, -1):
                daymax[k] = lev

    print(f"  {nrow:,} rows · {nll:,} with report lat/lon · {nfall:,} placed by county "
          f"centroid · {ndrop:,} unplaceable")

    cells = defaultdict(lambda: [0] * nlev)
    for (ci, y, m, _d), lev in daymax.items():
        arr = cells[(ci, y, m)]
        for j in range(lev + 1):
            arr[j] += 1

    keys = sorted(cells)
    y0 = min(k[1] for k in keys); y1 = max(k[1] for k in keys)
    return {
        "meta": {
            "hazard": hz, "label": spec["label"], "unit": spec["unit"],
            "thresholds": spec["thresholds"], "year0": y0, "year1": y1,
            "grid": GRID, "lat0": LAT0, "lon0": LON0, "nlat": NLAT, "nlon": NLON,
            "source": "NOAA/NCEI Storm Events Database",
            "ncell": len(keys), "ngrid": len({k[0] for k in keys}),
            "nfallback": nfall, "nlatlon": nll,
        },
        "ci": [k[0] for k in keys],
        "yi": [k[1] - y0 for k in keys],
        "mi": [k[2] for k in keys],
        "v": [[cells[k][i] for k in keys] for i in range(nlev)],
    }


def main():
    root = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)
    cents = county_centroids(os.path.join(here, "geo", "counties.topo.json.gz"))
    print(f"county centroids: {len(cents):,}")

    index = {"grid": GRID, "lat0": LAT0, "lon0": LON0, "nlat": NLAT, "nlon": NLON,
             "hazards": []}
    for hz in HAZARDS:
        print(f"\n== {hz}")
        res = build(hz, root, cents)
        if res is None:
            continue
        p = os.path.join(outdir, f"grid_{hz}.json.gz")
        with gzip.open(p, "wt", encoding="utf-8") as fh:
            json.dump(res, fh, separators=(",", ":"))
        m = res["meta"]
        print(f"  wrote {p}  ({os.path.getsize(p)/1e3:.0f} kB gz, "
              f"{m['ngrid']} cells, {m['ncell']:,} cell-months, {m['year0']}-{m['year1']})")
        index["hazards"].append({
            "k": hz, "label": m["label"], "unit": m["unit"],
            "thresholds": m["thresholds"], "y0": m["year0"], "y1": m["year1"],
            "file": f"grid_{hz}.json.gz",
        })
    with open(os.path.join(outdir, "grid_index.json"), "w") as fh:
        json.dump(index, fh, indent=1)
    print("\nwrote grid_index.json")


if __name__ == "__main__":
    main()
