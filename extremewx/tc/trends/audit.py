#!/usr/bin/env python3
"""
Independent audit of everything tccard.html displays.

Written from the page's *documented behaviour*, not from its code.  This file
shares nothing with build_tc_trends.py, ref_values.py or tccard.html: it reads
the raw IBTrACS CSV, re-derives the grid, the gates, the aggregations and the
statistics from scratch, and writes audit_ref.json for audit.js to compare
against the live page.

    python3 audit.py [ibtracs.csv]      # writes audit_ref.json
    node audit.js .                     # compares against the page

Covered: per-cell climatology and trend, the coverage gates, zonal profiles,
region annual series and their trends, the seasonal cycle, the month-by-month
grids, the Gaussian smoother, and the basin partition.
"""
import json, sys
import numpy as np
import pandas as pd

CSV = sys.argv[1] if len(sys.argv) > 1 else '../ibtracs.ALL.list.v04r01.csv'
GRID = 5.0
NLAT, NLON = 36, 72
Y0, Y1 = 1980, 2025
NY = Y1 - Y0 + 1

# --- rules restated from the page, deliberately not imported -----------------
CUT = {'all': None, 'ts': 34.0, 'hu': 64.0, 'maj': 96.0}
STAGES = {'all': None, 'ts': ['TS'], 'et': ['ET'], 'tset': ['TS', 'ET'],
          'ss': ['SS'], 'ds': ['DS'], 'mx': ['MX'], 'nr': ['NR']}
BOX = {
    'GL': ((0, 360), (-60, 60)),
    'NA': ((260, 40), (0, 60)),
    'EP': ((180, 260), (0, 60)),
    'WP': ((100, 180), (0, 60)),
    'NI': ((40, 100), (0, 60)),
    'SI': ((0, 90), (-60, 0)),
    'AU': ((90, 160), (-60, 0)),
    'SP': ((160, 290), (-60, 0)),
    'SA': ((290, 360), (-60, 0)),
    'NH': ((0, 360), (0, 60)),
    'SH': ((0, 360), (-60, 0)),
}
SPAN_MIN, HALF_MIN, YR_MIN, YR_FRAC = 0.70, 2, 8, 0.30
SMOOTH_SIGMA = 1.0

R34Q = ['USA_R34_NE', 'USA_R34_SE', 'USA_R34_SW', 'USA_R34_NW']


def years_needed(nwin):
    return max(YR_MIN, int(np.ceil(YR_FRAC * nwin)))


def load():
    cols = ['SID', 'SEASON', 'ISO_TIME', 'NATURE', 'LAT', 'LON',
            'USA_WIND', 'USA_PRES', 'TRACK_TYPE'] + R34Q
    d = pd.read_csv(CSV, usecols=cols, skiprows=[1],
                    keep_default_na=False, low_memory=False)
    d['SEASON'] = pd.to_numeric(d.SEASON, errors='coerce')
    d = d[(d.SEASON >= Y0) & (d.SEASON <= Y1)]
    d = d[d.TRACK_TYPE.isin(['main', 'PROVISIONAL', 'US-PROVISIONAL'])]
    t = pd.to_datetime(d.ISO_TIME, errors='coerce')
    d = d.assign(month=t.dt.month)
    d = d[t.dt.hour.isin([0, 6, 12, 18]).fillna(False)]
    for c in ['LAT', 'LON', 'USA_WIND', 'USA_PRES'] + R34Q:
        d[c] = pd.to_numeric(d[c], errors='coerce')
    d = d[d.LAT.notna() & d.LON.notna()]

    lon360 = d.LON % 360.0
    li = np.clip(np.floor((d.LAT + 90.0) / GRID).astype(int), 0, NLAT - 1)
    ki = np.clip(np.floor(lon360 / GRID).astype(int), 0, NLON - 1) % NLON
    q = d[R34Q]
    nz = (q > 0).sum(axis=1)
    r34 = q.where(q > 0).mean(axis=1).where(nz >= 3)
    return d.assign(li=li, ki=ki, ci=li * NLON + ki,
                    yi=(d.SEASON - Y0).astype(int),
                    trop=d.NATURE.isin(['TS', 'SS']), r34=r34)


