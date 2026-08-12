/* ============================================================================
 * scssounding.js — the Chavas & Dawson (2021, JAS) severe convective storm
 * environmental sounding model, as a standalone JavaScript module.
 *
 *   Chavas, D. R., and D. T. Dawson II, 2021: An Idealized Physical Model for
 *   the Severe Convective Storm Environmental Sounding. J. Atmos. Sci., 78,
 *   653-670. https://doi.org/10.1175/JAS-D-20-0120.1
 *
 * This is a direct port of the algorithm in section 2d of the paper — the
 * eight-parameter thermodynamic profile and the six-parameter kinematic
 * profile — plus the standard parcel-theory diagnostics (CAPE, CIN, LCL, LFC,
 * EL), precipitable water, bulk shear, Bunkers storm motion and SRH, and a
 * CM1 `input_sounding` writer.
 *
 * No dependencies. Works in the browser or under node:
 *     const SCS = require('./scssounding.js');
 *     const s = SCS.buildSounding(SCS.DEFAULTS);
 *
 * Reference implementations:
 *   MATLAB  — https://purr.purdue.edu/publications/4122  (doi:10.4231/NJVV-B778)
 *   Python  — https://zenodo.org/records/15358857        (Qin Jiang)
 *
 * (c) 2026 Dan Chavas. Free to use with attribution to the paper above.
 * ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCSSounding = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* --------------------------------------------------------------------------
 * 1. Physical constants
 * Chosen to match CM1, since the whole point of the sounding is to be fed to
 * CM1. Changing these changes CAPE at the tens-of-J/kg level.
 * ------------------------------------------------------------------------ */
const C = {
  g   : 9.81,        // gravity                          [m/s^2]
  cp  : 1005.7,      // specific heat, dry air, const P  [J/kg/K]
  Rd  : 287.04,      // gas constant, dry air            [J/kg/K]
  Rv  : 461.5,       // gas constant, water vapour       [J/kg/K]
  Lv  : 2501000.0,   // latent heat of vaporization      [J/kg]
  p00 : 100000.0     // reference pressure for theta     [Pa]
};
C.eps = C.Rd / C.Rv;             // 0.6220
// Dry adiabatic lapse rate, in K/m (= 9.754 K/km). Kept in SI so it composes
// directly with beta = cp*(Gd - Gamma_FT); callers passing Gamma in K/km must
// divide by 1000 first.
C.Gd  = C.g / C.cp;              // [K/m]

/* --------------------------------------------------------------------------
 * 2. Thermodynamic helpers
 * ------------------------------------------------------------------------ */

/** Saturation vapour pressure over liquid water, Bolton (1980) Eq. 10. T[K] -> [Pa] */
function esat(T) {
  const Tc = T - 273.15;
  return 611.2 * Math.exp(17.67 * Tc / (Tc + 243.5));
}

/** Mixing ratio from vapour pressure and pressure. e,p [Pa] -> r [kg/kg] */
function rFromE(e, p) {
  const d = p - e;
  return d > 1 ? C.eps * e / d : C.eps * e / 1;   // guard near p -> e
}

/** Mixing ratio at a given relative humidity. T[K], p[Pa], RH[0-1] -> r[kg/kg] */
function rFromRH(RH, T, p) { return rFromE(RH * esat(T), p); }

/** Relative humidity from mixing ratio. r[kg/kg], T[K], p[Pa] -> RH[0-1] */
function rhFromR(r, T, p) {
  const e = r * p / (C.eps + r);
  return e / esat(T);
}

/** Virtual temperature. T[K], r[kg/kg] -> Tv[K] */
function Tvirt(T, r) { return T * (1 + r / C.eps) / (1 + r); }

/** Potential temperature. T[K], p[Pa] -> theta[K] */
function theta(T, p) { return T * Math.pow(C.p00 / p, C.Rd / C.cp); }

/** Dew point from mixing ratio, inverting Bolton. r[kg/kg], p[Pa] -> Td[K] */
function dewpoint(r, p) {
  if (r <= 0) return NaN;
  const e = Math.max(r * p / (C.eps + r), 1e-6);
  const L = Math.log(e / 611.2);
  return 273.15 + 243.5 * L / (17.67 - L);
}

/** Dry static energy   D = cp*T + g*z            [J/kg]   (paper Eq. 2) */
function dryStaticEnergy(T, z) { return C.cp * T + C.g * z; }

