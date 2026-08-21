#!/usr/bin/env python3
"""
Build gridded tropical-cyclone activity data for tccard.html.

Aggregates IBTrACS best-track points onto a regular lat/lon grid, by year and by
intensity bin, and writes a sparse columnar JSON that the browser can hold in
memory and re-reduce on every control change (any year window, any cumulative
Vmax threshold, mean or extreme statistic).

    python3 build_tc_trends.py [ibtracs.csv] [outdir] [--grid 5] [--y0 1980] [--y1 2024]

Design notes
------------
*Synoptic times only.*  IBTrACS carries 3-hourly interpolated positions for many
storms; roughly half of all rows are 03/09/15/21 UTC.  Counting them doubles the
track density for no extra information.  Only 00/06/12/18 UTC are used, so one
count unit is one 6-hour storm-position, and 4 counts = 1 storm-day.

*USA winds only.*  USA_WIND (NHC in the Atlantic and E-Pacific, JTWC elsewhere)
is a uniform 1-minute sustained wind and is present for ~84% of synoptic points.
The alternative, WMO_WIND, is whatever the responsible RSMC reports: it mixes
1-minute and 10-minute averaging across basins, covers only 47% of West Pacific
points, and its global availability rises from 55% to 85% between 1980 and 2015.
That rise is a reporting-practice trend, not a climate trend, which is exactly
the artefact this page must not manufacture.  So USA is the only source built.

*Bins, not thresholds.*  Each (cell, year) record is split by intensity bin
rather than by cumulative threshold, so the browser can sum bins upward to get
any of the thresholds and totals stay consistent.  Points with no wind report
land in a separate "unknown" bin that is counted in track density only.

Output
------
data/index.json          grid definition, basins, years, bins, metadata
data/grid_usa.json.gz    sparse columnar arrays
"""

import sys, os, json, gzip, time, argparse
import numpy as np
import pandas as pd

# Cumulative Vmax cut points in knots.  Bin i covers [EDGES[i], EDGES[i+1]).
# Bin 0 is the "unknown wind" bin.
EDGES = [34, 64, 96]                      # TS, hurricane/typhoon, major
BIN_LABELS = ['no wind report', '<34 kt', '34–63 kt', '64–95 kt', '≥96 kt']
THRESH = [
    {'k': 'all', 'label': 'All TC positions',      'bins': [0, 1, 2, 3, 4], 'cut': None},
    {'k': 'ts',  'label': 'Vmax ≥ 34 kt (TS+)',    'bins': [2, 3, 4],       'cut': 34},
    {'k': 'hu',  'label': 'Vmax ≥ 64 kt (Cat 1+)', 'bins': [3, 4],          'cut': 64},
    {'k': 'maj', 'label': 'Vmax ≥ 96 kt (Cat 3+)', 'bins': [4],             'cut': 96},
]

