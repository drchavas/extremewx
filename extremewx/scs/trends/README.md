# U.S. Severe Convective Storm Climatology, Trends and Events

Three live pages over the same NOAA/NCEI Storm Events record, plus the SPC derecho archive.

**`scstrend.html`** — climatology and trend side by side on one shared, pannable map: drag
or zoom either and both follow, so the pair is always over the same ground. Click a state to
centre on it or a county to pin it, with an annual series (95% confidence band) and all
twelve months as small multiples below. Covers hail, tornado, thunderstorm wind, derecho,
freezing rain and peak wind.

**`scstrend_grid.html`** — the same two maps on a 2° × 2° grid instead of counties. States
and counties are drawn as geographic reference only; every number is per grid box.

**`scsevents.html`** — individual storms rather than the climatology. The SPC derecho
archive (184 wind swaths, 1956–2025) and the biggest days on record for hail, tornado and
thunderstorm wind: top 50 for any state, top 100 nationally, or type any date as `YYYYMMDD`.

Deprecated pages live in `old/` and are not linked from anywhere: `scstrend_state.html`
(the original single-SVG "baseball card"), `scstrend_map.html` and `scscard.html`.

## What a "hazard day" is

A hazard day is a **(county, calendar date)** pair with at least one report meeting the
selected magnitude threshold. Counting days rather than reports removes most of the
duplicate-report inflation you get when one storm generates a dozen calls to the same
office.

Two hazards do not use that definition, on purpose:

- **Derecho** is counted in **events per year**, not hazard days. A derecho is one coherent
  storm, and it is dated by its swath's start rather than by each report's local date —
  half these swaths cross a date boundary, and dating by report counted one storm twice in
  any county hit either side of midnight.
- **Station hazards** (freezing rain, peak wind) are per station, and a station-year below
  90% complete is dropped as *no observation* rather than counted as zero. That is the
  opposite of the county rule, and both are right: every county exists every year, a
  station does not.

## Data

| Hazard | Source | Record | Thresholds |
|---|---|---|---|
| Hail | NOAA/NCEI Storm Events | 1955–2024 | any, ≥1″, ≥2″, ≥3″ |
| Tornado | NOAA/NCEI Storm Events | 1950–2024 | EF0+, EF1+, EF2+, EF3+ |
| Thunderstorm wind | NOAA/NCEI Storm Events | 1955–2024 | any, ≥50 kt, ≥65 kt, ≥80 kt |
| Derecho | SPC archive + Storm Events | 1996–2024 | ≥50 kt, ≥64 kt, ≥74 kt |
| Freezing rain | NOAA/NCEI ISD hourly | 2000–2024 | ≥1 h, ≥3 h, ≥6 h |
| Peak wind | NOAA/NCEI ISD hourly | 2000–2024 | ≥40 kt, ≥50 kt, ≥60 kt |

Only `CZ_TYPE == "C"` (county) records are used; the county GEOID is built from
`STATE_FIPS` + `CZ_FIPS` rather than by matching county names, which avoids the
name-collision and independent-city problems.

### County days vs. state days

The build emits two different things, and they are not interchangeable:

- **County days** (`ci`/`yi`/`mi`/`v`) — per county, used for the maps.
- **State and national days** (`rri`/`ryi`/`rmi`/`rv`) — calendar dates on which
  *anywhere* in the state (or country) qualified. This is what the lower panels plot, and
  it is deliberately **not** the sum of county days: one storm can hit twenty counties on
  the same afternoon. Indiana averages 28 statewide hail days a year but 125 county-days.

Note also that the original per-county scripts divided each county's total by the number
of years *present in the data* rather than by the length of the period, which inflates
counties that had quiet years. Everything here divides by the full period: Marion County
is 3.60 mean annual hail days for 2000–2024, not 3.91.

Geometry is the Census `cb_2023_us_county_500k` cartographic boundary file, simplified
to 4% with mapshaper: 3,222 counties across 50 states + DC + Puerto Rico (the Pacific
territories are dropped). Aleutians West is shifted across the antimeridian so it draws
contiguously. State outlines are the same file dissolved by `STATEFP`.

## Three things about the source that bite

**June and July 1993 do not exist.** Not sparse — absent. NCEI's own documentation: *"A best
effort was made to import these files into the original Storm Events Database in FoxPro 3.0
format. (June & July 1993 were misplaced and are not included)."* Verified against all three
files: zero rows in those two months, non-zero in every other month of 1993. Unrecoverable,
so it is masked (`NODATA` in the builders, `meta.gaps` on the wire). Left unmasked, 1993 read
40% low for hail, 46% for tornado and 53% for wind, which looks like a quiet year rather
than a partial one.

