#!/usr/bin/env python3
"""
build_derecho_data.py
---------------------
One record per derecho in the SPC archive of Squitieri, Wade and Jirak (2026),
carrying the NOAA/NCEI Storm Events thunderstorm-wind reports that fall inside
the archive's own event window.

Why this replaces the previous version
--------------------------------------
The first version of this script worked from Shourd and Kaplan (2025), which
publishes DATES only.  A date is not an event -- 10 Aug 2020 has severe wind in
21 states -- so that version invented a rule (single-link reports within 150 km
and 3 h, keep the largest group) to guess which reports belonged to the storm.
It worked, but it was my heuristic standing in for a definition.

The SPC archive publishes, for every one of its 184 wind swaths, the UTC time
and position of the first and last report.  So the guessing is gone.  Reports
are selected by the paper's own two rules:

  1. UTC time falls within [start, end] of the swath.
  2. Spatial progress matches temporal progress.  The paper defines, for a report
     at distance dx from the start point and time tx after it,

         SP = (dx - di) / D        TP = (tx - ti) / T

     with D the swath length and T its duration, and requires |SP - TP| below
     0.5 for short (~400 km) swaths tightening to 0.25 above 1000 km.  A report
     700 km downstream four minutes into a thirteen-hour event is a different
     storm, and this is what says so.
  3. The report lies within (track length + 100 km) of BOTH endpoints.
  4. It joins the coherent swath.  The paper builds its wind-swath polygon by
     growing disks of at least 25 km around each report "until all circles
     overlapped"; here the radius grows from 25 km in 5 km steps until the
     largest connected group holds 90% of the reports, capped at 75 km, and only
     that group is the swath.  Reports left outside are kept and drawn grey.

The published envelope is that UNION OF DISKS, not a convex hull.  This matters:
a hull spans empty space to reach any outlier, so two stray reports in northern
Wisconsin and northeast Michigan were stretching the 10 Aug 2020 envelope up
over Lake Michigan.  The union hugs the reports and simply does not go there.

Everything drawn is therefore either the archive's or a direct consequence of
its published window.  The track line is the archive's start and end points; it
exists for every event, including the pre-NEXRAD ones, so a storm from 1956 is
still drawable when the report record behind it is thin.

Report coverage by era (thunderstorm wind, checked against the source CSV)

    1955-1992   100.0% carry coordinates
    1993-1995     0.0%  -- placed at their county centroid instead
    1996-2024    99.5%
    2025          absent from this extract entirely

Seven events therefore come up with no reports, and neither cause is a fault in
the archive:

  * 2025-04-29, 2025-06-20, 2025-07-29 -- the report file stops at 2024.
  * 1993-06-04, 1993-06-09, 1993-06-29, 1993-07-08 -- June and July 1993 are
    MISSING OUTRIGHT from wind_events_complete_years.csv (and from the tornado
    file).  Not sparse, not uncoordinated: zero rows.  Worth knowing beyond this
    script, because those are peak severe-weather months and any climatology
    that treats 1993 as a real zero will read it as a quiet year rather than an
    absent one.
"""

import csv
import gzip
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta

import pandas as pd
from shapely.geometry import Point
from shapely.ops import unary_union

WIND_CSV = "Tstm Winds Baseball Card/wind_events_complete_years.csv"
ARCHIVE = "derechos_squitieri2026.csv"

# knots.  33 and 38 m/s are the criteria the derecho literature is written in;
# 50 kt is the NWS severe threshold.
THRESHOLDS = [
    {"k": "k50", "label": "≥ 50 kt (58 mph, severe)", "min": 50},
    {"k": "k64", "label": "≥ 64 kt (33 m s⁻¹)",       "min": 64},
    {"k": "k74", "label": "≥ 74 kt (38 m s⁻¹)",       "min": 74},
]

# Modern rows read "CST-6"; rows from the 1990s and earlier read plain "CST",
# so the offset has to be looked up or every old event loses its clock.
TZ = {"AST": -4, "EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6,
      "PST": -8, "PDT": -7, "AKST": -9, "AKDT": -8, "HST": -10, "SST": -11, "GST": 10}

