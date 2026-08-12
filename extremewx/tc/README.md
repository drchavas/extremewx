# TC Track & Wind-Field Explorer

Interactive single-storm viewer. Pick a **year** and **storm** from the dropdowns to plot
its IBTrACS best-track, coloured by Saffir–Simpson category, with coherent **34 kt** (R34)
and **64 kt** (R64) wind-field swaths and an optional **Rmax** swath (each the union of every
timestep's area, with interpolated bridging between points). **Click any track point** to
highlight that timestep's wind radii and read its full data: date/time, type, lat, lon, Vmax,
Pmin, Rmax, R64/R50/R34 (non-zero mean + NE/SE/SW/NW quadrants), translation speed, motion
direction, POCI, ROCI, distance to land, and ATCF ID. Landfall timesteps are flagged.

## Use it
Serve **`ibtracs_viewer.html`** over http (it's live on the Purdue web space). Data is split:
the page first fetches a small **`data/index.json.gz`** (~0.15 MB — the storm list for the
dropdowns + per-basin climatology), then loads **`data/basin_<B>.json.gz`** for whichever
basin you pick, on demand. Each basin is cached in memory (revisiting is instant), and each
file is gunzipped in the browser (`DecompressionStream`) so no server gzip is required. First
load is ~1 MB (index + default basin) instead of ~6 MB. (Because it uses `fetch`, opening the
file via `file://` won't load data — use a local server like `python3 -m http.server` to
preview.) Map tiles and the polygon-union library (`polygon-clipping`) load from CDNs.

## Data
- Source: NOAA **IBTrACS v04r01**, global — `USA_*` columns (NHC in the Atlantic/E-Pacific,
  JTWC elsewhere).
- **All storms, all basins, entire record** at synoptic (6-hourly) resolution, plus landfall
  and wind-radii points. (3-hourly interpolated points are dropped to keep the file small.)
- Per point: position, Vmax (`USA_WIND`), Pmin (`USA_PRES`), SSHS (`USA_SSHS`),
  Rmax (`USA_RMW`), translation speed/direction (`STORM_SPEED`/`STORM_DIR`), nature
  (`NATURE`), landfall record (`USA_RECORD` = "L"), distance to land (`DIST2LAND`),
  POCI/ROCI (`USA_POCI`/`USA_ROCI`), and the four-quadrant `USA_R34/R50/R64` radii (nm).
  ATCF ID (`USA_ATCF_ID`) is stored per storm.
- Wind radii (R34/R50/R64), Rmax, POCI and ROCI are routinely analysed only from ~2004 on;
  earlier storms usually lack them.

## Regenerate / update
This folder is self-contained: run the build here and it writes `storms.js` in place.
```
python3 process_storms.py            # rebuild storms.js from a local IBTrACS CSV
python3 process_storms.py --update   # download the latest IBTrACS NA CSV first, then rebuild
```
`--update` downloads `ibtracs.NA.list.v04r01.csv` from NCEI (updated ~daily; includes
provisional current-season storms) **into this folder**, then rebuilds `storms.js`. Plain
`process_storms.py` reuses whatever CSV it finds (this folder first). After rebuilding, push
the updated `storms.js` (and any changed files) to the remote web server. This same command
is what a daily cron / GitHub Action would run to keep the page current automatically.
