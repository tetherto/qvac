"""
Convert EasyOCR PyTorch checkpoints (.pth) to GGUF.

This is a pure weight conversion: it copies every tensor in the state_dict
into a GGUF file, keeping the original dtype (F32 / I64) or quantizing
F32 weight matrices to a GGML block type (Q8_0 / Q4_K) when --quantize is
passed. The model graph itself is NOT serialized - it must be rebuilt by
the GGML runtime that loads this file (see addon/src/... in this package
for the reference implementations).

The script automatically classifies the input by looking it up in
easyocr.config.detection_models and easyocr.config.recognition_models:

  * detection (CRAFT / DBNet) -> writes only the weights + provenance
    metadata. No vocab is needed because the detector only outputs spatial
    heatmaps.

  * recognition (CRNN gen2) -> additionally embeds:
        crnn.generation        (2)
        crnn.num_classes       (int, == Prediction.bias.shape[0])
        crnn.blank_index       (int, EasyOCR's CTC blank token id = 0)
        crnn.vocab             (string, character set from config.py)
        crnn.symbols           (string, the punctuation/digit subset)
    so the C/C++ runtime can decode CTC outputs without any per-language
    config file.

Self-sufficiency: this script only depends on the upstream `easyocr` pip
package (for its `detection_models` / `recognition_models` registry) plus
`torch`, `numpy`, and `gguf`. See `scripts/requirements.txt` and
`scripts/setup-venv.sh` for one-shot venv provisioning. The previous home
of this file was tetherto/easy-ocr-ggml; that copy is no longer the
source of truth for this package.

Usage:
    python scripts/pth_to_gguf.py <input.pth> <output.gguf> \
        [--arch NAME] [--quantize Q8_0|Q4_K]

If --arch is omitted, the architecture is derived from the input filename.
Pass --arch explicitly only for custom checkpoints not shipped by EasyOCR.
"""

import argparse
import re
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import torch
from gguf import GGUFWriter, GGMLQuantizationType, QuantError, quantize

from easyocr.config import detection_models, recognition_models


MODULE_PREFIX = "module."
CTC_BLANK_INDEX = 0
DEFAULT_QUANTIZE_CHOICES = ["Q8_0", "Q4_K"]


def strip_module_prefix(name: str) -> str:
    """Drop the nn.DataParallel "module." prefix if present."""
    return name[len(MODULE_PREFIX):] if name.startswith(MODULE_PREFIX) else name


def load_state_dict(pth_path: Path) -> dict:
    """
    Load an EasyOCR checkpoint.

    EasyOCR ships plain state_dicts (no optimizer state, no model object),
    so weights_only=True is safe and skips Python unpickling of arbitrary
    objects.
    """
    obj = torch.load(str(pth_path), map_location="cpu", weights_only=True)
    if not isinstance(obj, dict):
        raise TypeError(
            f"Expected a state_dict (OrderedDict), got {type(obj).__name__}. "
            "If this checkpoint contains a full model object, you must load "
            "it with the original nn.Module class first and then pass "
            "model.state_dict() to this script."
        )
    return obj


def to_numpy(t: torch.Tensor) -> np.ndarray:
    """
    Convert a torch tensor to a contiguous numpy view that GGUFWriter accepts.

    GGUFWriter picks the GGML dtype from the numpy dtype:
      float32 -> F32, float16 -> F16, int64 -> I64, int32 -> I32, int8 -> I8.
    EasyOCR only uses float32 and int64, so no extra mapping is needed.
    """
    return t.detach().cpu().contiguous().numpy()


