# TC Wind Field Explorers

Two interactive education pages for the tropical cyclone near-surface wind and pressure
field, both built on the [`tcwindprofile`](https://pypi.org/project/tcwindprofile/) model
and both running entirely client-side off the shared `tcwindprofile.js`.

- **`windfield_ideal.html`** — one storm, four linked views of its wind and pressure structure.
- **`track.html`** — a full idealized track, and the wind swath it leaves behind.

---

## 1. `windfield_ideal.html` — single-storm wind field explorer

Set **Vmax**, **R34kt**, **latitude**, **translation speed** and **Penv** and four linked
views update live:

1. **Idealized wind footprint** — plan view of the 10-m wind speed with 34/50/64 kt rings
   and the Rmax circle. Optional translation asymmetry (rotating wind + 0.55 × translation
   vector, rotated 20° for inflow; Lin & Chavas 2012) shows why the strongest winds sit on
   one side of a moving storm.
2. **Radial wind profile V(r)** — colour-coded by the four model branches: eye (linear),
   inner core (linear-M), intermediate (modified Rankine), outer (Ekman suction / E04).
3. **Pressure profile P(r)** — from gradient wind balance, rescaled to the predicted Pmin.
4. **The Vmax–R34kt plane** — log-shaded contour maps of Rmax, Pmin, R0 or Rmax/R34kt over
   the whole plane, with the current storm marked. Click anywhere to move the storm there.

Preset storms include the Igor / Julia / Karl 2010 trio (same Vmax, very different size),
plus Katrina, Wilma, Sandy, Haiyan and Tip.

No build step, no CDN, no network access needed.

---

## 2. `track.html` — idealized track & wind swath

The idealized counterpart to `../ibtracs_viewer.html`. Instead of reading IBTrACS, the
track is built by hand: **lat, lon, Vmax, R34kt** per point, in an editable table, with the
number of points set by the user (2–40). Points can also be **dragged on the map**.
Everything else — Rmax, Pmin, R0, the wind profile and the quadrant wind radii — is
predicted by the model. Click any point for its full data plus an inline plot of its radial
wind profile.

Translation speed and heading are derived from the track geometry given one global
"hours per point" setting (3/6/12/24 h), and feed the optional motion asymmetry.

**Move the whole track** shifts every point rigidly in latitude and/or longitude, so the
shape — and therefore every translation speed and heading — is untouched. Latitude is the
scientifically interesting one: it changes *f*, and with it Rmax, R0 and Pmin, which is a
neat way to see the Coriolis dependence on an otherwise identical storm. The sliders hold
the *cumulative* shift, so returning one to zero exactly undoes it. Two details:

- Latitude is clamped as a whole-track quantity, so the track never distorts by piling up
  against ±60°; the slider handle snaps back to whatever was actually applied.
- Longitude is re-centred with a single offset applied to every point, not per point, so a
  track pushed across the dateline stays contiguous instead of splitting across the map.

Presets: Gulf landfall (intensifying then weakening), Atlantic recurve, typhoon recurving
into Japan while expanding, straight westward Pacific landfall, and a same-track/very-large
storm for comparison against the Gulf case.

### Swath rendering

The swath construction is the same code as `ibtracs_viewer.html` — `dest`, `radiusAt`,
`footprint`, `ringOf`, `swathPolys`, `unionAll`, `drawUnion`, the panes, the graticule and
the clicked-point highlight are carried over unchanged, so the two pages produce directly
comparable pictures. Quadrant radii are computed at the quadrant centres (NE 45°, SE 135°,
SW 225°, NW 315°) by ray-casting outward from the storm centre, which reduces to four equal
values when asymmetry is off.

Two resolution constants **do** differ, and deliberately (see the comment at `AZ_STEP` in
the source). Idealized tracks are often 12- or 24-hourly with a storm that grows a long way
between points; the union of the bridging circles then staircases along the widening flank,
because each bridged circle is ΔR/N larger than the last. So:

- footprints are sampled every **2°** instead of 3°, and
- the bridging count adds a **growth** criterion — no single step may enlarge a quadrant
  radius by more than 2.5 n mi — on top of the viewer's overlap criterion.

The growth criterion is what actually removes the staircase, and it costs nothing where
storm size is steady. A full rebuild is ~100–700 ms depending on preset, dominated by
`polygonClipping.union`.

### Point clicks vs. drag handles

Each track point is a `circleMarker` (overlay pane, z 400) with an invisible draggable
`L.marker` on top of it (marker pane, z 600). The drag handle therefore receives *every*
click aimed at the point, so the click and hover handlers must be bound to the handle, not
only to the circle. Leaflet also fires a trailing `click` after a drag; that is suppressed
with an explicit `moved` flag rather than a time window, because rebuilding the swath inside
`dragend` can take longer than any reasonable window and the click would slip through.

Motion asymmetry adds 0.55 × the translation vector to the rotating wind, rotated 20°
toward the low for surface inflow (Lin & Chavas 2012) — the same 0.55 the model uses in
reverse to recover azimuthal-mean Vmax from the reported point-max. Verified: the swath
bulges right of track in the NH, mirrors correctly in the SH, and is symmetric when the
toggle is off.

---

## Files

| file | what it is |
|---|---|
| `windfield_ideal.html` | single-storm explorer: UI, plotting, all four panels |
| `track.html` | idealized track & wind swath (Leaflet + polygon-clipping, from CDN) |
| `tcwindprofile.js` | standalone JavaScript port of the Python model — reusable on its own |

`tcwindprofile.js` has no dependencies and works in the browser or under Node
(`const TCWind = require('./tcwindprofile.js')`). The main entry point is
`TCWind.runFullWindModel({VmaxNHC_kt, Vtrans_kt, R34kt_quadmean_nmi, lat, Penv_mb})`.

## Model, and how it was verified

Four published steps, unchanged:

1. **Rmax from R34kt** — Chavas & Knaff (2022) WAF, [doi:10.1175/WAF-D-21-0103.1](https://doi.org/10.1175/WAF-D-21-0103.1)
2. **Complete wind profile** — Tao, Nystrom, Chavas & Avenas (2025) GRL; an analytic
   approximation to Chavas, Lin & Emanuel (2015) JAS
3. **Pmin from intensity + size** — Chavas, Knaff & Klotzbach (2025) WAF, [doi:10.1175/WAF-D-24-0031.1](https://doi.org/10.1175/WAF-D-24-0031.1)
4. **Pressure profile** — gradient wind balance applied to the wind profile

Both pages were also exercised headlessly (jsdom + node-canvas, plus real Leaflet and
polygon-clipping for `track.html`): 41 checks on `windfield_ideal.html`, and 86 on `track.html` split
across four suites — general interaction (45), map-marker clicks and drag handling (10),
panel layout and the compact breakpoint (13), and rigid track translation (18). Together
they cover every preset, slider extreme, toggle, table edit, point-count change, dateline
and pole case, and guard condition.

The JS port was checked against `tcwindprofile` 2.1.2 over six storms spanning the input
space. Agreement is at machine precision for Rmax, R0, Pmin, Vmaxmean and R34ktmean;
V(r) matches to <1e-4 m/s and P(r) to <0.2 mb (the pressure difference is only the
integration grid spacing — the page uses 6000 radial points, the package uses 10 m).

### One thing to be aware of

`tc_rmax_estimatefromR34kt.py` in v2.1.2 **computes** the Eq. 8 large-Rmax bias adjustment
but assigns it to a separate local variable and returns the *uncorrected* value, so the
correction never takes effect. This matters only for Rmax > 60 km, where it is sizeable
(e.g. 96 → 114 km).

This page reproduces the package's actual behaviour, so the two agree. The port exposes the
correction behind an opt-in flag:

```js
TCWind.predictRmaxFromR34kt(VmaxNHC_ms, R34ktmean_km, lat, /* applyBiasAdj */ true)
// or:  runFullWindModel({..., applyRmaxBiasAdj: true})
```

If the Python is fixed to apply Eq. 8, flip the default here to match.

## Regenerate / edit

Everything is hand-written; there is no build. Edit `windfield_ideal.html` directly. If you change
the model, re-run the cross-check against Python before deploying.

## Caveat shown on the page

This is an idealized footprint: a smooth, circular, mature storm over open ocean. Real
storms have asymmetric convection, spiral bands, boundary-layer rolls, land interaction and
shear-induced tilt. The point is to show how much of the wind field is set by a handful of
numbers — not to replace an analysis of a specific storm.