# Basin boxes, in 0-360 longitude.  Deliberately simple and stated on the page:
# every grid cell belongs to exactly one basin, so basin sums are partitions of
# the global field.  (The notebook's boxes cut the North Atlantic off at 51W,
# excluding the entire Cape Verde main development region; these do not.)
# Geographic boxes, not IBTrACS's own BASIN column.  What these pages measure is
# cyclone activity *at a place*, so a position belongs where the storm physically
# was, not to whichever agency's ledger the track was filed under.  The two differ
# for about 1% of positions -- mostly East Pacific storms that cross Central
# America and keep their EP label into the Caribbean.
#
# The seven named basins exactly tile the global box: every cell inside
# |lat| < 60 belongs to exactly one of them, so basin sums add to the global sum.
# That is a property worth keeping -- an earlier version left three gaps (0-40E in
# the north, 0-20E and 240-290E in the south) holding 65 positions that were in
# Global and in no basin at all.  NA therefore wraps the prime meridian, which
# `mapFrame` and the cell-longitude normalisation in `mapPanel` both handle.
BASINS = [
    {'k': 'GL', 'name': 'Global',                'lon': [0,   360], 'lat': [-60,  60]},
    {'k': 'NA', 'name': 'North Atlantic',        'lon': [260,  40], 'lat': [  0,  60]},
    {'k': 'EP', 'name': 'Eastern N. Pacific',    'lon': [180, 260], 'lat': [  0,  60]},
    {'k': 'WP', 'name': 'Western N. Pacific',    'lon': [100, 180], 'lat': [  0,  60]},
    {'k': 'NI', 'name': 'North Indian',          'lon': [ 40, 100], 'lat': [  0,  60]},
    {'k': 'SI', 'name': 'South Indian',          'lon': [  0,  90], 'lat': [-60,   0]},
    # Australian region: the Bureau of Meteorology's area of responsibility,
    # 90E-160E south of the equator.  Carved out of South Indian (which ran to
    # 135E) and South Pacific (which began there), so the three remain disjoint
    # and the global partition is unchanged.
    {'k': 'AU', 'name': 'Australian region',     'lon': [ 90, 160], 'lat': [-60,   0]},
    {'k': 'SP', 'name': 'South Pacific',         'lon': [160, 290], 'lat': [-60,   0]},
    {'k': 'SA', 'name': 'South Atlantic',        'lon': [290, 360], 'lat': [-60,   0]},
    {'k': 'NH', 'name': 'Northern Hemisphere',   'lon': [0,   360], 'lat': [  0,  60]},
    {'k': 'SH', 'name': 'Southern Hemisphere',   'lon': [0,   360], 'lat': [-60,   0]},
]

# IBTrACS NATURE is a closed list of six.  Order fixes the index stored in the
# data files, so it must not be reshuffled without a rebuild.
NATURES = ['TS', 'SS', 'ET', 'DS', 'MX', 'NR']

# Selections the page offers.  `None` means every stage.  Distinct storm counts
# are not additive over stages, so the build emits one count column per
# selection rather than one per stage -- these keys are those column names.
STAGE_SETS = [
    ('all',  'All stages',               None),
    ('ts',   'Tropical only',            ['TS']),
    ('et',   'Extratropical only',       ['ET']),
    ('tset', 'Tropical + extratropical', ['TS', 'ET']),
    ('ss',   'Subtropical only',         ['SS']),
    ('ds',   'Disturbance only',         ['DS']),
    ('mx',   'Mixture only',             ['MX']),
    ('nr',   'Not reported only',        ['NR']),
]

R34Q = ['USA_R34_NE', 'USA_R34_SE', 'USA_R34_SW', 'USA_R34_NW']
R34S = 12       # fixed-point scale for the R34 sums; see the emit block.
                # 12, not 4: a mean over 3 non-zero quadrants is a third of an
                # integer and a mean over 4 is a quarter, so the scale has to
                # clear both denominators to stay lossless.
USECOLS = ['SID', 'SEASON', 'BASIN', 'ISO_TIME', 'NATURE', 'LAT', 'LON',
           'USA_WIND', 'USA_PRES', 'TRACK_TYPE'] + R34Q


def load(path):
    t0 = time.time()
    df = pd.read_csv(path, usecols=USECOLS, skiprows=[1],
                     keep_default_na=False, low_memory=False)
    print(f'  read {len(df):,} rows in {time.time()-t0:.0f}s')
    return df