/** Moist static energy M = cp*T + Lv*r + g*z     [J/kg]   (paper Eq. 1) */
function moistStaticEnergy(T, r, z) { return C.cp * T + C.Lv * r + C.g * z; }

/* --------------------------------------------------------------------------
 * 3. Default parameters
 * These are the paper's Fig. 4 example sounding (section 2e).
 * ------------------------------------------------------------------------ */
const DEFAULTS = {
  // --- thermodynamic: the eight external parameters of section 2d(1) -------
  Psfc      : 1000,    // surface pressure                            [hPa]
  Tsfc      : 300,     // surface temperature                         [K]
  RHsfc     : 0.70,    // surface relative humidity                   [0-1]
  HBL       : 700,     // boundary layer depth                        [m]
  dD        : 3000,    // dry static energy jump across the cap       [J/kg]
  GammaFT   : 7.0,     // free-tropospheric lapse rate                [K/km]
  RHFT0     : 0.70,    // free-tropospheric relative humidity         [0-1]
  Ttpp      : 220,     // tropopause temperature                      [K]

  // --- kinematic: the six external parameters of section 2d(2) ------------
  usfc      : -2.64,   // surface zonal wind                          [m/s]
  vsfc      : 5.83,    // surface meridional wind                     [m/s]
  cBL       : 0.0293,  // meridional shear in the BL                  [1/s]
  cFT1      : 0.0139,  // zonal shear at the base of the upper layer  [1/s]
  cFT2      : -5.367e-6, // rate of change of zonal shear with height [1/(m s)]
  Hstop     : 3000,    // top of the upper shear layer                [m]

  // --- numerics -----------------------------------------------------------
  ascent    : 'pseudo',// parcel ascent: 'pseudo' | 'reversible' | 'dry'
  ice       : false,   // include the latent heat of fusion (mixed phase)
  ztop      : 20000,   // model top                                   [m]
  dz        : 20       // vertical grid spacing                       [m]
};

/**
 * Named presets. THEO is the paper's fit to the 3 May 1999 proximity sounding
 * (section 3c); its free-tropospheric parameters are the published values, and
 * its surface state is set to the value that reproduces the published
 * SBCAPE of ~4490 J/kg (the paper does not tabulate Psfc/Tsfc/RHsfc).
 */
const PRESETS = {
  'CD21 Fig. 4 (paper example)': {},
  'THEO — CD21 fit to 3 May 1999': {
    Psfc: 959, Tsfc: 301, RHsfc: 0.69,
    HBL: 420, dD: 2095, GammaFT: 7.34, RHFT0: 0.54, Ttpp: 211.25,
    usfc: -2.64, vsfc: 5.83, cBL: 0.0293, cFT1: 0.0139, cFT2: -5.367e-6,
    Hstop: 3000
  },
  'High CAPE, high shear': {
    Psfc: 1000, Tsfc: 303, RHsfc: 0.80, HBL: 1000, dD: 2500,
    GammaFT: 7.5, RHFT0: 0.50, Ttpp: 215,
    usfc: -6, vsfc: 8, cBL: 0.010, cFT1: 0.0085, cFT2: 0, Hstop: 6000
  },
  'Capped / high CIN': {
    Psfc: 1000, Tsfc: 300, RHsfc: 0.65, HBL: 700, dD: 6000,
    GammaFT: 7.5, RHFT0: 0.35, Ttpp: 220,
    usfc: -4, vsfc: 6, cBL: 0.020, cFT1: 0.0110, cFT2: -1.8e-6, Hstop: 3000
  },
  'Low-level jet / tornadic hodograph': {
    Psfc: 985, Tsfc: 300.5, RHsfc: 0.82, HBL: 500, dD: 2200,
    GammaFT: 7.2, RHFT0: 0.60, Ttpp: 213,
    usfc: -3, vsfc: 12, cBL: 0.030, cFT1: 0.0150, cFT2: -6.0e-6, Hstop: 3000
  },
  'Dry free troposphere (MODTHEO-style)': {
    Psfc: 959, Tsfc: 301, RHsfc: 0.69,
    HBL: 420, dD: 2095, GammaFT: 7.34, RHFT0: 0.20, Ttpp: 211.25,
    usfc: -2.64, vsfc: 5.83, cBL: 0.0293, cFT1: 0.0139, cFT2: -5.367e-6,
    Hstop: 3000
  },
  'Tropical (weak cap, moist)': {
    Psfc: 1010, Tsfc: 301, RHsfc: 0.85, HBL: 600, dD: 500,
    GammaFT: 6.2, RHFT0: 0.75, Ttpp: 195,
    usfc: -5, vsfc: 1, cBL: 0.004, cFT1: 0.0015, cFT2: 0, Hstop: 6000
  }
};

