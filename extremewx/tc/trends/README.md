# Tropical Cyclone Trends

**`tccard.html`** is the page. The whole story of one field in one frame:

1. a gridded **climatology**, with its **zonal mean** beside it
2. a gridded **trend**, with its **zonal trend** and 95% band beside it
3. the region-aggregate **annual series**
4. the climatological **seasonal cycle**
5. a **month-by-month** grid of twelve small multiples, each with its own trend

The two map rows run the full width, and each profile is drawn inside its map's own
coordinate group using the map's `Y()` — so a band at 20°N sits exactly level with the 20°N
row of cells. That alignment is the point of pairing them: the eye reads "the increase is at
15–25°N" off the two together without converting between panels.

The entire card is a single SVG, so it exports cleanly to PNG or SVG for a talk or a paper,
and it has a light theme for print. It mirrors `../../scs/trends/scstrend_state.html` for U.S.
severe convective hazards.

### How the maps are meant to be read

**The two maps are not equally certain, and only the trend map carries a caveat.** A cell's
climatology pools every year in the window — 45 of them by default — so at 5° it is reasonably
well determined and can be read at that scale. A cell's *trend* is a slope through only the
storms that happened to cross that box, which is a far smaller and noisier sample; it should be
read for the broad pattern, with the zonal profile beside it, rather than box by box. The card
says exactly this under the trend map.

Neither map is an estimate for a particular place *inside* a cell — risk at a point depends on
landfall geometry a 5° grid cannot resolve.

This is also why the card is the primary page rather than the zoomable map: a fixed frame does
not invite anyone to zoom to their own town and read a value off one box.

**The trend map carries no significance marking, on purpose.** Whether a 5° box clears *p* < 0.05
depends mostly on how many storms happened to cross it, so a significant box beside a
non-significant one says nothing physical — and stippling one and not the other implies it
does. Significance is nested, too: a pooled region can be significant while every sub-box
inside it is not, and vice versa. So it is shown only where the sample is pooled enough to
carry it, in the zonal trend profile (filled markers) and in the basin series and each monthly
panel (slope and *p*, bold when significant). Per-cell *p*-values are still
computed and still go into the CSV; they are simply not drawn.

**No R² anywhere.** R² answers "how much of the interannual variance does a straight line
explain", which is not the question these panels ask. Interannual TC variability is dominated
by ENSO and weather noise that no linear trend is meant to capture, so a low R² alongside a
clearly significant slope invites the wrong conclusion. What is reported instead is the slope
and its *p* — the size of the change and how confident one can be of its sign. The 95% limits
are drawn as the shaded band rather than spelled out, which keeps the headers readable.

<details>
<summary><b><code>trendmaps.html</code></b> — a pannable map explorer, kept but not actively maintained</summary>

One zoomable global map with live climatology, trend, late-vs-early change and single-year
views, plus a docked panel holding the trend by latitude and the annual series for whichever
region you pick, with the region's box outlined on the map. Hover any cell for a readout, click
for its full numbers; CSV export and shareable URLs included.

It shares this folder's `data/` and `geo/`, so it must stay here — moving the file alone breaks
its relative fetches. Nothing links to it; it is here in case the approach is wanted later, for
TCs or anything else. `test_maps.js` still covers it, and is worth running after any change to
the data schema so it does not rot silently.
</details>

## Fields

| Field | What a cell holds | Statistic |
|---|---|---|
| Track density (default) | storm-days: 6-hourly positions ÷ 4 | mean |
| Storm count | distinct cyclones through the box | mean |
| ACE | Σ Vmax² over the positions, in 10⁴ kt² | mean |
| Intensity (Vmax) | 1-min sustained wind at those positions | mean or maximum |
| Minimum pressure | central pressure at those positions | mean or minimum |
| Size (R34) | mean radius of 34-kt winds, n mi (2004+) | mean or maximum |

**Track density** counts 6-hourly best-track positions ÷ 4, so a storm lingering in a box counts
for more — a measure of exposure. It is the default because it is the simpler quantity: a
plain sum that adds up cleanly from cell to basin, and directly comparable with the notebook's
track density (which is the same thing without the ÷ 4).

**Storm count** counts each cyclone once per box per year however long it stayed — frequency
rather than exposure. It is the more careful quantity but the more awkward one, because
distinct counts do not sum between levels (see below).

These two were once a single "Track density" field with a Statistic toggle. They are now
separate fields, because the toggle read as a formatting choice when it is a change of
question — exposure versus frequency — and the two are not convertible into one another.
Links written under the old scheme (`?v=density&s=storms`) still resolve to the field they
named.

**ACE** — accumulated cyclone energy — is the sum of Vmax² over every 6-hourly position, in
10⁴ kt². It is time-integrated activity, so it rises with how many storms there were, how
strong each got, and how long each lasted; a season of many weak short-lived storms and one of
a few long-lived major hurricanes can have the same storm count and very different ACE. Like
storm-days it is extensive, so it sums cleanly from cell to basin.

Two details of the standard definition matter. ACE counts only **6-hourly synoptic positions**,
which is what these pages restrict to anyway, and only **tropical and subtropical stages** —
extratropical and remnant-low positions are excluded even when the wind is still above
threshold. That exclusion is not cosmetic: in the North Atlantic 14% of positions at ≥34 kt are
post-tropical, and counting them inflates the 2005 season to 273 against a published 245.
Excluding them gives 257, and 1994 lands exactly on its published 32. The conventional
threshold is ≥34 kt, which is this page's default; other thresholds work but are non-standard.

### Size (R34) — a much shorter and more uneven record

**Size** is the mean 34-kt wind radius (`USA_R34_NE/SE/SW/NW`) over the quadrants that *have*
gale-force winds, requiring **at least three of the four**, in nautical miles with a km toggle.
It measures how *large* a storm is, not how strong. This follows

