#!/usr/bin/env python3
"""
build_hazard_data.py
--------------------
Turn NOAA Storm Events CSV exports into compact, sparse, browser-ready JSON for
the US Extreme Weather Trends explorer.

For each hazard we count DISTINCT HAZARD DAYS: a (county, calendar date) pair
with at least one qualifying report.  Counts are stored per
    county x year x month x cumulative magnitude threshold
which lets the browser aggregate to any period, any season, any threshold
without re-reading the raw reports.

Output (per hazard):  <hazard>.json.gz  with columnar sparse arrays.
"""

import gzip
import json
import os
import sys

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------
# Hazard definitions
# --------------------------------------------------------------------------
# Each threshold is CUMULATIVE: level i counts days with a report >= that level.
# level 0 is always "any qualifying report".

HAZARDS = {
    "hail": {
        "label": "Hail",
        "csv": "Hail Days Baseball Card/hail_events_complete_years.csv",
        "magnitude": "inches",          # MAGNITUDE column, hail diameter (in)
        "unit": "in",
        "thresholds": [
            {"key": "any",  "label": "Any hail report",  "short": "any",     "min": 0.0},
            {"key": "t100", "label": "≥ 1.00″ (severe, quarter)",   "short": "≥1″",  "min": 1.00},
            {"key": "t200", "label": "≥ 2.00″ (significant, hen egg)", "short": "≥2″", "min": 2.00},
            {"key": "t300", "label": "≥ 3.00″ (giant, baseball)",  "short": "≥3″",  "min": 3.00},
        ],
        "note": "Hail diameter in inches as reported in NOAA Storm Events.",
    },
    "tornado": {
        "label": "Tornado",
        "csv": "Tornado Days Baseball Card/tornado_events_complete_years.csv",
        "magnitude": "fscale",          # TOR_F_SCALE column, F/EF rating
        "unit": "EF",
        "thresholds": [
            {"key": "any", "label": "Any tornado (EF0+)",           "short": "EF0+", "min": 0},
            {"key": "ef1", "label": "EF1+ ",                        "short": "EF1+", "min": 1},
            {"key": "ef2", "label": "EF2+ (significant)",           "short": "EF2+", "min": 2},
            {"key": "ef3", "label": "EF3+ (intense)",               "short": "EF3+", "min": 3},
            {"key": "ef4", "label": "EF4+ (violent)",               "short": "EF4+", "min": 4},
        ],
        "note": "F-scale before 2007, EF-scale after; treated as one continuous rating.",
    },
    "wind": {
        "label": "Thunderstorm Wind",
        "csv": "Tstm Winds Baseball Card/wind_events_complete_years.csv",
        "magnitude": "knots",           # MAGNITUDE column, gust (kt)
        "unit": "kt",
        "thresholds": [
            {"key": "any",  "label": "Any wind report",                    "short": "any",    "min": 0},
            {"key": "k50",  "label": "≥ 50 kt (58 mph, severe)",      "short": "≥50kt", "min": 50},
            {"key": "k65",  "label": "≥ 65 kt (75 mph, significant)", "short": "≥65kt", "min": 65},
            {"key": "k80",  "label": "≥ 80 kt (92 mph)",              "short": "≥80kt", "min": 80},
        ],
        "note": "Measured or estimated gust in knots as reported in NOAA Storm Events.",
    },
}

USECOLS = [
    "BEGIN_YEARMONTH", "BEGIN_DAY", "STATE", "STATE_FIPS",
    "YEAR", "EVENT_TYPE", "CZ_TYPE", "CZ_FIPS", "CZ_NAME",
    "MAGNITUDE", "TOR_F_SCALE",
]


def fips(state_fips, cz_fips):
    """Build a 5-digit county GEOID from the Storm Events FIPS columns."""
    s = pd.to_numeric(state_fips, errors="coerce")
    c = pd.to_numeric(cz_fips, errors="coerce")
    ok = s.notna() & c.notna()
    out = pd.Series(pd.NA, index=s.index, dtype="object")
    out[ok] = (
        s[ok].astype(int).astype(str).str.zfill(2)
        + c[ok].astype(int).astype(str).str.zfill(3)
    )
    return out


def fscale_to_num(s):
    """'EF3' / 'F3' -> 3 ; 'EFU', blank, junk -> NaN"""
    x = s.astype(str).str.upper().str.extract(r"E?F(\d)", expand=False)
    return pd.to_numeric(x, errors="coerce")