/* --------------------------------------------------------------------------
 * 4. Thermodynamic profile — section 2d(1) of the paper, steps 1-8
 * ------------------------------------------------------------------------ */
function thermoProfile(P) {
  const N    = Math.round(P.ztop / P.dz) + 1;
  const dz   = P.dz;
  const Psfc = P.Psfc * 100;                       // hPa -> Pa

  const z = new Float64Array(N);
  for (let k = 0; k < N; k++) z[k] = k * dz;

  // -- step 1: surface dry and moist static energy -------------------------
  const Dsfc = dryStaticEnergy(P.Tsfc, 0);
  let   rsfc = rFromRH(P.RHsfc, P.Tsfc, Psfc);
  const Msfc = moistStaticEnergy(P.Tsfc, rsfc, 0);

  // -- steps 2, 5, 6: temperature from the two-layer static energy state ---
  // beta_FT = dD_FT/dz sets the FT lapse rate:  Gamma_FT = Gamma_d - beta/cp
  const beta = C.cp * (C.Gd - P.GammaFT / 1000);   // [J/kg/m]
  const DFT0 = Dsfc + P.dD;                        // step 4

  const T = new Float64Array(N);
  const D = new Float64Array(N);
  let   Htpp = NaN, ktpp = N - 1;

  for (let k = 0; k < N; k++) {
    const Dk = (z[k] <= P.HBL) ? Dsfc                       // step 2: BL, D const
                               : DFT0 + beta * (z[k] - P.HBL); // step 5: FT
    const Tk = (Dk - C.g * z[k]) / C.cp;                    // steps 2 & 6
    // -- step 8: dry isothermal "stratosphere" where T would fall below Ttpp
    if (Tk < P.Ttpp) {
      if (isNaN(Htpp)) { Htpp = z[k]; ktpp = k; }
      T[k] = P.Ttpp;
    } else {
      T[k] = Tk;
    }
    D[k] = dryStaticEnergy(T[k], z[k]);
  }
  if (isNaN(Htpp)) { Htpp = z[N - 1]; ktpp = N - 1; }

  // -- steps 3, 7: hydrostatic pressure, and mixing ratio -------------------
  // Mixing ratio is well-mixed (constant r) in the BL, constant-RH in the FT,
  // and zero in the stratosphere. Because r in the FT depends on p, and p
  // depends on r through the virtual temperature, we sweep upward with a
  // predictor-corrector and then repeat the whole sweep (footnote 2).
  const p = new Float64Array(N);
  const r = new Float64Array(N);

  const rAt = function (k, pk) {
    if (k >= ktpp) return 0;                                  // stratosphere
    if (z[k] <= P.HBL) {
      // step 3: well mixed, r = rsfc, capped so RH never exceeds 99%
      return Math.min(rsfc, rFromRH(0.99, T[k], pk));
    }
    return rFromRH(P.RHFT0, T[k], pk);                        // step 7
  };

  for (let sweep = 0; sweep < 3; sweep++) {
    p[0] = Psfc;
    r[0] = rAt(0, p[0]);
    for (let k = 0; k < N - 1; k++) {
      const Tv0 = Tvirt(T[k], r[k]);
      let pGuess = p[k] * Math.exp(-C.g * dz / (C.Rd * Tv0));
      for (let it = 0; it < 3; it++) {                        // corrector
        const r1  = rAt(k + 1, pGuess);
        const Tv1 = Tvirt(T[k + 1], r1);
        const Tvm = 0.5 * (Tv0 + Tv1);
        pGuess = p[k] * Math.exp(-C.g * dz / (C.Rd * Tvm));
      }
      p[k + 1] = pGuess;
      r[k + 1] = rAt(k + 1, p[k + 1]);
    }
    // rsfc itself is fixed by the surface state, so nothing to relax there;
    // the sweeps only matter through the FT moisture -> pressure feedback.
  }

  // -- derived fields ------------------------------------------------------
  const Td = new Float64Array(N), RH = new Float64Array(N),
        M  = new Float64Array(N), Mstar = new Float64Array(N),
        th = new Float64Array(N), Tv = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    Td[k]    = dewpoint(r[k], p[k]);
    RH[k]    = rhFromR(r[k], T[k], p[k]);
    M[k]     = moistStaticEnergy(T[k], r[k], z[k]);
    Mstar[k] = moistStaticEnergy(T[k], rFromRH(1, T[k], p[k]), z[k]);
    th[k]    = theta(T[k], p[k]);
    Tv[k]    = Tvirt(T[k], r[k]);
    D[k]     = dryStaticEnergy(T[k], z[k]);
  }

  return {
    N, z, p, T, Td, r, RH, Tv, theta: th, D, M, Mstar,
    Dsfc, Msfc, rsfc, DFT0, beta, Htpp, ktpp,
    // temperature jump across the capping inversion, dD/cp
    dTcap: P.dD / C.cp
  };
}