USECOLS = ["BEGIN_YEARMONTH", "BEGIN_DAY", "BEGIN_TIME", "CZ_TIMEZONE", "CZ_TYPE",
           "MAGNITUDE", "MAGNITUDE_TYPE", "BEGIN_LAT", "BEGIN_LON", "STATE",
           "STATE_FIPS", "CZ_FIPS"]

PAD_KM = 100.0        # the paper's allowance beyond the swath endpoints
LINK_MIN, LINK_MAX, LINK_STEP = 25.0, 75.0, 5.0   # disk radius search, section 3
LINK_FRAC = 0.90                                   # "coherent" = holds this share
SIMPLIFY_KM = 4.0                                  # ring simplification for the wire


def sp_tp_tol(D):
    """|SP - TP| tolerance: 0.5 at <=400 km, 0.25 at >=1000 km, linear between."""
    if D <= 400.0:
        return 0.5
    if D >= 1000.0:
        return 0.25
    return 0.5 - (D - 400.0) * 0.25 / 600.0


def tz_offset(s):
    if not isinstance(s, str):
        return None
    s = s.strip()
    m = re.search(r"(-?\d{1,2})\s*$", s)
    return int(m.group(1)) if m else TZ.get(re.sub(r"[^A-Z]", "", s.upper()))


def county_state(topo_path):
    """GEOID -> state abbreviation, taken from the county topology rather than by
       matching Storm Events' STATE strings, which are inconsistently spelled."""
    topo = json.load(gzip.open(topo_path, "rt"))
    obj = topo["objects"][list(topo["objects"])[0]]
    return {g["properties"]["GEOID"]: g["properties"]["STUSPS"]
            for g in obj["geometries"]}


