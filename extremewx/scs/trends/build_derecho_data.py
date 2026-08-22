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
  2. The report lies within (track length + 100 km) of BOTH endpoints, which is
     the filter the paper applies (its section 3) to separate a coherent swath
     from unrelated storm modes.

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


def tz_offset(s):
    if not isinstance(s, str):
        return None
    s = s.strip()
    m = re.search(r"(-?\d{1,2})\s*$", s)
    return int(m.group(1)) if m else TZ.get(re.sub(r"[^A-Z]", "", s.upper()))


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


def hull(pts):
    """Monotone-chain convex hull; returns the ring in lon/lat order."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return list(pts)
    def half(ps):
        out = []
        for p in ps:
            while len(out) >= 2:
                (x1, y1), (x2, y2) = out[-2], out[-1]
                if (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1) > 0:
                    break
                out.pop()
            out.append(p)
        return out
    lo, up = half(pts), half(pts[::-1])
    return lo[:-1] + up[:-1]


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
                # the paper's own spatial filter, applied to both endpoints
                lim = e["track_km"] + PAD_KM
                if km(alat, alon, e["start_lat"], e["start_lon"]) > lim:
                    continue
                if km(alat, alon, e["end_lat"], e["end_lon"]) > lim:
                    continue
                e["reports"].append({
                    "la": round(float(alat), 3), "lo": round(float(alon), 3),
                    "kt": int(m),
                    "t": int((utc - e["start"]).total_seconds() // 60),  # min after start
                    "ms": ch.MAGNITUDE_TYPE.iloc[i] == "MG",
                    "st": ch.STATE.iloc[i] if isinstance(ch.STATE.iloc[i], str) else "",
                    "approx": approx,
                })

    print(f"scanned {nrow:,} wind rows · {nutc:,} landed on an archive date · "
          f"{nfall:,} placed by county centroid")

    out = []
    for e in evs:
        rep = sorted(e["reports"], key=lambda r: r["t"])
        out.append({
            "id": e["id"], "tier": e["tier"], "tier_note": e["tier_note"],
            "start": e["start_utc"], "end": e["end_utc"],
            "hours": int(e["hours"]), "km": e["track_km"],
            "track": [[e["start_lon"], e["start_lat"]], [e["end_lon"], e["end_lat"]]],
            "n": {t["k"]: sum(1 for r in rep if r["kt"] >= t["min"]) for t in THRESHOLDS},
            "reports": rep,
            "hull": {t["k"]: hull([(r["lo"], r["la"]) for r in rep if r["kt"] >= t["min"]])
                     for t in THRESHOLDS},
            "kmax": max((r["kt"] for r in rep), default=None),
            "states": sorted({r["st"] for r in rep if r["st"]}),
            "approx": sum(1 for r in rep if r["approx"]),
        })

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
    tot = sum(len(e["reports"]) for e in out)
    empty = [e for e in out if not e["reports"]]
    print(f"wrote {p}  ({os.path.getsize(p)/1e3:.0f} kB gz, {len(out)} events, "
          f"{tot:,} reports ≥50 kt)")
    print(f"  events with no report in window: {len(empty)}"
          + (f"  ({', '.join(e['start'][:10] for e in empty[:8])}"
             + (" …" if len(empty) > 8 else "") + ")" if empty else ""))


if __name__ == "__main__":
    main()
