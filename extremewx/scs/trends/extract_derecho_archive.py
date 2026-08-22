#!/usr/bin/env python3
"""
extract_derecho_archive.py
--------------------------
Parse the six supplemental tables of

    Squitieri, B. J., A. R. Wade, and I. L. Jirak, 2026: On a Comprehensive
    Archive for Derechos across the Contiguous United States.  Bull. Amer.
    Meteor. Soc., 107 (7).  https://doi.org/10.1175/BAMS-D-25-0002.1

into one CSV.  This is the SPC archive: 70 years, explicit UTC start and end
times, and start/end coordinates for every wind swath.  That last part is why it
replaces the Shourd and Kaplan list here -- with a published event window there
is no need to guess which reports belong to which storm.

Tiers, kept distinct because the paper keeps them distinct:

    definitive    96   1996-2025   confirmed against NEXRAD
    likely_pre    48   1956-1995   pre-NEXRAD, met the wind-report criteria
    possible_pre  16   1957-1991   pre-NEXRAD, fell just short
    likely_nex    13   1996-2020   NEXRAD era, just short of the criteria
    hybrid_nex     7   1998-2015   suspected hybrid (bowing within a squall line)
    hybrid_pre     4   1974-1991   pre-NEXRAD hybrid candidate

definitive + likely_pre = 144, the figure the paper and the press quote.

Usage:  extract_derecho_archive.py <supplement.pdf> [out.csv]
"""

import csv
import datetime as dt
import re
import subprocess
import sys

TIERS = {
    "Table S1": ("definitive",   96, "NEXRAD-era definitive derecho"),
    "Table S2": ("likely_nex",   13, "NEXRAD-era likely derecho, just short of the wind-report criteria"),
    "Table S3": ("hybrid_nex",    7, "NEXRAD-era suspected hybrid"),
    "Table S4": ("likely_pre",   48, "pre-NEXRAD likely derecho"),
    "Table S5": ("possible_pre", 16, "pre-NEXRAD possible derecho"),
    "Table S6": ("hybrid_pre",    4, "pre-NEXRAD potential hybrid candidate"),
}

ROW = re.compile(
    r"^\s*(\d{1,3})\s+"
    r"(\d{2}/\d{2}/\d{4})\s+(\d{1,2}:\d{2})\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+"
    r"(\d{2}/\d{2}/\d{4})\s+(\d{1,2}:\d{2})\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)\s+"
    r"(\d+)\s+(\d+)\s*$")


def main():
    pdf = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "derechos_squitieri2026.csv"
    txt = subprocess.run(["pdftotext", "-layout", pdf, "-"],
                         capture_output=True, text=True, check=True).stdout
    lines = txt.splitlines()

    heads = [(i, l) for i, l in enumerate(lines) if re.match(r"^\s*Table S\d:", l)]
    heads.append((len(lines), "END"))

    rows = []
    for (a, h), (b, _) in zip(heads[:-1], heads[1:]):
        key = re.match(r"^\s*(Table S\d):", h).group(1)
        tier, want, desc = TIERS[key]
        got = []
        for l in lines[a:b]:
            m = ROW.match(l)
            if m:
                got.append(m.groups())
        # A silently short table would look like a smaller archive rather than a
        # parse failure, so the published count is asserted, not just reported.
        assert len(got) == want, f"{key}: parsed {len(got)} rows, paper says {want}"
        assert [int(g[0]) for g in got] == list(range(1, want + 1)), \
            f"{key}: event numbering is not 1..{want}"
        for g in got:
            n, d0, t0, la0, lo0, d1, t1, la1, lo1, dur, trk = g
            f = lambda d, t: dt.datetime.strptime(f"{d} {t}", "%m/%d/%Y %H:%M")
            s, e = f(d0, t0), f(d1, t1)
            assert e > s, f"{key} #{n}: end is not after start"
            rows.append({
                "id": f"{tier}-{int(n):03d}",
                "tier": tier, "table": key, "event_num": int(n),
                "start_utc": s.isoformat(sep=" "), "end_utc": e.isoformat(sep=" "),
                "start_lat": float(la0), "start_lon": float(lo0),
                "end_lat": float(la1), "end_lon": float(lo1),
                "hours": int(dur), "track_km": int(trk),
                "tier_note": desc,
            })
        print(f"  {key}  {tier:<13}{len(got):>4} rows")

    rows.sort(key=lambda r: r["start_utc"])
    with open(out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)

    head = sum(1 for r in rows if r["tier"] in ("definitive", "likely_pre"))
    assert head == 144, f"headline tiers total {head}, paper says 144"
    print(f"\nwrote {out}: {len(rows)} events, {rows[0]['start_utc'][:4]}-{rows[-1]['start_utc'][:4]}")
    print(f"  headline tiers (definitive + likely_pre) = {head}")


if __name__ == "__main__":
    main()
