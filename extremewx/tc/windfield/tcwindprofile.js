/* ============================================================================
 * tcwindprofile.js  —  JavaScript port of the Python package `tcwindprofile`
 *                      https://pypi.org/project/tcwindprofile/  (v2.1.2)
 *
 * A fast, robust, physics-based model for the complete radial profile of
 * tropical cyclone near-surface wind and sea-level pressure.
 *
 * Original Python package: Dan Chavas (2025), MIT License.
 *   DOI: 10.5281/zenodo.15442673
 *
 * The pipeline, and the papers each step comes from:
 *   1. Rmax  from (Vmax, R34kt, lat) ......... Chavas & Knaff  2022, WAF
 *   2. V(r)  from (Vmax, Rmax, R34kt, lat) ... Tao et al.      2025, GRL
 *      (analytic approximation to Chavas, Lin & Emanuel 2015 JAS)
 *   3. Pmin  from (Vmax, R34kt, lat, Vtrans, Penv)
 *                                    ......... Chavas, Knaff & Klotzbach 2025, WAF
 *   4. P(r)  from V(r) + Pmin ................ gradient wind balance, CKK25
 *
 * This port is numerically faithful to the Python source: same coefficients,
 * same constants, same branch structure. It is written to be readable next to
 * the Python so you can check it line by line.
 * ========================================================================== */

