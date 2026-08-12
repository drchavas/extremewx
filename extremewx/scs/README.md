# SCS Environmental Sounding Explorer

Interactive page for the idealized severe convective storm environmental sounding of
**Chavas and Dawson (2021, JAS)**. Set the eight thermodynamic and six kinematic parameters
and the skew-*T*, the static-energy profile, the hodograph and every derived index update
live. Export the result as a CM1 `input_sounding`.

Everything runs client-side off `scssounding.js`. No build step, no CDN, no network access —
the page works over `file://`.

---

## The model

Two tropospheric layers separated by a capping inversion, phrased in static energy rather
than potential temperature. Below `H_BL`, dry static energy `D = cpT + gz` and moist static
energy `M = D + Lv·r` are both constant — which is a dry-adiabatic temperature profile and a
well-mixed (constant) mixing ratio. At `H_BL` the dry static energy jumps by `ΔD`, the capping
inversion, then rises linearly at `β_FT`, which is exactly a constant lapse rate
`Γ_FT = Γd − β_FT/cp`. Free-tropospheric relative humidity is constant at `RH_FT,0`. Pressure
comes from integrating hydrostatic balance upward from `P_sfc`. Wherever the temperature would
fall below `T_tpp` it is clipped there, giving a dry isothermal stratosphere whose base is the
tropopause.

The kinematic profile is two unidirectional shear layers: constant meridional shear `c_BL`
below `H_BL`, then zonal shear `∂u/∂z = c_FT,1 + c_FT,2(z − H_BL)` up to `H_top`, constant
above. Setting `c_FT,2 = −c_FT,1/(H_top − H_BL)` tapers the shear linearly to zero at the layer
top — the checkbox on the page.

The point of the static-energy framing is AE17's scaling: `CAPE ~ (M_BL − D_FT)·ln(T_LFC/T_LNB)`
and `CIN ~ (D_BL − D_FT)·ln(T_p,sfc/T_LFC)`. That is why `ΔD` controls CIN almost by itself,
and why `RH_sfc` — which moves `M_BL` but not `D_BL` — moves CAPE without much touching the cap.

### The 14 parameters

| | parameter | units | what it does |
|---|---|---|---|
| thermo | `P_sfc` | hPa | surface pressure |
| | `T_sfc` | K | surface temperature |
| | `RH_sfc` | – | surface RH; sets the well-mixed BL mixing ratio |
| | `H_BL` | m | boundary layer depth |
| | `ΔD` | J/kg | dry static energy jump = capping inversion; ΔT = ΔD/cp |
| | `Γ_FT` | K/km | free-tropospheric lapse rate |
| | `RH_FT,0` | – | free-tropospheric RH, constant with height |
| | `T_tpp` | K | tropopause temperature; sets `H_tpp` |
| kinematic | `u_sfc`, `v_sfc` | m/s | surface wind vector |
| | `c_BL` | 1/s | meridional shear in the BL |
| | `c_FT,1` | 1/s | zonal shear at the base of the upper layer |
| | `c_FT,2` | 1/(m s) | rate of change of that shear with height |
| | `H_top` | m | top of the upper shear layer |

Everything else on the page — CAPE, CIN, LCL, LFC, EL, PW, bulk shear, SRH — is a diagnostic
read off the profile, **not** an input.

---

## Files

| file | what it is |
|---|---|
| `sounding_ideal.html` | the explorer: UI, five panels, CM1 export |
| `scssounding.js` | standalone JS port of the model — reusable on its own |
| `../skewt.js` | shared skew-T renderer, ported from the PI page |

`scssounding.js` has no dependencies and works in the browser or under node:

```js
const SCS = require('./scssounding.js');
const s = SCS.buildSounding({ Tsfc: 302, RHsfc: 0.8, dD: 2500 });
console.log(s.diag.SBCAPE, s.diag.shear06);
process.stdout.write(SCS.toCM1(s, { dzOut: 100 }));
```

`buildSounding(params)` returns the full profile (`z, p, T, Td, r, RH, Tv, theta, D, M, Mstar,
u, v`), the lifted parcel, Bunkers storm motion, and a `diag` object with every index on the
page. `toCM1(snd, {dzOut})` writes the CM1 base-state file.

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

`test_scs.js` lives in this folder and runs 113 checks under node
(`npm i jsdom canvas && node test_scs.js .`). Against the paper:

**Fig. 4 example** (`Psfc` 1000 hPa, `Tsfc` 300 K, `RH_sfc` 0.7, `H_BL` 700 m, `ΔD` 3000 J/kg,
`Γ_FT` 7.0 K/km, `RH_FT,0` 0.7, `T_tpp` 220 K). §2e reports the equivalent Weisman–Klemp
parameters for exactly this sounding, which is a clean external check:

