#!/usr/bin/env python3
"""
Reference values for test_card.js, computed straight from the IBTrACS CSV and
from scipy, sharing no code with either build_tc_trends.py or tccard.html.

    python3 ref_values.py [ibtracs.csv] > /dev/null     # writes ref_values.json
"""
import json, sys
import numpy as np
import pandas as pd
from scipy import stats

CSV = sys.argv[1] if len(sys.argv) > 1 else '../ibtracs.ALL.list.v04r01.csv'
GRID = 5.0

# Same boxes as build_tc_trends.BASINS, restated here on purpose.
# Same boxes as build_tc_trends.BASINS, restated here on purpose so this file
# shares nothing with the code it checks.  NA wraps the prime meridian.
BOX = {
    'GL': ((0, 360), (-60, 60)),
    'NA': ((260, 40), (0, 60)),
    'WP': ((100, 180), (0, 60)),
    'EP': ((180, 260), (0, 60)),
    'SI': ((0, 90), (-60, 0)),
    'AU': ((90, 160), (-60, 0)),
    'SP': ((160, 290), (-60, 0)),
}
CUT = {'all': -1e9, 'ts': 34, 'hu': 64, 'maj': 96}

# Same stage selections as build_tc_trends.STAGE_SETS, restated on purpose.
STAGE_SETS = {
    'all': None, 'ts': ['TS'], 'et': ['ET'], 'tset': ['TS', 'ET'],
    'ss': ['SS'], 'ds': ['DS'], 'mx': ['MX'], 'nr': ['NR'],
}


def points():
    d = pd.read_csv(CSV, usecols=['SID', 'SEASON', 'ISO_TIME', 'NATURE', 'LAT', 'LON',
                                  'USA_WIND', 'USA_PRES', 'TRACK_TYPE',
                                  'USA_R34_NE', 'USA_R34_SE', 'USA_R34_SW',
                                  'USA_R34_NW'],
                    skiprows=[1], keep_default_na=False, low_memory=False)
    d['SEASON'] = pd.to_numeric(d.SEASON, errors='coerce')
    d = d[(d.SEASON >= 1980) & (d.SEASON <= 2024)]
    d = d[d.TRACK_TYPE.isin(['main', 'PROVISIONAL', 'US-PROVISIONAL'])]
    t = pd.to_datetime(d.ISO_TIME, errors='coerce')
    d = d.assign(month=t.dt.month)
    d = d[t.dt.hour.isin([0, 6, 12, 18])]
    # ACE is defined over tropical and subtropical stages only
    d['trop'] = d.NATURE.isin(['TS', 'SS'])
    R34 = ['USA_R34_NE', 'USA_R34_SE', 'USA_R34_SW', 'USA_R34_NW']
    for c in ['LAT', 'LON', 'USA_WIND', 'USA_PRES'] + R34:
        d[c] = pd.to_numeric(d[c], errors='coerce')
    # storm size: mean 34-kt radius over the quadrants that have gales, needing
    # at least three of the four (see build_tc_trends.prepare for why)
    _q = d[R34]
    d['r34'] = _q.where(_q > 0).mean(axis=1).where((_q > 0).sum(axis=1) >= 3)
    d = d[d.LAT.notna() & d.LON.notna()]
    d['LON360'] = d.LON % 360
    # snap to the cell the point falls in, then use the cell centre for the box
    # test, so the region membership matches the map exactly
    d['clat'] = np.floor((d.LAT + 90) / GRID) * GRID - 90 + GRID / 2
    d['clon'] = np.floor(d.LON360 / GRID) * GRID + GRID / 2
    return d


def in_box(d, lo, hi, la, lb):
    """Cell-centre membership, handling a box that wraps the prime meridian."""
    inlon = ((d.clon >= lo) & (d.clon < hi)) if lo < hi else \
            ((d.clon >= lo) | (d.clon < hi))
    return inlon & (d.clat >= la) & (d.clat < lb)