/* --------------------------------------------------------------------------
 * 5. Kinematic profile — section 2d(2) of the paper, steps 1-4
 * ------------------------------------------------------------------------ */
function kinematicProfile(P, z) {
  const N = z.length;
  const u = new Float64Array(N), v = new Float64Array(N);
  const uTop = P.usfc + P.cFT1 * (P.Hstop - P.HBL)
                      + 0.5 * P.cFT2 * Math.pow(P.Hstop - P.HBL, 2);
  const vTop = P.vsfc + P.cBL * P.HBL;

  for (let k = 0; k < N; k++) {
    const zk = z[k];
    if (zk <= P.HBL) {                     // step 2: BL, constant southerly shear
      u[k] = P.usfc;
      v[k] = P.vsfc + P.cBL * zk;
    } else if (zk <= P.Hstop) {            // step 3: upper layer, westerly shear
      const dzz = zk - P.HBL;
      u[k] = P.usfc + P.cFT1 * dzz + 0.5 * P.cFT2 * dzz * dzz;
      v[k] = vTop;
    } else {                               // step 4: constant above Hstop
      u[k] = uTop;
      v[k] = vTop;
    }
  }
  return { u, v, uTop, vTop };
}

/* --------------------------------------------------------------------------
 * 6. Parcel theory — CAPE, CIN, LCL, LFC, EL
 * Pseudoadiabatic ascent (condensate rained out), buoyancy from virtual
 * temperature. Not part of the CD21 model itself; these are the standard
 * diagnostics you want to read off it.
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------- moist ascent ----
 * One generalized saturated lapse rate covers both moist ascent modes:
 *
 *   dT/dlnp = (1 + rv/ε)(Rd T + L rv) / (cpd + rt cl + L² rv (1 + rv/ε)/(Rv T²))
 *
 * with rt the TOTAL water: rt = rv for pseudoadiabatic ascent (condensate
 * removed as fast as it forms) and rt = r0, conserved, for reversible ascent
 * (condensate carried along, adding heat capacity and weighing the parcel
 * down). Emanuel (1994) Eq. 4.7.3 converted from height to log-pressure.
 * Identical to the implementation in the sounding plotter on this site, so the
 * two pages give the same CAPE for the same profile and ascent assumption.
 *
 * With ice on, the latent heat and saturation vapour pressure are blended
 * between liquid and ice over 0 to -40 °C (Peters et al. 2022).
 * ------------------------------------------------------------------------ */
const ICE = { Tliq:273.15, Tice:233.15, Lf:3.337e5, cpv:1870, cl:4190 };

/** Ice fraction of the condensate: 0 above 0 °C, 1 below -40 °C. T in K. */
function iceFrac(T, useIce){
  if (!useIce) return 0;
  if (T >= ICE.Tliq) return 0;
  if (T <= ICE.Tice) return 1;
  return (ICE.Tliq - T)/(ICE.Tliq - ICE.Tice);
}
/** Saturation vapour pressure over ice (Magnus form). T K -> Pa */
function esatIce(T){
  const Tc=T-273.15;
  return 611.2*Math.exp(22.46*Tc/(272.62+Tc));
}
/** Saturation vapour pressure blended across the mixed-phase range. T K -> Pa */
function esatMix(T, useIce){
  const w=iceFrac(T,useIce);
  return w===0 ? esat(T) : (1-w)*esat(T) + w*esatIce(T);
}
/** Effective latent heat, temperature dependent, plus fusion where ice exists. */
function Lheat(T, useIce){
  return C.Lv + (ICE.cpv-ICE.cl)*(T-273.15) + iceFrac(T,useIce)*ICE.Lf;
}
/** Saturation mixing ratio using the blended vapour pressure. T K, p Pa -> kg/kg */
function rSat(T, p, useIce){ return rFromE(esatMix(T,useIce), p); }