def prepare(df, y0, y1, grid):
    d = df.copy()
    d['SEASON'] = pd.to_numeric(d.SEASON, errors='coerce')
    d = d[(d.SEASON >= y0) & (d.SEASON <= y1)]

    # spur tracks are duplicate representations of a storm already in `main`
    d = d[d.TRACK_TYPE.isin(['main', 'PROVISIONAL', 'US-PROVISIONAL'])]

    t = pd.to_datetime(d.ISO_TIME, errors='coerce')
    d = d[t.dt.hour.isin([0, 6, 12, 18]).fillna(False)]
    d = d.assign(month=t.dt.month,
                 prov=~d.TRACK_TYPE.isin(['main']))

    for c in ['LAT', 'LON', 'USA_WIND', 'USA_PRES'] + R34Q:
        d[c] = pd.to_numeric(d[c], errors='coerce')
    d = d[d.LAT.notna() & d.LON.notna()]

    # Storm size: the mean 34-kt wind radius over the quadrants that HAVE 34-kt
    # winds, requiring at least three of the four.
    #
    # A zero quadrant means the storm has no gale-force winds on that side at
    # all, which is a statement about asymmetry rather than about radial extent.
    # Averaging zeros in would make size partly a proxy for intensity: 35% of
    # 34-49 kt positions have a zero quadrant against 0.1% above 64 kt, and on
    # the positions that have one the two conventions differ by nearly a factor
    # of two (46 n mi with zeros, 86 n mi without).  So zeros are excluded from
    # the mean, and a position needs >= 3 non-zero quadrants to be used at all --
    # below that the surviving quadrants describe a lopsided fragment of a wind
    # field, not a size.  That gate drops 3,464 of 37,308 positions (9.3%).
    #
    # Missingness needs no rule: IBTrACS fills these all-or-nothing, so across
    # 1980-2025 every position has either 0 or 4 quadrants present, never 1-3.
    _q = d[R34Q]
    d['r34'] = _q.where(_q > 0).mean(axis=1).where((_q > 0).sum(axis=1) >= 3)

    lon = d.LON.to_numpy() % 360.0
    lat = d.LAT.to_numpy()
    nlat, nlon = int(180 // grid), int(360 // grid)
    li = np.clip(np.floor((lat + 90.0) / grid).astype(int), 0, nlat - 1)
    ki = np.clip(np.floor(lon / grid).astype(int), 0, nlon - 1) % nlon
    # ACE is defined over tropical and subtropical stages only.  IBTrACS carries
    # the whole best-track lifecycle, and in the North Atlantic 14% of positions
    # at >=34 kt are extratropical or a disturbance.  Counting those inflates the
    # 2005 season to 273 against a published 245; excluding them gives 257, and
    # 1994 lands exactly on its published 32.  The other fields keep the full
    # lifecycle, which is what the source notebook does.
    d = d.assign(li=li, ki=ki, ci=li * nlon + ki,
                 yi=(d.SEASON.to_numpy() - y0).astype(int),
                 trop=d.NATURE.isin(['TS', 'SS']).to_numpy(),
                 na=pd.Categorical(d.NATURE, categories=NATURES).codes)
    print(f'  {len(d):,} synoptic points, {d.SID.nunique():,} storms, '
          f'{y0}-{y1}')
    return d, nlat, nlon


def bin_index(v):
    """0 = missing, 1..4 = intensity bins."""
    b = np.full(len(v), 0, dtype=np.int8)
    ok = np.isfinite(v)
    b[ok] = 1
    for j, e in enumerate(EDGES):
        b[ok & (v >= e)] = j + 2
    return b


def aggregate(d, wind_col, pres_col, nyear):
    v = d[wind_col].to_numpy(dtype=float)
    p = d[pres_col].to_numpy(dtype=float)
    b = bin_index(v)

    r = d.r34.to_numpy(dtype=float)
    # `tr` splits every additive record by lifecycle stage so the page can drop
    # the non-tropical part without a second copy of the data.  Sums are additive
    # over this dimension, so "all stages" is just both groups added.  Distinct
    # storm counts are NOT additive over it -- a cyclone with both tropical and
    # extratropical positions in a box would be counted twice -- so those are
    # emitted as two parallel value columns instead (see storm_counts).
    t = pd.DataFrame({
        'ci': d.ci.to_numpy(), 'yi': d.yi.to_numpy(), 'bi': b,
        'na': d.na.to_numpy(),
        'v': v, 'v2': np.where(d.trop.to_numpy(), v * v, 0.0), 'p': p,
        'r': r,
        'nv': np.isfinite(v).astype(np.int32),
        'np_': np.isfinite(p).astype(np.int32),
        'nr_': np.isfinite(r).astype(np.int32),
        'sid': d.SID.to_numpy(),
    })
    # Note there is deliberately no distinct-storm count here.  nunique does not
    # sum across bins — a storm that crosses 34 kt inside one cell appears in two
    # bins and would be counted twice — so storm counts are built separately, per
    # cumulative threshold, in storm_counts().
    g = t.groupby(['ci', 'yi', 'bi', 'na'], sort=True)
    a = g.agg(n=('v', 'size'),
              sumv=('v', 'sum'), sumv2=('v2', 'sum'), nv=('nv', 'sum'),
              maxv=('v', 'max'),
              sump=('p', 'sum'), npr=('np_', 'sum'), minp=('p', 'min'),
              sumr=('r', 'sum'), nr=('nr_', 'sum'), maxr=('r', 'max')).reset_index()

    # NaN sums come back as 0.0 from pandas when every value is missing; max/min
    # come back as NaN.  Store a sentinel the reader can test.
    a['sumv'] = a.sumv.fillna(0.0)
    a['sumv2'] = a.sumv2.fillna(0.0)
    a['sump'] = a.sump.fillna(0.0)
    a['maxv'] = a.maxv.fillna(-1)
    a['minp'] = a.minp.fillna(-1)
    a['sumr'] = a.sumr.fillna(0.0)
    a['maxr'] = a.maxr.fillna(-1)

    print(f'    {len(a):,} (cell,year,bin) records')
    return a


def q(x, s=1):
    """Round to a compact integer representation."""
    return [int(round(float(u) * s)) for u in x]


def month_table(d, wind_col, pres_col, mask):
    """Basin x year x month x cumulative-threshold aggregates.

    Only the seasonal-cycle and month-by-month panels need a month dimension,
    and both are region-level, so the month table is built per basin rather than
    per cell.  That keeps it to a few thousand rows instead of multiplying the
    2,592-cell table by twelve.

    Distinct storms are counted here too, at the basin-month level, for the same
    reason they are counted separately everywhere else: a cyclone spanning two
    months is one storm in each, and the months do not sum to the year.
    """
    v = d[wind_col].to_numpy(dtype=float)
    p = d[pres_col].to_numpy(dtype=float)
    out = []
    for ti, th in enumerate(THRESH):
        sel = np.ones(len(d), bool) if th['cut'] is None else (v >= th['cut'])
        if not sel.any():
            continue
        s = pd.DataFrame({
            'yi': d.yi.to_numpy()[sel], 'mi': d.month.to_numpy()[sel],
            'ci': d.ci.to_numpy()[sel], 'sid': d.SID.to_numpy()[sel],
            'na': d.na.to_numpy()[sel],
            'nat': d.NATURE.to_numpy()[sel],
            'v': v[sel],
            'v2': np.where(d.trop.to_numpy()[sel], v[sel] ** 2, 0.0),
            'p': p[sel],
            'r': d.r34.to_numpy(dtype=float)[sel],
            'nv': np.isfinite(v[sel]).astype(np.int32),
            'np_': np.isfinite(p[sel]).astype(np.int32),
            'nr_': np.isfinite(d.r34.to_numpy(dtype=float)[sel]).astype(np.int32),
        })
        for bk, m in mask.items():
            inb = m[s.ci.to_numpy()]
            if not inb.any():
                continue
            sb = s[inb]
            g = sb.groupby(['yi', 'mi', 'na'], sort=True)
            a = g.agg(n=('v', 'size'),
                      sumv=('v', 'sum'), sumv2=('v2', 'sum'), nv=('nv', 'sum'),
                      maxv=('v', 'max'),
                      sump=('p', 'sum'), npr=('np_', 'sum'),
                      minp=('p', 'min'),
                      sumr=('r', 'sum'), nr=('nr_', 'sum'),
                      maxr=('r', 'max')).reset_index()
            # distinct storms do not add across the stage dimension, so carry
            # one count per selection on the all-stages key and let the page pick
            cc = None
            for key, _lab, nats in STAGE_SETS:
                f_ = sb if nats is None else sb[sb.nat.isin(nats)]
                col = 'ns' if key == 'all' else 'ns_' + key
                if not len(f_):
                    if cc is not None:
                        cc[col] = 0
                    continue
                g_ = f_.groupby(['yi', 'mi']).sid.nunique().reset_index(name=col)
                cc = g_ if cc is None else cc.merge(g_, on=['yi', 'mi'], how='left')
            for _k, _l, _n in STAGE_SETS:
                col = 'ns' if _k == 'all' else 'ns_' + _k
                if col not in cc:
                    cc[col] = 0
                cc[col] = cc[col].fillna(0).astype(int)
            a = a.merge(cc, on=['yi', 'mi'], how='left')
            a['bk'] = bk
            a['ti'] = ti
            out.append(a)
    r = pd.concat(out, ignore_index=True)
    for c, f in (('sumv', 0.0), ('sumv2', 0.0), ('maxv', -1), ('minp', -1),
                 ('sumr', 0.0), ('maxr', -1)):
        r[c] = r[c].fillna(f)
    print(f'    months: {len(r):,} (basin,year,month,threshold) records')
    return r


def storm_counts(d, wind_col, mask, nlon):
    """Distinct storms, counted once per box per year, at three levels.

    A storm is a track, not a set of positions: one cyclone sitting in a box for
    three days is one occurrence there, not twelve.  That makes the count a
    *nunique*, and nunique does not add up — a storm crossing twenty cells is one
    storm in each of them but still only one storm in the basin.  Summing the
    per-cell counts for 2020 gives 513; there were 102 storms.  So each level the
    pages display has to be counted at that level:

        cell   (ci, yi, ti)       -> the map
        band   (bk, li, yi, ti)   -> the trend-by-latitude panel
        basin  (bk, yi, ti)       -> the annual series panel

    and the three are deliberately not derivable from one another.  Everything is
    per cumulative threshold `ti`, not per intensity bin, for the same reason.
    """
    v = d[wind_col].to_numpy(dtype=float)
    out = {'cell': [], 'band': [], 'basin': []}
    for ti, th in enumerate(THRESH):
        sel = np.ones(len(d), bool) if th['cut'] is None else (v >= th['cut'])
        s = d.loc[sel, ['ci', 'yi', 'SID', 'NATURE']]
        if not len(s):
            continue

        def two(frame, keys):
            """Distinct storms for every stage selection, on the all-stages key
            set.  One value column per selection rather than a stage dimension,
            because nunique does not add up across stages: a cyclone with both
            tropical and extratropical positions in a box is one storm there,
            not two."""
            out_ = None
            for key, _lab, nats in STAGE_SETS:
                f_ = frame if nats is None else frame[frame.NATURE.isin(nats)]
                col = 'ns' if key == 'all' else 'ns_' + key
                if not len(f_):
                    if out_ is not None:
                        out_[col] = 0
                    continue
                g_ = f_.groupby(keys).SID.nunique().reset_index(name=col)
                out_ = g_ if out_ is None else out_.merge(g_, on=keys, how='left')
            for _k, _l, _n in STAGE_SETS:
                col = 'ns' if _k == 'all' else 'ns_' + _k
                if col not in out_:
                    out_[col] = 0
                out_[col] = out_[col].fillna(0).astype(int)
            return out_

        c = two(s, ['ci', 'yi'])
        c['ti'] = ti
        out['cell'].append(c)

        li = (s.ci.to_numpy() // nlon)
        for bk, m in mask.items():
            inb = m[s.ci.to_numpy()]
            if not inb.any():
                continue
            sb = s[inb].assign(li=li[inb], bk=bk)
            b = two(sb, ['bk', 'li', 'yi'])
            b['ti'] = ti
            out['band'].append(b)
            r = two(sb, ['bk', 'yi'])
            r['ti'] = ti
            out['basin'].append(r)

    res = {k: (pd.concat(v_, ignore_index=True) if v_ else pd.DataFrame())
           for k, v_ in out.items()}
    print(f'    storms: {len(res["cell"]):,} cell / {len(res["band"]):,} band / '
          f'{len(res["basin"]):,} basin records')
    return res


def ns_cols(frame):
    """The per-selection distinct-storm columns, as plain lists."""
    return {('ns' if k == 'all' else 'ns_' + k):
            frame['ns' if k == 'all' else 'ns_' + k].tolist()
            for k, _l, _n in STAGE_SETS}


def build(args):
    print('loading IBTrACS ...')
    df = load(args.csv)
    d, nlat, nlon = prepare(df, args.y0, args.y1, args.grid)
    nyear = args.y1 - args.y0 + 1

    # cell -> basin membership bitmask
    lat_c = (np.arange(nlat) + 0.5) * args.grid - 90.0
    lon_c = (np.arange(nlon) + 0.5) * args.grid
    LON, LAT = np.meshgrid(lon_c, lat_c)
    mask = {}
    for bs in BASINS:
        lo, hi = bs['lon']
        inlon = (LON >= lo) & (LON < hi) if lo < hi else ((LON >= lo) | (LON < hi))
        m = inlon & (LAT >= bs['lat'][0]) & (LAT < bs['lat'][1])
        mask[bs['k']] = m.ravel()

    # A season is "provisional" while most of its positions still carry a
    # PROVISIONAL track type — best tracks are reanalysed after the season and
    # intensities can move.  Report the first such year rather than dropping it:
    # a complete season is worth showing with a caveat.
    pf = d.groupby('SEASON').prov.mean()
    late = pf[pf > 0.5]
    prov_from = int(late.index.min()) if len(late) else None

    index = {
        'meta': {
            'source': 'NOAA IBTrACS v04r01',
            'built': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()),
            'note': 'synoptic (00/06/12/18 UTC) positions only; '
                    'one count unit = one 6-hour storm position',
            'reference': 'Klotzbach et al. (2022), Geophys. Res. Lett. 49, '
                         'e2021GL095774, doi:10.1029/2021GL095774 — the basis '
                         'for defaulting the period to 1990 onward',
        },
        'grid': args.grid, 'nlat': nlat, 'nlon': nlon,
        'y0': args.y0, 'y1': args.y1,
        # first season not yet through post-season reanalysis; the pages flag it
        'provisional_from': prov_from,
        'bins': BIN_LABELS, 'edges': EDGES,
        'thresholds': THRESH,
        'natures': NATURES,
        'stage_sets': [{'k': k, 'label': l, 'nat': nats} for k, l, nats in STAGE_SETS],
        'basins': BASINS,
        'basin_cells': {k: np.flatnonzero(v).tolist() for k, v in mask.items()},
        'sources': {},
    }

    for src, (wc, pc) in {'usa': ('USA_WIND', 'USA_PRES')}.items():
        print(f'aggregating {src} ...')
        a = aggregate(d, wc, pc, nyear)
        sc = storm_counts(d, wc, mask, nlon)
        mt = month_table(d, wc, pc, mask)
        bkeys = [b['k'] for b in BASINS]
        obj = {
            'ci':   a.ci.tolist(),
            'yi':   a.yi.tolist(),
            'bi':   a.bi.tolist(),
            'na':   a.na.tolist(),
            'n':    a.n.tolist(),
            'sumv2': q(a.sumv2),
            # distinct storms, counted once per box per year, at each level
            'sc': dict({'ci': sc['cell'].ci.tolist(), 'yi': sc['cell'].yi.tolist(),
                        'ti': sc['cell'].ti.tolist()}, **ns_cols(sc['cell'])),
            'sb': dict({'bk': [bkeys.index(x) for x in sc['band'].bk],
                        'li': sc['band'].li.tolist(), 'yi': sc['band'].yi.tolist(),
                        'ti': sc['band'].ti.tolist()}, **ns_cols(sc['band'])),
            'sr': dict({'bk': [bkeys.index(x) for x in sc['basin'].bk],
                        'yi': sc['basin'].yi.tolist(),
                        'ti': sc['basin'].ti.tolist()}, **ns_cols(sc['basin'])),
            'mo': dict({'bk': [bkeys.index(x) for x in mt.bk], 'yi': mt.yi.tolist(),
                   'mi': mt.mi.tolist(), 'ti': mt.ti.tolist(),
                   'na': mt.na.tolist(),
                   'n': mt.n.tolist(),
                   'sumv': q(mt.sumv), 'sumv2': q(mt.sumv2), 'nv': mt.nv.tolist(),
                   'maxv': q(mt.maxv), 'sump': q(mt.sump), 'np': mt.npr.tolist(),
                   'minp': q(mt.minp), 'sumr': q(mt.sumr, R34S),
                   'nr': mt.nr.tolist(), 'maxr': q(mt.maxr, R34S)},
                  **ns_cols(mt)),
            'sumv': q(a.sumv),
            'nv':   a.nv.tolist(),
            'maxv': q(a.maxv),
            'sump': q(a.sump),
            'np':   a.npr.tolist(),
            'minp': q(a.minp),
            # R34 is a mean over 3 or 4 integer quadrant radii, so it lands on
            # thirds or quarters of a nautical mile.  q() rounds to integers,
            # which is exact for winds and pressures but would quietly lose that
            # and put every summed total slightly off.  Store x12 (the lcm of 3
            # and 4) and divide on read.
            'sumr': q(a.sumr, R34S),
            'nr':   a.nr.tolist(),
            'maxr': q(a.maxr, R34S),
        }
        path = os.path.join(args.out, f'grid_{src}.json.gz')
        with gzip.open(path, 'wt', compresslevel=9) as f:
            json.dump(obj, f, separators=(',', ':'))
        sz = os.path.getsize(path) / 1e6
        print(f'    wrote {path}  {sz:.2f} MB gz')

        # When each field actually begins, per basin.  This is not cosmetic:
        # NHC has issued a central-pressure estimate since 1980, but JTWC only
        # from 2001 (West Pacific) and 2002 (South Indian / South Pacific), so
        # "Pmin, 1990-2024" is a 1990 record in the Atlantic and a 2002 one in
        # the West Pacific.  The pages use this to explain why a field is blank
        # over part of the globe rather than just drawing nothing.
        # `any` is the first year the basin has any storm position at all, which
        # separates a *reporting* gap from simply having had no cyclones: the
        # South Atlantic's first hurricane-strength storm was Catarina in 2004,
        # and that is not the same kind of fact as JTWC not issuing pressures
        # until 2001.  The pages only warn when a field starts later than the
        # basin's own record does.
        starts = {}
        for fld, col in (('any', None), ('vmax', wc), ('pmin', pc), ('r34', 'r34')):
            ok = d if col is None else d[pd.to_numeric(d[col], errors='coerce').notna()]
            per = {}
            for bs in BASINS:
                m = mask[bs['k']][ok.ci.to_numpy()]
                if m.any():
                    per[bs['k']] = int(ok.SEASON[m].min())
            starts[fld] = per
        index['field_start'] = starts

        vv = pd.to_numeric(d[wc], errors='coerce')
        index['sources'][src] = {
            'label': 'USA (NHC / JTWC, 1-min sustained)',
            'wind_col': wc, 'pres_col': pc,
            'coverage': round(float(vv.notna().mean()), 4),
            'file': f'grid_{src}.json.gz',
        }

    with open(os.path.join(args.out, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    print('wrote index.json')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('csv', nargs='?', default='../ibtracs.ALL.list.v04r01.csv')
    ap.add_argument('out', nargs='?', default='data')
    ap.add_argument('--grid', type=float, default=5.0)
    ap.add_argument('--y0', type=int, default=1980)
    ap.add_argument('--y1', type=int, default=2025)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    build(args)
