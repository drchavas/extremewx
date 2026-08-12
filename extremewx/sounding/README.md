# Sounding Plotter

A general-purpose skew-*T* log-*p* plotter and editor. Load a preset, paste a sounding, edit any
level in a table, or drag the temperature and dewpoint curves on the plot; CAPE, CIN, the parcel
curves, the hodograph and the full severe-weather index suite update live.

Everything runs client-side off `sounding.js`. No build step, no CDN, no network — the page works
over `file://`.

This is the *observed/arbitrary* counterpart to [`../scs/sounding_ideal.html`](../scs/), which
generates an idealized sounding from physical parameters instead of taking one as input.

---

## Files

| file | what it is |
|---|---|
| `sounding_plotter.html` | the page: UI, editable table, skew-*T*, hodograph, diagnostics |
| `sounding.js` | standalone engine — parsing, thermodynamics, parcels, diagnostics |
| `../skewt.js` | shared skew-T renderer, ported from the PI page |
| `test_plotter.js` | 104 headless checks (`npm i jsdom canvas && node test_plotter.js .`) |

`sounding.js` has no dependencies and runs under node:

```js
const SK = require('./sounding.js');
const a  = SK.analyze(SK.PRESETS['Classic supercell (plains, EML cap)']);
console.log(a.sb.CAPE, a.kin.shear06, a.idx.STP);

const r = SK.parseText(fs.readFileSync('my_sounding.txt','utf8'));
console.log(SK.analyze(r.levels).mu.CAPE);
```

Input is a list of `{p, T, Td, u, v}` (hPa, °C, °C, m/s). `analyze()` returns the interpolated
profile, the three parcels, the effective inflow layer, kinematics and indices.

---

## What it computes

**Parcels** — surface-based, mixed-layer (lowest 100 hPa, mass-weighted mean θ and *r*) and
most-unstable (highest θ<sub>e</sub> in the lowest 300 hPa), each with CAPE, CIN, LCL, LFC and EL.

**Thermodynamic** — precipitable water, 0–3 km and 700–500 hPa lapse rates, freezing level,
wet-bulb zero, DCAPE.

**Kinematic** — 0–1/0–3/0–6 km bulk shear, Bunkers right and left movers, 0–1 and 0–3 km SRH,
effective inflow layer, effective SRH and effective bulk wind difference.

**Composite** — SCP, STP (fixed layer), K index, Total Totals.

**Vertical structure** — a row of panels against **height** rather than log-pressure, following
Chavas and Peters (2023, *BAMS*, Fig. 2) and Chavas and Dawson (2021, *JAS*, Fig. 2): temperature;
specific humidity and mixing ratio; relative humidity; θ, θ<sub>e</sub> and θ*<sub>e</sub>; dry and
moist static energy with saturation MSE; and the decomposition of moist static energy into its
potential, sensible and latent buckets.

```
D = g z + cp T                dry static energy
M = g z + cp T + Lv qv        moist static energy
```

That last panel is the argument for static energy in the first place: because g, c<sub>p</sub> and
L<sub>v</sub> are all near-constant, M is a plain *sum* of energies that separates into buckets you
can point at. Potential temperature cannot be decomposed that way — it is a nonlinear combination of
temperature and pressure, and θ<sub>e</sub> folds in water vapour nonlinearly on top of that. The
θ/θ<sub>e</sub> and D/M panels sit side by side so you can see they carry the same vertical
information in a hydrostatic atmosphere while only one of them decomposes.

Two conventions to be aware of. CP23 Eq. 2 uses **specific humidity** q<sub>v</sub>, which is what is
plotted; CD21 Eq. 1 uses **mixing ratio** r. They differ by about 2% of the latent term (0.75 kJ/kg at
the surface of the supercell preset), and `staticEnergy()` returns both as `M` and `Mr`. And *z* in
the potential-energy term is height above **mean sea level**, so the page has a surface-elevation box —
CP23's Fig. 2 sounding sits at 277.4 m. Elevation shifts PE, and with it the absolute D and M, by
exactly gΔz; it changes nothing else, including CAPE.

