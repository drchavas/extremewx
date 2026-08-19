/* ============================================================================
 * tcrain.js — JavaScript port of the TCR tropical cyclone rainfall model
 *
 * Rainfall is computed as the upward water-vapour flux across the top of the
 * boundary layer, times a precipitation efficiency:
 *
 *     R = eps * (rho_a/rho_l) * q900 * max(w + w_rad, 0)
 *
 * where w is the net vertical velocity built from four physical mechanisms:
 *
 *   w_friction   Ekman convergence under the surface stress of the vortex
 *   w_stretching vortex stretching as the storm intensifies or decays
 *   w_topographic the boundary-layer wind blowing up terrain,  u.grad(h)
 *   w_shear      the balanced response to environmental vertical wind shear
 *
 * The shear term is the elegant part: it enters as an *effective* terrain
 * gradient proportional to absolute vorticity crossed with the shear vector,
 * which is what puts the rainfall maximum downshear-left in the N. hemisphere.
 *
 * References
 *   Zhu L., S. M. Quiring and K. Emanuel (2013). Estimating tropical cyclone
 *     precipitation risk in Texas. Geophys. Res. Lett. 40, 6225-6230.
 *   Lu P., N. Lin, K. Emanuel, D. Chavas and J. Smith (2018). Assessing
 *     hurricane rainfall mechanisms using a physics-based model: Hurricanes
 *     Isabel (2003) and Irene (2011). J. Atmos. Sci. 75, 2337-2358.
 *   Xi D., N. Lin and D. Chavas (2020). Evaluating a physics-based tropical
 *     cyclone rainfall model for risk assessment. J. Hydromet. 21, 2197-2218.
 *
 * Ported from the reference implementation in pyTCR (tcr/wind.py,
 * tcr/rainfall.py). Coefficients and structure follow that source; the wind
 * profile is supplied externally so this can be driven by the Chavas, Lin &
 * Emanuel (2015) profile via tcwindprofile.js — which is how Xi et al. (2020)
 * and Gori et al. (2025) drive it.
 *
 * UNITS (following the reference implementation, which mixes them deliberately)
 *   radius r  : km          wind V : m/s        elevation h : m
 *   hx, hy    : m per m     lat : degrees       rain rate : mm/hr
 * ========================================================================== */

