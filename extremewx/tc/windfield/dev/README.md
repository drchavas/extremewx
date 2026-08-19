# dev/ — Jamaica multi-hazard model (NOT WORKING, NOT PUBLIC)

**Do not deploy, link, or use the output of this page.** It is parked here mid-development.

Kept out of public view by four separate mechanisms, because any one of them can be missed:

1. no link to it from `extremewx.html` or anywhere else on the site
2. `dev/.htaccess` sends `X-Robots-Tag: noindex, nofollow` (covers the `.js`/`.py` files too,
   which a `<meta>` tag cannot) and disables directory listing
3. `<meta name="robots" content="noindex,nofollow,...">` in the page
4. `/robots.txt` disallows `/extremewx/tc/windfield/dev/`

Note the tension between 2 and 4: `robots.txt` stops a crawler fetching the page at all, so it
never sees the `noindex` header. That is fine while nothing links here. If this ever does get
linked from an external site, drop the `robots.txt` rule and rely on `X-Robots-Tag`, which is
the only way to guarantee a URL is de-indexed rather than merely uncrawled.

## What works and what doesn't

**Peak wind — believed correct.** Chavas/Tao profile plus motion asymmetry, 15% land
reduction. Renders as a clean swath.

**Rainfall — broken.** The cross-track profile oscillates by roughly a factor of five
(915 → 255 → 658 → 206 → 1078 mm across the swath) where physics demands a smooth double peak
straddling the track, highest near r ≈ Rmax. Ruled out so far:

- *not* the shear term — the profile is essentially identical with shear switched off
- *not* timestep aliasing — unchanged over a 30× reduction in timestep

Leading untested hypothesis: the radial derivative `w = -Htrop/Δr · d(r·u)/dr` in `tcrain.js`
interacting with the 2 km stencil near the eyewall, where `w` spikes from 0.45 m/s at r = 19 km
to 6.6 m/s at r = 22 km and back to 1.2 m/s at r = 24 km. The suggested next step is to isolate
that term against a **stationary** storm, where the accumulated field must be exactly radially
symmetric and is therefore analytically checkable.

**Already fixed** (do not re-litigate): chain-link aliasing in both fields, caused by
point-sampling that ~3 km eyewall ring on a 2 km grid as the storm advanced. Fixed by an
adaptive timestep targeting ~1 km of storm displacement plus a 3×3 sub-grid average.
Along-track roughness fell from 7.70 to 0.47 kt.

**Terrain is schematic, not a DEM.** `jamaica_terrain.js` is a smooth analytic surface matching
Jamaica's outline (12,400 vs 10,991 km²) and summit positions (peak at 18.05 N/76.60 W vs Blue
Mountain Peak's 18.045 N/76.585 W), but its slopes average ~2° where real hillslopes exceed 25°.
The bathymetry is worse — roughly 2,500 m too deep close inshore. Run `build_terrain.py` with a
real SRTM/GEBCO raster to replace it.

**Surge, landslide, inland flood** are not implemented; reasons are documented at the foot of
`hazards.js`.

## Files

| file | what it is |
|---|---|
| `hazard_jamaica.html` | the page (loads `../tcwindprofile.js` from the parent folder) |
| `hazards.js` | footprint engine: walks the track, accumulates wind and rain |
| `tcrain.js` | TCR rainfall model, ported from `pyTCR`; 17 physics checks pass |
| `jamaica_terrain.js` | schematic terrain — **not** a DEM |
| `build_terrain.py` | ingests a real DEM into `terrain_jamaica.bin/.json` |
| `.htaccess` | `noindex` headers, no directory listing |

## A note on testing

The numeric suite passed 32/32 while the map was visibly wrong, because roughness was being
measured *across* the track when timestep aliasing manifests *along* it. Rendering the field to
a PNG and looking at it caught two defects the assertions missed. Render before trusting.