### Method notes

- Input levels are interpolated onto a 500-point log-pressure grid. Heights come from integrating
  hydrostatic balance upward from the lowest level given, so **all heights are AGL** — if your
  sounding starts at 850 hPa, everything is relative to that.
- Parcel ascent is **pseudoadiabatic**; buoyancy uses virtual temperature.
- Saturation vapour pressure is Bolton (1980) Eq. 10; θ<sub>e</sub> is Bolton Eq. 38/39; the LCL is
  Bolton Eq. 22; wet bulb is Stull (2011).
- Effective inflow layer: the contiguous levels whose parcels have CAPE ≥ 100 J/kg and
  CIN ≥ −250 J/kg (Thompson et al. 2007).
- DCAPE descends the minimum-θ<sub>e</sub> parcel found between 50 and 400 hPa above the surface,
  saturated, to the ground. The 50 hPa floor matters: without it, a boundary layer that is itself
  the θ<sub>e</sub> minimum gives a zero-depth descent and DCAPE = 0.
- `SCP = (MUCAPE/1000)(ESRH/50)(EBWD/20)` with EBWD capped at 20 m/s and zeroed below 10.
  `STP` is the fixed-layer form from SBCAPE, SBLCL, 0–1 km SRH and 0–6 km shear.

---

## Pasting soundings

The parser tries, in order:

1. **CM1 `input_sounding`** — detected from its shape (3-field header, then 5-field rows with *z*
   increasing). The file contains no pressure, so pressure is recovered by integrating hydrostatic
   balance up from the header surface pressure. The header line also carries no wind, so the
   surface level inherits the wind of the first level above it; the page says so when it loads.
2. **A header row naming the columns** — `pres/press/p`, `temp/tmpc/t`, `dwpt/td`, `drct/dir`,
   `sknt/spd`, or `u`/`v`. `mixr` or `relh` are accepted in place of dewpoint. This is what a
   University of Wyoming table looks like, so those paste directly.
3. **Positional** — `p, T, Td` and, if there are five or more columns, wind direction and speed.

Anything unparseable is reported in the box rather than silently applied.

---

### Parcel ascent

Selectable in the sidebar on both pages, and shared between the two engines:

| mode | condensate | effect |
|---|---|---|
| **pseudoadiabatic** (default) | removed as fast as it forms | no water load; what most sounding software reports |
| **reversible** | all carried along | adds heat capacity *and* weight; CAPE drops 20–30% |
| **dry** | none — no condensation at all | not a real CAPE calculation; the gap to the other two is exactly the latent heating |

Both moist modes come from a single generalized saturated lapse rate that differs only in the
total-water term,

```
dT/dlnp = (1 + rv/ε)(Rd T + L rv) / (cpd + rt cl + L² rv (1 + rv/ε)/(Rv T²))
```

with `rt = rv` for pseudoadiabatic and `rt = r0` conserved for reversible (Emanuel 1994, Eq. 4.7.3,
converted from height to log-pressure). Because the only difference is `rt`, the comparison between
the two is clean rather than an artefact of two different formulas.

The **ice** toggle blends the latent heat of fusion and the saturation vapour pressure over ice
linearly across 0 to −40 °C, following the mixed-phase treatment of Peters et al. (2022); it adds a
few tens of J/kg.

One result worth stating because it looks wrong at first: the reversible parcel is **warmer** than
the pseudoadiabatic one aloft — retained condensate adds heat capacity, which slows the cooling — yet
it is **less buoyant**, because the water it drags along more than cancels the extra warmth. On the
supercell preset the reversible parcel is 2.15 K warmer at mid-levels but 1.70 K lower in density
temperature. This is why the CAPE shading on both pages is drawn between *density* temperatures
rather than raw temperatures: shading temperature would show a larger area for a smaller CAPE.

---

## Verification