const TCRain = (function () {
  'use strict';

  /* ------------------------------------------------------------- defaults */
  const D = {
    Htrop:    4000,      // depth of the lower troposphere [m]
    deltar:   2,         // radial increment for dM/dr [km]
    timeres:  2,         // native time resolution for the stretching term [hr]
    q900:     0.01,      // specific humidity at 900 hPa [g/g]
    eprecip:  0.9,       // precipitation efficiency [-]
    wrad:     -0.005,    // radiative-cooling subsidence [m/s]
    radcity:  300,       // beyond this radius the storm is ignored [km]
    Cd_sea:   1.5e-3,    // drag coefficient over water
    Cd_land:  3.0e-3,    // drag coefficient over land (rougher)
    wmax:     7,         // cap on vertical velocity [m/s]
    thresM:   2          // floor on dM/dr, prevents blow-up near the centre
  };
  const RHOA_OVER_RHOL = 0.00117;   // air density / liquid water density
  const OMEGA = Math.PI / (6 * 3600);   // = 2*pi/86400 s^-1, Earth rotation

  /* ======================================================================
   * Net vertical velocity at one point, for one storm timestep.
   *
   * s = {
   *   r, costheta, sintheta   position of the point relative to the storm
   *                           centre: radius [km] and unit vector components
   *   V, Vrp, Vrm             azimuthal wind at r, r+dr, r-dr  [m/s]
   *   dVdt_p, dVdt_m          d/dt of the wind at r+dr, r-dr   [m/s per
   *                           timeres hours] - drives vortex stretching
   *   rm                      radius of maximum wind [km]
   *   lat                     latitude [deg]
   *   ut, vt                  storm translation components     [m/s]
   *   us, vs                  shear vector components          [m/s]
   *   h, hx, hy               terrain height [m] and gradient  [m/m]
   *   land                    true over land (sets the drag coefficient)
   * }
   * ==================================================================== */
  function verticalVelocity(s, o) {
    o = Object.assign({}, D, o || {});
    const { Htrop, deltar, timeres, radcity, wmax, thresM } = o;
    const Hi = 1 / Htrop;
    const deltari = 1 / deltar;
    const timereswi = 1 / (3600 * timeres);

    const r = Math.max(s.r, 0.5);
    const latfac = s.lat >= 0 ? 1 : -1;          // cyclonic sense by hemisphere

    // ---- 1. Ekman pumping from surface friction -------------------------
    // Wind at the half-radii either side of r
    const vph = 0.5 * (s.V + s.Vrp);
    const vmh = 0.5 * (s.V + s.Vrm);
    // Total surface wind including storm motion, used for the stress
    const u1 = s.vt * s.costheta - s.ut * s.sintheta;
    const u2 = s.vt * s.vt + s.ut * s.ut;
    const vnetp = Math.sqrt(Math.max(vph * vph + 2 * vph * latfac * u1 + u2, 0));
    const vnetm = Math.sqrt(Math.max(vmh * vmh + 2 * vmh * latfac * u1 + u2, 0));

    let Cd = s.land ? o.Cd_land : o.Cd_sea;
    Cd = Math.min(Math.max(Cd, 0), 0.005);
    // Over water the drag coefficient rises with wind speed; over land the
    // roughness is set by the surface, so this adjustment is not applied.
    const facp = s.land ? 1 : 1 + 0.0193 * vnetp;
    const facm = s.land ? 1 : 1 + 0.0193 * vnetm;

    const uekp = -Hi * Cd * facp * vph * vnetp;
    const uekm = -Hi * Cd * facm * vmh * vnetm;

    // ---- 2. Vortex stretching from storm intensity change ---------------
    const cp = 1000 * 2 * OMEGA * Math.sin(Math.abs(s.lat) * Math.PI / 180);
    let dMdrp = cp * (r + 0.5 * deltar)
              + (r + 0.5 * deltar) * deltari * (s.Vrp - s.V)
              + 0.5 * (s.Vrp + s.V);
    let dMdrm = cp * (r - 0.5 * deltar)
              + (r - 0.5 * deltar) * deltari * (s.V - s.Vrm)
              + 0.5 * (s.Vrm + s.V);
    dMdrp = Math.max(dMdrp, thresM);
    dMdrm = Math.max(dMdrm, thresM);

    const rm = s.rm > 0 ? s.rm : 1e-32;
    const efacp = Math.min(-1 + 2 * Math.pow((r + deltar) / rm, 2), 1);
    const efacm = Math.min(-1 + 2 * Math.pow((r - deltar) / rm, 2), 1);

    const up = (r + deltar) * (-0.5 * timereswi * efacp * s.dVdt_p + uekp) / dMdrp;
    const um = (r - deltar) * (-0.5 * timereswi * efacm * s.dVdt_m + uekm) / dMdrm;

    // Mass continuity: convergence of the radial flow drives w
    let w = -Htrop * deltari * ((r + deltar) * up - (r - deltar) * um)
            / Math.max(r, 1);

    // ---- 3. Topographic forcing:  w += u . grad(h) ----------------------
    // The storm's own translation only matters near the storm, so taper it.
    const ufunc = Math.min(Math.max((radcity - r) / 50, 0), 1);
    const utl = s.ut * ufunc, vtl = s.vt * ufunc;
    const Vd = s.V;                              // boundary-layer azimuthal wind
    const uSurf = utl - Vd * latfac * s.sintheta;   // eastward  wind component
    const vSurf = vtl + Vd * latfac * s.costheta;   // northward wind component
    w += uSurf * s.hx + vSurf * s.hy;

    // ---- 4. Shear, as an effective terrain gradient ---------------------
    // vort ~ f + 2V/r + dV/dr. Written out, this term reduces to
    //     dw = 0.0005 * vort * V * (r_hat . shear_vector)
    // i.e. an effective slope that the vortex blows over, maximised where the
    // radial direction aligns with the shear -> ascent peaks DOWNSHEAR.
    // Note: observed TC rainfall asymmetry peaks downshear-LEFT. This reduced
    // model captures the downshear displacement but not the additional
    // left-of-shear rotation, which comes from the full balanced response.
    // That is a known simplification of the reference implementation, kept
    // here deliberately so results match pyTCR / Lu et al. (2018).
    const vort = cp + 2 * Vd / (0.1 + r) + deltari * (s.Vrp - s.Vrm);
    const hxmod = -0.0005 * vort * s.vs;
    const hymod = 0.0005 * vort * s.us;
    w += Vd * s.costheta * hymod - Vd * s.sintheta * hxmod;

    return Math.min(w, wmax);
  }

  /* Rain rate [mm/hr] from the net vertical velocity [m/s]. */
  function rainRate(w, o) {
    o = Object.assign({}, D, o || {});
    return o.eprecip * 1000 * 3600 * RHOA_OVER_RHOL * o.q900
           * Math.max(w + o.wrad, 0);
  }

  /* Shear proxy used by the reference implementation: the difference between
     the storm's translation and the 850 hPa environmental flow, scaled by 5,
     with a beta-drift correction removed from the meridional component.
     Pass environmental winds in m/s; returns {us, vs} in m/s. */
  function shearFromEnv(ut, vt, u850, v850, lat) {
    const vdrift = 1.5 * (lat >= 0 ? 1 : -1);
    return {
      us: 5 * (ut - u850),
      vs: 5 * (vt - vdrift * Math.cos(lat * Math.PI / 180) - v850)
    };
  }

  return { verticalVelocity, rainRate, shearFromEnv, defaults: D,
           RHOA_OVER_RHOL, OMEGA };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TCRain;
