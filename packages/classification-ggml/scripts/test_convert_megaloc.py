import importlib.util
import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location("convert_megaloc", Path(__file__).with_name("convert-megaloc.py"))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class PositionEmbeddingTests(unittest.TestCase):
    def test_constant_grid_and_class_token_are_preserved(self):
        positions = np.full((1, 1370, 768), .25, dtype=np.float32)
        positions[0, 0] = np.arange(768, dtype=np.float32)
        result = converter.position_embeddings(positions)
        self.assertEqual(result.shape, (530, 768))
        self.assertEqual(result.dtype, np.float32)
        np.testing.assert_array_equal(result[0], positions[0, 0])
        np.testing.assert_array_equal(result[1:], .25)

    def test_original_coordinates_and_cubic_kernel(self):
        positions = np.zeros((1, 1370, 768), dtype=np.float32)
        grid = positions[0, 1:].reshape(37, 37, 768)
        grid[:, :, 0] = np.arange(37)[None, :]
        grid[:, :, 1] = np.arange(37)[:, None]
        result = converter.position_embeddings(positions)[1:].reshape(23, 23, 768)
        # Original PyTorch float64 bicubic reference, rounded to F32.
        expected = np.array([0.2324579656124115, 1.867202877998352, 3.503246784210205,
                             5.143410682678223, 6.664815902709961, 8.350232124328613,
                             9.877997398376465, 11.509742736816406, 13.153846740722656,
                             14.672478675842285, 16.35762596130371, 17.88897705078125,
                             19.51624298095703, 21.16411018371582, 22.680238723754883,
                             24.36493682861328, 25.900146484375, 27.522754669189453,
                             29.174203872680664, 30.688098907470703, 32.37217330932617,
                             33.91150665283203, 35.629722595214844], dtype=np.float32)
        np.testing.assert_allclose(result[0, :, 0], expected, rtol=0, atol=1e-6)
        np.testing.assert_allclose(result[:, 0, 1], expected, rtol=0, atol=1e-6)
        np.testing.assert_array_equal(result[:, :, 2:], 0)

    def test_wrong_input_shape_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "shape"):
            converter.position_embeddings(np.zeros((1, 530, 768), dtype=np.float32))


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "model.tmp"
        self.output = Path(self.directory.name) / "model.gguf"
        self.source.write_bytes(b"GGUF test data")

    def test_hardlink_publishes_complete_file(self):
        converter.publish(self.source, self.output)
        self.assertEqual(self.source.read_bytes(), self.output.read_bytes())

    def test_unsupported_links_fall_back_to_exclusive_copy(self):
        with patch.object(converter.os, "link", side_effect=OSError(errno.ENOTSUP, "unsupported")):
            converter.publish(self.source, self.output)
        self.assertEqual(self.source.read_bytes(), self.output.read_bytes())

    def test_existing_output_is_preserved_on_both_paths(self):
        self.output.write_bytes(b"existing")
        for error in [FileExistsError(errno.EEXIST, "exists"), OSError(errno.ENOTSUP, "unsupported")]:
            with self.subTest(error=error), patch.object(converter.os, "link", side_effect=error):
                with self.assertRaises(FileExistsError):
                    converter.publish(self.source, self.output)
                self.assertEqual(self.output.read_bytes(), b"existing")

    def test_failed_copy_removes_partial_output_and_retains_source(self):
        def failed_copy(source, destination, length):
            destination.write(source.read(4))
            raise OSError(errno.ENOSPC, "disk full")

        with patch.object(converter.os, "link", side_effect=OSError(errno.ENOTSUP, "unsupported")), \
                patch.object(converter.shutil, "copyfileobj", side_effect=failed_copy):
            with self.assertRaisesRegex(OSError, "disk full"):
                converter.publish(self.source, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.source.read_bytes(), b"GGUF test data")

    def test_unrelated_errors_are_not_masked(self):
        with patch.object(converter.os, "link", side_effect=OSError(errno.ENOSPC, "disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                converter.publish(self.source, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
