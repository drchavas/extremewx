#!/usr/bin/env python3
"""
build_events_data.py
--------------------
Top severe-weather days, ranked by how much ground they covered.

A "day" is a calendar date; its score for a region is the number of DISTINCT
COUNTIES in that region reporting the hazard at or above the chosen threshold.
Counties rather than reports on purpose: report counts rose roughly thirtyfold
between 1955 and the late 1990s as population, spotter networks and radar
changed, so ranking by reports would mostly rank by era and by population. A
county either saw it or did not, which travels much better across seventy years.

Output, per hazard:

  * the top 50 days for every state and the top 100 nationally, separately for
    each threshold -- the top >=2" hail days are a different and more
    interesting list than the top "any hail" days;
  * every REPORT belonging to any listed day.

Storing the reports rather than pre-aggregated county counts means the page can
draw either a county choropleth or the individual points from one payload, and
can re-filter by threshold without another fetch.  County counts are cheap to
derive in the browser and expensive to store four times over.

Note the hole: June and July 1993 are missing from Storm Events entirely (NCEI
lost them), so no day in those months can appear in any list.
"""

import gzip
import json
import os
import re
import sys
from collections import defaultdict

import pandas as pd

TOP_STATE, TOP_US = 50, 100

HAZARDS = {
    "hail": {
        "label": "Hail", "unit": "in", "magnitude": "inches",
        "csv": "Hail Days Baseball Card/hail_events_complete_years.csv",
        "thresholds": [
            {"k": "any",  "label": "Any hail report",       "short": "any",   "min": 0.0},
            {"k": "t100", "label": "≥ 1.00″ (severe)",      "short": "≥1″",   "min": 1.00},
            {"k": "t200", "label": "≥ 2.00″ (significant)", "short": "≥2″",   "min": 2.00},
            {"k": "t300", "label": "≥ 3.00″ (giant)",       "short": "≥3″",   "min": 3.00},
        ],
    },
    "tornado": {
        "label": "Tornado", "unit": "EF", "magnitude": "fscale",
        "csv": "Tornado Days Baseball Card/tornado_events_complete_years.csv",
        "thresholds": [
            {"k": "any", "label": "Any tornado (EF0+)", "short": "EF0+", "min": 0},
            {"k": "ef1", "label": "EF1+",               "short": "EF1+", "min": 1},
            {"k": "ef2", "label": "EF2+ (significant)", "short": "EF2+", "min": 2},
            {"k": "ef3", "label": "EF3+ (intense)",     "short": "EF3+", "min": 3},
        ],
    },
    "wind": {
        "label": "Thunderstorm Wind", "unit": "kt", "magnitude": "knots",
        "csv": "Tstm Winds Baseball Card/wind_events_complete_years.csv",
        "thresholds": [
            {"k": "any", "label": "Any wind report",          "short": "any",    "min": 0},
            {"k": "k50", "label": "≥ 50 kt (58 mph, severe)", "short": "≥50 kt", "min": 50},
            {"k": "k65", "label": "≥ 65 kt (significant)",    "short": "≥65 kt", "min": 65},
            {"k": "k80", "label": "≥ 80 kt (92 mph)",         "short": "≥80 kt", "min": 80},
        ],
    },
}

USECOLS = ["BEGIN_YEARMONTH", "BEGIN_DAY", "BEGIN_TIME", "CZ_TYPE", "STATE_FIPS",
           "CZ_FIPS", "MAGNITUDE", "TOR_F_SCALE", "BEGIN_LAT", "BEGIN_LON"]

NODATA = {(1993, 6), (1993, 7)}     # NCEI lost these; see build_hazard_data.py


def county_meta(topo_path):
    """GEOID -> (state abbrev, centroid lat, centroid lon)."""
    topo = json.load(gzip.open(topo_path, "rt"))
    obj = topo["objects"][list(topo["objects"])[0]]
    tr = topo["transform"]
    sx, sy = tr["scale"]; tx, ty = tr["translate"]
    dec = []
    for a in topo["arcs"]:
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
                walk(e) if isinstance(e, list) else ids.append(e)
        walk(g["arcs"])
        sxx = syy = 0.0; n = 0
        for i in ids:
            for px, py in dec[i if i >= 0 else ~i]:
                sxx += px; syy += py; n += 1
        p = g["properties"]
        out[p["GEOID"]] = (p["STUSPS"], syy / n if n else 0.0, sxx / n if n else 0.0)
    return out