def lookup_metadata(pth_path: Path):
    """
    Find this checkpoint in the EasyOCR config so we can attach the right
    metadata. Returns a dict of fields (or {} if not a known model).

    Detection models -> {'kind': 'detection', 'arch': 'craft'|'dbnet', ...}
    Recognition models -> {'kind': 'recognition', 'arch': 'crnn',
                           'generation': 2, 'characters': '...', 'symbols': '...',
                           'model_key': 'english_g2', ...}
    """
    fname = pth_path.name

    for key, meta in detection_models.items():
        if meta["filename"] == fname:
            arch = "dbnet" if key.startswith("dbnet") else key
            return {
                "kind": "detection",
                "arch": arch,
                "model_key": key,
                "model_name": key,
            }

    for key, meta in recognition_models.get("gen2", {}).items():
        if meta["filename"] == fname:
            return {
                "kind": "recognition",
                "arch": "crnn",
                "generation": 2,
                "model_key": key,
                "model_name": key,
                "characters": meta.get("characters", ""),
                "symbols": meta.get("symbols", ""),
                "script": meta.get("model_script", ""),
            }
    return {}


def resolve_quantization_type(name: str | None) -> GGMLQuantizationType | None:
    if name is None:
        return None
    key = name.upper()
    try:
        return GGMLQuantizationType[key]
    except KeyError as exc:
        valid = ", ".join(DEFAULT_QUANTIZE_CHOICES)
        raise ValueError(
            f"Unsupported --quantize value '{name}'. "
            f"Supported values: {valid}."
        ) from exc