`test_plotter.js` runs 153 checks. The ones that matter most:

**Thermodynamic primitives** against published values — `esat(0°C) = 6.112` hPa, `esat(20°C) = 23.37`
vs 23.4, mixing ratio 14.88 vs 14.9 g/kg at 20 °C / 1000 hPa, θ<sub>e</sub> = 358.9 K vs Bolton's
worked example of 358.4, `theta(0°C, 500 hPa) = 332.9` vs 333.3 K, wet bulb between T<sub>d</sub>
and T and equal to T at saturation.

**Analytic limit cases** — a column built to be exactly a pseudoadiabat and saturated throughout
returns CAPE = 0.0 and CIN = 0.0 J/kg with the LCL at 2.5 m; an isothermal column returns no CAPE
and no LFC.

**Cross-check against the independent CD21 implementation** — write a CM1 `input_sounding` from
`scssounding.js`, read it back through this parser, and compare. Pressure at 4940 m agrees to
0.17 hPa, temperature to 0.02 K, winds to machine precision, and SBCAPE to 2607 vs 2614 J/kg
(0.3%). Two separately written codebases, agreeing through a lossy file format.

**Physical sensitivities** — warmer or moister surface raises CAPE; drier surface raises the LCL and
lowers CAPE; doubling the winds doubles the shear. Two sign conventions worth stating because they
are easy to get backwards: rotating the hodograph 180° (negating *both* u and v) leaves SRH
**unchanged**, because SRH is quadratic in the wind and the sense of turning is preserved;
*mirroring* it (negating u only) flips the sign.

**Convergence** — SBCAPE on the supercell preset is 3708 / 3707 / 3708 J/kg at 200 / 500 / 1200 grid
points, so the default 500 is well converged.

**Static energy** — `D = PE + SE` and `M = PE + SE + LE` hold to exactly zero floating-point error;
`PE = g·z` with z from MSL; M* ≥ M ≥ D and θ*<sub>e</sub> ≥ θ<sub>e</sub> ≥ θ at every level; changing
the surface elevation shifts D and M by exactly gΔz while leaving SE, LE and CAPE untouched. In the
inverted-V preset's deep dry-adiabatic mixed layer, D is constant to 0.07 kJ/kg and θ to 0.0 K over
3 km — the two statements of the same fact. Across the supercell sounding, D and θ increase and
decrease together at 100% of the 318 levels below 14 km, which is the CP23 point that the two carry
the same vertical information.

**Parsing** — a real Wyoming table (including checking that a 170° wind gives v > 0 and a 255° wind
gives u > 0), CSV with RH or mixing ratio in place of dewpoint, headerless positional input, the CM1
round-trip above, `toText` → `parseText` round-tripping to the printed precision, and five kinds of
garbage input returning cleanly rather than throwing.

**The page** driven through jsdom + node-canvas — all presets, all three parcel types, every display
toggle, cell editing, the T<sub>d</sub> ≤ T clamp, add/delete level, paste import, a deliberately bad
paste, copy/download, a wind-free sounding degrading gracefully to a message instead of a hodograph,
and a non-blank check on both canvases.

---

## Relationship to the other explorers on this site

The skew-*T* on this page is drawn entirely by **`../skewt.js`**, which is the renderer lifted out of
the [TC potential-intensity explorer](../../) — same geometry (MetPy `skew_deg`, rotation 47°,
p 1050 → 50 hPa, surface-temperature-dependent x-bounds), same background (cornflower dry and moist
adiabats, black dashed saturation mixing-ratio lines, blue dashed 0 and −20 °C isotherms, grey
isobars across the plot, bold black tick labels), same fonts, same line widths, and the same
SounderPy-derived curve palette. Curves are labelled in place rather than through a legend. So the
PI page, the SCS sounding explorer and the sounding plotter all produce the same figure; only the
curve set differs.

Curves, following the PI page but with a single parcel and a single CAPE:

