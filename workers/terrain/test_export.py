import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from osgeo import gdal, osr

from export import export

gdal.UseExceptions()


class TerrainExportTest(unittest.TestCase):
    def test_chunks_share_edges_and_reject_missing_coverage(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            src = root / "source.tif"
            grid = gdal.GetDriverByName("GTiff").Create(str(src), 128, 128, 1, gdal.GDT_Float32)
            crs = osr.SpatialReference()
            crs.ImportFromProj4("+proj=aeqd +lat_0=25 +lon_0=51 +datum=WGS84 +units=m +no_defs")
            grid.SetProjection(crs.ExportToWkt())
            grid.SetGeoTransform((-1600, 25, 0, 1600, 0, -25))
            row, col = np.indices((128, 128))
            grid.GetRasterBand(1).WriteArray(row + 2 * col)
            grid = None

            output = root / "world"
            export(src, "test-dem/1", 25, 51, 4, output)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(len(manifest["chunks"]), 4)
            self.assertEqual(manifest["samplesPerChunkAxis"], 33)
            self.assertEqual(manifest["sampleSpacingMeters"], 31.25)

            def heights(x, y):
                return np.fromfile(output / f"height-{x}-{y}.f32", dtype="<f4").reshape(33, 33)

            northwest = heights(0, 0)
            self.assertLess(northwest[0, 0], northwest[-1, -1])
            np.testing.assert_array_equal(northwest[:, -1], heights(1, 0)[:, 0])
            np.testing.assert_array_equal(northwest[-1, :], heights(0, 1)[0, :])

            missing = root / "missing"
            with self.assertRaisesRegex(ValueError, "does not cover"):
                export(src, "test-dem/1", 26, 51, 4, missing)
            self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