def convert(
    pth_path: Path,
    gguf_path: Path,
    arch_override: str | None,
    quantize_to: str | None = None,
) -> None:
    print(f"\n[load]   {pth_path}")
    state = load_state_dict(pth_path)
    n_total_params = sum(t.numel() for t in state.values() if hasattr(t, "numel"))
    n_tensors = len(state)
    print(f"         {n_tensors} tensors, {n_total_params/1e6:.2f} M params")

    info = lookup_metadata(pth_path)
    if not info:
        print(f"         (file not in easyocr.config; using --arch override or generic 'easyocr')")
    arch = arch_override or info.get("arch", "easyocr")
    kind = info.get("kind", "unknown")
    quant_type = resolve_quantization_type(quantize_to)
    print(f"         arch='{arch}' kind='{kind}'"
          + (f" generation={info['generation']}" if "generation" in info else ""))
    if quant_type is not None:
        print(f"         quantize={quant_type.name} (weights only; biases stay F32)")

    print(f"[write]  {gguf_path}")
    writer = GGUFWriter(str(gguf_path), arch)

    writer.add_string("general.name", info.get("model_name", pth_path.stem))
    writer.add_description(
        "EasyOCR weights converted from PyTorch .pth. "
        "Tensor names match the bare nn.Module attribute paths (no 'module.' prefix). "
        "Graph must be reconstructed by the GGML runtime; see the addon source "
        "for the reference forward passes (CRAFT detector + CRNN recognizer)."
    )
    writer.add_file_type(0)
    writer.add_custom_alignment(32)

    writer.add_string("conversion.source_file", pth_path.name)
    writer.add_string("conversion.source_format", "pytorch_state_dict")
    writer.add_string("conversion.tool", "packages/ocr-ggml/scripts/pth_to_gguf.py")
    writer.add_string("conversion.timestamp", dt.datetime.now(dt.timezone.utc).isoformat())
    writer.add_uint32("conversion.num_tensors", n_tensors)
    writer.add_uint64("conversion.num_parameters", n_total_params)
    writer.add_string("conversion.quantize", quant_type.name if quant_type else "F32")
    try:
        import easyocr
        writer.add_string("easyocr.version", getattr(easyocr, "__version__", "unknown"))
    except (ImportError, AttributeError):
        writer.add_string("easyocr.version", "unknown")

    if info.get("kind") == "recognition":
        chars = info["characters"]
        num_class_from_vocab = len(chars) + 1
        writer.add_uint32("crnn.generation", info["generation"])
        writer.add_uint32("crnn.num_classes", num_class_from_vocab)
        writer.add_uint32("crnn.blank_index", CTC_BLANK_INDEX)
        writer.add_string("crnn.vocab", chars)
        writer.add_string("crnn.symbols", info["symbols"])
        if info.get("script"):
            writer.add_string("crnn.script", info["script"])
        print(f"         crnn vocab: {len(chars)} chars (+1 blank = {num_class_from_vocab} classes)")

    dtype_counts: dict[str, int] = {}
    qtype_counts: dict[str, int] = {}
    n_skipped = 0
    n_quantized = 0
    n_quantize_fallback = 0
    for raw_name, tensor in state.items():
        clean_name = strip_module_prefix(raw_name)
        # `num_batches_tracked` is a BatchNorm2d bookkeeping scalar with no
        # effect on inference. Skip it; it's also one of the longest names
        # in deeper models and can exceed ggml's
        # GGUF_MAX_TENSOR_NAME_LEN (64) when prefixes get long.
        if clean_name.endswith(".num_batches_tracked"):
            n_skipped += 1
            continue
        arr = to_numpy(tensor)
        if (
            quant_type is not None
            and arr.dtype == np.float32
            and arr.ndim >= 2
        ):
            try:
                qarr = quantize(arr, quant_type)
                writer.add_tensor(
                    clean_name,
                    qarr,
                    raw_dtype=quant_type,
                )
                n_quantized += 1
                qtype_counts[quant_type.name] = qtype_counts.get(quant_type.name, 0) + 1
                continue
            except (QuantError, NotImplementedError, ValueError):
                n_quantize_fallback += 1
        writer.add_tensor(clean_name, arr)
        dtype_counts[str(arr.dtype)] = dtype_counts.get(str(arr.dtype), 0) + 1
    if n_skipped:
        print(f"         skipped {n_skipped} BN num_batches_tracked scalars")
    if n_quantized:
        print(f"         quantized {n_quantized} tensors to {quant_type.name}")
    if n_quantize_fallback:
        print(f"         fallback to F32 for {n_quantize_fallback} tensors (unsupported shape/type)")

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    if info.get("kind") == "recognition":
        pred_bias = state.get("module.Prediction.bias", state.get("Prediction.bias"))
        if pred_bias is not None:
            n_class_from_weights = pred_bias.shape[0]
            if n_class_from_weights != num_class_from_vocab:
                print(
                    f"         WARNING: vocab implies {num_class_from_vocab} classes "
                    f"but Prediction.bias has {n_class_from_weights}. "
                    f"Check that the right character string was selected."
                )

    size_mb = gguf_path.stat().st_size / (1024 * 1024)
    print(
        f"         done. dtypes={dtype_counts}, quantized={qtype_counts}, "
        f"file size={size_mb:.1f} MiB"
    )


_ARCH_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _arch_arg(value: str) -> str:
    """Restrict --arch to a conservative identifier set so it cannot be used
    to inject arbitrary bytes into GGUF metadata."""
    if not _ARCH_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"--arch must match {_ARCH_RE.pattern} (got: {value!r})"
        )
    return value


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Convert an EasyOCR .pth checkpoint to GGUF.")
    p.add_argument("input", type=Path, help="Path to the .pth file")
    p.add_argument("output", type=Path, help="Path to the .gguf file to write")
    p.add_argument(
        "--arch",
        default=None,
        type=_arch_arg,
        help="Architecture tag stored in general.architecture. "
             "Auto-detected from easyocr.config when the filename matches a "
             "shipped model. Pass explicitly only for custom checkpoints.",
    )
    p.add_argument(
        "--quantize",
        default=None,
        choices=DEFAULT_QUANTIZE_CHOICES,
        help="Optional GGML weight quantization. Applies to float tensors with "
             "rank >= 2. Bias vectors and unsupported tensors remain F32.",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if not args.input.is_file():
        print(f"error: input file not found: {args.input}", file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)

    convert(args.input, args.output, args.arch, args.quantize)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