def cell_centres():
    lat = (np.arange(NLAT) + 0.5) * GRID - 90.0
    lon = (np.arange(NLON) + 0.5) * GRID
    LON, LAT = np.meshgrid(lon, lat)
    return LAT.ravel(), LON.ravel()

CLAT, CLON = cell_centres()


def basin_mask(b):
    (lo, hi), (la, lb) = BOX[b]
    inlon = ((CLON >= lo) & (CLON < hi)) if lo < hi else ((CLON >= lo) | (CLON < hi))
    return inlon & (CLAT >= la) & (CLAT < lb)


def ols(x, y):
    """Slope per unit x, its p, and the 95% limits, from first principles."""
    n = len(x)
    if n < 3:
        return None
    x = np.asarray(x, float); y = np.asarray(y, float)
    mx, my = x.mean(), y.mean()
    sxx = ((x - mx) ** 2).sum()
    if sxx == 0:
        return None
    b = ((x - mx) * (y - my)).sum() / sxx
    a = my - b * mx
    resid = y - (a + b * x)
    s2 = (resid ** 2).sum() / (n - 2)
    se = np.sqrt(s2 / sxx)
    from scipy import stats
    tval = b / se if se > 0 else 0.0
    p = 2 * stats.t.sf(abs(tval), n - 2)
    tc = stats.t.ppf(0.975, n - 2)
    return dict(slope=b, p=p, lo=b - tc * se, hi=b + tc * se, n=n)


def gates(vals, years, nwin):
    """`vals` is one value per year of the window, NaN where undefined."""
    ok = np.isfinite(vals)
    if not ok.any():
        return None
    pos = ok & (vals > 0)
    ne = int(pos.sum())
    idx = np.where(pos)[0]
    if ne == 0:
        return dict(ne=0, plot=False, trend=False)
    e0, e1 = idx[0], idx[-1]
    mid = nwin / 2.0
    nfh = int((idx < mid).sum()); nsh = int((idx >= mid).sum())
    return dict(ne=ne, plot=ne >= 1,
                trend=(ne >= years_needed(nwin)
                       and (e1 - e0 + 1) >= SPAN_MIN * nwin
                       and nfh >= HALF_MIN and nsh >= HALF_MIN))


def annual_cell(sub, field, stat, i0, i1):
    """One value per cell per year, shaped (NCELL, nwin).  NaN = undefined."""
    nwin = i1 - i0 + 1
    out = np.full((NLAT * NLON, nwin), np.nan)
    if field in ('density', 'storms', 'ace'):
        out[:] = 0.0                      # a quiet year is a real zero
    g = sub.groupby(['ci', 'yi'])
    if field == 'density':
        r = g.size() / 4.0
    elif field == 'storms':
        r = g.SID.nunique()
    elif field == 'ace':
        s = sub[sub.trop & (sub.USA_WIND >= 34)]
        r = s.groupby(['ci', 'yi']).USA_WIND.apply(lambda v: (v ** 2).sum() * 1e-4)
    elif field == 'vmax':
        r = g.USA_WIND.max() if stat == 'ext' else g.USA_WIND.mean()
    elif field == 'pmin':
        r = g.USA_PRES.min() if stat == 'ext' else g.USA_PRES.mean()
    else:
        r = g.r34.max() if stat == 'ext' else g.r34.mean()
    for (ci, yi), v in r.items():
        if i0 <= yi <= i1 and np.isfinite(v):
            out[ci, yi - i0] = v
    return out


