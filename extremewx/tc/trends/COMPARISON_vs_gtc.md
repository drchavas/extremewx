# How this page's ACE compares with global-tropical-cyclones.com

An independent check of the **ACE** field against
[global-tropical-cyclones.com](https://global-tropical-cyclones.com/basin/global/) (Ryan Maue
and Roger Pielke Jr.), whose global season table is published from the same underlying
best-track archive but assembled differently. Compared on global ACE by season, 1980–2025.

## Verdict

**The series agree, and they agree best over the window this page actually opens on.**

| period | ours | theirs | ratio | *r* | mean abs. diff | worst year |
|---|---|---|---|---|---|---|
| **1990–2024** (page default) | 770.9 | 787.9 | 0.978 | **0.992** | **1.96%** | 11.4% (1997) |
| 2008–2025 | 706.0 | 718.0 | 0.983 | 0.998 | 1.58% | 5.2% (2022) |
| 1980–2025 (full) | 748.4 | 767.5 | 0.975 | 0.974 | 3.65% | 16.3% (1981) |

The trends match too, which is what the page reports:

| 1990–2024 global ACE trend | slope/decade | *p* |
|---|---|---|
| this page | −59.8 | 0.041 |
| their table | −66.7 | 0.035 |

Same sign, same order of magnitude, same significance verdict. Over the full 1980–2025 record
both are flat and insignificant (−6.7, *p* = 0.71 here; −12.4, *p* = 0.53 there).

## What matches exactly

Read against their [Methodology](https://global-tropical-cyclones.com/methodology) page, the
definitions are the same, which is why the residual is a *source* difference rather than a
*method* difference:

- **ACE formula.** Theirs: "sum of (wind speed in knots)² × 10⁻⁴ over all synoptic fixes at or
  above 34 kt." Identical here, including the 6-hourly synoptic restriction.
- **Tropical/subtropical only — inferred, not stated.** Their *Named Storm* definition is
  "≥ 34 kt *while in a tropical or subtropical stage*", but their *ACE* definition omits the
  qualifier: "over all synoptic fixes at or above 34 kt." So whether the restriction carries over
  to ACE is not written down. The numbers say it does: removing the filter on this side makes
  1998–2025 agreement *worse*, 1.45% → 2.51%. That is inference from ~1% differences rather than
  proof, and it is the one place where "matches exactly" rests on a reading of their methodology
  instead of a statement in it.

  This page takes the restriction as fixed for ACE regardless of its own **Stages** control, for
  the same reason: ACE under a non-standard stage set would be a non-standard number wearing a
  standard name.
- **Southern Hemisphere seasons run July–June, labelled by the year the season ends.** That is
  exactly IBTrACS `SEASON`, which this page uses unmodified. Tested both alternatives — filing SH
  storms by calendar year drops *r* from 0.974 to 0.947, and shifting the SH label by ±1 year
  drops it to 0.88.
- **ACE is attributed to where the storm was**, not where it formed. This page grids per fix, so
  that holds by construction.
- **The Atlantic and East Pacific source is the same.** They use HURDAT2 directly; `USA_WIND` in
  IBTrACS *is* HURDAT2 in those basins.

## What differs: source supplementation before ~1990

This page uses **`USA_WIND` alone** — NHC/CPHC in the Atlantic and East Pacific, JTWC everywhere
else — for the whole record. One convention, no substitutions.

They use the same fields, but in the **North Indian, South Indian and South Pacific** they fill
fixes JTWC has no record for from two other archives IBTrACS carries alongside it: **NCAR ds824**
(through 1980) and **C. Neumann's** Southern Hemisphere / Indian Ocean compilation (through
2007), taking whichever source reports the highest eligible wind at that fix. Their own caveat
explains why:

> JTWC's own area of responsibility for these three basins wasn't formalized until 1985, so
> before then a large share of storms have no JTWC record at all […] JTWC alone misses roughly
> 60–90% of storms in this era for these three basins.

That is the whole early-record gap. Reconstructing their rule here from the `DS824_WIND` and
`NEUMANN_WIND` columns:

| year | `USA_WIND` only (this page) | with ds824/Neumann fill |
|---|---|---|
| 1980 | −12.5% | **−2.4%** |
| 1981 | −16.3% | **+0.9%** |
| 1982 | −12.6% | **−0.5%** |

Across the record the supplementation moves the ratio from 0.9751 to 0.9908 and cuts the 1980s
mean absolute error from 9.6% to 5.9%. It changes nothing from 2008 on, where both are 1.58% —
Neumann's record ends in 2007 and JTWC is complete by then.

### Why this page does not adopt it

Filling one basin's fixes from a second archive that stops in 1980, and a third that stops in
2007, means the composition of the record changes twice inside the analysis period. That is the
same defect that made these pages reject `WMO_WIND` (see
[`COMPARISON_vs_notebook.md`](COMPARISON_vs_notebook.md)): a field whose *coverage* drifts
through time will read as a trend whether or not the storms did anything.

For a **seasonal tally**, which is what their site is, completeness is the right priority and the
supplementation is clearly the better choice. For a **trend page**, a uniform convention with a
known, documented low bias in three basins before 1990 is the safer one. The two goals genuinely
pull in different directions here.

It is also an independent argument for the 1990 default start year. Klotzbach et al. (2022) reach
1990 from geostationary coverage and Dvorak practice; their 60–90% figure reaches essentially the
same year from JTWC's basin responsibilities. Two unrelated lines of evidence, one answer.

## What is still unexplained

Two features the supplementation does not account for, both in the noisy early era:

- **1983 (+14.9%) and 1985 (+16.2%)** — this page reads *higher* than theirs, and adding their
  supplementation widens the gap rather than closing it (to +16.9% and +24.7%). Something is being
  excluded on their side that is included here.
- **1997 (−11.4%)** — the single worst year inside the default window, and unaffected by
  supplementation.

One known but insufficient difference: their global is the sum of six basins and has no South
Atlantic, which this page's global box includes. That is far too small to explain either.

## Reproducing this

No script is kept; it was a throwaway. The recipe:

1. Scrape the season table from `https://global-tropical-cyclones.com/basin/global/` (they also
   offer CSV and XLSX download links on that page).
2. From `ibtracs.ALL.list.v04r01.csv`, keep 00/06/12/18 UTC fixes with `NATURE ∈ {TS, SS}` and
   `USA_WIND ≥ 34`, and sum `USA_WIND² × 10⁻⁴` by `SEASON`.
3. For the supplementation test, recompute with
   `max(USA_WIND, DS824_WIND, NEUMANN_WIND)` on rows where `BASIN ∈ {NI, SI, SP}`.

Worth re-running when either side updates. Their site is versioned — this was checked against
**Version 1.0, 21 July 2026**, data current through 2026-08-07.
