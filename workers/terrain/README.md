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

## Optional water classification

Provide a licensed, single-layer Polygon or MultiPolygon dataset with a
defined CRS and coverage of the pilot area. Pass `--water-source` and
`--water-source-id` to the exporter, or set `TERRAIN_WATER_SOURCE` and
`TERRAIN_WATER_SOURCE_ID` on the job runner. Use polygons representing water,
including a marine polygon if the pilot crosses a coastline.

The exporter projects the polygons onto the same grid as the elevation
samples. The manifest includes optional `waterMask` metadata and a
`waterFile` for each chunk. Each file contains unsigned bytes in elevation
sample order, with 1 inside mapped water and 0 outside. Coverage gaps in the
polygon source are indistinguishable from land, so validate the dataset
extent before enabling this layer. Older elevation-only packages keep
their existing format. The API serves masks through the owner's terrain
route. The Unity renderer still needs to consume the optional mask.

### San Francisco water source

The USGS pilot can be paired with the U.S. Census Bureau's 2024 TIGER/Line
Area Water polygons for San Francisco County (FIPS 06075). Download the
archive from the [official Area Water directory](https://www2.census.gov/geo/tiger/TIGER2024/AREAWATER/).
Keep the shapefile sidecar files together.

```sh
mkdir -p /tmp/farmland-pilot/water
curl -fL https://www2.census.gov/geo/tiger/TIGER2024/AREAWATER/tl_2024_06075_areawater.zip \
  -o /tmp/farmland-pilot/water.zip
unzip /tmp/farmland-pilot/water.zip -d /tmp/farmland-pilot/water
export TERRAIN_WATER_SOURCE=/tmp/farmland-pilot/water/tl_2024_06075_areawater.shp
export TERRAIN_WATER_SOURCE_ID=TIGER2024/tl_2024_06075_areawater
```

At the USGS pilot center, all three area presets exported with matching
mask samples along shared chunk edges. The 9 km² package classified
`37.7598, -122.514` offshore as water and `37.7598, -122.486` inland as land.
The worker and API served all nine 1,089-byte mask files to the owner and
returned HTTP 404 to an unrelated account. The classification follows the
source polygons and the 31.25 m game sampling grid.

### Keep terrain generation running

After building the API, run `npm run terrain:watch` as a long-running service
with the same database and terrain settings as the one-shot command. The
worker processes queued worlds in order and checks for new work every five
seconds when the queue is empty. A failed export is recorded on the world
and the worker moves on to the next request. SIGTERM or SIGINT lets an
in-flight export finish before shutdown. Use a service supervisor to restart
the worker after infrastructure failures.

The API and worker must both have access to the same `TERRAIN_ROOT`.
`npm run terrain:once` remains available for manual processing.