def run(d, cfg):
    field, stat, basin, thr, stage, a, b = (
        cfg['v'], cfg['stat'], cfg['b'], cfg['thr'], cfg['stage'], cfg['y0'], cfg['y1'])
    i0, i1 = a - Y0, b - Y0
    nwin = i1 - i0 + 1
    years = np.arange(a, b + 1, dtype=float)

    m = basin_mask(basin)
    sub = d[m[d.ci.to_numpy()]]
    if CUT[thr] is not None:
        sub = sub[sub.USA_WIND >= CUT[thr]]
    if STAGES[stage] is not None and field != 'ace':
        sub = sub[sub.NATURE.isin(STAGES[stage])]
    sub = sub[(sub.yi >= i0) & (sub.yi <= i1)]

    ann = annual_cell(sub, field, stat, i0, i1)

    # a cell that never saw a storm in the window is empty ocean, not data
    npos = np.zeros(NLAT * NLON)
    cnt = sub.groupby('ci').size()
    npos[cnt.index.to_numpy()] = cnt.to_numpy()

    mean = np.full(NLAT * NLON, np.nan)
    trend = np.full(NLAT * NLON, np.nan)
    for ci in np.where(m & (npos > 0))[0]:
        v = ann[ci]
        gt = gates(v, years, nwin)
        if gt is None or not gt['plot']:
            continue
        ok = np.isfinite(v)
        mean[ci] = v[ok].mean()
        if gt['trend']:
            r = ols(years[ok], v[ok])
            if r:
                trend[ci] = r['slope'] * 10

    # ---- zonal: bin straight into the latitude row, longitude ignored -------
    zonal = []
    for li in range(NLAT):
        cells = np.where(m & (np.arange(NLAT * NLON) // NLON == li))[0]
        if not len(cells):
            continue
        z = region_series(sub, field, stat, cells, i0, i1)
        gt = gates(z, years, nwin)
        lat = (li + 0.5) * GRID - 90.0
        if gt is None or not (np.isfinite(z).any() and gt['ne'] > 0):
            continue
        ok = np.isfinite(z)
        r = ols(years[ok], z[ok]) if gt['trend'] else None
        zonal.append(dict(lat=lat, mean=float(z[ok].mean()),
                          slope=(r['slope'] * 10 if r else None),
                          p=(r['p'] if r else None)))

    # ---- region annual series and its trend --------------------------------
    cells = np.where(m)[0]
    ser = region_series(sub, field, stat, cells, i0, i1)
    ok = np.isfinite(ser)
    gt = gates(ser, years, nwin)
    r = ols(years[ok], ser[ok]) if (gt and gt['trend']) else None

    # ---- seasonal cycle: 12 climatological monthly values -------------------
    seas = season_cycle(sub, field, stat, i0, i1, nwin)

    return dict(cfg=cfg,
                mean={str(int(c)): float(mean[c]) for c in np.where(np.isfinite(mean))[0]},
                trend={str(int(c)): float(trend[c]) for c in np.where(np.isfinite(trend))[0]},
                zonal=zonal,
                series=[None if not np.isfinite(x) else float(x) for x in ser],
                series_trend=(dict(slope=r['slope'] * 10, p=r['p']) if r else None),
                seasonal=seas)


def region_series(sub, field, stat, cells, i0, i1):
    """Region aggregate per year: total for extensive, position-weighted mean
    for intensive.  Distinct storms are counted at the region level."""
    nwin = i1 - i0 + 1
    out = np.full(nwin, np.nan)
    s = sub[sub.ci.isin(cells)]
    if field in ('density', 'storms', 'ace'):
        out[:] = 0.0
    g = s.groupby('yi')
    if field == 'density':
        r = g.size() / 4.0
    elif field == 'storms':
        r = g.SID.nunique()
    elif field == 'ace':
        t = s[s.trop & (s.USA_WIND >= 34)]
        r = t.groupby('yi').USA_WIND.apply(lambda v: (v ** 2).sum() * 1e-4)
    elif field == 'vmax':
        r = g.USA_WIND.max() if stat == 'ext' else g.USA_WIND.mean()
    elif field == 'pmin':
        r = g.USA_PRES.min() if stat == 'ext' else g.USA_PRES.mean()
    else:
        r = g.r34.max() if stat == 'ext' else g.r34.mean()
    for yi, v in r.items():
        if i0 <= yi <= i1 and np.isfinite(v):
            out[yi - i0] = v
    return out


def season_cycle(sub, field, stat, i0, i1, nwin):
    """Extensive fields average their annual monthly totals over the years;
    intensive fields pool every position in that month."""
    out = []
    for mo in range(1, 13):
        s = sub[sub.month == mo]
        if field in ('density', 'storms', 'ace'):
            tot = np.zeros(nwin)
            if len(s):
                if field == 'density':
                    r = s.groupby('yi').size() / 4.0
                elif field == 'storms':
                    r = s.groupby('yi').SID.nunique()
                else:
                    t = s[s.trop & (s.USA_WIND >= 34)]
                    r = t.groupby('yi').USA_WIND.apply(lambda v: (v ** 2).sum() * 1e-4)
                for yi, v in r.items():
                    if i0 <= yi <= i1:
                        tot[yi - i0] = v
            out.append(float(tot.mean()))
        else:
            col = {'vmax': 'USA_WIND', 'pmin': 'USA_PRES', 'size': 'r34'}[field]
            v = s[col].dropna()
            if not len(v):
                out.append(None)
            elif stat == 'ext':
                out.append(float(v.max() if field != 'pmin' else v.min()))
            else:
                out.append(float(v.mean()))
    return out


def smooth(vals):
    """Normalised Gaussian, sigma = 1 cell, longitude wrapping, gaps excluded,
    output NaN wherever the input was NaN."""
    R = int(np.ceil(2 * SMOOTH_SIGMA))
    w = np.exp(-0.5 * (np.arange(-R, R + 1) / SMOOTH_SIGMA) ** 2)
    g = np.array(vals, float).reshape(NLAT, NLON)
    ok = np.isfinite(g)
    f = np.where(ok, g, 0.0)
    num = np.zeros_like(f); den = np.zeros_like(f)
    for dy in range(-R, R + 1):
        ys = slice(max(0, dy), NLAT + min(0, dy))
        yd = slice(max(0, -dy), NLAT + min(0, -dy))
        for dx in range(-R, R + 1):
            wt = w[dy + R] * w[dx + R]
            num[yd] += wt * np.roll(f, -dx, axis=1)[ys]
            den[yd] += wt * np.roll(ok.astype(float), -dx, axis=1)[ys]
    res = np.where((den > 0) & ok, num / np.where(den == 0, 1, den), np.nan)
    return res.ravel()


CONFIGS = [
    dict(v='density', stat='mean', b='GL', thr='ts',  stage='tset', y0=1990, y1=2024),
    dict(v='storms',  stat='mean', b='NA', thr='hu',  stage='all',  y0=1990, y1=2024),
    dict(v='ace',     stat='mean', b='WP', thr='ts',  stage='tset', y0=1990, y1=2024),
    dict(v='vmax',    stat='mean', b='GL', thr='hu',  stage='ts',   y0=1990, y1=2024),
    dict(v='vmax',    stat='ext',  b='AU', thr='ts',  stage='all',  y0=1990, y1=2024),
    dict(v='pmin',    stat='mean', b='NA', thr='ts',  stage='tset', y0=2001, y1=2024),
    dict(v='size',    stat='mean', b='NA', thr='ts',  stage='tset', y0=2004, y1=2024),
    dict(v='size',    stat='ext',  b='EP', thr='hu',  stage='all',  y0=2004, y1=2024),
]

if __name__ == '__main__':
    print('reading %s ...' % CSV)
    d = load()
    print('  %d synoptic positions, %d storms' % (len(d), d.SID.nunique()))

    out = {'grid': GRID, 'nlat': NLAT, 'nlon': NLON, 'y0': Y0,
           'partition': {b: int(basin_mask(b).sum()) for b in BOX},
           'cases': []}
    for cfg in CONFIGS:
        r = run(d, cfg)
        out['cases'].append(r)
        print('  %-8s %-4s %-3s %-4s %-5s %d-%d  cells %4d  trends %4d  bands %2d'
              % (cfg['v'], cfg['stat'], cfg['b'], cfg['thr'], cfg['stage'],
                 cfg['y0'], cfg['y1'], len(r['mean']), len(r['trend']), len(r['zonal'])))

    # smoothing check on the first case's climatology
    base = CONFIGS[0]
    c0 = out['cases'][0]
    arr = np.full(NLAT * NLON, np.nan)
    for k, v in c0['mean'].items():
        arr[int(k)] = v
    sm = smooth(arr)
    out['smooth_case'] = {'cfg': base,
                          'smoothed': {str(int(c)): float(sm[c])
                                       for c in np.where(np.isfinite(sm))[0]}}

    with open('audit_ref.json', 'w') as fh:
        json.dump(out, fh)
    print('wrote audit_ref.json')
