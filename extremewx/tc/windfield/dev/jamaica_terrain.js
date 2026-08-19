/* ============================================================================
 * jamaica_terrain.js
 *
 * ####################################################################
 * ##  SCHEMATIC TERRAIN - THIS IS NOT A DIGITAL ELEVATION MODEL.    ##
 * ##  It reproduces the gross morphology of Jamaica (island outline, ##
 * ##  the main ranges, their approximate summit heights and          ##
 * ##  positions) as a smooth analytic surface. It is a placeholder   ##
 * ##  so the hazard machinery can be built and demonstrated.         ##
 * ##                                                                 ##
 * ##  Replace it with real data: drop an SRTM/GEBCO raster in this   ##
 * ##  folder and run  python3 build_terrain.py  , which writes       ##
 * ##  terrain_jamaica.bin/.json. The page prefers those files        ##
 * ##  automatically and only falls back to this module.              ##
 * ####################################################################
 *
 * Why this matters for the results, not just the picture: the orographic term
 * in the TCR rainfall model is the boundary-layer wind dotted with the terrain
 * GRADIENT. A smooth analytic surface has gradients that are far gentler and
 * far better organised than real topography, so orographic rainfall totals
 * here are systematically too low and too smooth. Treat the patterns as
 * qualitative until a real DEM is loaded.
 *
 * Morphology encoded (summit heights are the real published values):
 *   Blue Mountains      Blue Mountain Peak 2256 m, far east
 *   John Crow Mountains ~1140 m, north-east, parallel ridge
 *   Dry Harbour Mts     ~850 m, north-central
 *   Cockpit Country     ~700 m karst plateau, west-central
 *   Santa Cruz / Don Figuerero  ~800 m, south-west
 *   Lowlands            Liguanea plain (Kingston, SE), Black River morass (SW)
 * ========================================================================== */

