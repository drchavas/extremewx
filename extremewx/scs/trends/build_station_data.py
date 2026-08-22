#!/usr/bin/env python3
"""
build_station_data.py
---------------------
Turn NOAA ISD "Global Hourly" station-year CSVs into compact, browser-ready JSON
for the station-based hazards on the extreme-weather trend pages.

Two hazards come out of the same downloads:

  freezing rain  — days with FZRA in the METAR remarks (REM), counted over a
                   July–June COLD SEASON labelled by its ending year, matching
                   calculate_annual_mean_number_of_days_multi_station.py
  peak wind      — days with a "PK WND dddff/hhmm" remark at or above a gust
                   threshold, counted over the CALENDAR year, matching
                   generate_station_annual_time_series_plot.py

Both keep the 90% completeness screen from those scripts.  This matters and is
the opposite of the county rule: for a station, a year that failed completeness
is *no observation*, not zero days, so it is dropped rather than zero-filled.
Counties are exhaustive (every county exists every year); stations are not.
"""

import calendar
import gzip
import math
import json
import os
import re
import sys
from collections import defaultdict

import pandas as pd

PKWND = re.compile(r"PK WND \d{3}(\d{2,3})/\d{4}")
COMPLETENESS = 0.90

# Restrict to the 86 stations DelPizzo et al. (2025) retained after QC.  Their
# decisive criterion is one we cannot reconstruct from the ISD files themselves:
# stations without an overnight manual observer were excluded, which drops AWOS
# and unaugmented ASOS sites.  Automated present-weather sensors over-report
# freezing rain badly -- in Indiana the excluded sites average 74% more FZRA
# days than the retained ones, and Indianapolis Eagle Creek reads 3.5x
# Indianapolis International 15 km away.  So we take their published list.
STATION_LIST = "stations_delpizzo2025.csv"
MATCH_KM = 3.0


def load_station_list(path):
    if not os.path.exists(path):
        print(f"  !! {path} not found — keeping all stations, NO observer-type screening")
        return None
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("num,"):
                continue
            p = line.split(",")
            rows.append({"icao": p[1], "name": p[2], "lon": float(p[-2]), "lat": float(p[-1])})
    print(f"  station list: {len(rows)} sites from {path}")
    return rows


def nearest(lat, lon, listed):
    """Closest listed station and its distance in km."""
    best, bd = None, 1e9
    for r in listed:
        dy = (r["lat"] - lat) * 111.0
        dx = (r["lon"] - lon) * 111.0 * math.cos(math.radians(lat))
        d = math.hypot(dx, dy)
        if d < bd:
            bd, best = d, r
    return best, bd

HAZARDS = {
    "fzra": {
        "label": "Freezing Rain",
        "unit": "h",
        "season": "JulJun",          # cold season, labelled by the ending year
        "note": ("Days with freezing rain (FZRA) in the METAR remarks at an ASOS station. "
                 "Counted over a July–June cold season labelled by the ending year. "
                 "Higher levels count hours of freezing rain in the day, a rough proxy "
                 "for how much ice had a chance to accrete."),
        "thresholds": [
            {"key": "any", "label": "Any freezing rain",  "short": "any",  "min": 1},
            {"key": "h3",  "label": "≥ 3 hours in a day", "short": "≥3 h", "min": 3},
            {"key": "h6",  "label": "≥ 6 hours in a day", "short": "≥6 h", "min": 6},
        ],
    },
    "pkwnd": {
        "label": "Peak Wind",
        "unit": "kt",
        "season": "calendar",
        "note": ("Days on which an ASOS station reported a peak wind gust at or above the "
                 "threshold, read from the 'PK WND' group in the METAR remarks."),
        "thresholds": [
            {"key": "k30", "label": "≥ 30 kt (35 mph)",             "short": "≥30 kt", "min": 30},
            {"key": "k40", "label": "≥ 40 kt (46 mph)",             "short": "≥40 kt", "min": 40},
            {"key": "k50", "label": "≥ 50 kt (58 mph, severe)",     "short": "≥50 kt", "min": 50},
            {"key": "k60", "label": "≥ 60 kt (69 mph)",             "short": "≥60 kt", "min": 60},
        ],
    },
}