def county_days(events, geo_state, thresholds):
    """Distinct county-days touched by a coherent derecho swath, in the same
       shape the county hazard builder emits, so the climatology and trend
       machinery on the page works unchanged.

       Only DEFINITIVE swaths are used.  The pre-NEXRAD tiers are reconstructions
       from radar summary charts, and their report coverage is an order of
       magnitude thinner (a mean of 6 reports per event in the 1950s against
       ~200 today), so mixing them in would produce a map of how reporting has
       changed rather than of where derechos go.

       The day is the SWATH's start date, not each report's local date.  52% of
       these swaths cross a date boundary, and dating by report would count one
       derecho twice in a county unlucky enough to be hit either side of
       midnight -- it inflated the national series by 47%.  A derecho is one
       storm with one identity, and its start date is that identity.
    """
    nlev = len(thresholds)
    mins = [t["min"] for t in thresholds]
    cday, sday, nday = {}, {}, {}
    used = 0
    for e in events:
        if e["tier"] != "definitive":
            continue
        core = [r for r in e["reports"] if r["d"]]
        if core:
            used += 1
        sd = datetime.fromisoformat(e["start"])
        ymd = (sd.year, sd.month, sd.day)
        for r in core:
            g = r["_geoid"]
            if not g:
                continue
            ab = geo_state.get(g)
            if ab is None:
                continue
            lev = 0
            for j in range(1, nlev):
                if r["kt"] >= mins[j]:
                    lev = j
            for store, key in ((cday, (g,) + ymd), (sday, (ab,) + ymd), (nday, ymd)):
                if lev > store.get(key, -1):
                    store[key] = lev

    cells = {}
    for (g, y, m, _d), L in cday.items():
        arr = cells.setdefault((g, y, m), [0] * nlev)
        for i in range(L + 1):
            arr[i] += 1
    rcells = {}
    for (ab, y, m, _d), L in sday.items():
        arr = rcells.setdefault((ab, y, m), [0] * nlev)
        for i in range(L + 1):
            arr[i] += 1
    for (y, m, _d), L in nday.items():
        arr = rcells.setdefault(("US", y, m), [0] * nlev)
        for i in range(L + 1):
            arr[i] += 1

    counties = sorted({k[0] for k in cells})
    cidx = {g: i for i, g in enumerate(counties)}
    keys = sorted(cells, key=lambda k: (cidx[k[0]], k[1], k[2]))
    y0 = min(k[1] for k in keys)
    y1 = max(k[1] for k in keys)
    ci, yi, mi = [], [], []
    vals = [[] for _ in range(nlev)]
    for k in keys:
        ci.append(cidx[k[0]]); yi.append(k[1] - y0); mi.append(k[2])
        for i in range(nlev):
            vals[i].append(cells[k][i])

    regions = sorted({k[0] for k in rcells})
    ridx = {r: i for i, r in enumerate(regions)}
    rkeys = sorted(rcells, key=lambda k: (ridx[k[0]], k[1], k[2]))
    rri, ryi, rmi = [], [], []
    rvals = [[] for _ in range(nlev)]
    for k in rkeys:
        rri.append(ridx[k[0]]); ryi.append(k[1] - y0); rmi.append(k[2])
        for i in range(nlev):
            rvals[i].append(rcells[k][i])

    return {
        "meta": {
            "hazard": "derechoday", "label": "Derecho", "unit": "kt",
            # A derecho is one coherent storm, so the thing being counted is an
            # event, not a "hazard day" like hail or wind. The pages read this
            # word rather than assuming "day".
            "countword": "event",
            "gaps": [],                       # the NCEI 1993 gap predates this record
            "note": ("Calendar dates on which a county lay inside a definitive derecho wind "
                     "swath from the SPC archive of Squitieri, Wade and Jirak (2026), dated by "
                     "the swath's start. NEXRAD era only, so the record starts in 1996."),
            "thresholds": [{"key": t["k"], "label": t["label"],
                            "short": t["label"].split(" (")[0], "min": t["min"]}
                           for t in thresholds],
            "year0": int(y0), "year1": int(y1),
            "source": "NOAA/NCEI Storm Events Database",
            "archive": ("Squitieri, Wade and Jirak (2026), Bull. Amer. Meteor. Soc., 107 (7)"),
            "doi": "https://doi.org/10.1175/BAMS-D-25-0002.1",
            "nswath": used, "ncell": len(keys), "nrcell": len(rkeys),
        },
        "regions": regions, "rri": rri, "ryi": ryi, "rmi": rmi, "rv": rvals,
        "counties": counties, "ci": ci, "yi": yi, "mi": mi, "v": vals,
    }


def county_centroids(topo_path):
    """GEOID -> (lat, lon).  Wind reports carry no coordinates in 1993-1995."""
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
        if n:
            out[g["properties"]["GEOID"]] = (syy / n, sxx / n)
    return out


def km(lat1, lon1, lat2, lon2):
    """Great-circle distance, haversine."""
    p = math.pi / 180.0
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742.0 * math.asin(min(1.0, math.sqrt(a)))


def _proj(lat0):
    """Local equirectangular km <-> lon/lat, good enough over one swath."""
    k = 111.0 * math.cos(math.radians(lat0))
    return (lambda lo, la: (lo * k, la * 111.0),
            lambda x, y: (x / k, y / 111.0))


def coherent(reps, lat0):
    """The paper's coherent wind swath: grow the disk radius from 25 km until one
       connected group holds LINK_FRAC of the reports. Returns (indices, radius).

       A convex hull would instead reach out to any stray report and drag the
       envelope across empty country, which is exactly what it was doing."""
    if not reps:
        return set(), LINK_MIN
    fwd, _ = _proj(lat0)
    P = [fwd(r["lo"], r["la"]) for r in reps]
    n = len(P)
    r = LINK_MIN
    while True:
        par = list(range(n))
        def find(a):
            while par[a] != a:
                par[a] = par[par[a]]; a = par[a]
            return a
        lim = (2 * r) ** 2
        for i in range(n):
            xi, yi = P[i]
            for j in range(i + 1, n):
                if (xi - P[j][0]) ** 2 + (yi - P[j][1]) ** 2 <= lim:
                    a, b = find(i), find(j)
                    if a != b:
                        par[a] = b
        groups = {}
        for i in range(n):
            groups.setdefault(find(i), []).append(i)
        big = max(groups.values(), key=len)
        if len(big) >= LINK_FRAC * n or r >= LINK_MAX:
            return set(big), r
        r += LINK_STEP