const JamaicaTerrain = (function () {
  'use strict';

  const IS_SCHEMATIC = true;

  // Grid covering Jamaica plus surrounding water
  const GRID = { lat0: 17.40, lat1: 18.80, lon0: -78.75, lon1: -75.95, res: 0.01 };

  // Island outline: superellipse lobes that together approximate the coastline
  const LOBES = [
    // [lat, lon, semi-lat, semi-lon, power]
    [18.13, -77.45, 0.30, 0.90, 2.6],   // main body
    [18.20, -76.60, 0.26, 0.42, 2.4],   // eastern parishes
    [17.93, -77.90, 0.22, 0.42, 2.4],   // south-west (St Elizabeth)
    [18.44, -77.30, 0.16, 0.55, 2.4]    // north coast bulge
  ];

  // Ranges: [lat, lon, peak_m, sigma_lat, sigma_lon, rotation_deg]
  const RANGES = [
    [18.045, -76.585, 2256, 0.085, 0.20, -20],   // Blue Mountains
    [18.10,  -76.36,  1140, 0.11,  0.055, -10],  // John Crow Mountains
    [18.05,  -76.80,   900, 0.09,  0.16, -20],   // western Blue Mtn foothills
    [18.30,  -77.35,   850, 0.10,  0.28,   5],   // Dry Harbour Mountains
    [18.22,  -77.62,   720, 0.11,  0.24,   0],   // Cockpit Country plateau
    [18.05,  -77.72,   800, 0.09,  0.17,  25],   // Santa Cruz / Don Figuerero
    [18.16,  -77.05,   700, 0.10,  0.20,  10],   // Port Royal / central hills
    [18.30,  -78.05,   500, 0.09,  0.16,   0]    // western hills (Hanover)
  ];

  // Lowland basins subtracted back out: [lat, lon, depth_m, s_lat, s_lon]
  const BASINS = [
    [17.99, -76.79, 420, 0.07, 0.13],   // Liguanea plain / Kingston
    [18.05, -77.85, 380, 0.08, 0.15],   // Black River morass
    [18.47, -77.92, 300, 0.06, 0.12]    // Montego Bay coastal
  ];

  const d2r = Math.PI / 180;

  function islandFraction(lat, lon) {
    let f = 0;
    for (const [la, lo, sla, slo, p] of LOBES) {
      const u = Math.pow(Math.abs((lat - la) / sla), p)
              + Math.pow(Math.abs((lon - lo) / slo), p);
      f = Math.max(f, Math.exp(-u));
    }
    return f;
  }

  /* Elevation [m] at a point. Negative = water depth. */
  function elevationAt(lat, lon) {
    const f = islandFraction(lat, lon);

    let relief = 0;
    for (const [la, lo, pk, sla, slo, rot] of RANGES) {
      const c = Math.cos(rot * d2r), s = Math.sin(rot * d2r);
      const dla = lat - la, dlo = lon - lo;
      const a = (dlo * c + dla * s) / slo;
      const b = (-dlo * s + dla * c) / sla;
      relief += pk * Math.exp(-(a * a + b * b));
    }
    for (const [la, lo, dp, sla, slo] of BASINS) {
      const a = (lon - lo) / slo, b = (lat - la) / sla;
      relief -= dp * Math.exp(-(a * a + b * b));
    }
    relief = Math.max(relief, 0);

    // Offshore: a smooth deepening away from land.
    // WARNING - this bathymetry is NOT calibrated. Checked against GEBCO it is
    // far too deep close inshore (it gives ~-2950 m where GEBCO has -409 m at
    // 17.6N 76.8W). Jamaica's real shelf is narrow and steep, but not this
    // steep. Do NOT drive a surge calculation off this; load real GEBCO via
    // build_terrain.py first. Unused by the wind and rainfall models.
    const shelf = -25 - 3000 * Math.pow(Math.max(0, 0.55 - f) / 0.55, 1.7);
    if (f > 0.55) return 8 + relief * Math.min(1, (f - 0.55) / 0.12);
    return shelf;
  }

  /* Build the full field set the hazard models consume. */
  function build(res) {
    res = res || GRID.res;
    const lats = [], lons = [];
    for (let v = GRID.lat0; v <= GRID.lat1 + 1e-9; v += res) lats.push(+v.toFixed(6));
    for (let v = GRID.lon0; v <= GRID.lon1 + 1e-9; v += res) lons.push(+v.toFixed(6));
    const ny = lats.length, nx = lons.length, n = ny * nx;

    const h = new Float32Array(n);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        h[j * nx + i] = elevationAt(lats[j], lons[i]);

    // Terrain gradient in m per m. dy is constant; dx shrinks with latitude.
    const M_PER_DEG = 111320;
    const hx = new Float32Array(n), hy = new Float32Array(n);
    const dy = res * M_PER_DEG;
    for (let j = 0; j < ny; j++) {
      const dx = res * M_PER_DEG * Math.cos(lats[j] * d2r);
      for (let i = 0; i < nx; i++) {
        const ip = Math.min(i + 1, nx - 1), im = Math.max(i - 1, 0);
        const jp = Math.min(j + 1, ny - 1), jm = Math.max(j - 1, 0);
        hx[j * nx + i] = (h[j * nx + ip] - h[j * nx + im]) / ((ip - im) * dx);
        hy[j * nx + i] = (h[jp * nx + i] - h[jm * nx + i]) / ((jp - jm) * dy);
      }
    }

    const land = new Uint8Array(n);
    const slope = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      land[k] = h[k] > 0 ? 1 : 0;
      slope[k] = Math.atan(Math.hypot(hx[k], hy[k])) / d2r;
    }

    return {
      lat0: lats[0], lat1: lats[ny - 1], lon0: lons[0], lon1: lons[nx - 1],
      res, ny, nx, h, hx, hy, slope, land,
      schematic: IS_SCHEMATIC,
      source: 'schematic analytic surface - NOT a DEM'
    };
  }

  /* Nearest-cell lookup helper used by the hazard loops. */
  function indexOf(T, lat, lon) {
    const j = Math.round((lat - T.lat0) / T.res);
    const i = Math.round((lon - T.lon0) / T.res);
    if (j < 0 || j >= T.ny || i < 0 || i >= T.nx) return -1;
    return j * T.nx + i;
  }

  return { build, elevationAt, indexOf, GRID, IS_SCHEMATIC };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = JamaicaTerrain;