/**
 * dT/dln(p) for a saturated parcel. T K, p Pa; rt = total water in kg/kg, or
 * null for pseudoadiabatic (rt = rv at every level).
 */
function dTdlnp(T, p, rt, useIce) {
  const rs = rSat(T, p, useIce);
  const L  = Lheat(T, useIce);
  const rtot = (rt === null || rt === undefined) ? rs : Math.max(rt, rs);
  const f = 1 + rs / C.eps;
  return f * (C.Rd * T + L * rs) /
         (C.cp + rtot * ICE.cl + L * L * rs * f / (C.Rv * T * T));
}

/**
 * Density temperature: virtual temperature reduced by condensate loading.
 * rv = vapour, rt = total water, both kg/kg. With rt = rv this is Tvirt.
 */
function Tdens(T, rv, rt) {
  return T * (1 + rv / C.eps) / (1 + Math.max(rt, rv));
}

/**
 * Lift a parcel with state (T0, r0, p0) along the sounding's pressure grid.
 * Returns parcel T, r and buoyancy at every level, plus LCL/LFC/EL/CAPE/CIN.
 */
function liftParcel(snd, T0, r0, p0, kStart, opt) {
  const N = snd.N, z = snd.z, p = snd.p;
  kStart = kStart || 0;
  opt = opt || {};
  const mode = opt.mode || 'pseudo';        // 'pseudo' | 'reversible' | 'dry'
  const ice  = !!opt.ice;
  const rtArg = mode === 'reversible' ? r0 : null;

  const Tp  = new Float64Array(N).fill(NaN);
  const Tvp = new Float64Array(N).fill(NaN);  // density temperature (what CAPE uses)
  const rp  = new Float64Array(N).fill(NaN);  // vapour
  const rl  = new Float64Array(N).fill(NaN);  // condensate
  const B   = new Float64Array(N).fill(NaN);

  // --- LCL, Bolton (1980) Eq. 22 -----------------------------------------
  const e0    = Math.max(r0 * p0 / (C.eps + r0), 1e-6);
  const Tlcl  = 2840 / (3.5 * Math.log(T0) - Math.log(e0 / 100) - 4.805) + 55;
  const pLCL  = p0 * Math.pow(Tlcl / T0, C.cp / C.Rd);

  let Tk = T0, saturated = false;
  for (let k = kStart; k < N; k++) {
    const pk = p[k];
    if (k === kStart) {
      Tk = T0;
    } else if (mode === 'dry' || (!saturated && pk >= pLCL)) {
      Tk = T0 * Math.pow(pk / p0, C.Rd / C.cp);            // dry adiabat
    } else {
      if (!saturated) {                                     // cross the LCL
        Tk = T0 * Math.pow(pLCL / p0, C.Rd / C.cp);
        const nsub = 8, dl = (Math.log(pk) - Math.log(pLCL)) / nsub;
        for (let i = 0; i < nsub; i++) {
          const pa = Math.exp(Math.log(pLCL) + i * dl);
          const pb = Math.exp(Math.log(pLCL) + (i + 1) * dl);
          const k1 = dTdlnp(Tk, pa, rtArg, ice);
          const k2 = dTdlnp(Tk + k1 * dl, pb, rtArg, ice);
          Tk += 0.5 * (k1 + k2) * dl;
        }
        saturated = true;
      } else {
        const dl = Math.log(pk) - Math.log(p[k - 1]);       // RK2, one step
        const k1 = dTdlnp(Tk, p[k - 1], rtArg, ice);
        const k2 = dTdlnp(Tk + k1 * dl, pk, rtArg, ice);
        Tk += 0.5 * (k1 + k2) * dl;
      }
    }
    Tp[k] = Tk;

    // partition the parcel's water
    let rv, rt;
    if (mode === 'dry' || !saturated) { rv = r0; rt = r0; }
    else {
      rv = rSat(Tk, pk, ice);
      if (mode === 'reversible') { rt = r0; rv = Math.min(rv, r0); }
      else                       { rt = rv; }     // pseudo: condensate removed
    }
    rp[k]  = rv;
    rl[k]  = Math.max(0, rt - rv);
    Tvp[k] = Tdens(Tk, rv, rt);
    B[k]   = C.g * (Tvp[k] - snd.Tv[k]) / snd.Tv[k];
  }

  // --- z of the LCL by interpolation in pressure --------------------------
  let zLCL = NaN;
  for (let k = kStart; k < N - 1; k++) {
    if (p[k] >= pLCL && p[k + 1] < pLCL) {
      const f = (p[k] - pLCL) / (p[k] - p[k + 1]);
      zLCL = z[k] + f * (z[k + 1] - z[k]);
      break;
    }
  }

  // --- LFC: lowest level at or above the LCL with positive buoyancy -------
  let kLFC = -1;
  for (let k = kStart; k < N; k++) {
    if (z[k] >= (isNaN(zLCL) ? 0 : zLCL) && B[k] > 0) { kLFC = k; break; }
  }

  let CAPE = 0, CIN = 0, zLFC = NaN, zEL = NaN, kEL = -1;
  if (kLFC > 0) {
    // interpolate the LFC height to the B = 0 crossing
    const k0 = kLFC - 1;
    zLFC = (B[k0] < 0 && !isNaN(B[k0]))
         ? z[k0] + (z[kLFC] - z[k0]) * (-B[k0]) / (B[kLFC] - B[k0])
         : z[kLFC];

    // EL: highest level above the LFC where buoyancy last goes + -> -
    for (let k = kLFC; k < N - 1; k++) {
      if (B[k] > 0 && B[k + 1] <= 0) {
        zEL = z[k] + (z[k + 1] - z[k]) * B[k] / (B[k] - B[k + 1]);
        kEL = k;
      }
    }
    if (kEL < 0) { kEL = N - 1; zEL = z[N - 1]; }

    // CAPE: positive area between LFC and EL
    for (let k = kLFC; k < kEL; k++) {
      const b0 = Math.max(B[k], 0), b1 = Math.max(B[k + 1], 0);
      CAPE += 0.5 * (b0 + b1) * (z[k + 1] - z[k]);
    }
    // CIN: negative area from the parcel level to the LFC
    for (let k = kStart; k < kLFC; k++) {
      const b0 = Math.min(B[k], 0), b1 = Math.min(B[k + 1], 0);
      CIN += 0.5 * (b0 + b1) * (z[k + 1] - z[k]);
    }
  }

  return { Tp, Tvp, rp, rl, B, zLCL, pLCL, zLFC, zEL, kLFC, kEL, CAPE, CIN, mode, ice };
}