def swath_rings(reps, lat0, r):
    """Boundary of the union of disks of radius r -- the paper's swath polygon.
       Returns a list of rings in lon/lat, one per disjoint piece."""
    if not reps:
        return []
    fwd, inv = _proj(lat0)
    poly = unary_union([Point(*fwd(x["lo"], x["la"])).buffer(r, quad_segs=8)
                        for x in reps])
    poly = poly.simplify(SIMPLIFY_KM)
    geoms = [poly] if poly.geom_type == "Polygon" else list(poly.geoms)
    out = []
    for g in geoms:
        ring = [[round(v, 3) for v in inv(x, y)] for x, y in g.exterior.coords]
        if len(ring) >= 4:
            out.append(ring)
    return out


def load_archive(here):
    with open(os.path.join(here, ARCHIVE)) as fh:
        evs = list(csv.DictReader(fh))
    for e in evs:
        e["start"] = datetime.fromisoformat(e["start_utc"])
        e["end"] = datetime.fromisoformat(e["end_utc"])
        for k in ("start_lat", "start_lon", "end_lat", "end_lon"):
            e[k] = float(e[k])
        e["track_km"] = int(e["track_km"])
        e["reports"] = []
    return evs


def main():
    root = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)

    cents = county_centroids(os.path.join(here, "geo", "counties.topo.json.gz"))
    evs = load_archive(here)
    print(f"archive: {len(evs)} events, "
          f"{evs[0]['start'].year}-{evs[-1]['end'].year}")

    # index events by every UTC date they touch, so one pass over the report file
    # can find candidates without comparing every report to every event
    byday = defaultdict(list)
    for e in evs:
        d = e["start"].date()
        while d <= e["end"].date():
            byday[d].append(e)
            d += timedelta(days=1)

    nrow = nutc = nfall = 0
    for ch in pd.read_csv(os.path.join(root, WIND_CSV), usecols=USECOLS, dtype=str,
                          chunksize=400_000, low_memory=False):
        nrow += len(ch)
        ym = pd.to_numeric(ch.BEGIN_YEARMONTH, errors="coerce")
        yy, mm = ym // 100, ym % 100
        dd = pd.to_numeric(ch.BEGIN_DAY, errors="coerce")
        tt = pd.to_numeric(ch.BEGIN_TIME, errors="coerce")
        mag = pd.to_numeric(ch.MAGNITUDE, errors="coerce")
        la = pd.to_numeric(ch.BEGIN_LAT, errors="coerce")
        lo = pd.to_numeric(ch.BEGIN_LON, errors="coerce")
        sf = pd.to_numeric(ch.STATE_FIPS, errors="coerce")
        cf = pd.to_numeric(ch.CZ_FIPS, errors="coerce")

        for i in range(len(ch)):
            m = mag.iloc[i]
            if not (m >= THRESHOLDS[0]["min"]):
                continue
            y, mo, d, t = yy.iloc[i], mm.iloc[i], dd.iloc[i], tt.iloc[i]
            if not (y == y and mo == mo and d == d and t == t):
                continue
            off = tz_offset(ch.CZ_TIMEZONE.iloc[i])
            if off is None:
                continue
            try:
                loc = datetime(int(y), int(mo), int(d),
                               int(t) // 100 % 24, int(t) % 100)
            except ValueError:
                continue
            utc = loc - timedelta(hours=off)
            cand = byday.get(utc.date(), [])
            if not cand:
                continue
            nutc += 1

            alat, alon, approx = la.iloc[i], lo.iloc[i], False
            if not (alat == alat and alon == alon):
                if not (sf.iloc[i] == sf.iloc[i] and cf.iloc[i] == cf.iloc[i]
                        and ch.CZ_TYPE.iloc[i] == "C"):
                    continue
                c = cents.get(f"{int(sf.iloc[i]):02d}{int(cf.iloc[i]):03d}")
                if c is None:
                    continue
                alat, alon, approx = c[0], c[1], True
                nfall += 1

            for e in cand:
                if not (e["start"] <= utc <= e["end"]):
                    continue
                lim = e["track_km"] + PAD_KM
                d0 = km(alat, alon, e["start_lat"], e["start_lon"])
                d1 = km(alat, alon, e["end_lat"], e["end_lon"])
                if d0 > lim or d1 > lim:
                    continue
                # spatial progress must match temporal progress (paper eqs 1-2)
                D = e["track_km"] or 1
                T = (e["end"] - e["start"]).total_seconds() / 60.0 or 1
                sp = d0 / D
                tp = (utc - e["start"]).total_seconds() / 60.0 / T
                if abs(sp - tp) > sp_tp_tol(D):
                    continue
                geoid = ""
                if (sf.iloc[i] == sf.iloc[i] and cf.iloc[i] == cf.iloc[i]
                        and ch.CZ_TYPE.iloc[i] == "C"):
                    geoid = f"{int(sf.iloc[i]):02d}{int(cf.iloc[i]):03d}"
                e["reports"].append({
                    "la": round(float(alat), 3), "lo": round(float(alon), 3),
                    "kt": int(m),
                    "t": int((utc - e["start"]).total_seconds() // 60),  # min after start
                    "ms": ch.MAGNITUDE_TYPE.iloc[i] == "MG",
                    "st": ch.STATE.iloc[i] if isinstance(ch.STATE.iloc[i], str) else "",
                    "approx": approx,
                    # kept for the county climatology, stripped before the wire
                    "_geoid": geoid, "_y": int(y), "_m": int(mo), "_d": int(d),
                })

    print(f"scanned {nrow:,} wind rows · {nutc:,} landed on an archive date · "
          f"{nfall:,} placed by county centroid")

    out = []
    ndrop_coh = 0
    for e in evs:
        rep = sorted(e["reports"], key=lambda r: r["t"])
        lat0 = (sum(r["la"] for r in rep) / len(rep)) if rep else e["start_lat"]
        mem, rad = coherent(rep, lat0)
        for i, r in enumerate(rep):
            r["d"] = 1 if i in mem else 0          # part of the coherent swath
        core = [r for r in rep if r["d"]]
        ndrop_coh += len(rep) - len(core)
        out.append({
            "id": e["id"], "tier": e["tier"], "tier_note": e["tier_note"],
            "start": e["start_utc"], "end": e["end_utc"],
            "hours": int(e["hours"]), "km": e["track_km"],
            "track": [[e["start_lon"], e["start_lat"]], [e["end_lon"], e["end_lat"]]],
            "n": {t["k"]: sum(1 for r in core if r["kt"] >= t["min"]) for t in THRESHOLDS},
            "nall": len(rep),
            "radius_km": rad,
            "reports": rep,
            # union of disks, the paper's own swath polygon -- a list of rings,
            # since a swath can legitimately come apart into pieces
            "hull": {t["k"]: swath_rings([r for r in core if r["kt"] >= t["min"]], lat0, rad)
                     for t in THRESHOLDS},
            "kmax": max((r["kt"] for r in core), default=None),
            "states": sorted({r["st"] for r in core if r["st"]}),
            "approx": sum(1 for r in core if r["approx"]),
        })

    # --- county derecho-days, definitive swaths only ---------------------
    geo_state = county_state(os.path.join(here, "geo", "counties.topo.json.gz"))
    cd = county_days(out, geo_state, THRESHOLDS)
    pc = os.path.join(outdir, "derechoday.json.gz")
    with gzip.open(pc, "wt", encoding="utf-8") as fh:
        json.dump(cd, fh, separators=(",", ":"))
    print(f"wrote {pc}  ({os.path.getsize(pc)/1e3:.0f} kB gz, "
          f"{cd['meta']['nswath']} definitive swaths, {len(cd['counties']):,} counties, "
          f"{cd['meta']['year0']}-{cd['meta']['year1']})")

    # private helper fields must not reach the browser
    for e in out:
        for r in e["reports"]:
            for k in ("_geoid", "_y", "_m", "_d"):
                r.pop(k, None)

    blob = {"meta": {
        "label": "Derecho events",
        "source": "NOAA/NCEI Storm Events Database",
        "archive": ("Squitieri, Wade and Jirak (2026), Bull. Amer. Meteor. Soc., 107 (7): "
                    "On a Comprehensive Archive for Derechos across the Contiguous United States"),
        "doi": "https://doi.org/10.1175/BAMS-D-25-0002.1",
        "thresholds": THRESHOLDS, "pad_km": PAD_KM,
        "nevent": len(out),
        "tiers": [{"k": k, "n": sum(1 for e in out if e["tier"] == k),
                   "note": next(e["tier_note"] for e in out if e["tier"] == k)}
                  for k in ("definitive", "likely_pre", "likely_nex",
                            "possible_pre", "hybrid_nex", "hybrid_pre")],
    }, "events": out}

    p = os.path.join(outdir, "derecho.json.gz")
    with gzip.open(p, "wt", encoding="utf-8") as fh:
        json.dump(blob, fh, separators=(",", ":"))

    # register in the shared index, merging so the county and station entries survive
    idx_path = os.path.join(outdir, "index.json")
    index = json.load(open(idx_path)) if os.path.exists(idx_path) else {"hazards": []}
    index["hazards"] = [h for h in index["hazards"] if h["key"] != "derecho"]
    yrs = sorted({e["start"][:4] for e in out})
    index["hazards"].append({
        "key": "derecho", "label": "Derecho events", "unit": "kt", "kind": "event",
        "note": ("The SPC derecho archive of Squitieri, Wade and Jirak (2026): "
                 f"{len(out)} wind swaths, {yrs[0]}-{yrs[-1]}. Wind reports shown are those "
                 "falling inside each swath's published UTC window."),
        "thresholds": [{"key": t["k"], "label": t["label"],
                        "short": t["label"].split(" (")[0], "min": t["min"]}
                       for t in THRESHOLDS],
        "tiers": blob["meta"]["tiers"],
        "year0": int(yrs[0]), "year1": int(yrs[-1]), "file": "derecho.json.gz",
    })
    index["hazards"] = [h for h in index["hazards"] if h["key"] != "derechoday"]
    m = cd["meta"]
    index["hazards"].append({
        "key": "derechoday", "label": m["label"], "unit": m["unit"], "note": m["note"],
        "countword": m["countword"],
        "thresholds": m["thresholds"], "year0": m["year0"], "year1": m["year1"],
        "file": "derechoday.json.gz",
    })
    order = {k: i for i, k in enumerate(["hail", "tornado", "wind", "derechoday",
                                         "fzra", "pkwnd", "derecho"])}
    index["hazards"].sort(key=lambda h: order.get(h["key"], 99))
    json.dump(index, open(idx_path, "w"), indent=1)
    print("updated index.json")
    tot = sum(len(e["reports"]) for e in out)
    empty = [e for e in out if not e["reports"]]
    print(f"wrote {p}  ({os.path.getsize(p)/1e3:.0f} kB gz, {len(out)} events, "
          f"{tot:,} reports ≥50 kt)")
    print(f"  {ndrop_coh:,} reports fell outside the coherent swath and are drawn grey")
    print(f"  events with no report in window: {len(empty)}"
          + (f"  ({', '.join(e['start'][:10] for e in empty[:8])}"
             + (" …" if len(empty) > 8 else "") + ")" if empty else ""))


if __name__ == "__main__":
    main()