def series(d, basin, thr, field, stat, y0=1980, y1=2024, band=None, stage='all'):
    """`band`, if given, is the southern edge of a GRID-wide latitude band, which
    scopes the result the way the trend-by-latitude panel does.  `stage` mirrors
    the page's Stages control."""
    (lo, hi), (la, lb) = BOX[basin]
    m = in_box(d, lo, hi, la, lb)
    nats = STAGE_SETS[stage]
    if nats is not None:
        m &= d.NATURE.isin(nats)
    if thr != 'all':
        m &= d.USA_WIND >= CUT[thr]
    if band is not None:
        m &= (d.clat >= band) & (d.clat < band + GRID)
    s = d[m]
    out = []
    for yr in range(y0, y1 + 1):
        r = s[s.SEASON == yr]
        if field == 'ace':
            out.append(float((r.USA_WIND[r.trop] ** 2).sum()) * 1e-4)
        elif field == 'density':
            # storms: one cyclone counted once, however long it stayed
            out.append(r.SID.nunique() if stat == 'storms' else len(r) / 4.0)
        elif field == 'size':
            z = r.r34.dropna()
            out.append(None if not len(z) else
                       float(z.mean()) if stat == 'mean' else float(z.max()))
        elif field == 'vmax':
            v = r.USA_WIND.dropna()
            # None, not NaN: a year with no qualifying position is missing data,
            # and NaN is not valid JSON
            out.append(None if not len(v) else
                       float(v.mean()) if stat == 'mean' else float(v.max()))
        else:
            p = r.USA_PRES.dropna()
            out.append(None if not len(p) else
                       float(p.mean()) if stat == 'mean' else float(p.min()))
    return out


