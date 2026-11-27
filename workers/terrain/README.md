# Terrain exporter

Run with Python, the GDAL Python bindings, and NumPy. Supply a licensed
single-band georeferenced elevation raster with meter heights and full
coverage of the selected area.

```sh
python3 workers/terrain/export.py elevation.tif terrain-output \
  --source-id pilot-dem/version --latitude 25 --longitude 51 --area-km2 4
cd workers/terrain && python3 -m unittest test_export
```

The output directory must be new. The manifest appears after all elevation
chunks are written. Keep the source dataset's attribution and redistribution
information with any published package.

Each chunk is a one-kilometer square with 33×33 height samples, row-major
north to south and west to east, using little-endian float32 meters in the
source vertical datum. The local horizontal grid is centered on the requested
coordinates. Adjacent tiles share a boundary row or column. The manifest gives
the local CRS, origin, spacing, dataset version, and chunk filenames.

The API repository README describes the one-job runner and authenticated file retrieval.
Select a licensed pilot raster that covers the requested world.