def scan(data_dir):
    """station id -> {year: path}"""
    out = defaultdict(dict)
    for f in sorted(os.listdir(data_dir)):
        if not f.endswith(".csv") or "_" not in f:
            continue
        sid, yr = f[:-4].rsplit("_", 1)
        if yr.isdigit():
            out[sid][int(yr)] = os.path.join(data_dir, f)
    return out


_cache = {}


def load(path):
    """Read one station-year, keeping only what both hazards need."""
    if path in _cache:
        return _cache[path]
    try:
        df = pd.read_csv(path, low_memory=False,
                         usecols=lambda c: c in ("DATE", "REM", "LATITUDE",
                                                 "LONGITUDE", "ELEVATION", "NAME"))
    except Exception as e:
        print(f"    could not read {os.path.basename(path)}: {e}")
        return None
    if df.empty or "DATE" not in df:
        return None
    df["DATE"] = pd.to_datetime(df["DATE"], errors="coerce")
    df = df.dropna(subset=["DATE"])
    if df.empty:
        return None
    df["DAY"] = df["DATE"].dt.date
    df["HOUR"] = df["DATE"].dt.hour
    df["REM"] = df["REM"].fillna("").astype(str) if "REM" in df else ""
    if len(_cache) > 40:
        _cache.clear()
    _cache[path] = df
    return df


def gust(rem):
    m = PKWND.search(rem)
    return int(m.group(1)) if m else 0


def season_frames(files, year, mode):
    """Rows making up one 'year', and the day count it should have."""
    if mode == "calendar":
        if year not in files:
            return None, 0
        df = load(files[year])
        return df, (366 if calendar.isleap(year) else 365)
    # July of year-1 through June of year
    if (year - 1) not in files or year not in files:
        return None, 0
    a, b = load(files[year - 1]), load(files[year])
    if a is None or b is None:
        return None, 0
    a = a[a["DATE"].dt.month >= 7]
    b = b[b["DATE"].dt.month <= 6]
    df = pd.concat([a, b], ignore_index=True)
    return df, (366 if calendar.isleap(year) else 365)