| curve | style | what it is |
|---|---|---|
| `T` | red, lw 3.2 | environment temperature |
| `Td` | green, lw 3 | environment dewpoint |
| `Tv` | dark red dotted, lw 2.2 | environment virtual temperature |
| `Tw` | light blue, lw 1.8 | environment wet bulb (plotter only, optional) |
| `T_parcel` | grey dashed, lw 1.8 | parcel temperature |
| `T_v,parcel` | magenta fine-dotted, lw 1.6 | parcel virtual temperature (vapour only) |
| `T_ρ,parcel` | magenta dashed, lw 2.6 | parcel **density** temperature — bounds the shading |

`T_v,parcel` and `T_ρ,parcel` coincide exactly under pseudoadiabatic ascent, because there is no
condensate. Under reversible ascent they separate, and the gap between them *is* the water loading —
which is why the reversible parcel can be warmer than the pseudoadiabatic one while producing less
CAPE. The shaded areas are bounded by `T_ρ,parcel` and the environment `Tv`, so the picture always
matches the reported number.

The surrounding page stays dark; the figure itself is light so it drops straight into a slide.

---

## Caveats

- Numbers will not match SHARPpy or MetPy to the last joule. Reversible ascent, ice, or a different
  saturation vapour pressure formula each shift CAPE by order 100–300 J/kg.
- Composite indices are operational triage tools tuned on real soundings. Applied to a hand-drawn or
  heavily idealized profile they can be badly misleading.
- Diagnostics are only as good as the vertical resolution supplied. A 10-level sounding gives a
  noticeably different CAPE from the same profile at 200 levels.

---

## References

1. Chavas, D. R., and J. Peters, 2023: Static energy deserves greater emphasis in the meteorology
   community. *Bull. Amer. Meteor. Soc.*, **104**, E1918–E1927,
   [doi:10.1175/BAMS-D-22-0013.1](https://doi.org/10.1175/BAMS-D-22-0013.1).
2. Chavas, D. R., and D. T. Dawson II, 2021: An idealized physical model for the severe convective
   storm environmental sounding. *J. Atmos. Sci.*, **78**, 653–670,
   [doi:10.1175/JAS-D-20-0120.1](https://doi.org/10.1175/JAS-D-20-0120.1).
3. Bolton, D., 1980: The computation of equivalent potential temperature. *Mon. Wea. Rev.*,
   **108**, 1046–1053.
4. Bunkers, M. J., et al., 2000: Predicting supercell motion using a new hodograph technique.
   *Wea. Forecasting*, **15**, 61–79.
5. Thompson, R. L., C. M. Mead and R. Edwards, 2007: Effective storm-relative helicity and bulk shear
   in supercell thunderstorm environments. *Wea. Forecasting*, **22**, 102–115.
6. Thompson, R. L., R. Edwards, J. A. Hart, K. L. Elmore and P. Markowski, 2003: Close proximity
   soundings within supercell environments obtained from the Rapid Update Cycle.
   *Wea. Forecasting*, **18**, 1243–1261.
7. Stull, R., 2011: Wet-bulb temperature from relative humidity and air temperature.
   *J. Appl. Meteor. Climatol.*, **50**, 2267–2269.
8. Weisman, M. L., and J. B. Klemp, 1982: The dependence of numerically simulated convective storms
   on vertical wind shear and buoyancy. *Mon. Wea. Rev.*, **110**, 504–520.

## Regenerate / edit

Hand-written, no build. Edit `sounding_plotter.html` directly. If you change the engine, re-run
`test_plotter.js` before deploying.

### Additional references for the ascent modes

- Emanuel, K. A., 1994: *Atmospheric Convection*. Oxford University Press, §4.7.
- Peters, J. M., J. P. Mulholland and D. R. Chavas, 2022: Generalized lapse rate formulas for use in
  entraining CAPE calculations. *J. Atmos. Sci.*, **79**, 815–836,
  [doi:10.1175/JAS-D-21-0118.1](https://doi.org/10.1175/JAS-D-21-0118.1).