/** Surface-based parcel. */
function surfaceParcel(snd, opt) {
  return liftParcel(snd, snd.T[0], snd.r[0], snd.p[0], 0, opt);
}

/** Mixed-layer parcel: mass-weighted mean theta and r over the lowest 100 hPa. */
function mixedLayerParcel(snd, depth_hPa, opt) {
  const dP = (depth_hPa || 100) * 100;
  const pTop = snd.p[0] - dP;
  let sTh = 0, sR = 0, sW = 0;
  for (let k = 0; k < snd.N - 1; k++) {
    if (snd.p[k] < pTop) break;
    const w = snd.p[k] - snd.p[k + 1];
    sTh += snd.theta[k] * w; sR += snd.r[k] * w; sW += w;
  }
  if (sW <= 0) return surfaceParcel(snd, opt);
  const thM = sTh / sW, rM = sR / sW;
  const T0 = thM * Math.pow(snd.p[0] / C.p00, C.Rd / C.cp);
  return liftParcel(snd, T0, rM, snd.p[0], 0, opt);
}

/* --------------------------------------------------------------------------
 * 7. Bulk kinematic diagnostics
 * ------------------------------------------------------------------------ */

function interpAtZ(z, f, target) {
  const N = z.length;
  if (target <= z[0]) return f[0];
  if (target >= z[N - 1]) return f[N - 1];
  const k = Math.min(N - 2, Math.floor(target / (z[1] - z[0])));
  const t = (target - z[k]) / (z[k + 1] - z[k]);
  return f[k] + t * (f[k + 1] - f[k]);
}

/** Bulk vector shear magnitude over 0 -> h. */
function bulkShear(z, u, v, h) {
  const du = interpAtZ(z, u, h) - u[0];
  const dv = interpAtZ(z, v, h) - v[0];
  return Math.hypot(du, dv);
}

/** Layer-mean wind between z0 and z1. */
function meanWind(z, u, v, z0, z1) {
  let su = 0, sv = 0, n = 0;
  for (let k = 0; k < z.length; k++) {
    if (z[k] >= z0 && z[k] <= z1) { su += u[k]; sv += v[k]; n++; }
  }
  return n ? { u: su / n, v: sv / n } : { u: u[0], v: v[0] };
}

