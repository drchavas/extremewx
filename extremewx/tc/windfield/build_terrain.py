#!/usr/bin/env python3
"""
build_terrain.py — turn a Jamaica DEM (and optional bathymetry) into the
compact binary terrain file the hazard page loads.

Drop your source raster(s) in this folder (or pass paths) and run:

    python3 build_terrain.py                      # auto-discovers *.tif/*.nc here
    python3 build_terrain.py dem.tif bathy.tif    # explicit
    python3 build_terrain.py --res 0.0025         # ~275 m output grid

What it does
------------
1. Reads the DEM, reprojects/resamples to a regular lat/lon grid over Jamaica.
2. Merges bathymetry (negative elevations) where the DEM has no data / is ocean.
3. Derives the fields the hazard models need:
     h    elevation [m]           (negative = water depth)
     hx   dh/dx     [m per m]     eastward  terrain slope
     hy   dh/dy     [m per m]     northward terrain slope
     slope  [degrees]             for the landslide model
     land   0/1 mask
     acc    upslope flow accumulation (D8) for inland flood routing
4. Writes terrain_jamaica.bin  (Int16 h, Int8 slope/land, Float32 hx/hy, Uint16 acc)
   plus terrain_jamaica.json   (grid metadata) for the browser to read.

Why hx/hy matter: the TCR rainfall model's orographic term is the boundary-layer
wind vector dotted with the terrain gradient, w_topo = u*hx + v*hy. Over Jamaica
that term dominates the rainfall pattern, so the gradient — not just the height —
is the quantity that has to be right.

Requires: rasterio, numpy   (pip install rasterio attrs)
"""

import argparse
import glob
import json
import os
import sys

import numpy as np

# Jamaica + enough surrounding ocean for shelf/surge work
BBOX = dict(lat0=17.40, lat1=18.80, lon0=-78.75, lon1=-75.95)
DEFAULT_RES = 0.005          # ~550 m


def find_rasters(paths):
    if paths:
        return paths
    here = os.path.dirname(os.path.abspath(__file__))
    found = []
    for pat in ("*.tif", "*.tiff", "*.TIF", "*.nc", "*.hgt", "*.vrt"):
        found += sorted(glob.glob(os.path.join(here, pat)))
    return found


def read_to_grid(path, lats, lons, res):
    """
    Reproject a raster onto the target lat/lon grid.

    Uses area-averaging rather than nearest-neighbour: going from 30 m SRTM to a
    ~500 m grid, point sampling would alias badly and — because the hazard models
    care about the terrain *gradient* — would produce slopes that are essentially
    noise. Averaging gives the correct mean elevation per cell.

    Returns an array with row 0 = southernmost latitude (ascending), matching
    `lats`, and NaN wherever the source raster had no data.
    """
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject

    ny, nx = len(lats), len(lons)
    # destination is north-up (row 0 = max lat), flipped at the end
    dst_transform = from_origin(lons[0] - res / 2, lats[-1] + res / 2, res, res)
    dst = np.full((ny, nx), np.nan, dtype="float64")

    with rasterio.open(path) as ds:
        src = ds.read(1, masked=True).astype("float64")
        src = np.ma.filled(src, np.nan)
        if ds.nodata is not None:
            src[src == ds.nodata] = np.nan
        # downsampling -> average; upsampling -> bilinear
        src_res = abs(ds.transform.a)
        method = Resampling.average if src_res < res * 0.75 else Resampling.bilinear
        reproject(
            source=src,
            destination=dst,
            src_transform=ds.transform,
            src_crs=ds.crs or "EPSG:4326",
            src_nodata=np.nan,
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            dst_nodata=np.nan,
            resampling=method,
        )
        cov = np.isfinite(dst).sum()
        print(f"    {os.path.basename(path)}: {cov:,}/{dst.size:,} cells covered "
              f"(src {src_res*111000:.0f} m, {method.name})")

    return dst[::-1, :]        # flip so row 0 = southernmost