**Tornado rows are county segments, not tornadoes.** Storm Events splits a tornado at every
county line: 3 April 1974 holds 239 segments for 148 tornadoes. County-based quantities are
unaffected and in fact *want* segments — each of those counties genuinely had a tornado —
which is why `scsevents.html` ranks days by counties. Segments cannot be collapsed back into
tornadoes across the record: `TOR_OTHER_CZ_FIPS` is empty for every row before ~1990 and
populated on only 13% of rows since 2010. So the column is labelled *Segments*, not *Reports*.

**1993–1995 carries no coordinates.** Report lat/lon is ~100% present 1955–1992 and 1996 on,
and 0% in between. Anything needing a position (the 2° grid, the derecho swaths) falls back
to the county centroid for those years.

## Rebuilding

Order matters: the county builder owns `index.json` and the others merge into it.

```sh
python3 build_hazard_data.py   "/path/to/Baseball Cards" data   # hail, tornado, wind
python3 build_station_data.py  "/path/to/ISD csvs"        data   # fzra, pkwnd
python3 extract_derecho_archive.py SquitieriWadeJirak2026_supp.pdf
python3 build_derecho_data.py  "/path/to/Baseball Cards" data   # derecho swaths + county
python3 build_scs_grid.py      "/path/to/Baseball Cards" data   # 2 deg grid
python3 build_events_data.py   "/path/to/Baseball Cards" data   # biggest-days lists
```

`build_station_data.py` needs the raw NOAA ISD Global Hourly station-year CSVs, which are
**not** in the Baseball Cards folder. It refuses to write an empty file if it finds none —
an earlier version silently overwrote good data with zero stations.

Geometry:

```sh
mapshaper cb_2023_us_county_500k.shp \
  -filter '["60","66","68","69","78"].indexOf(STATEFP) === -1' \
  -simplify 4% keep-shapes \
  -each 'AREA = Math.round(ALAND/1e6)' \
  -filter-fields GEOID,NAME,STUSPS,AREA \
  -o format=topojson geo/counties.topo.json
gzip -9 -k geo/counties.topo.json
```

The output is sparse and columnar — `ci` (county index), `yi` (year offset), `mi` (month),
and one count array per cumulative threshold — so the browser holds every county-year-month
cell in memory and recomputes means, trends and regressions on every control change.

`build_events_data.py` splits its output: the ranked lists plus a per-day county aggregate
(0.24–0.84 MB, always loaded) and the individual reports (0.6–3.9 MB, fetched only when the
reader switches to the points view).

Adding a hazard means adding an entry to `HAZARDS` in the relevant builder and re-running;
the pages read `data/index.json` and build their menus from whatever is there. Hazards carry
a `kind` (`station`, `event`, or absent for county) and the pages filter on it — filtering by
name broke twice as new hazards arrived.

## Caveat that matters

Storm Events is a **report** database, not a fixed observing network. National report counts
rose roughly 30-fold between 1955 and the late 1990s as population, spotter networks,
NEXRAD and NWS verification practice changed. Long-period trends therefore partly measure
the evolution of reporting. Trends from ~2000 on are much more defensible, and high
thresholds (≥2″ hail, EF2+ tornadoes) are far less sensitive to reporting practice than
"any report."

## Testing

Everything runs under node with jsdom (`npm i jsdom topojson-client`):

```sh
node test_scstrend.js        .        # climatology + trend page, Leaflet stubbed
node test_scstrend_grid.js   .        # 2 deg grid page
node test_scstrend_grid_audit.js .    # grid counts against an independent recomputation
node test_derecho.js         .        # the Derecho county climatology
node test_scsevents.js       .        # derecho archive + biggest-days lists
node old/test_tctrend.js        old      # deprecated single-SVG card, real SVG output
node old/test_dom.js         old      # deprecated map explorer
node old/test_logic.js old/scstrend_map.html geo/counties.topo.json.gz data/hail.json.gz
```

`old/test_logic.js` drives the page's functions directly through `vm` rather than booting it,
so it prints a harmless `your browser is too old to decompress the data` to stderr from the
page's own init path. Its checks still run: season partition 0, threshold monotonicity 0,
and the Student's *t* values exact.

What the suites are actually for, beyond "it renders": that the projection is not upside
down (it was once, and four visual checks missed it); that a zero-filled year is a real
zero while a masked month is not; that the smoother preserves NaN and does not change which
units are drawn; that switching hazard, threshold or state cannot strand the reader on a
selection that no longer exists; that the heavy per-report file is fetched only on demand;
and that a map is never built into a hidden container, which silently pins it at maximum
zoom.

For a visual check of the deprecated card, dump its SVG and rasterise:

```sh
node old/dump_tctrend.js old out.svg "h=hail&r=IN&p=2000-2024"
python3 -c "import cairosvg; cairosvg.svg2png(url='out.svg', write_to='out.png', \
            output_width=1520, output_height=1035)"
```
