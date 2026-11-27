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

## USGS pilot area

The development pilot uses western San Francisco, California, centered at
latitude `37.7598`, longitude `-122.499`. The USGS Science Data Catalog
identifies 3DEP products as public domain. This test uses the 1/3 arc-second
release `USGS_13_n38w123_20220810`. Keep that release identifier in generated
manifests. The raster and generated files stay outside Git.

Prepare a small raster with enough margin for every supported area preset:

```sh
mkdir -p /tmp/farmland-pilot
GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_TIMEOUT=30 gdal_translate \
  -projwin -122.53 37.79 -122.46 37.73 -co COMPRESS=DEFLATE \
  /vsicurl/https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/historical/n38w123/USGS_13_n38w123_20220810.tif \
  /tmp/farmland-pilot/elevation.tif
export TERRAIN_SOURCE=/tmp/farmland-pilot/elevation.tif
export TERRAIN_SOURCE_ID=USGS-3DEP/USGS_13_n38w123_20220810
```

Use the API README to set the database and terrain directory. Submit the
pilot coordinates through the world endpoint or Unity pilot form, run one
terrain job, and fetch the manifest and its named chunks.

The queue-to-download smoke test on PostgreSQL 17 and GDAL 3.10.3 passed
for 1, 4, and 9 km². Each result reached `ready` and returned all named
chunks with finite heights and exact shared edge samples. The 9 km² package
spanned about −0.4 to 132.7 meters. An unrelated account received HTTP 404.
This checks elevation and delivery. A separate water mask is required to
classify coastlines and water, and Unity rendering still requires Play Mode.

Data source: [USGS 3DEP 1/3 arc-second DEM catalog](https://data.usgs.gov/datacatalog/data/USGS%3A3a81321b-c153-416f-98b7-cc8e5f0e17c3).
