# U.S. Extreme Weather Trends

Two views of the same data.

**`scstrend_state.html`** — the whole story of one hazard in one frame: climatology map,
trend map, annual series with a 95% confidence band, and all twelve months as small
multiples. The entire card is a single SVG, so it exports cleanly to PNG or SVG for a
talk or a paper, and it has a light theme for print. Pick any state or county.

**`scstrend_map.html`** — a pannable, zoomable county-level map of hazard days with live
climatology, trend, change and single-year views, a season filter and CSV export.

## What a "hazard day" is

A hazard day is a **(county, calendar date)** pair with at least one report meeting the
selected magnitude threshold. This is the same definition used in the original Indiana
baseball-card scripts. Counting days rather than reports removes most of the duplicate-report
inflation you get when one storm generates a dozen calls to the same office.

## Data

| Hazard | Source | Record | Thresholds |
|---|---|---|---|
| Hail | NOAA/NCEI Storm Events | 1955–2024 | any, ≥1″, ≥2″, ≥3″ |
| Tornado | NOAA/NCEI Storm Events | 1950–2024 | EF0+, EF1+, EF2+, EF3+, EF4+ |
| Thunderstorm wind | NOAA/NCEI Storm Events | 1955–2024 | any, ≥50 kt, ≥65 kt, ≥80 kt |

Only `CZ_TYPE == "C"` (county) records are used; the county GEOID is built from
`STATE_FIPS` + `CZ_FIPS` rather than by matching county names, which avoids the
name-collision and independent-city problems.

### County days vs. state days

The build emits two different things, and they are not interchangeable:

- **County days** (`ci`/`yi`/`mi`/`v`) — per county, used for both maps.
- **State and national days** (`rri`/`ryi`/`rmi`/`rv`) — calendar dates on which
  *anywhere* in the state (or country) qualified. This is what the lower two panels of
  the baseball card plot, and it is deliberately **not** the sum of county days: one
  storm can hit twenty counties on the same afternoon. Indiana averages 28 statewide
  hail days a year but 125 county-days.

Note also that the original per-county scripts divided each county's total by the number
of years *present in the data* rather than by the length of the period, which inflates
counties that had quiet years. Everything here divides by the full period: Marion County
is 3.60 mean annual hail days for 2000–2024, not 3.91.

Geometry is the Census `cb_2023_us_county_500k` cartographic boundary file, simplified
to 4% with mapshaper: 3,222 counties across 50 states + DC + Puerto Rico (the Pacific
territories are dropped). Aleutians West is shifted across the antimeridian so it draws
contiguously. State outlines are the same file dissolved by `STATEFP`.

## State focus

The **Focus on** dropdown zooms to a state, outlines it in orange, dims the surrounding
states, and scopes the side panel's time series, seasonal cycle and month-by-year heatmap
to that state's counties. The page opens on **Indiana**; choose *United States (all)* to
un-focus, at which point the side panel follows whatever is in the map view instead.
The focused state is carried in the URL (`f=IN`), so shared links land where you left them.

## Rebuilding

```sh
# hazard data  (needs pandas + numpy)
python3 build_hazard_data.py "/path/to/Baseball Cards" data

# geometry     (needs npm i mapshaper)
mapshaper cb_2023_us_county_500k.shp \
  -filter '["60","66","68","69","78"].indexOf(STATEFP) === -1' \
  -simplify 4% keep-shapes \
  -each 'AREA = Math.round(ALAND/1e6)' \
  -filter-fields GEOID,NAME,STUSPS,AREA \
  -o format=topojson geo/counties.topo.json
gzip -9 -k geo/counties.topo.json
```

The output is sparse and columnar — `ci` (county index), `yi` (year offset), `mi` (month),
and one count array per cumulative threshold. Total payload is ~0.8 MB gzipped for all
three hazards, so the browser can hold every county-year-month cell in memory and
recompute means, trends and regressions on every control change.

Adding a hazard means adding an entry to `HAZARDS` in `build_hazard_data.py` and re-running;
the page reads `data/index.json` and builds its menus from whatever is there.

## Caveat that matters

Storm Events is a **report** database, not a fixed observing network. National report counts
rose roughly 30-fold between 1955 and the late 1990s as population, spotter networks,
NEXRAD and NWS verification practice changed. Long-period trends therefore partly measure
the evolution of reporting. Trends from ~2000 on are much more defensible, and high
thresholds (≥2″ hail, EF2+ tornadoes) are far less sensitive to reporting practice than
"any report."

## Testing

All three run under node with jsdom (`npm i jsdom topojson-client`):

```sh
node test_logic.js scstrend_map.html geo/counties.topo.json.gz data/hail.json.gz
node test_dom.js   .            # scstrend_map.html, Leaflet stubbed
node test_card.js  .            # scstrend_state.html, real SVG output
```

`test_logic.js` checks season partitioning (months must sum to the annual total),
threshold monotonicity, Student's *t* p-values against known critical values, and county
means against an independent pandas computation. `test_dom.js` exercises every control on
the map explorer, the county click path and CSV export. `test_card.js` renders the card
and verifies the panels, the projection, and the regression statistics — Indiana hail
2000–2024 must come out at R² = 0.235 and −5.45 days/decade, matching the original
matplotlib figure.

For a visual check, dump the card's SVG and rasterise it:

```sh
node dump_card.js . out.svg "h=hail&r=IN&p=2000-2024"
python3 -c "import cairosvg; cairosvg.svg2png(url='out.svg', write_to='out.png', \
            output_width=1520, output_height=1035)"
```