const TCWind = (function () {
  'use strict';

  /* ---------------------------------------------------------------- units */
  const MS_PER_KT   = 0.5144444;   // 1 kt -> m/s
  const KM_PER_NMI  = 1.852;       // 1 nautical mile -> km
  const V34KT_MS    = 34 * MS_PER_KT;   // 17.4911 m/s  (tropical-storm force)

  // Two slightly different values of Earth's rotation rate appear in the
  // Python package (7.292e-5 in the CK22/CKK25 modules, 7.2921e-5 in the wind
  // profile module). Kept distinct here so results match the Python exactly.
  const OMEGA_CK  = 7.292e-5;      // used by CK22 (Rmax) and CKK25 (Pmin)
  const OMEGA_WP  = 7.2921e-5;     // used by the Tao+ 2025 wind profile

  const d2r = (d) => (d * Math.PI) / 180;
  const coriolis = (lat, omega) => Math.abs(2 * omega * Math.sin(d2r(Math.abs(lat))));

  /* ======================================================================
   * 1) Rmax from outer size  —  Chavas & Knaff (2022, WAF)
   *    https://doi.org/10.1175/WAF-D-21-0103.1
   *
   *    The idea: angular momentum M = r*V + 0.5*f*r^2 is a more natural
   *    coordinate than wind speed. The ratio Mmax/M34kt turns out to be a
   *    tight, near-universal function of just two predictors, so we predict
   *    that ratio and then invert M(r) to get Rmax.
   * ==================================================================== */
  function predictRmaxFromR34kt(VmaxNHC_ms, R34ktmean_km, lat, applyBiasAdj) {
    const R34_m = R34ktmean_km * 1000;
    const fcor  = coriolis(lat, OMEGA_CK);

    // Eq. 2: angular momentum at the 34-kt radius
    const M34kt = R34_m * V34KT_MS + 0.5 * fcor * R34_m * R34_m;

    // intermediate predictor: half the "Coriolis wind" at R34kt
    const halffcorR34kt = 0.5 * fcor * R34_m;

    // Eq. 7 / Table 2: Mmax/M34kt fit to Extended Best Track 2004-2020
    const b = 0.699, betaV = -0.00618, betaVfR = -0.00210;
    const dV = VmaxNHC_ms - V34KT_MS;
    const MmaxM34kt = b * Math.exp(betaV * dV + betaVfR * dV * halffcorR34kt);

    // Eq. 3 then Eq. 4: invert Mmax = Rmax*Vmax + 0.5*f*Rmax^2 for Rmax
    const Mmax = MmaxM34kt * M34kt;
    const Rmax_m =
      (VmaxNHC_ms / fcor) *
      (Math.sqrt(1 + (2 * fcor * Mmax) / (VmaxNHC_ms * VmaxNHC_ms)) - 1);

    let Rmax_km = Rmax_m / 1000;

    // Eq. 8: optional bias adjustment for large Rmax (>60 km), where the raw
    // model is systematically low. Below 60 km the correction is smaller than
    // the uncertainty and can even go negative, so it is never applied there.
    //
    // NOTE: tcwindprofile v2.1.2 COMPUTES this correction but returns the
    // uncorrected value (it is assigned to a separate local variable). To stay
    // consistent with `pip install tcwindprofile`, the default here is OFF.
    if (applyBiasAdj && Rmax_km > 60) Rmax_km = (1 / 0.76) * (Rmax_km - 9.02);

    return Rmax_km;
  }

  /* ======================================================================
   * 2) Complete wind profile  —  Tao et al. (2025, GRL)
   *
   *    Four analytic pieces stitched together, each with a physical basis:
   *      (a) r < Rmax          eye        : solid-body-like, V linear in r
   *      (b) Rmax -> Raa       inner core : "linear-M", M linear in r (Tao+ 2023)
   *      (c) Raa  -> Rba       middle     : modified Rankine, V ~ 1/r
   *      (d) Rba  -> R0        outer      : Ekman suction balance (Emanuel 2004)
   *
   *    Raa, Rba and R0 are not free parameters — they fall out of requiring
   *    the pieces to join smoothly, given (Vmax, Rmax, R34kt, lat).
   * ==================================================================== */
  function generateWindProfile(Vmaxmean_ms, Rmax_km, R34ktmean_km, lat, nPoints) {
    const fcor   = coriolis(lat, OMEGA_WP);
    const Rmax_m = Rmax_km * 1000;
    const R34_m  = R34ktmean_km * 1000;

    // angular momentum at the two anchor points
    const Mmax  = Vmaxmean_ms * Rmax_m + 0.5 * fcor * Rmax_m * Rmax_m;
    const M34kt = V34KT_MS * R34_m + 0.5 * fcor * R34_m * R34_m;

    // slope of M(r) between Rmax and R34kt, nondimensionalised ("linear-M")
    const SL34kt = (M34kt / Mmax - 1) / (R34_m / Rmax_m - 1);

    // Aa sets the amplitude of the 1/r (modified-Rankine) middle branch
    const Aa =
      (0.5 / fcor) * Math.pow((SL34kt * Mmax) / Rmax_m, 2) + Mmax * (1 - SL34kt);

    // Raa: where the linear-M branch hands off to the 1/r branch
    const Raa_m = (SL34kt * Mmax) / fcor / Rmax_m;

    const sqrtTerm = Math.sqrt((2 * Aa) / fcor);
    const chi = 1.5;   // outer-profile slope parameter (= 2*Cd/w_cool), fixed
    const inner = Math.sqrt(chi * Aa * sqrtTerm + Aa / (2 * fcor));

    const Rba_m = 0.5 * inner - 0.25 * sqrtTerm;   // 1/r  ->  Ekman branch
    const R0_m  = 0.5 * inner + 0.75 * sqrtTerm;   // outer edge, V = 0

    // ---- sample the composite profile ----
    const N  = nPoints || 1200;
    const dr = R0_m / (N - 1);
    const r  = new Float64Array(N);
    const v  = new Float64Array(N);
    const seg = new Uint8Array(N);   // 0 eye, 1 linear-M, 2 mod-Rankine, 3 E04

    for (let i = 0; i < N; i++) {
      const rr = i * dr;
      r[i] = rr;
      if (rr < Rmax_m) {
        v[i] = rr === 0 ? 0 : Vmaxmean_ms * (rr / Rmax_m);   // (a) eye
        seg[i] = 0;
      } else if (rr <= Raa_m) {
        v[i] =                                                // (b) linear-M
          ((SL34kt * (rr / Rmax_m - 1) + 1) * Mmax - 0.5 * fcor * rr * rr) / rr;
        seg[i] = 1;
      } else if (rr <= Rba_m) {
        v[i] = Aa / rr;                                       // (c) mod-Rankine
        seg[i] = 2;
      } else {
        v[i] =                                                // (d) Ekman/E04
          (Aa - 0.5 * fcor * Rba_m * Rba_m) / rr +
          fcor * Rba_m -
          0.5 * fcor * rr;
        seg[i] = 3;
      }
      if (!isFinite(v[i]) || v[i] < 0) v[i] = 0;
    }

    return {
      r_km: Float64Array.from(r, (x) => x / 1000),
      v_ms: v,
      seg,
      R0_km:  R0_m  / 1000,
      Raa_km: Raa_m / 1000,
      Rba_km: Rba_m / 1000,
      SL34kt,
      Mmax,
      M34kt,
    };
  }

  /* Wind speed at an arbitrary radius (km) — same four branches, closed form.
     Used by the 2-D footprint so we don't have to interpolate a table. */
  function makeWindFunction(p, Vmaxmean_ms, Rmax_km, lat) {
    const fcor   = coriolis(lat, OMEGA_WP);
    const Rmax_m = Rmax_km * 1000;
    const { SL34kt, Mmax } = p;
    const Raa_m = p.Raa_km * 1000,
          Rba_m = p.Rba_km * 1000,
          R0_m  = p.R0_km * 1000;
    const Aa =
      (0.5 / fcor) * Math.pow((SL34kt * Mmax) / Rmax_m, 2) + Mmax * (1 - SL34kt);

    return function windAt(r_km) {
      const rr = r_km * 1000;
      if (rr <= 0) return 0;
      if (rr >= R0_m) return 0;
      let vv;
      if (rr < Rmax_m) vv = Vmaxmean_ms * (rr / Rmax_m);
      else if (rr <= Raa_m)
        vv = ((SL34kt * (rr / Rmax_m - 1) + 1) * Mmax - 0.5 * fcor * rr * rr) / rr;
      else if (rr <= Rba_m) vv = Aa / rr;
      else
        vv = (Aa - 0.5 * fcor * Rba_m * Rba_m) / rr + fcor * Rba_m - 0.5 * fcor * rr;
      return isFinite(vv) && vv > 0 ? vv : 0;
    };
  }

  /* ======================================================================
   * 3) Pmin from intensity + size  —  Chavas, Knaff & Klotzbach (2025, WAF)
   *    https://doi.org/10.1175/WAF-D-24-0031.1
   *
   *    A four-term fit for the pressure deficit dP = Pmin - Penv (negative).
   *    Bigger storms and stronger storms both dig deeper — but size matters
   *    through the Coriolis term 0.5*f*R34kt, not through R34kt alone.
   * ==================================================================== */
  function predictPminFromR34kt(VmaxNHC_ms, R34ktmean_km, lat, Vtrans_ms, Penv_mb) {
    const R34_m = R34ktmean_km * 1000;
    // Eq. 2: azimuthal-mean Vmax from the NHC point-max (Lin & Chavas 2012)
    const Vmaxmean_ms = VmaxNHC_ms - 0.55 * Vtrans_ms;
    const fcor = coriolis(lat, OMEGA_CK);
    const halffcorR34kt = 0.5 * fcor * R34_m;

    // Eq. 5
    const c = [-6.6, -0.0127, -5.506, 109.013];
    const dP_mb =
      c[0] +
      c[1] * Vmaxmean_ms * Vmaxmean_ms +
      c[2] * halffcorR34kt +
      (c[3] * halffcorR34kt) / Vmaxmean_ms;

    return { Pmin_mb: Penv_mb + dP_mb, dP_mb };   // Eq. 3
  }

  /* ======================================================================
   * 4) Pressure profile from the wind profile  —  CKK25
   *
   *    Integrate gradient wind balance inward from R0:
   *        dP/dr = rho * ( f*V + V^2/r )
   *    Density is held constant; the resulting deficit profile is then
   *    rescaled by a single constant so the centre matches the predicted
   *    Pmin. (That rescaling is why the exact value of rho doesn't matter.)
   * ==================================================================== */
  function pressureProfileFromWind(r_km, v_ms, Penv_mb, Pmin_mb, lat, rho) {
    rho = rho || 1.15;                        // kg m^-3
    const fcor = coriolis(lat, OMEGA_CK);
    const N = r_km.length;
    const dPdr = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      const rm = r_km[i] * 1000, vv = v_ms[i];
      dPdr[i] = rho * (fcor * vv + (rm > 0 ? (vv * vv) / rm : 0));
    }

    // cumulative integral inward from the outer edge -> pressure deficit (>0)
    const dP = new Float64Array(N);
    let acc = 0;
    for (let i = N - 1; i >= 0; i--) {
      if (i < N - 1) acc += dPdr[i] * (r_km[i + 1] - r_km[i]) * 1000;
      dP[i] = acc;
    }
    // linear extrapolation to r = 0 (matches the Python)
    if (N >= 3) dP[0] = dP[1] + (dP[1] - dP[2]);

    // rescale so the centre deficit equals the predicted one
    const target = Penv_mb - Pmin_mb;         // mb, positive
    const have = dP[0] / 100;                 // Pa -> mb
    const scale = have > 0 ? target / have : 0;

    const p_mb = new Float64Array(N);
    for (let i = 0; i < N; i++) p_mb[i] = Penv_mb - (dP[i] / 100) * scale;
    return p_mb;
  }

  /* ======================================================================
   * Full pipeline  —  equivalent to run_full_wind_model() in the package
   *
   * Inputs are in the units forecasters actually use:
   *   VmaxNHC_kt          : NHC/JTWC point-max 1-min sustained wind [kt]
   *   Vtrans_kt           : storm translation speed [kt]
   *   R34kt_quadmean_nmi  : mean of the four quadrant R34kt values [n mi]
   *   lat                 : storm centre latitude [deg]
   *   Penv_mb             : environmental pressure [mb]
   *   Rmax_km (optional)  : override the CK22 Rmax estimate
   * ==================================================================== */
  function runFullWindModel(opts) {
    const VmaxNHC_ms = opts.VmaxNHC_kt * MS_PER_KT;
    const Vtrans_ms  = opts.Vtrans_kt * MS_PER_KT;

    // azimuthal-mean Vmax: strip out the part of the point-max that is just
    // the storm's own motion being added on the right-hand side
    const Vmaxmean_ms = VmaxNHC_ms - 0.55 * Vtrans_ms;

    // quadrant values are MAXIMA within each quadrant, so the quadrant mean
    // overestimates the true azimuthal-mean radius; reduce by 0.85 (DeMaria+ 2009)
    const R34ktmean_km = 0.85 * opts.R34kt_quadmean_nmi * KM_PER_NMI;

    if (Vmaxmean_ms < V34KT_MS)
      return { error: 'Azimuthal-mean Vmax must be at least 34 kt (17.5 m/s).' };

    const RmaxAuto_km = predictRmaxFromR34kt(
      VmaxNHC_ms, R34ktmean_km, opts.lat, opts.applyRmaxBiasAdj
    );
    const Rmax_km = opts.Rmax_km != null ? opts.Rmax_km : RmaxAuto_km;

    const prof = generateWindProfile(
      Vmaxmean_ms, Rmax_km, R34ktmean_km, opts.lat, opts.nPoints
    );

    const { Pmin_mb, dP_mb } = predictPminFromR34kt(
      VmaxNHC_ms, R34ktmean_km, opts.lat, Vtrans_ms, opts.Penv_mb
    );

    const p_mb = pressureProfileFromWind(
      prof.r_km, prof.v_ms, opts.Penv_mb, Pmin_mb, opts.lat
    );

    return {
      r_km: prof.r_km,
      v_ms: prof.v_ms,
      p_mb,
      seg: prof.seg,
      windAt: makeWindFunction(prof, Vmaxmean_ms, Rmax_km, opts.lat),
      VmaxNHC_ms,
      Vmaxmean_ms,
      Vtrans_ms,
      Rmax_km,
      RmaxAuto_km,
      RmaxIsManual: opts.Rmax_km != null,
      R34ktmean_km,
      V34kt_ms: V34KT_MS,
      R0_km: prof.R0_km,
      Raa_km: prof.Raa_km,
      Rba_km: prof.Rba_km,
      lat: opts.lat,
      Penv_mb: opts.Penv_mb,
      Pmin_mb,
      dP_mb,
    };
  }

  return {
    MS_PER_KT, KM_PER_NMI, V34KT_MS,
    coriolis,
    predictRmaxFromR34kt,
    generateWindProfile,
    predictPminFromR34kt,
    pressureProfileFromWind,
    runFullWindModel,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TCWind;
