# How these pages compare with `Notebooks/IBTrACS.ipynb`

Compared against the current notebook and its stored outputs in
`github.com/adevroy569/Hurricane-Intensities`. Test case chosen to match the presentation
slide: **mean Vmax, Vmax ≥ 64 kt, 1990–2024**.

## The comparison is trustworthy

The notebook cannot be executed here (cartopy, cmaps, and hours of per-point Python loops), so
its gridding, averaging and trend logic was reimplemented and run on the raw IBTrACS CSV.
That reimplementation **reproduces the stored array**
`Vmax/ibtracs-meanint-4x4_1990-2024_64.nc` to **98.7% of cell-years exactly**, *r* = 0.99982,
mean 81.513 vs 81.502 kt. The small residual is a newer IBTrACS release on this side — best
tracks get revised — not a difference of method.

Two properties of the stored files, worth recording:

- **They are in knots, not m/s.** `ibtracs-meanint-…_64.nc` has min exactly 64.00 and max
  155.00. The gridding cell's comment says "already in m/s", but `WMO_WIND` is knots and no
  conversion happens there; it is applied at *plot* time (`*0.514444`), so the figures are
  correctly labelled. Note there is a second variant of the gridding cell that converts
  inline — take care not to double-convert.
- **Track density is a genuine count of track positions.** Values run 0, 1, 2 … 40 and match
  an independent position count in **99.89%** of cells (totals 22,671 vs 23,147).

## Verdict

Stored arrays against this site's `data/grid_usa.json.gz`, on a common 20° grid:

| | agreement |
|---|---|
| **Climatology map** | **Good.** *r* = 0.808, levels close: **39.44** m/s notebook vs **40.30** m/s here. |
| **Trend map** | **Sign mostly, magnitude no.** *r* = 0.622, sign agrees in **75%** of boxes, but the notebook averages **+0.420** m/s/decade against **+0.225** here — a factor of ~1.9. |
| **Trend vs latitude** | **Shape yes, detail no.** North Atlantic differences ≤ 0.9 m/s/decade, West Pacific up to **1.1** at 6°N. Same broad structure. |

The trend gap is large enough to matter for the slide's claim that certain basins show an
upward intensity trend. The **sign of that claim survives; the magnitude roughly halves.**

## What already agrees

- **Zonal weighting is algebraically identical.** The notebook's
  `(tint*td).mean("lon") / td.where(td>0).mean("lon")` expands, with a real count in `td`, to
  `Σ(Σ Vmax)/Σ(N)` — exactly this site's position-weighted `Σ(sum)/Σ(count)`. Checked band by
  band: largest disagreement in any band-year is **1.4 × 10⁻¹⁴ m/s**.
- **Intensity gridding is the same idea.** A cell-year value is the mean over that year's
  qualifying positions in the cell.
- **Trend estimator and minimum-years rule are the same** — Theil–Sen, `thresh` = 10.

## What differs, ranked by how much it moves the answer

### 1. `WMO_WIND` vs `USA_WIND` — dominant, and the whole story of the 1.9× gap

Global pooled mean-Vmax | Cat 1+ trend, 1990–2024:

| field | mean | trend | coverage, first 5 yrs → last 5 yrs |
|---|---|---|---|
| `WMO_WIND` (notebook) | 43.27 m/s | **+0.465** m/s/decade | 64% → 79% |
| `USA_WIND` (this site) | 46.48 m/s | **+0.285** m/s/decade | 89% → 86% |

It is **not** a fixed averaging-convention offset. Restricting to the *same* positions with
the *same* selection (USA ≥ 64 kt and WMO present), the two still give **+1.06** vs **+0.28**
m/s/decade. The WMO field's own composition changes through the record — which positions carry
a value at all, and which agency supplied it with its own averaging period — and that drift is
read as trend.

`USA_WIND` is NHC in the Atlantic and East Pacific and JTWC elsewhere: one convention
throughout, and coverage that is flat rather than rising. That is why these pages use it.

### 2. Track density counts different things

The notebook counts **track positions**. This site's default, **storm-days**, is the same
quantity ÷ 4, so the two are directly comparable up to that factor and the 3-hourly difference
below.

The second option, **storms**, counts each cyclone once per box per year. Over 1990–2024 at
Cat 1+ that gives 7,331 against the notebook's 22,671 — roughly a third — because a cyclone
contributes many positions to a box but only one occurrence. Distinct counts also do not sum
between cell, latitude band and basin, so each level is counted separately.

### 3. 3-hourly positions

The notebook counts every row. About half of IBTrACS rows are 3-hourly interpolated positions;
this site keeps only 00/06/12/18 UTC. The fraction is stable over time so it is not a trend
artefact, but it changes the weighting inside a cell-year and roughly doubles track density.

### 4. Grid definition

The notebook uses `round(lon/n)` and `round((lat+90)/n)`, snapping to the **nearest node**, so
cells are centred on multiples of *n* and the first and last are half-width. This site uses
`floor`, giving proper *n*-degree bins. Changing only this moved the trend-map correlation from
0.76 to 0.36 on a 20° grid — per-cell trends are sensitive to which cell a point lands in. The
presentation uses 4°, these pages 5°.

### 5. North Atlantic basin box

The notebook's is `lon 266.25–308.75` — it stops at 51.25°W and excludes the entire Cape Verde
main development region. These pages use 260–360°E.

### 6. Coverage gates

Both require a minimum number of years. These pages add two requirements the notebook does not
have: the years must span ≥ 70% of the period and have ≥ 2 in each half. This blanks cells
whose "1990–2024 trend" is really a trend over a much shorter sub-period. It matters most for
Pmin, which does not exist in the JTWC basins until 1999–2002.

## Reproducing the notebook's numbers here

Points 3–6 are options or constants that could be relaxed. Point 1 would need a data rebuild:
`build_tc_trends.py` originally emitted a `grid_wmo.json.gz` alongside the USA file, and
re-enabling it would let the page offer a **wind source** toggle so the notebook's figures can
be reproduced side by side with the USA-based ones.

## How this was checked

The repo is cloned at `AniketDevRoy/github/Hurricane-Intensities`. The comparison scripts were
throwaway; the recipe is:

1. Rebuild `Vmax/ibtracs-meanint-4x4_1990-2024_64.nc` from `ibtracs.ALL.list.v04r01.csv` using
   the notebook's exact indexing — `np.round((lat+90)/4)`, `np.round(lon/4)` with negative
   longitudes left to wrap through Python's negative indexing, `WMO_WIND ≥ 64`, every row, no
   spur filter — and confirm it matches the stored array.
2. Coarsen that array and this site's `data/grid_usa.json.gz` to a common 20° grid; correlate
   the climatology and the Theil–Sen trend.
3. For the zonal panel, apply the notebook's own `(tint*td)/td` reduction to the stored files
   and compare band by band with this site's `Σ(sum)/Σ(count)`.

Worth re-running whenever either side changes.