def main():
    d = points()

    rng = np.random.default_rng(7)
    x = np.arange(1980, 2025, dtype=float)
    y = np.round(30 + 0.35 * (x - 1980) + rng.normal(0, 6, x.size), 0)
    lr = stats.linregress(x, y)
    # the page's CI is slope +/- t(0.975, n-2) * stderr; reproduce it here
    tc = stats.t.ppf(0.975, x.size - 2)

    cases = []
    #  name                       basin thr    field      stat      band
    spec = [
        ('storms GL TS+',          'GL', 'ts',  'density', 'storms', None),
        ('storms NA ts+',          'NA', 'ts',  'density', 'storms', None),
        ('storms WP hu+',          'WP', 'hu',  'density', 'storms', None),
        ('storms SI ts+ 20-15S',   'SI', 'ts',  'density', 'storms', -20),
        ('storms GL ts+ 10-15N',   'GL', 'ts',  'density', 'storms', 10),
        ('ace GL TS+',             'GL', 'ts',  'ace',     'sum',    None),
        ('ace NA TS+',             'NA', 'ts',  'ace',     'sum',    None),
        ('ace WP hu+',             'WP', 'hu',  'ace',     'sum',    None),
        ('storm-days GL TS+',      'GL', 'ts',  'density', 'days',   None),
        ('storm-days NA hu+',      'NA', 'hu',  'density', 'days',   None),
        ('vmax GL hu+ mean',       'GL', 'hu',  'vmax',    'mean',   None),
        ('vmax WP all max',        'WP', 'all', 'vmax',    'ext',    None),
        ('pmin SI ts+ mean',       'SI', 'ts',  'pmin',    'mean',   None),
        # the Australian region, carved out of SI and SP
        ('storms AU ts+',          'AU', 'ts',  'density', 'storms', None, 'all'),
        ('storm-days AU ts+',      'AU', 'ts',  'density', 'days',   None, 'all'),
        ('vmax AU hu+ mean',       'AU', 'hu',  'vmax',    'mean',   None, 'all'),
        # size exists only from ~2001 and is best-tracked from 2004; the case
        # windows below still start in 1980 and simply carry Nones before that,
        # which also checks that a field with a late start is handled
        ('size NA ts+ mean',       'NA', 'ts',  'size',    'mean',   None),
        ('size EP hu+ max',        'EP', 'hu',  'size',    'ext',    None),
        # the Stages control: same selections, tropical/subtropical positions only
        ('storm-days NA ts+ TS',   'NA', 'ts',  'density', 'days',   None, 'ts'),
        ('storm-days NA ts+ ET',   'NA', 'ts',  'density', 'days',   None, 'et'),
        ('storm-days NA ts+ TSET', 'NA', 'ts',  'density', 'days',   None, 'tset'),
        ('vmax NA ts+ mean TSET',  'NA', 'ts',  'vmax',    'mean',   None, 'tset'),
        ('size NA ts+ mean TS',    'NA', 'ts',  'size',    'mean',   None, 'ts'),
        ('storms NA ts+ TSET',     'NA', 'ts',  'density', 'storms', None, 'tset'),
        ('storms NA ts+ ET',       'NA', 'ts',  'density', 'storms', None, 'et'),
        ('storms NA ts+ SS',       'NA', 'ts',  'density', 'storms', None, 'ss'),
    ]
    for name, b, t, f, st, band, *rest in spec:
        stage = rest[0] if rest else 'all'
        v = series(d, b, t, f, st, band=band, stage=stage)
        yr = np.arange(1980, 2025, dtype=float)
        keep = np.array([u is not None for u in v])
        yv = np.array([u for u in v if u is not None], dtype=float)
        r = stats.linregress(yr[keep], yv)
        tci = stats.t.ppf(0.975, keep.sum() - 2)
        cases.append({
            'name': name, 'y0': 1980, 'y1': 2024,
            'field': f, 'stat': st, 'thr': t, 'basin': b, 'band': band,
            # always explicit: the page now defaults to tset, so an omitted
            # stage would silently mean something other than "all stages"
            'hash': f'v={f}&s={st}&t={t}&b={b}&p=1980-2024&g={stage}',
            'stage': stage,
            'series': v, 'n_valid': int(keep.sum()),
            'slope_decade': float(r.slope) * 10,
            'ci_lo_decade': float(r.slope - tci * r.stderr) * 10,
            'ci_hi_decade': float(r.slope + tci * r.stderr) * 10,
            'p': float(r.pvalue),
        })

    # monthly reference for the seasonal-cycle and month-by-month panels
    monthly = []
    for name, b, t, f, st in [('ace NA ts+', 'NA', 'ts', 'ace', 'sum'),
                              ('storm-days NA ts+', 'NA', 'ts', 'density', 'days'),
                              ('vmax WP hu+ mean', 'WP', 'hu', 'vmax', 'mean')]:
        (lo, hi), (la, lb) = BOX[b]
        m = in_box(d, lo, hi, la, lb)
        if t != 'all':
            m &= d.USA_WIND >= CUT[t]
        s_ = d[m]
        grid = []          # [month][year]
        for mo in range(1, 13):
            row = []
            for yr in range(1980, 2025):
                r = s_[(s_.SEASON == yr) & (s_.month == mo)]
                if f == 'ace':
                    row.append(float((r.USA_WIND[r.trop] ** 2).sum()) * 1e-4)
                elif f == 'density':
                    row.append(len(r) / 4.0)
                else:
                    v = r.USA_WIND.dropna()
                    row.append(None if not len(v) else float(v.mean()))
            grid.append(row)
        monthly.append({'name': name, 'field': f, 'stat': st, 'thr': t, 'basin': b,
                        'grid': grid})

    out = {
        'monthly': monthly,
        'fit_test': {
            'x': x.tolist(), 'y': y.tolist(),
            'ols_slope': float(lr.slope), 'ols_p': float(lr.pvalue),
            'ols_lo': float(lr.slope - tc * lr.stderr),
            'ols_hi': float(lr.slope + tc * lr.stderr),
            'ols_r2': float(lr.rvalue) ** 2,
        },
        'cases': cases,
    }
    with open('ref_values.json', 'w') as fh:
        json.dump(out, fh)
    print('wrote ref_values.json')
    for c in cases:
        print(f'  {c["name"]:24s} n={c["n_valid"]:2d}  slope/decade '
              f'{c["slope_decade"]:+9.4f}  [{c["ci_lo_decade"]:+.4f}, '
              f'{c["ci_hi_decade"]:+.4f}]')


if __name__ == '__main__':
    main()
