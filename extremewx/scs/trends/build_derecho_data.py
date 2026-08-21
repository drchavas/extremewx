#!/usr/bin/env python3
"""
build_derecho_data.py
---------------------
One record per derecho date from Shourd and Kaplan (2025): the NOAA/NCEI Storm
Events thunderstorm-wind reports on that date, the convex hull enclosing them,
and the UTC span from first report to last.

What this is and is not
-----------------------
The paper supplies the DATES.  Everything else here is computed from Storm
Events and is NOT the paper's own report set, so the counts on this page run
higher than the ones it quotes.  Two reasons, both worth stating plainly:

  1. The paper used SPC "filtered" storm reports, which thin near-duplicate
     reports of the same gust.  Raw Storm Events keeps them all.
  2. The paper counted only reports attributable to the derecho itself.  A
     calendar date can also hold unrelated convection elsewhere in the country.

Checked against the two events the paper quotes exactly (its section 3b):

                        paper >=33 m/s   here raw   thinned 40 km / 60 min
    10 Aug 2020 Corn Belt      39          159              42
    12 May 2022                49          196              48

So the >=33 m/s (64 kt) criterion plus SPC-style thinning lands within a few
reports of the paper on both events, which is the confirmation that this is the
right quantity.  The page still plots every report rather than a thinned set,
because thinning is a display choice the reader cannot see through, and the
envelope is unaffected by it -- duplicates sit inside the hull, not on it.

Times are Storm Events local times converted to UTC via CZ_TIMEZONE.  Reports
are taken from the labelled local calendar date only; a derecho running past
local midnight has its tail counted under the following date, which is how the
paper labels events too.
"""

import csv, gzip, json, math, os, re, sys
from collections import defaultdict

import pandas as pd

WIND_CSV = "Tstm Winds Baseball Card/wind_events_complete_years.csv"

# knots.  33 m/s and 38 m/s are the paper's gust criteria; 50 kt is the NWS
# severe threshold and is what the map's plain "severe" symbol means.
THRESHOLDS = [
    {"k": "k50", "label": "≥ 50 kt (58 mph, severe)",        "min": 50},
    {"k": "k64", "label": "≥ 64 kt (33 m s⁻¹ — Shourd & Kaplan criterion)", "min": 64},
    {"k": "k74", "label": "≥ 74 kt (38 m s⁻¹ — high-end)",   "min": 74},
]

USECOLS = ["BEGIN_YEARMONTH", "BEGIN_DAY", "BEGIN_TIME", "CZ_TIMEZONE", "CZ_TYPE",
           "MAGNITUDE", "MAGNITUDE_TYPE", "BEGIN_LAT", "BEGIN_LON", "STATE",
           "STATE_FIPS", "CZ_FIPS"]


def county_centroids(topo_path):
    """GEOID -> (lat, lon).  Wind reports carry no coordinates at all in
       1993-1995, which is exactly where five of these derechos fall, so without
       a fallback those events come up empty.  Same fallback the 2 deg grid
       builder uses: the county that filed the report, to county precision."""
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


# Modern rows read "CST-6"; rows from the 1990s read plain "CST", so the offset
# has to be looked up or every pre-2000 event loses its clock.
TZ = {"AST": -4, "EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6,
      "PST": -8, "PDT": -7, "AKST": -9, "AKDT": -8, "HST": -10, "SST": -11, "GST": 10}


def tz_offset(s):
    """'CST-6' -> -6; bare 'CST' -> -6 from the table."""
    if not isinstance(s, str):
        return None
    s = s.strip()
    m = re.search(r"(-?\d{1,2})\s*$", s)
    if m:
        return int(m.group(1))
    return TZ.get(re.sub(r"[^A-Z]", "", s.upper()))


LINK_KM, LINK_H = 150.0, 3.0


def _xy(r):
    """Crude equirectangular km, good enough for a 150 km linkage test."""
    return (r["lo"] * 111.0 * math.cos(math.radians(r["la"])), r["la"] * 111.0)


def swath(reps):
    """Isolate the derecho itself from everything else that happened that day.

    A calendar date is not an event: 10 Aug 2020 carries severe wind reports in
    21 states, and a hull drawn round all of them is a picture of the country,
    not of the derecho.  So single-link the reports in space and time and keep
    the strongest connected group.

    Reports that predate coordinates (1993-1995) also predate a usable clock in
    some rows; those link on distance alone rather than being dropped.

    Returns the member indices.  Checked against the two events the paper
    describes: 10 Aug 2020 comes out 1238 km across 9 states, 12 May 2022
    1426 km across 5 -- both the published tracks.
    """
    n = len(reps)
    if n == 0:
        return []
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a

    P = [_xy(r) for r in reps]
    for i in range(n):
        xi, yi = P[i]; ti = reps[i]["t"]
        for j in range(i + 1, n):
            dx = xi - P[j][0]; dy = yi - P[j][1]
            if dx * dx + dy * dy > LINK_KM * LINK_KM:
                continue
            tj = reps[j]["t"]
            if ti is not None and tj is not None and abs(ti - tj) > LINK_H * 60:
                continue
            a, b = find(i), find(j)
            if a != b:
                parent[a] = b

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    # the derecho is the group carrying the most >=33 m/s gusts, not merely the
    # most reports -- a dense cluster of marginal 50 kt reports is not a derecho
    return max(groups.values(),
               key=lambda g: (sum(1 for i in g if reps[i]["kt"] >= 64), len(g)))