> Chavas, D. R., J. A. Knaff and P. Klotzbach (2025). A simple model for predicting tropical
> cyclone minimum central pressure from intensity and size. *Weather and Forecasting* **40**(2),
> 333–346. [doi:10.1175/WAF-D-24-0031.1](https://doi.org/10.1175/WAF-D-24-0031.1)

**Why zeros are excluded rather than averaged in.** A zero quadrant says the storm has no gales
on that side at all — a statement about *asymmetry*, not radial extent. Averaging zeros in makes
size partly a proxy for intensity, because asymmetry is overwhelmingly a weak-storm phenomenon:

| Vmax | positions with ≥1 zero quadrant | dropped by the ≥3 gate |
|---|---|---|
| 34–49 kt | 35.0% | 24.6% |
| 50–63 kt | 6.7% | 1.5% |
| 64–95 kt | 0.1% | 0.0% |
| ≥96 kt | 0.0% | 0.0% |

On the 5,340 positions with at least one zero the two conventions differ by nearly a factor of
two — **46 n mi** with zeros against **86 n mi** without. Over the whole record the change moves
the median from 80.0 to 87.5 n mi. The ≥3 gate then removes 3,464 of 37,308 positions (9.3%):
below three quadrants what survives describes a lopsided fragment of a wind field, not a size.

**Missingness needs no rule.** IBTrACS fills these all-or-nothing — across 1980–2025 every
position has either 0 or 4 quadrants present, never 1–3 — and missing is blank, not a `-999`
sentinel. So a minimum-*present* threshold would never fire; the ≥3 rule is entirely about
non-zero quadrants.

**Selecting it pulls the period to 2004**, and the period box will not go earlier. The radii
appear in the file from about 2001, but 2004 is the first season NHC and CPHC best-track them
for *every* tropical-storm-force position:

| TS+ positions with all four quadrants present | NA | EP | WP | SI | SP | NI |
|---|---|---|---|---|---|---|
| 1980–2003 | 11% | 7% | 10% | 7% | 4% | 6% |
| 2004–2025 | **100%** | **100%** | 90% | 87% | 87% | 84% |

Note that *usable* coverage after the ≥3-non-zero gate reorders this: NA falls to 74% and EP to
82%, while the JTWC basins are untouched at 84–90%. That is not NHC being worse — it is NHC
recording genuine zero quadrants for asymmetric weak storms, which JTWC essentially never does.
The gate removes exactly the positions where the two agencies' practice differs most, which is
an argument for it rather than against it.

The reason the JTWC basins plateau instead of filling is documented: JTWC considers position and
intensity reliable from 2000, but its **34-kt wind radii were not retrospectively
quality-controlled until 2016**, with accuracy improving gradually thereafter. Before that they
are operational estimates that never went through post-storm review.

> Howell, B., A. Howard, M. Kucas, C. R. Sampson, L. Cowan and B. Strahl (2025). *The Joint
> Typhoon Warning Center Tropical Cyclone Best Tracks, 1945–2025.* Naval Research Laboratory
> Report NRL/7550/FR--2025/3.
> [PDF](https://www.metoc.navy.mil/jtwc/products/best-tracks/JTWC_TC_Best_Tracks_NRL_Report.pdf)

So the page's caveat is **basin-aware** rather than generic: it says "this region is NHC/CPHC
best-tracked throughout" in the Atlantic and East Pacific, and in a JTWC basin with a pre-2016
start it names the region and suggests setting the start year to 2016. Saying "some basins are
worse" in the abstract is easy to read past; naming the one on screen is not.

**Storage note.** R34 is a mean of four integer quadrants, so it lands on quarter-nautical-miles.
The build's `q()` rounds to integers — exact for winds and pressures, which are integers in kt
and mb — so the R34 sums are stored as **quarter-nmi fixed point** (`×4`) and divided once on
load. Without that, `ref_values.py` caught 23 of 45 annual values disagreeing in the fourth
significant figure. It is a good example of why the reference re-derivation is worth keeping.

Each field is available at four cumulative intensity thresholds — all positions, ≥34 kt (TS+),
≥64 kt (Cat 1+), ≥96 kt (Cat 3+) — over any year window in 1980–2025, on a 5° grid.

## Stages: which part of a cyclone's life counts

IBTrACS classifies every position into one of six `NATURE` stages. This is a closed list — there
is no "post-tropical" category, which is an NHC product term rather than an IBTrACS one.

| code | meaning | positions 1980–2025 | at ≥34 kt |
|---|---|---|---|
| `TS` | Tropical | 115,688 (75.6%) | 72,548 |
| `DS` | Disturbance | 11,601 (7.6%) | 542 |
| `NR` | Not reported | 8,816 (5.8%) | 599 |
| `ET` | Extratropical | 8,166 (5.3%) | 2,366 |
| `MX` | Mixture (agencies disagree) | 7,632 (5.0%) | 1,351 |
| `SS` | Subtropical | 1,093 (0.7%) | 562 |

Where each falls relative to a storm's tropical/subtropical phase:

| | before | during | after | never tropical |
|---|---|---|---|---|
| `ET` | 4% | 1% | **95%** | 0% |
| `DS` | **43%** | 8% | **48%** | 1% |
| `MX` | 23% | 35% | 41% | 0% |
| `NR` | 44% | 2% | 30% | **25%** |
| `SS` | — | **100%** | — | — |

So **`ET` is in effect the post-tropical stage** — 95% of it follows the tropical phase.
**`DS` is not**, being split almost evenly between the pre-genesis disturbance and the decaying
remnant; labelling it post-tropical would be wrong about half the time. Splitting it by position
within the track would give a genuine remnant-low category, but that is a derived quantity, not
one the file carries. `SS` is always mid-life, never a transition state.

### The eight selections

**Tropical + extratropical is the default** — a cyclone and the post-transition storm it becomes,
which is what most hazard questions mean by the event. North Atlantic, TS+, 2004–2024 storm-days:

| selection | storm-days |
|---|---|
| All stages | 2023.5 |
| Tropical only | 1619.8 |
| Extratropical only | 278.8 |
| **Tropical + extratropical** (default) | **1898.5** |
| Subtropical only | 56.0 |
| Disturbance only | 69.0 |
| Mixture only | 0.0 |
| Not reported only | 0.0 |

The six single stages partition the record exactly: they sum to 2023.5, and `ts + et` equals the
`tset` selection to machine precision. `test_card.js` asserts both.

### ACE ignores this control

ACE is defined over tropical **and subtropical** stages. Letting a selection like
*tropical + extratropical* apply to it would silently drop the subtropical contribution and
produce a non-standard number under a standard name, so ACE is summed outside the stage filter
and is identical under all eight settings — asserted to 1e-6.

Worth noting that even a careful outside source leaves this implicit:
[global-tropical-cyclones.com](https://global-tropical-cyclones.com/methodology) states the
stage restriction in its *Named Storm* definition ("≥ 34 kt while in a tropical or subtropical
stage") but omits it from its *ACE* definition ("over all synoptic fixes at or above 34 kt").
Their numbers are consistent with applying it — see
[`COMPARISON_vs_gtc.md`](COMPARISON_vs_gtc.md) — but it is inferred, not stated.

### How it is stored

Sums are additive over stage, so the build puts the `NATURE` index in the key of every additive
record — `(cell, year, bin, stage)` — and the page adds whichever groups a selection names. That
costs +17% rows (34,552 → 40,325) rather than eight copies of everything.

**Distinct storm counts are not additive over stages.** A cyclone with both tropical and
extratropical positions in one box is one storm there, not two — summing the per-stage counts
over-counts, which `test_card.js` asserts directly. So the build emits **one count column per
selection** (`ns`, `ns_ts`, `ns_et`, `ns_tset`, …) on the all-stages key set. Eight reference
cases in `ref_values.py` re-derive stage-filtered series independently, storm counts included.

Payload: 0.47 → 0.68 MB gzipped.

## Period: 1980–2025 in the data, 1990–2024 by default

The build ingests from **1980**, but both pages open on **1990**. Klotzbach et al. (2022)
take 1990 as the point from which the global best-track record is reasonably reliable and
homogeneous — geostationary coverage and Dvorak practice had settled by then — and that is a
better default than an era whose apparent trends partly measure the observing system. Earlier
years stay one keystroke away in the period control.

> Klotzbach, P. J., K. M. Wood, C. J. Schreck III, S. G. Bowen, C. M. Patricola and M. M. Bell
> (2022). Trends in Global Tropical Cyclone Activity: 1990–2021. *Geophysical Research Letters*
> **49**(6), e2021GL095774. [doi:10.1029/2021GL095774](https://doi.org/10.1029/2021GL095774)

**The last season is provisional.** IBTrACS best tracks are reanalysed after the season, and
until that happens the positions carry a `PROVISIONAL` track type and intensities can still
move — 70% of 2025's synoptic positions are provisional as of this build. The season is
complete in coverage (105 storms, 97 at TS+, comparable with recent years), so it is included
in the data rather than dropped, and the build records the first such year in `index.json` as
`provisional_from`.

**The default window ends the year before it** — 1990–2024 as of this build. A season whose
intensities are still going to move should not be the endpoint that anchors every trend on the
page, and an endpoint is the most influential point in a slope. Extend the period control to
2025 and it is included, with the header saying what it is. The cutoff is derived from
`provisional_from` rather than hardcoded, so the next rebuild advances it without a code change.

2026 is excluded outright: it is a partial season.

(`trendmaps.html`, if you use it, adds three more ways to look at the same cell values: trend
per decade, change between the late and early halves of the period, and a single year with a
play button.)

## Three decisions that matter

**Synoptic positions only.** About half of all IBTrACS rows are 3-hourly interpolated
positions (03/09/15/21 UTC). Counting them doubles the track density for no extra
information. Only 00/06/12/18 UTC are used, so one count unit is one 6-hour storm position
and four is one storm-day. The 3-hourly fraction is stable at ~50% across 1980–2024, so this
is a scaling choice, not a trend correction.

**USA winds, not WMO.** `USA_WIND` is NHC in the Atlantic and East Pacific and JTWC
everywhere else: a uniform 1-minute sustained wind, present for 84% of synoptic positions.
`WMO_WIND` is whatever the responsible RSMC reports — it mixes 1-minute and 10-minute
averaging across basins, covers only 47% of West Pacific positions, and its global
availability climbs from 55% in 1980 to 85% by 2015. Any wind-thresholded field built on it
inherits that climb as a spurious upward trend, so it is not used. This is the main
departure from the source notebook.

**Empty ocean is not zero.** A grid cell that never sees a storm is left unpainted, and the
colour ranges are quantiles weighted by how many positions a cell carries. Without both, the
~95% of cells that are empty or marginal set the scale and every basin collapses into the
bottom few percent of the colour bar.

## Statistics

**Every trend on the page is ordinary least squares**, with a *t*-test for significance and a
95% band of slope ± *t*(0.975, *n*−2) · SE. There is no estimator menu. `test_card.js` checks
the slope, p, R² and both confidence limits against `scipy.stats.linregress` to the last digit,
and re-checks the slope and CI on thirteen real basin/band series.

### Why not Theil–Sen

Theil–Sen with Mann–Kendall significance is the more general choice, and is usually preferred
because the median of pairwise slopes resists outliers. It does not work on this field:

> We use least-squares because Theil–Sen, while more general and often preferred to minimise
> the effect of outliers, doesn't work well for the map since many gridboxes have multiple
> years with zero storms, which means the median of pairwise slopes will come out simply as
> zero.

Two things compound to produce that:

- **Sparsity.** At the TS+ threshold the median active cell has storms in only **10 of 45
  years**. Most pairs of years are therefore two zeros, and their slope is exactly zero.
- **Quantisation.** Storm-days come in quarters (one 6-hour position), so even a dense cell
  has many exactly-tied years, and those pairs are exactly zero too.

Measured over the 791 active cells at TS+, **88% got a Theil–Sen slope of exactly zero** —
94.8% at Cat 1+ — versus **0%** for least squares. It was not confined to marginal cells: even
a cell with data in all 45 years could land on zero. The cells it silenced were the quiet ones
(0.34 storm-days/yr on average, against 1.92 for the rest), so the map lost precisely the
gradient it exists to show.

On the **pooled** series the problem does not arise, because summing a basin's cells removes
the sparsity: over 1980–2024 the two estimators gave −11.21 vs −11.30 storm-days/yr per decade
for the West Pacific, +15.13 vs +14.88 for the North Atlantic. The zonal profile and the annual
series would have been safe with either.

The page used to default the estimator per field and let the reader override it. That was worse
than picking one: a reader has no way to judge which estimator suits a field they are looking
at for the first time, and the two answers differ by enough on the map to matter. One estimator,
stated in the methodology, is the honest version. The Theil–Sen and Mann–Kendall code has been
removed rather than left dormant.

### The seasonal panels

The **seasonal cycle** averages each month over the selected years — the annual total falling in
that month for the extensive fields, and the position-pooled mean for the intensities, so a
busy year does not count the same as a quiet one. The **month-by-month** grid plots each
month's own annual series with its own trend, on one shared vertical scale so the months stay
comparable. For tropical cyclones that scale is dominated by the peak months, which is itself
the point: it shows how concentrated the season is.

Months are stored per basin rather than per cell — only these two panels need a month
dimension and both are region-level, so the table stays at ten thousand rows instead of
multiplying the 2,592-cell grid by twelve. Storm counts are counted separately per basin-month
for the usual reason: **a cyclone spanning two months is one storm in each, so the months do
not sum to the year.** `test_card.js` asserts that they over-sum, so nobody can quietly wire
them back onto a total.

### Years with no storms

Most boxes are empty in most years, and "empty" means two different things depending on the
field. Conflating them would break the trends, so they are handled separately.

**Counts (storms, storm-days, ACE): a quiet year is a genuine zero and is kept.** Every year in the
window enters the fit. Dropping the zeros would regress only over the years that happened to
be active — precisely the years carrying the signal — and the slope would be meaningless. It
matters: at TS+ the median active cell is empty in **35 of 45 years**, and 49% of active cells
have storms in fewer than ten.

**Intensities (Vmax, Pmin): a quiet year has no defined mean and is dropped.** There is no
sensible zero for a wind speed, and zero-filling would drag every sparse cell's trend towards
nonsense. The series is then unevenly spaced in time, which least
squares handles correctly, dividing by the real Δx. The median active cell keeps 10 of 45 years. Verified exhaustively: across all
116,640 cell-years, no year without a qualifying position is ever assigned a value.

### The Maximum statistic

Each year contributes the single highest value among its qualifying positions — for a region,
the highest anywhere in it, not the average of its cells' peaks — and the trend is fitted through
that series of annual peaks. So it is the trend in the **extreme**, not in the distribution. A
flat maximum alongside a rising mean is perfectly possible, and because each year rests on one
observation the series is noisier than a mean.

**The intensity threshold barely affects it.** Where a cell-year survives at all, its maximum is
identical at every threshold in **100.0%** of cases — if the peak is ≥ 96 kt then restricting to
≥ 96 kt positions cannot change the peak. What the threshold changes is how many cell-years exist
at all: 15,301 at "all positions", 11,964 at TS+, 5,984 at Cat 1+, 2,449 at Cat 3+. On the
Maximum statistic the threshold is a coverage filter, not an intensity filter, which is not
obvious from the control.

**One artefact of the synoptic-only rule lands here specifically.** Agencies sometimes insert an
off-synoptic position precisely to capture peak intensity — the JTWC report says so explicitly —
and those rows are dropped. Measured over 1980–2025 it lowers the recorded peak for **57 of 4,435
storms (1.3%)**, by 5.7 kt on average, moving the global mean peak from 70.91 to 70.83 kt.

The shortfall is not stationary, which is what makes it worth recording:

| era | mean shortfall |
|---|---|
| 1980–1989 | 0.00 kt |
| 1990–1999 | 0.02 kt |
| 2000–2009 | 0.03 kt |
| 2010–2019 | 0.15 kt |
| 2020–2025 | **0.23 kt** |

Intermediate points have become more common, so this imparts a slight *downward* pressure on
maximum-Vmax trends of order 0.05 kt/decade, against typical slopes of 1–2 kt/decade. Small, but
it is an artefact of the filter rather than of the storms. Computing the maximum over all rows
including 3-hourly ones would remove it, at the cost of a statistic that no longer matches the
rest of the page.

### Smoothing

Both maps pass through a **Gaussian blur, sigma = 2.5°** — half a grid cell, so the kernel is a
3×3 with about 62% of the weight on the centre box — on by default with an Off switch. A single 5° box is a small sample and the eye goes straight to isolated extremes;
blurring makes the coherent pattern the thing you see first, which is how the page asks these
maps to be read.

It is a **normalised convolution**: only cells that have a value contribute, and the weights are
renormalised by what was found. A plain convolution treating gaps as zero would drag every
coastal and basin-edge cell towards nothing.

| property | behaviour |
|---|---|
| gated / empty cells | stay NaN — smoothing changes colours, never which boxes are drawn |
| longitude | wraps (verified symmetric across the seam); latitude clamps |
| spatial variance | falls, 0.861 → 0.784 for global TS+ storm-days |
| peak cell | 6.90 → 5.56, about **−19%** |
| sum over cells | rises ~0.4% — renormalisation lifts edge cells, so totals are *not* conserved |
| zonal profiles, series panels | untouched |

Two consequences worth stating plainly. The colour-bar maximum rescales with the smoothed field,
so it no longer corresponds to any real box. And because the drawn value can still sit away from
the box's own number, **the hover tooltip shows both** —
`0.72 storm-days/yr (smoothed; this box 1.31)`. Without that, smoothing would quietly conceal
the data it is drawn from.

The kernel is in grid-index space rather than physical distance, so at high latitude it reaches
less far zonally than meridionally, by cos(lat). Below 40°, where nearly all the activity is,
that distortion is under 25%. Making it distance-isotropic would mean a latitude-dependent
zonal sigma — easy, but it was not worth the complexity for a display filter.

### Zonal profiles bin by latitude directly

The profiles are the same pooling operation as a basin aggregate with longitude ignored:
positions go straight into their 5° latitude band and are pooled there. For the extensive fields
that is the band total; for the intensive ones the position-weighted mean across the row. It is
*not* an average of the drawn cell values, and both map headers say so.

**The fit is two-stage: annual value first, then the slope over years.** For a cell-year, the
value is the mean (or max) over that year's positions; the trend is then fitted to that annual
series, with the gaps left out. Each year counts once regardless of how many positions it
contained. Pooling all positions instead would be a different estimator that weights busy
years more — for the cell at 20°N 155°E it gives 0.00 kt/decade where the annual-mean fit over
24 years gives −5.41.

A year represented by a single 6-hourly position is kept and weighted like any other: one
observation of a storm's intensity is still an observation. The regression is over annual
values, and how many positions produced each one does not enter it.

### What has to be true before a cell is drawn, and before it gets a trend

Everything below counts **years that actually carry a storm**, not years used in the fit. That
distinction is what makes the thresholds work at all for counts: a count uses every year of
the window, so testing "years used" would always pass and a cell with two storms in
forty-five years would still be drawn a trend.

**To be drawn in colour: `Min plot` years, default 1** — that is, show everything by default and
let the reader tighten it. Applies to every view, so the map keeps
the same cells as you switch between climatology, trend, change and single-year — the
membership does not shift under you.

**To be given a trend, three further conditions, all of which must hold.** All three are fixed
in the code and stated in the legend — there is deliberately no control, because a reader has
no way to judge what "min years = 7" buys them, so offering the dial mostly invites the wrong
answer.

| condition | value | why |
|---|---|---|
| years carrying a storm | **max(8, 30% of the period)** | sample size, scaled to how much record there is to be present for |
| those years span ≥ **70%** of the period | fixed | every cell's slope then refers to roughly the same epoch, instead of one cell reporting 1980–95 and its neighbour 2005–24 |
| ≥ **2** of them in each half | fixed | bounds leverage |

At the 1990–2024 default that first rule asks for 11 years; over 1980–2025 it asks for 14, and
on a 15-year window it falls to the floor of 8.

**Why the year count scales.** A fixed count is simultaneously too strict on a short window and
too lax on a long one. Requiring 10 years of the global TS+ track-density map:

| window | pass span + halves | + fixed `10` | + `max(8, 30%)` |
|---|---|---|---|
| 1990–2024 (35 yr) | 446 | 371 | 344 |
| 1980–2025 (46 yr) | 473 | 400 | 348 |
| 2000–2024 (25 yr) | 400 | 299 | 343 |
| 1990–2005 (16 yr) | 332 | **188** | 257 |
| 2010–2024 (15 yr) | 340 | **181** | 247 |

A fixed 10 halves the map on a 16-year window — not because those cells got worse, but because
10 is a large fraction of 16. On a 46-year window the same 10 is sparse and passes anyway. The
floor of 8 is there because a slope through fewer points means little regardless of how well
spread they are.

**None of the three subsumes another.** Span constrains only the two endpoint years: storms in
1990 and 2024 alone span 100% of the period. Adding the per-half rule only forces four years.
Conversely a year count says nothing about *where* those years fall. Measured on the global
TS+ map, 1990–2024:

| field | year count removes beyond span | span removes beyond year count |
|---|---|---|
| track density | 75 | 3 |
| ACE | 66 | 6 |
| Vmax | 75 | 3 |
| **Pmin** | 14 | **167** |

For four of the five fields the span rule is nearly redundant — but Pmin is exactly why it
stays. JTWC central pressure does not begin until 1999–2002, so a Pmin cell can satisfy any
year count entirely within the back two-thirds of the window and report a 2002–2024 trend
labelled 1990–2024. Span is the only rule that catches that.

**The zonal profiles do not respond to `Min plot`, on purpose.** They pool every cell in the
band, including any the map has greyed out, so the profile beside a map is *not* the row-average
of the boxes you can see. `Min plot` is a display threshold — "do not colour a box I cannot
read" — not a claim that the storms in a thin box did not happen.

Making the profile follow the map would break it rather than reconcile it. For the extensive
fields a band value is the **total** across the row, so restricting the pool sums a smaller
region and still labels it the latitude band. Global track density, 1990–2024, at 17.5°N:

| cells pooled | band value |
|---|---|
| all 72 | 93.3 |
| 54 passing `Min plot` 5 | 93.0 |
| 35 passing `Min plot` 20 | 85.2 |
| 8 passing `Min plot` 34 | **41.2** |

That last row reads as a collapse in activity when it is only a smaller sample. At 7.5°N it
falls from 10.7 to 0.9 on one surviving cell. So the band is gated on its own terms — it needs
a year with data, nothing more — and the panel subtitle says the profile pools the whole band.
The trend profile keeps the trend rule at band level, which is a statement about the band's own
series rather than about the map's display.

**A cell that fails a gate is drawn grey, not deleted.** Grey means "storms happened here, but
not enough of them, or not spread widely enough, to put a number on it" — distinct from the
unpainted ocean, which means no storm ever crossed the box in this window. Both maps carry a
grey swatch in the legend, and hovering a grey cell says which gate it missed.

The reason not to simply drop them: a reader cannot see an absent cell, so raising `Min plot`
would appear to shrink the storm track itself rather than to raise the evidentiary bar. Greying
makes the cost of the setting visible, and the grey fringe on the climatology map is
informative in its own right — it is the outer envelope of where cyclones have ever reached, as
opposed to where they reliably recur. The grey is chosen from outside both colour ramps so it
cannot be read as a value.

The per-half rule earns its place against a cell like

```
1980, 1981, 1984, 1990, 1992, 1995, 2015
```

which spans 80% while one isolated late year sets the slope almost single-handed; thirteen
cells look like that.

When a cell or a region fails, the popup and the series panel say *which* condition failed,
not just that no trend was drawn.

### Minimum pressure does not exist everywhere before 2002

The most important consequence of the span rule, and the one most likely to look like a bug.
`USA_PRES` is not a uniform field — it is a step function, because JTWC did not issue an
operational central-pressure estimate until well into the record:

| basin | Pmin from | basin's own record from |
|---|---|---|
| North Atlantic | 1980 | 1980 |
| Eastern N. Pacific | 1980 | 1980 |
| Western N. Pacific | **1999** | 1980 |
| North Indian, South Indian | **2001** | 1980 |
| South Pacific | **2002** | 1980 |

So a Pmin trend requested over 1990–2024 is computable in the Atlantic and East Pacific and
**not** in the JTWC basins, where the available years span only about two thirds of the
window. Before the span rule those cells were drawn anyway, silently reporting a 2002–2024
trend next to a 1990–2024 one. Now they are blank — which is correct, but blank on its own
looks broken, so the legend spells it out: how many cells have data but no trend, which
condition they failed, which basins start late and in what year, and what period to ask for
instead. Starting at 2002 fills the map back in.

`build_tc_trends.py` records the first year of each field per basin, alongside the first year
of the basin's record at all. The comparison matters: the South Atlantic's Vmax also "starts"
in 2004, but so does its entire record — that is an absence of cyclones, not a reporting gap,
and it is deliberately not reported as one.

## Aggregation

- **Storm-days** sum across cells — the region total is the sum of its parts. This is one
  reason they are the default.
- **Vmax and Pmin** take the *position-weighted* mean, `Σ(sum)/Σ(count)`, so the region
  value equals the mean over every storm position in the region. The notebook approximates
  this by weighting the zonal mean with track density; this is the exact version.
- A cell-year with no positions is `0` for density but **missing** for Vmax and Pmin. A
  quiet year is an observation; an undefined mean is not.

### Storm counts do not add up, so they are built three times

A cyclone crossing twenty cells is one storm in each of them — and still only one storm in
the basin. Summing the per-cell counts for 2020 gives **513**; there were **102** storms.
This is the same trap as county-days versus statewide days in `../../trends/`, and the fix is
the same: count at each level separately. `build_tc_trends.py` emits

| table | key | feeds |
|---|---|---|
| `sc` | (cell, year, threshold) | the map |
| `sb` | (basin, latitude band, year, threshold) | the trend-by-latitude panel |
| `sr` | (basin, year, threshold) | the annual series panel |

and the three are deliberately **not** derivable from one another. The counts are stored per
*cumulative threshold* rather than per intensity bin for the same reason — a storm that
crosses 34 kt inside one cell appears in two bins and would otherwise be counted twice.

The pages read whichever table matches the panel. Both test suites assert that summing the
map cells over-counts the global total several-fold; if that check ever starts passing,
someone has wired a storm panel back onto a sum.

Sanity: the basin table reproduces the published climatologies — **86.4** TS+ storms per year
globally, **47.0** at hurricane strength, **16.1** in the North Atlantic, **25.9** in the West
Pacific, **17.0** in the East Pacific — all verified against an independent `nunique` in
`ref_values.py`.

## Basins

Fixed longitude–latitude boxes, in 0–360° longitude, that **exactly partition the globe**.
Every cell inside |lat| < 60 belongs to one basin and one only, so basin sums add to the global
sum. `test_card.js` asserts all three halves of that — no orphan cell, no shared cell, no basin
cell outside Global — because it is the kind of property that quietly stops being true.

| | lon | lat | | | lon | lat |
|---|---|---|---|---|---|---|
| North Atlantic | 260–40 (wraps) | 0–60 | | South Indian | 0–**90** | −60–0 |
| Eastern N. Pacific | 180–260 | 0–60 | | **Australian region** | **90–160** | **−60–0** |
| Western N. Pacific | 100–180 | 0–60 | | South Pacific | **160**–290 | −60–0 |
| North Indian | 40–100 | 0–60 | | South Atlantic | 290–360 | −60–0 |
| | | | | Global | 0–360 | −60–60 |

The **Australian region** is the Bureau of Meteorology's area of responsibility, 90°E–160°E
south of the equator. It was carved out of South Indian (which previously ran to 135°E) and
South Pacific (which began there), so a cyclone in the Australian region is counted there and
**not** in either neighbour. The three remain disjoint and the global partition is unchanged —
`test_card.js` checks that SI + AU + SP + SA still equals the southern hemisphere exactly.

### Picking a basin off the map

On the global view the seven basins are outlined in thin green and the map is clickable: click
anywhere inside a box to zoom into that basin, and **← Global** in the control bar comes back.
The outlines are drawn only on the global view — inside a basin they would just retrace the
frame — and the button is disabled when you are already global.

The outlines are deliberately **click-through** (`pointer-events="none"`). An overlay that
caught the events would sit above the cells and kill every per-cell hover tooltip on the one
view where the map covers the most ground. Instead the click position is inverted back through
the map group's own transform to a lon/lat and `basinAt()` decides which box contains it — the
same wrap-aware test the build uses to assign cells. Hover highlighting is driven from the same
handler by toggling a class, rather than by CSS `:hover` on a rect that no longer receives
events.

`fill="none"` on the hit rectangles matters for a second reason: an exported SVG carries no
stylesheet, so anything the export needs has to be a presentation attribute rather than a CSS
rule. The first version used `class="hit"` with `fill:transparent` in the page's `<style>`, and
the exported PNG came out solid black.

### These are geographic boxes, not IBTrACS's `BASIN` column

What these pages measure is cyclone activity **at a place**, so a position belongs where the
storm physically was — not to whichever agency's ledger the track was filed under. The two
disagree for about **1.1%** of positions, concentrated in one place: East Pacific storms that
cross Central America keep their `EP` label into the Caribbean, so 5.7% of IBTrACS `EP`
positions sit outside the East Pacific box and 1,408 non-`NA` positions sit inside the North
Atlantic one. Under the geographic reading that is not an error — those positions are counted
where they actually were.

Only 18 grid cells contain positions from more than one IBTrACS basin, all of them around
Central America and the dateline, but they are busy cells holding 3.6% of all positions. Keying
the grid on `BASIN` instead would cost just +0.13% in file size, so this is a choice about
meaning rather than about cost.

### Closing the gaps

The boxes did not originally tile the globe. Three strips were inside Global and inside no
basin — 0–40°E in the north, 0–20°E and 240–290°E in the south — holding **65 positions**
(0.04%, 12 at TS+). Small, but it made "basin sums add to the global sum" false. The four
bolded edges above close them: North Indian reaches 60°N (empty — no cyclones over Central
Asia), South Indian reaches the prime meridian, South Pacific reaches the South American coast,
and the North Atlantic wraps 260°E → 40°E to take in the eastern Atlantic and Mediterranean.

Nothing published moved. The 0–40°E strip turns out to hold only *extratropical* remnants of
storms already counted in the Atlantic that same season — Charley 1986, Lili 1996, Katia 2011,
Ophelia 2017, Kirk 2024 — so ACE is unchanged (the tropical/subtropical filter excludes them)
and distinct storm counts are unchanged (they were already counted). Only track density moves,
by 21 positions in 45 years. Every reference value in `ref_values.json` came back bit-identical
after the rebuild.

The cost is framing: the North Atlantic map now carries 40° of Europe and Africa, and the South
Pacific 50° of empty ocean off Chile. That is the honest trade — the map frame is drawn from
the basin box, so a tighter frame would mean drawing less than what is being summed, which is
exactly the mismatch removed from the zonal profiles.

The notebook's North Atlantic box stops at 308.75°E (51.25°W), which excludes the entire
Cape Verde main development region; these boxes do not.

### The map is drawn in 0–360° longitude

`trendmaps.html` does *not* use Leaflet's default −180…180 frame. It draws every cell and
every box at the longitudes the data is already stored in, 0–360, which puts the seam over
**Africa** — the one stretch of longitude with essentially no tropical cyclones. Two things
follow:

- The quiet side of the world lands at the left edge, under the controls panel, so the panel
  hides almost nothing. In the −180…180 frame it covered the East Pacific.
- **Every basin becomes contiguous except one.** In −180…180 the North Atlantic and the South
  Pacific both straddle a seam and have to be drawn as two rings each. Here the South Pacific
  (135–290°E) is a single rectangle. The North Atlantic still needs two, because closing the
  basin gaps made it wrap the prime meridian (260°E → 40°E); `boxRings()` splits it and marks
  only the outer edge of each half as closed, so the pair reads as one region. On `tccard.html`
  this does not arise — `mapFrame()` unwraps the box to a 260–400 span and draws it whole.

Leaflet does not wrap longitudes it is handed, and Web Mercator is linear in longitude, so a
feature at 200°E simply lands one world-copy to the right of one at −160°E. The tile layer is
therefore set to `noWrap: false` so the basemap repeats to fill 180–360°E. Cell popups still
label longitudes the way people read them, so 280°E reads "80–75°W"; `test_maps.js` pins
that, the 0–360 cell geometry, and each basin's span.

## Data

- Source: NOAA **IBTrACS v04r01**, global, 1980–2024. 149,942 synoptic positions from 4,741
  storms.
- `spur` tracks — duplicate representations of a storm already present as `main` — are
  dropped.
- Output is sparse and columnar: one record per (cell, year, intensity bin) with counts and
  sums for wind and pressure — bins rather than cumulative thresholds, so the browser sums
  upward and every threshold stays consistent — plus the three storm-count tables above.
  33,839 + 51,135 records, **0.24 MB gzipped** for the whole globe, which is small enough to hold every cell-year in memory and recompute means,
  trends and regressions on every control change.

## Rebuilding

```sh
# 330 MB IBTrACS CSV lives one level up; takes ~4 s
python3 build_tc_trends.py ../ibtracs.ALL.list.v04r01.csv data --grid 5 --y0 1980 --y1 2024

# coastline (110m land, ~55 KB)
curl -sL -o geo/land-110m.json https://unpkg.com/world-atlas@2.0.2/land-110m.json
```

Adding a field means adding it to `VARS` in `tccard.html` and, if it needs new accumulators,
to `aggregate()` in the build script.

## Testing

```sh
npm i jsdom topojson-client
python3 ref_values.py          # recomputes reference values from the CSV via scipy
node test_card.js .            # tccard.html — renders the card, checks the numbers  (106)
node test_maps.js .            # trendmaps.html — Leaflet stubbed, every control     (149)
```

`ref_values.py` shares no code with either the build script or the pages: it re-derives the
region series straight from the CSV and the statistics from scipy.

`test_maps.js` covers the unmaintained map explorer. Run it anyway after changing
`build_tc_trends.py` or the data schema — it takes two seconds and is the only thing keeping
that page usable if it is ever wanted again.

`test_card.js` (161 checks) covers the least-squares slope, *p*, R² and both confidence limits
against `scipy.stats.linregress`; the same four on thirteen real basin/band series; the full
45-year annual series for five field/basin/threshold combinations; that the zonal bands and the
map cells each sum back to the region total; and that the SVG export is well formed.

It also pins the behaviours that are easy to "fix" back into bugs later:

- raising `Min plot` must **grey** map cells, not remove them — the count of drawn boxes stays
  fixed while the grey count rises
- the zonal profile must **not** move when `Min plot` does, even as the map collapses from 755
  drawn cells to 23
- each of the three trend conditions is given a series that breaks only that one, and each must
  be rejected — so nobody deletes a rule believing it redundant
- the year requirement scales: `need(15) = 8`, `need(35) = 11`, `need(46) = 14`
- no rank-based estimator survives in the page (`theilSen`, `mannKendall` both undefined)
- legacy URLs still resolve (`?v=density&s=storms` → storm count, `?v=ace&s=sum` → mean)
- the Methods section states every step of the chain, and quotes the *live* window and wind
  coverage rather than hardcoded numbers

`test_maps.js` walks the whole page: that every cell polygon stays inside 0–360 and is exactly
one grid box wide, that a known cell's index round-trips (25°N 280°E), that all seven basin
boxes come out as single contiguous pieces with the right span and that a global domain is
drawn with no vertical edges at all, that all four map metrics render with a sane colour
range, that the panel numbers match the same reference series, that a quiet year reads as zero
for a count but as missing for an intensity in the *same* cell, that the annual Vmax equals the
mean over that year's positions across all 11,694 populated cell-years, that the plot and trend
minima each thin the map, that the span and per-half gates reject a bunched or lopsided series
while passing an even one, that the hover tooltip re-evaluates when the field or metric changes
and that cells stay interactive across a threshold round trip, and that the cell popup (still
labelled °E/°W), CSV export and URL state work.

For a visual check of either page:

```sh
node dump_card.js . out.svg 'v=density&t=hu&b=WP&p=1980-2024'
node dump_maps.js . out.svg 'v=density&s=sum&t=ts&m=mean&r=WP&p=1980-2024&n=10&e=ols'
python3 -c "import cairosvg; cairosvg.svg2png(url='out.svg', write_to='out.png', scale=1.3)"
```

`dump_maps.js` re-projects the map cells into a plain plate carrée using the page's own
`cellStyle()` and `boxRings()`, so it checks the colours, the values and the box geometry —
everything except the tiles and Leaflet's Mercator.

## Caveat that matters

Best-track intensity is not a measurement. Away from aircraft reconnaissance — which means
almost everywhere outside the Atlantic — Vmax comes from Dvorak satellite analysis, whose
procedures, sensors and analyst practice have all changed since 1980. Trends in mean and
maximum intensity therefore carry some of that history. Track *counts* above a fixed
threshold are less exposed than intensity *values*, and the post-1980 geostationary era is
the shortest defensible record; this is why the page does not offer the earlier data at all.

## Origin

Special thanks to **Aniket Dev Roy** and **Dr. Aaron Kruskie** for developing the analyses for
the initial foundation of this site. Site development supported in part by NSF grants 2519425,
2431970 and 1945113.

Built from `Notebooks/IBTrACS.ipynb` (Aniket Dev Roy / Dan Chavas), which produces the same
climatology, trend and zonal-profile figures in matplotlib (with a Theil–Sen slope there). See
[`COMPARISON_vs_notebook.md`](COMPARISON_vs_notebook.md) for a measured comparison against that
notebook and its stored `.nc` outputs — the climatology agrees closely, and the trends differ
by about a factor of two, almost entirely because the notebook uses `WMO_WIND`.

## Checked against an outside reference

[`COMPARISON_vs_gtc.md`](COMPARISON_vs_gtc.md) compares this page's **ACE** with the global
season table at [global-tropical-cyclones.com](https://global-tropical-cyclones.com/basin/global/)
(Maue and Pielke Jr.), which is built from the same archive by a different pipeline. Over the
default 1990–2024 window the two agree to *r* = 0.992 and a mean absolute difference of 2.0%,
and the reported trend matches in sign, size and significance (−59.8 vs −66.7 ACE/decade,
*p* = 0.04 both). The ACE formula, the tropical/subtropical restriction and the Southern
Hemisphere season convention are identical.

The one systematic difference is before ~1990, where they supplement JTWC in the Indian Ocean
and South Pacific basins from the ds824 and Neumann archives and this page does not. That is the
right call for their seasonal tally and the wrong one here — mixing sources mid-record is the
same coverage-drift problem that rules out `WMO_WIND`. It leaves a documented low bias in those
basins before 1990, and is an independent argument for the 1990 default.

The Vmax/PI ratio field from that notebook is not yet ported — it needs the ERA5 monthly
potential intensity file — and neither is landfall or near-coast attribution.