/** Bunkers et al. (2000) internal dynamics storm motion, right and left movers. */
function bunkers(z, u, v) {
  const D  = 7.5;
  const mw = meanWind(z, u, v, 0, 6000);
  const lo = meanWind(z, u, v, 0, 500);
  const hi = meanWind(z, u, v, 5500, 6000);
  const su = hi.u - lo.u, sv = hi.v - lo.v;
  const mag = Math.hypot(su, sv) || 1e-9;
  return {
    right: { u: mw.u + D * sv / mag, v: mw.v - D * su / mag },
    left : { u: mw.u - D * sv / mag, v: mw.v + D * su / mag },
    mean : mw
  };
}

/** Storm-relative helicity 0 -> h, for storm motion (cu, cv). [m^2/s^2] */
function srh(z, u, v, h, cu, cv) {
  let s = 0;
  for (let k = 0; k < z.length - 1; k++) {
    if (z[k + 1] > h) break;
    s += (u[k + 1] - cu) * (v[k] - cv) - (u[k] - cu) * (v[k + 1] - cv);
  }
  return s;
}

/** Precipitable water, sfc -> model top. [mm] */
function precipitableWater(p, r) {
  let W = 0;
  for (let k = 0; k < p.length - 1; k++) {
    const q0 = r[k] / (1 + r[k]), q1 = r[k + 1] / (1 + r[k + 1]);
    W += 0.5 * (q0 + q1) * (p[k] - p[k + 1]) / C.g;
  }
  return W;   // kg/m^2 == mm
}

/**
 * Free-tropospheric column saturation fraction W/W* over (HBL, Htpp) — the
 * quantity the paper uses to set RHFT,0 when fitting a real sounding (§3c).
 */
function columnSaturationFraction(snd, HBL) {
  let W = 0, Ws = 0;
  for (let k = 0; k < snd.N - 1; k++) {
    if (snd.z[k] < HBL || snd.z[k + 1] > snd.Htpp) continue;
    const dp = snd.p[k] - snd.p[k + 1];
    const q0 = snd.r[k] / (1 + snd.r[k]), q1 = snd.r[k + 1] / (1 + snd.r[k + 1]);
    const rs0 = rFromRH(1, snd.T[k], snd.p[k]), rs1 = rFromRH(1, snd.T[k + 1], snd.p[k + 1]);
    W  += 0.5 * (q0 + q1) * dp;
    Ws += 0.5 * (rs0 / (1 + rs0) + rs1 / (1 + rs1)) * dp;
  }
  return Ws > 0 ? W / Ws : NaN;
}

/* --------------------------------------------------------------------------
 * 8. Top-level driver
 * ------------------------------------------------------------------------ */
function buildSounding(params) {
  const P = Object.assign({}, DEFAULTS, params || {});
  const snd = thermoProfile(P);
  const kin = kinematicProfile(P, snd.z);
  snd.u = kin.u; snd.v = kin.v;

  const asc = { mode: P.ascent || 'pseudo', ice: !!P.ice };
  const sb = surfaceParcel(snd, asc);
  const ml = mixedLayerParcel(snd, 100, asc);
  const bk = bunkers(snd.z, snd.u, snd.v);

  snd.params = P;
  snd.ascent = asc;
  snd.parcel = sb;
  snd.parcelML = ml;
  snd.bunkers = bk;
  snd.diag = {
    SBCAPE : sb.CAPE,
    SBCIN  : sb.CIN,
    MLCAPE : ml.CAPE,
    MLCIN  : ml.CIN,
    zLCL   : sb.zLCL,
    zLFC   : sb.zLFC,
    zEL    : sb.zEL,
    Htpp   : snd.Htpp,
    dTcap  : snd.dTcap,
    rsfc   : snd.rsfc * 1000,                    // g/kg
    thetaSfc: snd.theta[0],
    PW     : precipitableWater(snd.p, snd.r),
    CSF    : columnSaturationFraction(snd, P.HBL),
    shear01: bulkShear(snd.z, snd.u, snd.v, 1000),
    shear03: bulkShear(snd.z, snd.u, snd.v, 3000),
    shear06: bulkShear(snd.z, snd.u, snd.v, 6000),
    srh01  : srh(snd.z, snd.u, snd.v, 1000, bk.right.u, bk.right.v),
    srh03  : srh(snd.z, snd.u, snd.v, 3000, bk.right.u, bk.right.v),
    Dsfc   : snd.Dsfc,
    Msfc   : snd.Msfc,
    DFT0   : snd.DFT0,
    // AE17 / paper Eq. 3 scaling: CAPE ~ (M_BL - D_FT) ln(T_LFC/T_LNB)
    capeScale: (function () {
      if (isNaN(sb.zLFC) || isNaN(sb.zEL)) return NaN;
      const Tl = interpAtZ(snd.z, snd.T, sb.zLFC);
      const Tn = interpAtZ(snd.z, snd.T, sb.zEL);
      const DFTatLFC = interpAtZ(snd.z, snd.D, sb.zLFC);
      return (snd.Msfc - DFTatLFC) * Math.log(Tl / Tn);
    })()
  };
  return snd;
}