def major_axis(reps):
    """Longest separation in km, the paper's derecho major-axis measure."""
    P = [_xy(r) for r in reps]
    m = 0.0
    for i in range(len(P)):
        for j in range(i + 1, len(P)):
            m = max(m, math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]))
    return m


def hull(pts):
    """Monotone chain convex hull; returns the enclosing ring, lon/lat order."""
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


def main():
    root = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)

    cents = county_centroids(os.path.join(here, "geo", "counties.topo.json.gz"))
    print(f"county centroids: {len(cents):,}")

    with open(os.path.join(here, "derechos_shourd2025.csv")) as fh:
        meta = {r["date"]: r for r in csv.DictReader(fh)}
    want = defaultdict(list)
    for d in meta:
        y, m, dd = (int(x) for x in d.split("-"))
        want[(y, m, dd)] = []
    print(f"{len(meta)} derecho dates from Shourd and Kaplan (2025)")

    path = os.path.join(root, WIND_CSV)
    nrow = 0
    for ch in pd.read_csv(path, usecols=USECOLS, dtype=str,
                          chunksize=400_000, low_memory=False):
        nrow += len(ch)
        ym = pd.to_numeric(ch.BEGIN_YEARMONTH, errors="coerce")
        y, m = ym // 100, ym % 100
        d = pd.to_numeric(ch.BEGIN_DAY, errors="coerce")
        key = list(zip(y.astype("Int64"), m.astype("Int64"), d.astype("Int64")))
        hit = [i for i, k in enumerate(key) if k in want]
        if not hit:
            continue
        sub = ch.iloc[hit]
        mag = pd.to_numeric(sub.MAGNITUDE, errors="coerce")
        la = pd.to_numeric(sub.BEGIN_LAT, errors="coerce")
        lo = pd.to_numeric(sub.BEGIN_LON, errors="coerce")
        tm = pd.to_numeric(sub.BEGIN_TIME, errors="coerce")
        sf = pd.to_numeric(sub.STATE_FIPS, errors="coerce")
        cf = pd.to_numeric(sub.CZ_FIPS, errors="coerce")
        for j, i in enumerate(hit):
            if not (mag.iloc[j] >= THRESHOLDS[0]["min"]):
                continue
            alat, alon, approx = la.iloc[j], lo.iloc[j], False
            if not (alat == alat and alon == alon):
                if not (sf.iloc[j] == sf.iloc[j] and cf.iloc[j] == cf.iloc[j]
                        and sub.CZ_TYPE.iloc[j] == "C"):
                    continue
                c = cents.get(f"{int(sf.iloc[j]):02d}{int(cf.iloc[j]):03d}")
                if c is None:
                    continue
                alat, alon, approx = c[0], c[1], True
            off = tz_offset(sub.CZ_TIMEZONE.iloc[j])
            t = tm.iloc[j]
            utc = None
            if t == t and off is not None:
                utc = (int(t) // 100 * 60 + int(t) % 100) - off * 60   # minutes, may pass 1440
            want[key[i]].append({
                "la": round(float(alat), 3), "lo": round(float(alon), 3),
                "kt": int(mag.iloc[j]), "t": utc,
                "ms": sub.MAGNITUDE_TYPE.iloc[j] == "MG",
                "st": sub.STATE.iloc[j],
                "approx": approx,
            })
    print(f"scanned {nrow:,} wind rows")

    events = []
    for (y, m, d), rep in sorted(want.items()):
        date = f"{y:04d}-{m:02d}-{d:02d}"
        rep.sort(key=lambda r: (r["t"] is None, r["t"]))
        mem = set(swath(rep))
        for i, r in enumerate(rep):
            r["d"] = i in mem            # part of the derecho swath
        core = [r for r in rep if r["d"]]
        ts = [r["t"] for r in core if r["t"] is not None]
        ev = {
            "date": date,
            # counts are for the swath; the day's other convection is kept in
            # `reports` so it can be shown greyed, but it is not the event
            "n": {t["k"]: sum(1 for r in core if r["kt"] >= t["min"]) for t in THRESHOLDS},
            "nall": len(rep),
            "reports": rep,
            "hull": {t["k"]: hull([(r["lo"], r["la"]) for r in core if r["kt"] >= t["min"]])
                     for t in THRESHOLDS},
            "t0": min(ts) if ts else None,
            "t1": max(ts) if ts else None,
            "axis": round(major_axis(core)),
            "kmax": max((r["kt"] for r in core), default=None),
            "states": sorted({r["st"] for r in core if isinstance(r["st"], str)}),
            "approx": sum(1 for r in core if r["approx"]),
            "series": meta[date]["series"],
            "note": meta[date]["source"],
        }
        events.append(ev)

    out = {"meta": {"label": "Derecho events", "source": "NOAA/NCEI Storm Events Database",
                    "dates": "Shourd and Kaplan (2025), Electronic J. Severe Storms Meteor., 20 (2), 1–33",
                    "doi": "https://doi.org/10.55599/ejssm.v20i2.130",
                    "thresholds": THRESHOLDS, "nevent": len(events)},
           "events": events}
    p = os.path.join(outdir, "derecho.json.gz")
    with gzip.open(p, "wt", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    tot = sum(len(e["reports"]) for e in events)
    empty = [e["date"] for e in events if not e["reports"]]
    print(f"wrote {p}  ({os.path.getsize(p)/1e3:.0f} kB gz, {len(events)} events, "
          f"{tot:,} reports ≥50 kt)")
    if empty:
        print(f"  !! {len(empty)} dates with no qualifying report: {', '.join(empty)}")


if __name__ == "__main__":
    main()