def build(hz, data_dir, y0, y1, listed=None):
    spec = HAZARDS[hz]
    files = scan(data_dir)
    dropped = []
    nlev = len(spec["thresholds"])
    mins = [t["min"] for t in spec["thresholds"]]

    stations, cells, valid = [], {}, defaultdict(list)
    meta_by_id = {}

    for si, sid in enumerate(sorted(files)):
        got = 0
        for year in range(y0, y1 + 1):
            df, expected = season_frames(files[sid], year, spec["season"])
            if df is None or df.empty:
                continue

            # completeness screen — identical to the existing scripts
            if df["DAY"].nunique() / expected < COMPLETENESS:
                continue
            valid[si].append(year)
            got += 1

            if sid not in meta_by_id:
                r = df.iloc[0]
                # ISD NAME looks like "LAFAYETTE PURDUE UNIVERSITY AIRPORT, IN US"
                full = str(r.get("NAME", sid))
                tail = full.rsplit(",", 1)[-1].split() if "," in full else []
                meta_by_id[sid] = {
                    "id": sid,
                    "name": full.rsplit(",", 1)[0].title(),
                    "state": tail[0] if tail and len(tail[0]) == 2 else "",
                    "lat": round(float(r.get("LATITUDE", 0)), 4),
                    "lon": round(float(r.get("LONGITUDE", 0)), 4),
                }

            if hz == "fzra":
                hit = df[df["REM"].str.contains("FZRA", regex=False)]
                if hit.empty:
                    continue
                # distinct HOURS of freezing rain per day -> a duration threshold
                per_day = hit.groupby("DAY")["HOUR"].nunique()
            else:
                g = df["REM"].map(gust)
                hit = df[g > 0].assign(G=g[g > 0])
                if hit.empty:
                    continue
                per_day = hit.groupby("DAY")["G"].max()

            for day, val in per_day.items():
                mo = day.month
                arr = cells.setdefault((si, year, mo), [0] * nlev)
                for i in range(nlev):
                    if val >= mins[i]:
                        arr[i] += 1

        st = meta_by_id.get(sid, {"id": sid, "name": sid, "state": "",
                                  "lat": 0, "lon": 0})
        # Every station passing the 90% completeness screen is kept.  Sites on
        # the DelPizzo et al. (2025) list are flagged so the page can offer their
        # observer-type screening as a toggle rather than baking it in.
        st["dp"] = 0
        if listed is not None and got:
            near, dist = nearest(st["lat"], st["lon"], listed)
            if dist <= MATCH_KM:
                st["dp"] = 1
                st["icao"] = near["icao"]
            else:
                dropped.append(st["name"])
        stations.append(st)
        print(f"  {sid}  {st['name'][:30]:30s} {got:2d} yr   "
              f"{'DelPizzo ' + st.get('icao', '') if st['dp'] else 'not on list'}")

    # A July-June season needs the previous calendar year's file, so the first
    # requested year is never usable for cold-season hazards. Report the first
    # year that any station actually observed rather than the requested one,
    # otherwise a "balanced panel" over the full period can never be non-empty.
    obs = [y for ys in valid.values() for y in ys]
    if obs:
        y0, y1 = min(obs), max(obs)

    keys = [k for k in sorted(cells) if y0 <= k[1] <= y1]
    out = {
        "meta": {
            "hazard": hz, "label": spec["label"], "unit": spec["unit"],
            "note": spec["note"], "thresholds": spec["thresholds"],
            "season": spec["season"], "year0": y0, "year1": y1,
            "kind": "station",
            "completeness": COMPLETENESS,
            "nDelPizzo": sum(1 for x in stations if x.get("dp")),
            "source": "NOAA/NCEI Integrated Surface Database (Global Hourly)",
            "ncell": len(keys),
        },
        "stations": stations,
        "validYears": {str(k): v for k, v in valid.items()},
        "si": [k[0] for k in keys],
        "yi": [k[1] - y0 for k in keys],
        "mi": [k[2] for k in keys],
        "v": [[cells[k][i] for k in keys] for i in range(nlev)],
    }
    return out


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "global_hourly_downloads"
    outdir = sys.argv[2] if len(sys.argv) > 2 else "data"
    y0, y1 = 2000, 2024
    os.makedirs(outdir, exist_ok=True)
    listed = load_station_list(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                            STATION_LIST))

    idx_path = os.path.join(outdir, "index.json")
    index = json.load(open(idx_path)) if os.path.exists(idx_path) else {"hazards": []}
    index["hazards"] = [h for h in index["hazards"] if h["key"] not in HAZARDS]

    for hz in HAZARDS:
        print(f"\n== {hz}")
        res = build(hz, data_dir, y0, y1, listed)
        # Writing an empty file is worse than failing: it looks like a successful
        # rebuild and silently empties the map. This happened -- the ISD station
        # CSVs are not in the shared folder, so a re-run produced 0 stations and
        # overwrote good data.
        if not res["stations"]:
            raise SystemExit(
                f"\n!! {hz}: no stations found under {data_dir}.\n"
                f"   This builder needs the raw NOAA ISD Global Hourly station-year CSVs,\n"
                f"   which are not part of the Baseball Cards folder. Refusing to overwrite\n"
                f"   {os.path.join(outdir, hz + '.json.gz')} with an empty file.")
        p = os.path.join(outdir, f"{hz}.json.gz")
        with gzip.open(p, "wt", encoding="utf-8") as fh:
            json.dump(res, fh, separators=(",", ":"))
        nd = res["meta"]["nDelPizzo"]
        print(f"  wrote {p}  ({os.path.getsize(p)/1e3:.0f} kB gz, "
              f"{len(res['stations'])} stations ({nd} on the DelPizzo list), "
              f"{res['meta']['ncell']:,} cells)")
        m = res["meta"]
        index["hazards"].append({
            "key": hz, "label": m["label"], "unit": m["unit"], "note": m["note"],
            "thresholds": m["thresholds"], "year0": m["year0"], "year1": m["year1"],
            "kind": "station", "season": m["season"], "file": f"{hz}.json.gz",
            "nDelPizzo": m["nDelPizzo"],
        })

    json.dump(index, open(idx_path, "w"), indent=1)
    print("\nupdated index.json")


if __name__ == "__main__":
    main()