def fscale_num(s):
    return pd.to_numeric(s.astype(str).str.upper().str.extract(r"E?F(\d)", expand=False),
                         errors="coerce")


def build(hz, root, cmeta):
    spec = HAZARDS[hz]
    path = os.path.join(root, spec["csv"])
    if not os.path.exists(path):
        print(f"  !! missing {path}")
        return None
    thr = spec["thresholds"]
    nlev = len(thr)
    mins = [t["min"] for t in thr]

    # date -> level -> set of GEOIDs, and the raw reports for that date
    daycty = defaultdict(lambda: [set() for _ in range(nlev)])
    dayrep = defaultdict(list)
    nrow = nodrop = 0

    for ch in pd.read_csv(path, usecols=USECOLS, dtype=str,
                          chunksize=400_000, low_memory=False):
        nrow += len(ch)
        ym = pd.to_numeric(ch.BEGIN_YEARMONTH, errors="coerce")
        yy, mm = ym // 100, ym % 100
        dd = pd.to_numeric(ch.BEGIN_DAY, errors="coerce")
        tt = pd.to_numeric(ch.BEGIN_TIME, errors="coerce")
        sf = pd.to_numeric(ch.STATE_FIPS, errors="coerce")
        cf = pd.to_numeric(ch.CZ_FIPS, errors="coerce")
        mag = (fscale_num(ch.TOR_F_SCALE) if spec["magnitude"] == "fscale"
               else pd.to_numeric(ch.MAGNITUDE, errors="coerce"))
        la = pd.to_numeric(ch.BEGIN_LAT, errors="coerce")
        lo = pd.to_numeric(ch.BEGIN_LON, errors="coerce")
        czt = ch.CZ_TYPE.to_numpy()

        yv, mv, dv = yy.to_numpy(), mm.to_numpy(), dd.to_numpy()
        sv, cv, gv = sf.to_numpy(), cf.to_numpy(), mag.to_numpy(dtype=float)
        av, ov, tv = la.to_numpy(dtype=float), lo.to_numpy(dtype=float), tt.to_numpy(dtype=float)

        for i in range(len(ch)):
            if not (yv[i] == yv[i] and mv[i] == mv[i] and dv[i] == dv[i]):
                continue
            if (int(yv[i]), int(mv[i])) in NODATA:
                continue
            if czt[i] != "C" or not (sv[i] == sv[i] and cv[i] == cv[i]):
                nodrop += 1
                continue
            geoid = f"{int(sv[i]):02d}{int(cv[i]):03d}"
            if geoid not in cmeta:
                nodrop += 1
                continue
            lev = 0
            v = gv[i]
            if v == v:
                for j in range(1, nlev):
                    if v >= mins[j]:
                        lev = j
            date = f"{int(yv[i]):04d}-{int(mv[i]):02d}-{int(dv[i]):02d}"
            cs = daycty[date]
            for j in range(lev + 1):
                cs[j].add(geoid)
            dayrep[date].append((geoid, v if v == v else None,
                                 av[i] if av[i] == av[i] else None,
                                 ov[i] if ov[i] == ov[i] else None,
                                 int(tv[i]) if tv[i] == tv[i] else None))

    print(f"  {nrow:,} rows · {len(daycty):,} distinct dates · {nodrop:,} without a usable county")

    # --- rank days per threshold, per region -----------------------------
    # per (date, level): counties per state, and nationally
    rank = []
    keep = set()
    for lev in range(nlev):
        bystate = defaultdict(list)   # state -> [(ncounty, date)]
        national = []
        for date, sets in daycty.items():
            gset = sets[lev]
            if not gset:
                continue
            per = defaultdict(int)
            for g in gset:
                per[cmeta[g][0]] += 1
            for ab, n in per.items():
                bystate[ab].append((n, date))
            national.append((len(gset), date))
        entry = {}
        for ab, lst in bystate.items():
            lst.sort(key=lambda t: (-t[0], t[1]))
            top = lst[:TOP_STATE]
            entry[ab] = top
            keep.update(d for _, d in top)
        national.sort(key=lambda t: (-t[0], t[1]))
        entry["US"] = national[:TOP_US]
        keep.update(d for _, d in entry["US"])
        rank.append(entry)

    days = sorted(keep)
    didx = {d: i for i, d in enumerate(days)}
    counties = sorted({g for d in days for (g, *_r) in dayrep[d]})
    gidx = {g: i for i, g in enumerate(counties)}

    # --- county aggregate: what the default choropleth needs ------------
    # per day, per county: the report count at each threshold level. Small,
    # because it is one row per county-day rather than one per report, and it
    # gzips well since most rows are the same handful of small integers.
    dc_off, dc_ci, dc_n = [0], [], []
    for d in days:
        per = {}
        for (g, v, *_r) in dayrep[d]:
            lev = 0
            if v is not None:
                for j in range(1, nlev):
                    if v >= mins[j]:
                        lev = j
            arr = per.setdefault(gidx[g], [0] * nlev)
            for j in range(lev + 1):
                arr[j] += 1
        for k in sorted(per):
            dc_ci.append(k)
            dc_n.extend(per[k])
        dc_off.append(len(dc_ci))

    # --- the individual reports, shipped separately ----------------------
    # Only fetched when the reader asks for points. Keeping it out of the main
    # file takes thunderstorm wind from 2.5 MB to well under one.
    off = [0]
    ci, mg, la_, lo_, tm = [], [], [], [], []
    for d in days:
        for (g, v, a, o, t) in dayrep[d]:
            ci.append(gidx[g])
            mg.append(None if v is None else round(float(v), 2))
            la_.append(None if a is None else round(float(a), 2))
            lo_.append(None if o is None else round(float(o), 2))
            tm.append(t)
        off.append(len(ci))

    out = {
        "meta": {
            "hazard": hz, "label": spec["label"], "unit": spec["unit"],
            "thresholds": thr,
            "topState": TOP_STATE, "topUS": TOP_US,
            "year0": int(min(days)[:4]), "year1": int(max(days)[:4]),
            "source": "NOAA/NCEI Storm Events Database",
            "gaps": [[y, m] for (y, m) in sorted(NODATA)],
            "nday": len(days), "nreport": len(ci),
            "points": f"events_{hz}_pts.json.gz",
        },
        "days": days,
        "counties": counties,
        "dcOff": dc_off, "dcCi": dc_ci, "dcN": dc_n,
        "rank": [{ab: [[didx[d], n] for (n, d) in lst] for ab, lst in e.items()}
                 for e in rank],
    }
    pts = {"off": off, "ci": ci, "mag": mg, "la": la_, "lo": lo_, "t": tm}
    return out, pts


