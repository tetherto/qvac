import sys
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

from converter_args import parse_args


class ConverterArgsTest(unittest.TestCase):
    def test_default_output_uses_default_quantization(self):
        args = parse_args(argv=[])

        self.assertEqual(
            args.out,
            Path("models/parakeet-ctc-0.6b.q8_0.gguf"),
        )

    def test_default_output_tracks_explicit_quantization(self):
        args = parse_args(argv=["--quant", "f16"])

        self.assertEqual(
            args.out,
            Path("models/parakeet-ctc-0.6b.f16.gguf"),
        )

    def test_explicit_output_is_preserved(self):
        output = Path("models/custom-name.gguf")
        args = parse_args(
            argv=["--quant", "q5_0", "--out", str(output)],
        )

        self.assertEqual(args.out, output)


if __name__ == "__main__":
    unittest.main()