/* --------------------------------------------------------------------------
 * 9. CM1 input_sounding writer
 *
 * CM1 base-state format:
 *   line 1:  psfc(mb)  theta_sfc(K)  qv_sfc(g/kg)
 *   line 2+: z(m)  theta(K)  qv(g/kg)  u(m/s)  v(m/s)      (surface excluded)
 * ------------------------------------------------------------------------ */
function toCM1(snd, opts) {
  opts = opts || {};
  const stride = Math.max(1, Math.round((opts.dzOut || 100) / snd.params.dz));
  const f = (x, n) => x.toFixed(n === undefined ? 6 : n);
  const q = k => (snd.r[k] / (1 + snd.r[k])) * 1000;    // CM1 wants qv in g/kg

  const lines = [];
  lines.push([f(snd.p[0] / 100, 4), f(snd.theta[0], 6), f(q(0), 6)].join('   '));
  for (let k = stride; k < snd.N; k += stride) {
    lines.push([f(snd.z[k], 2), f(snd.theta[k], 6), f(q(k), 6),
                f(snd.u[k], 6), f(snd.v[k], 6)].join('   '));
  }
  return lines.join('\n') + '\n';
}

/** A python snippet reproducing the current parameter set. */
function toPython(P) {
  return [
    '# Chavas & Dawson (2021, JAS) SCS environmental sounding',
    '# https://doi.org/10.1175/JAS-D-20-0120.1',
    '# Reference code: https://zenodo.org/records/15358857',
    '',
    'params = dict(',
    `    Psfc_hPa   = ${P.Psfc},        # surface pressure          [hPa]`,
    `    Tsfc_K     = ${P.Tsfc},        # surface temperature       [K]`,
    `    RHsfc      = ${P.RHsfc},       # surface relative humidity [-]`,
    `    HBL_m      = ${P.HBL},         # boundary layer depth      [m]`,
    `    dD_Jkg     = ${P.dD},          # DSE jump / capping inv.   [J/kg]`,
    `    GammaFT_Kkm= ${P.GammaFT},     # free-trop lapse rate      [K/km]`,
    `    RHFT0      = ${P.RHFT0},       # free-trop relative hum.   [-]`,
    `    Ttpp_K     = ${P.Ttpp},        # tropopause temperature    [K]`,
    `    usfc       = ${P.usfc},        # surface u                 [m/s]`,
    `    vsfc       = ${P.vsfc},        # surface v                 [m/s]`,
    `    cBL        = ${P.cBL},         # BL meridional shear       [1/s]`,
    `    cFT1       = ${P.cFT1},        # FT zonal shear at HBL     [1/s]`,
    `    cFT2       = ${P.cFT2},        # d(FT shear)/dz            [1/(m s)]`,
    `    Hstop_m    = ${P.Hstop},       # top of upper shear layer  [m]`,
    ')'
  ].join('\n');
}

/* ---------------------------------------------------------------------- */
return {
  C, DEFAULTS, PRESETS,
  esat, esatIce, esatMix, iceFrac, Lheat, rSat, rFromE, rFromRH, rhFromR,
  Tvirt, Tdens, theta, dewpoint, dTdlnp, ICE,
  dryStaticEnergy, moistStaticEnergy,
  thermoProfile, kinematicProfile,
  liftParcel, surfaceParcel, mixedLayerParcel,
  bulkShear, meanWind, bunkers, srh, precipitableWater,
  columnSaturationFraction, interpAtZ,
  buildSounding, toCM1, toPython
};
}));