def main():
    root = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)
    cmeta = county_meta(os.path.join(here, "geo", "counties.topo.json.gz"))
    print(f"county metadata: {len(cmeta):,}")

    index = {"topState": TOP_STATE, "topUS": TOP_US, "hazards": []}
    for hz in HAZARDS:
        print(f"\n== {hz}")
        built = build(hz, root, cmeta)
        if built is None:
            continue
        res, pts = built
        p = os.path.join(outdir, f"events_{hz}.json.gz")
        with gzip.open(p, "wt", encoding="utf-8") as fh:
            json.dump(res, fh, separators=(",", ":"))
        pp = os.path.join(outdir, f"events_{hz}_pts.json.gz")
        with gzip.open(pp, "wt", encoding="utf-8") as fh:
            json.dump(pts, fh, separators=(",", ":"))
        m = res["meta"]
        print(f"  wrote {p}  ({os.path.getsize(p)/1e6:.2f} MB gz, {m['nday']:,} days, "
              f"{m['year0']}-{m['year1']})")
        print(f"  wrote {pp}  ({os.path.getsize(pp)/1e6:.2f} MB gz, {m['nreport']:,} reports, "
              f"fetched only for the points view)")
        index["hazards"].append({
            "key": hz, "label": m["label"], "unit": m["unit"],
            "thresholds": m["thresholds"], "year0": m["year0"], "year1": m["year1"],
            "file": f"events_{hz}.json.gz", "points": m["points"],
        })
    with open(os.path.join(outdir, "events_index.json"), "w") as fh:
        json.dump(index, fh, indent=1)
    print("\nwrote events_index.json")


if __name__ == "__main__":
    main()
