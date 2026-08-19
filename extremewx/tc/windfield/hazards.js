/* ============================================================================
 * hazards.js — multi-hazard footprint engine for a tropical cyclone track
 *
 * Given a track (lat, lon, Vmax, R34kt per point) and a terrain grid, walks the
 * storm along the track at sub-hourly steps and accumulates, at every grid cell:
 *
 *   wind   peak 10-m sustained wind ever experienced   [kt]
 *   rain   storm-total rainfall                        [mm]
 *
 * The wind field at each timestep is the Chavas/Tao profile (tcwindprofile.js)
 * plus the storm's motion vector; rainfall is the TCR model (tcrain.js), whose
 * orographic term reads the terrain gradient supplied by the grid.
 *
 * Surge, landslide and inland flood are deliberately NOT implemented here yet —
 * see the notes at the bottom of this file for why each is blocked on data.
 * ========================================================================== */

const Hazards = (function () {
  'use strict';

  const KT = 0.5144444;             // m/s per knot
  const KM_PER_DEG = 111.320;
  const d2r = Math.PI / 180;

  /* Great-circle-ish distance in km on a local tangent plane. Over a domain the
     size of Jamaica the error is far below the model's own uncertainty. */
  function offsetKm(lat, lon, lat0, lon0) {
    const dy = (lat - lat0) * KM_PER_DEG;
    const dx = (lon - lon0) * KM_PER_DEG * Math.cos(0.5 * (lat + lat0) * d2r);
    return { dx, dy, r: Math.hypot(dx, dy) };
  }

  /* Linear interpolation of the track to a finer time step. */
  function densify(track, dtHours, stepHours) {
    const out = [];
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i], b = track[i + 1];
      const n = Math.max(1, Math.round(dtHours / stepHours));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push({
          lat:  a.lat  + (b.lat  - a.lat)  * t,
          lon:  a.lon  + (b.lon  - a.lon)  * t,
          vmax: a.vmax + (b.vmax - a.vmax) * t,
          r34:  a.r34  + (b.r34  - a.r34)  * t,
          hours: (i + t) * dtHours
        });
      }
    }
    const last = track[track.length - 1];
    out.push({ lat: last.lat, lon: last.lon, vmax: last.vmax, r34: last.r34,
               hours: (track.length - 1) * dtHours });
    return out;
  }

  /* Storm motion (m/s, eastward & northward) by centred difference. */
  function motionAt(pts, i, stepHours) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const hrs = (Math.min(pts.length - 1, i + 1) - Math.max(0, i - 1)) * stepHours;
    if (hrs <= 0) return { ut: 0, vt: 0, spd: 0 };
    const { dx, dy } = offsetKm(b.lat, b.lon, a.lat, a.lon);
    const ut = dx * 1000 / (hrs * 3600);
    const vt = dy * 1000 / (hrs * 3600);
    return { ut, vt, spd: Math.hypot(ut, vt) };
  }

  /* ======================================================================
   * Main entry point.
   *
   * opts:
   *   track      [{lat, lon, vmax(kt), r34(nmi quadrant-mean)}]
   *   dtHours    hours between supplied track points
   *   stepHours  integration step (default 0.5 h)
   *   terrain    grid from JamaicaTerrain.build() or the real DEM loader
   *   res        hazard grid spacing in degrees (default = terrain res)
   *   asym       include storm-motion asymmetry in the wind (default true)
   *   shear      {us, vs} environmental shear in m/s (default none)
   *   penv       environmental pressure, mb (default 1010)
   *   onProgress callback(fraction)
   * ==================================================================== */
  function compute(opts) {
    const T = opts.terrain;

    // Time step must be short enough that the storm moves only a small fraction
    // of its EYEWALL width between samples — not merely a fraction of Rmax.
    // The TCR vertical velocity spikes hard at the radius of maximum wind: for a
    // typical Cat 3 it runs 0.45 m/s at r=19 km, 6.6 m/s at r=22 km and back to
    // 1.2 m/s at r=24 km. That ~3 km ring is narrower than a 2 km grid cell, so
    // point-sampling it along a moving track aliases into a chain-link pattern.
    // Target ~1 km of displacement per step.
    let stepHours = opts.stepHours;
    if (!stepHours) {
      const dtH = opts.dtHours || 6;
      let maxSpd = 0;                       // km/h
      for (let i = 0; i < opts.track.length - 1; i++) {
        const a = opts.track[i], b = opts.track[i + 1];
        maxSpd = Math.max(maxSpd, offsetKm(b.lat, b.lon, a.lat, a.lon).r / dtH);
      }
      stepHours = maxSpd > 0 ? Math.min(0.5, Math.max(0.01, 1 / maxSpd)) : 0.25;
    }
    const asym = opts.asym !== false;
    const penv = opts.penv || 1010;
    const shear = opts.shear || { us: 0, vs: 0 };
    const res = opts.res || T.res;
    const skip = Math.max(1, Math.round(res / T.res));

    // Hazard grid is a (possibly coarser) subsample of the terrain grid
    const ny = Math.floor((T.ny - 1) / skip) + 1;
    const nx = Math.floor((T.nx - 1) / skip) + 1;
    const n = ny * nx;
    const wind = new Float32Array(n);      // peak wind [m/s]
    const rain = new Float32Array(n);      // total rain [mm]
    const rmax = new Float32Array(n);      // peak rain rate [mm/hr]

    const pts = densify(opts.track, opts.dtHours || 6, stepHours);
    const nsteps = pts.length;

    // Pre-solve the wind model once per timestep — it is the expensive part and
    // depends only on the storm, not on the grid cell.
    const solved = [];
    for (let s = 0; s < nsteps; s++) {
      const p = pts[s];
      const mv = motionAt(pts, s, stepHours);
      const vtKt = mv.spd / KT;
      let M = null;
      if (isFinite(p.vmax) && isFinite(p.r34) && p.r34 > 0 && Math.abs(p.lat) > 1.5) {
        M = TCWind.runFullWindModel({
          VmaxNHC_kt: p.vmax, Vtrans_kt: vtKt, R34kt_quadmean_nmi: p.r34,
          lat: p.lat, Penv_mb: penv, nPoints: 900
        });
        if (M.error) M = null;
      }
      solved.push({ p, mv, M });
    }

    const dr = TCRain.defaults.deltar;      // km, for the dM/dr stencil
    const dtSec = stepHours;                 // hours, for rain accumulation

    for (let s = 0; s < nsteps; s++) {
      const { p, mv, M } = solved[s];
      if (!M) continue;

      // d(V)/dt at r±dr drives the vortex-stretching term. Use neighbouring
      // solved steps, scaled to the model's native 2-hour window.
      const prev = solved[Math.max(0, s - 1)].M;
      const next = solved[Math.min(nsteps - 1, s + 1)].M;
      const dtWin = (Math.min(nsteps - 1, s + 1) - Math.max(0, s - 1)) * stepHours;
      const tscale = dtWin > 0 ? (2 / dtWin) : 0;   // -> per 2 h

      // Ignore cells far outside the circulation
      const cut = Math.min(M.R0_km, TCRain.defaults.radcity);

      for (let j = 0; j < ny; j++) {
        const lat = T.lat0 + j * skip * T.res;
        for (let i = 0; i < nx; i++) {
          const lon = T.lon0 + i * skip * T.res;
          const k = j * nx + i;
          const tk = (j * skip) * T.nx + (i * skip);

          const { dx, dy, r } = offsetKm(lat, lon, p.lat, p.lon);
          if (r > cut) continue;

          const rr = Math.max(r, 0.5);
          const costheta = dx / rr;     // eastward component of r-hat
          const sintheta = dy / rr;     // northward component
          const latfac = p.lat >= 0 ? 1 : -1;

          // ---------------- wind ----------------
          const V = M.windAt(rr);
          let spd;
          if (asym) {
            // rotating wind + 0.55 x translation, rotated 20 deg for inflow
            let ue = -latfac * sintheta * V;
            let un =  latfac * costheta * V;
            const a = 0.55, beta = latfac * 20 * d2r;
            const te = a * mv.ut, tn = a * mv.vt;
            ue += te * Math.cos(beta) - tn * Math.sin(beta);
            un += te * Math.sin(beta) + tn * Math.cos(beta);
            spd = Math.hypot(ue, un);
          } else {
            spd = V;
          }
          // Over land, surface roughness reduces the 10-m wind. 0.85 is the
          // conventional marine-to-land exposure ratio.
          if (T.land[tk]) spd *= 0.85;
          if (spd > wind[k]) wind[k] = spd;

          // ---------------- rainfall ----------------
          const Vrp = M.windAt(rr + dr), Vrm = M.windAt(Math.max(rr - dr, 0));
          const dVdt_p = tscale * ((next ? next.windAt(rr + dr) : Vrp) -
                                   (prev ? prev.windAt(rr + dr) : Vrp));
          const dVdt_m = tscale * ((next ? next.windAt(Math.max(rr - dr, 0)) : Vrm) -
                                   (prev ? prev.windAt(Math.max(rr - dr, 0)) : Vrm));

          const w = TCRain.verticalVelocity({
            r: rr, costheta, sintheta,
            V, Vrp, Vrm, dVdt_p, dVdt_m,
            rm: M.Rmax_km, lat: p.lat,
            ut: mv.ut, vt: mv.vt,
            us: shear.us, vs: shear.vs,
            h: T.h[tk], hx: T.hx[tk], hy: T.hy[tk],
            land: !!T.land[tk]
          });
          const rate = TCRain.rainRate(w);       // mm/hr
          rain[k] += rate * dtSec;
          if (rate > rmax[k]) rmax[k] = rate;
        }
      }
      if (opts.onProgress && (s % 4 === 0)) opts.onProgress((s + 1) / nsteps);
    }

    // ---- sub-grid smoothing -------------------------------------------
    // The eyewall ascent ring is ~3 km wide, narrower than a grid cell, so the
    // point-sampled field carries aliasing energy the grid cannot legitimately
    // represent. A 3x3 boxcar removes it. This is not cosmetic: a cell value is
    // meant to be the cell AVERAGE, and surface rainfall is in any case smeared
    // by hydrometeor advection and fallout over several km. Peak wind is
    // smoothed more gently (weighted to the centre) so genuine maxima survive.
    function smooth(src, centreWeight) {
      const out = new Float32Array(n);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          let sum = 0, wt = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj; if (jj < 0 || jj >= ny) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di; if (ii < 0 || ii >= nx) continue;
              const c = (dj === 0 && di === 0) ? centreWeight : 1;
              sum += c * src[jj * nx + ii]; wt += c;
            }
          }
          out[j * nx + i] = sum / wt;
        }
      }
      return out;
    }
    const rainS = smooth(rain, 2);
    const rmaxS = smooth(rmax, 2);
    const windS = smooth(wind, 6);      // gentler: preserve the true peak
    rain.set(rainS); rmax.set(rmaxS); wind.set(windS);

    // convert peak wind to knots for display
    const windKt = new Float32Array(n);
    for (let k = 0; k < n; k++) windKt[k] = wind[k] / KT;

    return {
      ny, nx, res: skip * T.res,
      lat0: T.lat0, lon0: T.lon0,
      windKt, rain, rmax,
      terrain: T,
      nsteps, stepHours,
      durationHours: (opts.track.length - 1) * (opts.dtHours || 6)
    };
  }

  /* Value at a lat/lon, for the click-to-query readout. */
  function sample(H, field, lat, lon) {
    const j = Math.round((lat - H.lat0) / H.res);
    const i = Math.round((lon - H.lon0) / H.res);
    if (j < 0 || j >= H.ny || i < 0 || i >= H.nx) return null;
    return H[field][j * H.nx + i];
  }

  return { compute, sample, densify, motionAt, offsetKm, KT };

  /* ==========================================================================
   * NOT YET IMPLEMENTED, and why:
   *
   * SURGE       needs real bathymetry (the schematic shelf is wrong by ~2500 m
   *             close inshore) and, to be credible at all, a hydrodynamic model.
   *             A bathystrophic/static estimate is possible once GEBCO is
   *             loaded, but should be labelled a screening index, not a depth.
   *
   * LANDSLIDE   needs slope from a real DEM. The schematic surface averages
   *             ~2 deg over land where real Jamaican hillslopes routinely
   *             exceed 25 deg, so any slope-threshold model run on it would be
   *             meaningless rather than merely approximate.
   *
   * INLAND FLOOD needs the D8 flow accumulation from build_terrain.py, which in
   *             turn needs the real DEM. Jamaica's karst interior also drains
   *             internally, so accumulation must be interpreted carefully.
   * ======================================================================= */
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Hazards;
