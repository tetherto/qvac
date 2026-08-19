import argparse
from pathlib import Path
from typing import Sequence


QUANT_CHOICES = ["f32", "f16", "q8_0", "q5_0", "q4_0"]
DEFAULT_MODEL_STEM = "parakeet-ctc-0.6b"


def parse_args(
    description: str | None = None,
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=description,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--ckpt",
        type=Path,
        default=Path(f"models/{DEFAULT_MODEL_STEM}.nemo"),
        help="Path to .nemo archive (tarball). Downloads from HF if missing.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=(
            "Output GGUF path. Defaults to "
            f"models/{DEFAULT_MODEL_STEM}.<quant>.gguf."
        ),
    )
    parser.add_argument(
        "--quant",
        choices=QUANT_CHOICES,
        default="q8_0",
        help=(
            "Weight dtype for 2D projection matrices. Biases / norms / BN "
            "stay at f32. q8_0 default (~2x smaller than f16, bit-equal "
            "transcripts on clean speech across CTC/TDT/EOU/Sortformer); "
            "pass --quant f16 for the bit-equal floating-point baseline."
        ),
    )
    parser.add_argument(
        "--hf-repo",
        default="nvidia/parakeet-ctc-0.6b",
        help="HF model id to download from if --ckpt is missing.",
    )
    args = parser.parse_args(argv)
    if args.out is None:
        args.out = Path(f"models/{DEFAULT_MODEL_STEM}.{args.quant}.gguf")
    return args