| quantity | paper | this code |
|---|---|---|
| `θ_sfc` | 300 K | 300.00 K |
| `r_sfc` | 15.8 g/kg | 15.78 g/kg |
| `z_tpp` | 11.6 km | 11.58 km |
| `θ_tpp` | 340.6 K | 340.3 K |

**THEO, the §3c fit to 3 May 1999** (`ΔD` 2095, `H_BL` 420 m, `RH_FT,0` 0.54, `Γ_FT` 7.34,
`T_tpp` 211.25 K): 0–3 km bulk shear 21.8 m/s vs the published 21 m/s; SBCAPE 4442 J/kg vs the
published 4490. The paper does not tabulate `P_sfc`/`T_sfc`/`RH_sfc` for this case, so the
preset uses 959 hPa / 301 K / 0.69 — physically plausible for southwestern Oklahoma that
afternoon, and chosen to land on the published SBCAPE.

The rest of the suite covers structure (BL well mixed in `r`, constant `D` and `M`, the `ΔD`
jump, `Γ_FT` recovered to 0.002 K/km, isothermal dry stratosphere, FT RH constant, hydrostatic
to 1e-4 Pa/m, column saturation fraction recovering `RH_FT,0`, the 99% RH cap), the closed-form
kinematic profile including the taper limit case, monotonic parameter sensitivities, all seven
presets, all 28 slider extremes, the CM1 file format, and the page itself driven through
jsdom + node-canvas (sliders, presets, taper toggle, reset, warnings, download, and a
non-blank check on all five canvases).

### Two things worth knowing

**θ is not exactly constant in the boundary layer.** Constant `D` gives `dT/dz = −g/cp`
exactly, and `dlnθ/dz = (g/cp)(1/Tv − 1/T)`, which is slightly negative in a moist layer. The
drift is about −0.065 K over a 700 m BL. This is the paper's own §2b point (Eq. 18) — static
energy and potential temperature are dynamically equivalent but not identical — not a bug, and
far too small to matter to CM1.

**CAPE here will not match your favourite sounding package.** Parcel ascent is pseudoadiabatic
(condensate removed), buoyancy from virtual temperature, on the model's own vertical grid,
with Bolton (1980) saturation vapour pressure and CM1's constants. Reversible ascent, ice, or a
different `es` formula each shift CAPE by order 100–300 J/kg.

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

## Toward a Python package

`scssounding.js` is deliberately structured as a reference implementation rather than page
code: pure functions, SI units throughout, the algorithm steps commented against the paper's
numbered steps in §2d. A Python package would mirror it closely —
`thermo_profile()`, `kinematic_profile()`, `lift_parcel()`, `build_sounding()`, `to_cm1()` —
the same shape as `tcwindprofile` for the TC side.

The existing reference implementations to reconcile against:

- **MATLAB** — [PURR](https://purr.purdue.edu/publications/4122), doi:10.4231/NJVV-B778
- **Python** — [Zenodo 15358857](https://zenodo.org/records/15358857) (Qin Jiang), which also
  implements a relaxed "Method 2": an LFC-control layer, finite-depth inversion, non-constant
  BL MSE, explicit tropopause control. Those are not in this page; the page is Method 1 only.

---

## References

1. Chavas, D. R., and D. T. Dawson II, 2021: An idealized physical model for the severe
   convective storm environmental sounding. *J. Atmos. Sci.*, **78**, 653–670,
   [doi:10.1175/JAS-D-20-0120.1](https://doi.org/10.1175/JAS-D-20-0120.1).
2. Agard, V., and K. Emanuel, 2017: Clausius–Clapeyron scaling of peak CAPE in continental
   convective storm environments. *J. Atmos. Sci.*, **74**, 3043–3054.
3. Jiang, Q., D. T. Dawson II, and D. R. Chavas, 2025: Favorability of tornado-like vortex
   formation and duration as a function of surface drag in idealized simulations.
   *Mon. Wea. Rev.*
4. Bunkers, M. J., et al., 2000: Predicting supercell motion using a new hodograph technique.
   *Wea. Forecasting*, **15**, 61–79.
5. Bolton, D., 1980: The computation of equivalent potential temperature.
   *Mon. Wea. Rev.*, **108**, 1046–1053.

## Regenerate / edit

Hand-written, no build. Edit `sounding_ideal.html` directly. If you change the model, re-run
`test_scs.js` before deploying.

### Additional references for the ascent modes

- Emanuel, K. A., 1994: *Atmospheric Convection*. Oxford University Press, §4.7.
- Peters, J. M., J. P. Mulholland and D. R. Chavas, 2022: Generalized lapse rate formulas for use in
  entraining CAPE calculations. *J. Atmos. Sci.*, **79**, 815–836,
  [doi:10.1175/JAS-D-21-0118.1](https://doi.org/10.1175/JAS-D-21-0118.1).