def build(hazard, root, valid_geoids, fips2usps, chunksize=400_000):
    spec = HAZARDS[hazard]
    path = os.path.join(root, spec["csv"])
    if not os.path.exists(path):
        print(f"  !! missing: {path}")
        return None

    nlev = len(spec["thresholds"])
    mins = [t["min"] for t in spec["thresholds"]]

    # (geoid, year, month, day) -> highest threshold level met that day
    day_level = {}
    # the same thing at state and national scale.  A *state* hazard day is one
    # calendar date on which anywhere in the state qualified — this is NOT the
    # sum of county-days, so it has to be accumulated separately.
    sday_level = {}
    nday_level = {}

    nrows = 0
    dropped_geoid = 0
    for chunk in pd.read_csv(path, usecols=USECOLS, dtype=str, chunksize=chunksize,
                             low_memory=False):
        nrows += len(chunk)
        chunk = chunk[chunk["CZ_TYPE"] == "C"]

        geo = fips(chunk["STATE_FIPS"], chunk["CZ_FIPS"])
        ym = pd.to_numeric(chunk["BEGIN_YEARMONTH"], errors="coerce")
        day = pd.to_numeric(chunk["BEGIN_DAY"], errors="coerce")

        if spec["magnitude"] == "fscale":
            mag = fscale_to_num(chunk["TOR_F_SCALE"])
        else:
            mag = pd.to_numeric(chunk["MAGNITUDE"], errors="coerce")

        good = geo.notna() & ym.notna() & day.notna()
        dropped_geoid += int((~geo.notna()).sum())
        geo, ym, day, mag = geo[good], ym[good], day[good], mag[good]

        yr = (ym // 100).astype(int)
        mo = (ym % 100).astype(int)
        dy = day.astype(int)

        # highest cumulative threshold each report satisfies
        lev = np.zeros(len(mag), dtype=np.int8)
        magv = mag.to_numpy(dtype=float)
        for i in range(1, nlev):
            lev[np.nan_to_num(magv, nan=-1) >= mins[i]] = i

        for g, y, m, d, L in zip(geo.to_numpy(), yr.to_numpy(), mo.to_numpy(),
                                 dy.to_numpy(), lev):
            if g not in valid_geoids:
                continue
            y, m, d, L = int(y), int(m), int(d), int(L)
            k = (g, y, m, d)
            if L > day_level.get(k, -1):
                day_level[k] = L
            ab = fips2usps.get(g[:2])
            if ab:
                sk = (ab, y, m, d)
                if L > sday_level.get(sk, -1):
                    sday_level[sk] = L
            nk = (y, m, d)
            if L > nday_level.get(nk, -1):
                nday_level[nk] = L

    print(f"  read {nrows:,} rows -> {len(day_level):,} distinct county-days"
          f" ({dropped_geoid:,} rows without usable FIPS)")

    # collapse days -> county x year x month x cumulative threshold counts
    cells = {}
    for (g, y, m, _d), L in day_level.items():
        key = (g, y, m)
        arr = cells.get(key)
        if arr is None:
            arr = [0] * nlev
            cells[key] = arr
        for i in range(L + 1):      # cumulative: a 2" day is also a 1" day
            arr[i] += 1

    counties = sorted({k[0] for k in cells})
    cidx = {g: i for i, g in enumerate(counties)}

    keys = sorted(cells.keys(), key=lambda k: (cidx[k[0]], k[1], k[2]))
    y0 = min(k[1] for k in keys)
    y1 = max(k[1] for k in keys)

    ci, yi, mi = [], [], []
    vals = [[] for _ in range(nlev)]
    for k in keys:
        ci.append(cidx[k[0]])
        yi.append(k[1] - y0)
        mi.append(k[2])
        arr = cells[k]
        for i in range(nlev):
            vals[i].append(arr[i])

    # --- region (state + national) distinct-day series -------------------
    rcells = {}
    for (ab, y, m, _d), L in sday_level.items():
        arr = rcells.setdefault((ab, y, m), [0] * nlev)
        for i in range(L + 1):
            arr[i] += 1
    for (y, m, _d), L in nday_level.items():
        arr = rcells.setdefault(("US", y, m), [0] * nlev)
        for i in range(L + 1):
            arr[i] += 1

    regions = sorted({k[0] for k in rcells})
    ridx = {r: i for i, r in enumerate(regions)}
    rkeys = sorted(rcells.keys(), key=lambda k: (ridx[k[0]], k[1], k[2]))
    rri, ryi, rmi = [], [], []
    rvals = [[] for _ in range(nlev)]
    for k in rkeys:
        rri.append(ridx[k[0]])
        ryi.append(k[1] - y0)
        rmi.append(k[2])
        for i in range(nlev):
            rvals[i].append(rcells[k][i])

    out = {
        "regions": regions,
        "rri": rri, "ryi": ryi, "rmi": rmi, "rv": rvals,
        "meta": {
            "hazard": hazard,
            "label": spec["label"],
            "unit": spec["unit"],
            "note": spec["note"],
            "thresholds": spec["thresholds"],
            "year0": int(y0),
            "year1": int(y1),
            "source": "NOAA/NCEI Storm Events Database",
            "ncell": len(keys),
            "nrcell": len(rkeys),
        },
        "counties": counties,
        "ci": ci, "yi": yi, "mi": mi,
        "v": vals,
    }
    return out


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    os.makedirs(outdir, exist_ok=True)

    topo = json.load(gzip.open(os.path.join(outdir, "..", "geo",
                                            "counties.topo.json.gz"), "rt"))
    geoms = topo["objects"][list(topo["objects"])[0]]["geometries"]
    valid = {g["properties"]["GEOID"] for g in geoms}
    fips2usps = {g["properties"]["GEOID"][:2]: g["properties"]["STUSPS"] for g in geoms}
    print(f"{len(valid)} counties in geometry, {len(fips2usps)} states")

    index = {"hazards": []}
    for hz in HAZARDS:
        print(f"\n== {hz}")
        res = build(hz, root, valid, fips2usps)
        if res is None:
            continue
        p = os.path.join(outdir, f"{hz}.json.gz")
        with gzip.open(p, "wt", encoding="utf-8") as fh:
            json.dump(res, fh, separators=(",", ":"))
        mb = os.path.getsize(p) / 1e6
        print(f"  wrote {p}  ({mb:.2f} MB gz, {res['meta']['ncell']:,} cells,"
              f" {res['meta']['year0']}-{res['meta']['year1']})")
        index["hazards"].append({
            "key": hz,
            "label": res["meta"]["label"],
            "unit": res["meta"]["unit"],
            "note": res["meta"]["note"],
            "thresholds": res["meta"]["thresholds"],
            "year0": res["meta"]["year0"],
            "year1": res["meta"]["year1"],
            "file": f"{hz}.json.gz",
        })

    with open(os.path.join(outdir, "index.json"), "w") as fh:
        json.dump(index, fh, indent=1)
    print("\nwrote index.json")


if __name__ == "__main__":
    main()
