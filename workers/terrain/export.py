"""Export a bounded elevation raster into one-kilometer game terrain chunks."""

import argparse
import json
import math
from pathlib import Path
import shutil

import numpy as np
from osgeo import gdal, osr

CELLS_PER_CHUNK = 32
CHUNK_METERS = 1000


def export(source, source_id, latitude, longitude, area_km2, output):
    if area_km2 not in (1, 4, 9) or not (-80 <= latitude <= 80 and -180 <= longitude < 180):
        raise ValueError("Selection is outside the supported coordinate range or area presets.")
    if not source_id.strip():
        raise ValueError("A versioned elevation source identifier is required.")

    gdal.UseExceptions()
    raster = gdal.Open(str(source))
    if raster.RasterCount != 1 or raster.GetSpatialRef() is None:
        raise ValueError("Supply a georeferenced, single-band elevation raster in meters.")

    # Build the local grid in a metric projection centered on the selected location.
    local = osr.SpatialReference()
    local.ImportFromProj4(f"+proj=aeqd +lat_0={latitude} +lon_0={longitude} +datum=WGS84 +units=m +no_defs")

    chunks_per_axis = math.isqrt(area_km2)
    extent = chunks_per_axis * CHUNK_METERS
    spacing = CHUNK_METERS / CELLS_PER_CHUNK
    samples = chunks_per_axis * CELLS_PER_CHUNK + 1
    # GDAL bounds describe pixel edges. Extend half a cell to sample the mesh boundary.
    edge = (extent + spacing) / 2
    grid = gdal.Warp(
        "", raster, format="MEM", dstSRS=local.ExportToWkt(),
        outputBounds=(-edge, -edge, edge, edge), width=samples, height=samples,
        outputType=gdal.GDT_Float32, dstNodata=float("nan"), resampleAlg="bilinear",
    )
    heights = grid.GetRasterBand(1).ReadAsArray()
    if not np.isfinite(heights).all():
        raise ValueError("Elevation source does not cover the requested area.")

    chunks = []
    output.mkdir()
    try:
        for north_to_south in range(chunks_per_axis):
            row = north_to_south * CELLS_PER_CHUNK
            for west_to_east in range(chunks_per_axis):
                col = west_to_east * CELLS_PER_CHUNK
                filename = f"height-{west_to_east}-{north_to_south}.f32"
                heights[row:row + CELLS_PER_CHUNK + 1, col:col + CELLS_PER_CHUNK + 1].astype("<f4").tofile(
                    output / filename
                )
                chunks.append({"x": west_to_east, "y": north_to_south, "file": filename})

        manifest = {
            "version": 1,
            "sourceId": source_id,
            "center": {"latitude": latitude, "longitude": longitude},
            "areaKm2": area_km2,
            "crsWkt": local.ExportToWkt(),
            "northwestMeters": {"east": -extent / 2, "north": extent / 2},
            "samplesPerChunkAxis": CELLS_PER_CHUNK + 1,
            "sampleSpacingMeters": spacing,
            "encoding": "float32-le",
            "chunks": chunks,
        }
        pending_manifest = output / "manifest.tmp"
        pending_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        pending_manifest.rename(output / "manifest.json")
    except (OSError, ValueError):
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--latitude", type=float, required=True)
    parser.add_argument("--longitude", type=float, required=True)
    parser.add_argument("--area-km2", type=int, choices=(1, 4, 9), required=True)
    args = parser.parse_args()
    try:
        export(args.source, args.source_id, args.latitude, args.longitude, args.area_km2, args.output)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