def d8_accumulation(h, land):
    """
    Single-flow-direction (D8) upslope accumulation — the simplest defensible
    proxy for where TC rainfall concentrates into flooding. Cells are processed
    from high to low so each cell's inflow is already final when it drains.

    Verified on analytic cases: a V-valley on a tilted plane accumulates
    monotonically downstream and its outlet carries the entire grid; a conical
    hill leaves its peak at 1.

    LIMITATION — no depression filling. Flow entering a local minimum stops
    there. For Jamaica this cuts both ways: much of the interior (Cockpit
    Country) is karst with genuine internal drainage and no surface outlet, so
    some pits are real hydrology rather than DEM noise. Filling them would
    wrongly imply surface connectivity. Treat accumulation as indicative of
    where runoff concentrates, not as a routed discharge.
    """
    ny, nx = h.shape
    acc = np.ones((ny, nx), dtype="float64")
    acc[~land] = 0.0

    hh = np.where(land, h, -9999.0)
    order = np.argsort(hh.ravel())[::-1]        # highest first
    nbr = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    dist = [1.414, 1.0, 1.414, 1.0, 1.0, 1.414, 1.0, 1.414]

    for idx in order:
        j, i = divmod(int(idx), nx)
        if not land[j, i]:
            continue
        best, bj, bi = 0.0, -1, -1
        for (dj, di), dd in zip(nbr, dist):
            jj, ii = j + dj, i + di
            if jj < 0 or jj >= ny or ii < 0 or ii >= nx:
                continue
            drop = (hh[j, i] - hh[jj, ii]) / dd
            if drop > best:
                best, bj, bi = drop, jj, ii
        if bj >= 0:
            acc[bj, bi] += acc[j, i]

    # Rivers discharge into the sea, so ocean cells pick up land accumulation as
    # the loop runs. That is physically fine but meaningless to display (it paints
    # bright blobs at every river mouth), so zero the water afterwards - the
    # coastal land cell just upstream still carries the full catchment.
    acc[~land] = 0.0
    return acc


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("rasters", nargs="*", help="DEM first, then optional bathymetry")
    ap.add_argument("--res", type=float, default=DEFAULT_RES,
                    help=f"output grid spacing in degrees (default {DEFAULT_RES})")
    ap.add_argument("--out", default=None, help="output basename")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_base = args.out or os.path.join(here, "terrain_jamaica")

    rasters = find_rasters(args.rasters)
    if not rasters:
        sys.exit(
            "No raster found.\n"
            f"Drop a Jamaica DEM (.tif/.nc/.hgt) in {here} and re-run, or pass a path.\n"
            "Good sources:\n"
            "  SRTM 30 m   https://portal.opentopography.org  (Global Data > SRTM GL1)\n"
            "  SRTM 90 m   https://srtm.csi.cgiar.org\n"
            "  GEBCO bathy https://download.gebco.net\n"
            f"Bounding box: lat {BBOX['lat0']}..{BBOX['lat1']}, "
            f"lon {BBOX['lon0']}..{BBOX['lon1']}")

    lats = np.arange(BBOX["lat0"], BBOX["lat1"] + 1e-9, args.res)
    lons = np.arange(BBOX["lon0"], BBOX["lon1"] + 1e-9, args.res)
    ny, nx = len(lats), len(lons)
    print(f"Target grid: {ny} x {nx} = {ny*nx:,} cells at {args.res}deg "
          f"(~{args.res*111:.2f} km)")

    print("Reading rasters:")
    h = np.full((ny, nx), np.nan)
    for p in rasters:
        g = read_to_grid(p, lats, lons, args.res)
        h = np.where(np.isfinite(h), h, g)      # first raster wins
    if not np.isfinite(h).any():
        sys.exit("No raster covered the Jamaica bounding box - check your file.")

    # Unfilled cells are ocean the DEM didn't describe
    h = np.where(np.isfinite(h), h, -20.0)
    land = h > 0

    # Terrain gradient in m per m (dy is constant; dx shrinks with latitude)
    m_per_deg = 111_320.0
    dy = args.res * m_per_deg
    dx = args.res * m_per_deg * np.cos(np.radians(lats))[:, None]
    hy, hx = np.gradient(h, edge_order=1)
    hy = hy / dy
    hx = hx / dx

    slope = np.degrees(np.arctan(np.hypot(hx, hy)))

    print("Computing D8 flow accumulation...")
    acc = d8_accumulation(h, land)

    # ---- pack ----
    h_i16 = np.clip(np.round(h), -32000, 32000).astype("<i2")
    slope_u8 = np.clip(np.round(slope), 0, 90).astype("u1")
    land_u8 = land.astype("u1")
    hx_f32 = hx.astype("<f4")
    hy_f32 = hy.astype("<f4")
    # log-compress accumulation into 0..65535
    acc_u16 = np.clip(np.round(np.log1p(acc) / np.log1p(acc.max()) * 65535),
                      0, 65535).astype("<u2")

    with open(out_base + ".bin", "wb") as f:
        for arr in (h_i16, hx_f32, hy_f32, slope_u8, land_u8, acc_u16):
            f.write(arr.tobytes())

    meta = dict(
        lat0=float(lats[0]), lat1=float(lats[-1]),
        lon0=float(lons[0]), lon1=float(lons[-1]),
        res=float(args.res), ny=int(ny), nx=int(nx),
        acc_max=float(acc.max()),
        layers=["h_i16", "hx_f32", "hy_f32", "slope_u8", "land_u8", "acc_u16"],
        source=[os.path.basename(p) for p in rasters],
        land_cells=int(land.sum()),
        max_elev_m=float(h.max()), min_elev_m=float(h.min()),
    )
    with open(out_base + ".json", "w") as f:
        json.dump(meta, f, indent=2)

    size = os.path.getsize(out_base + ".bin")
    print(f"\nWrote {out_base}.bin  ({size/1e6:.1f} MB) and {out_base}.json")
    print(f"  land cells : {land.sum():,} of {ny*nx:,}")
    print(f"  elevation  : {h.min():.0f} to {h.max():.0f} m")
    print(f"  max slope  : {slope.max():.1f} deg")
    if h.max() < 1500:
        print("  WARNING: peak elevation < 1500 m - Blue Mountain Peak is 2256 m, "
              "so the DEM may not cover eastern Jamaica.")


if __name__ == "__main__":
    main()
