#!/usr/bin/env python3
"""Convert the supported MegaLoc safetensors checkpoint to a local GGUF.

Requires numpy, torch, safetensors and Fabric's gguf-py package. Mixed precision
also needs --ggml-library pointing to a shared GGML core with Q6_K quantization.
No model code is downloaded or executed, and no output is uploaded.
"""
import argparse
import ctypes
import hashlib
import os
from pathlib import Path
import sys
import tempfile

REVISION = "a0f34722c4297ff787e022433799250180860af7"
CHECKPOINT_SHA256 = "d4f9f2bcb60018f91eb6a8e061ed054fd55654e10c2569cf13841ea986ffb4f8"
SOURCE_URL = f"https://huggingface.co/gberton/MegaLoc/resolve/{REVISION}/model.safetensors"


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, epilog=f"Original checkpoint: {SOURCE_URL}")
    parser.add_argument("--input", required=True, type=Path, help="Original model.safetensors")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--quant", choices=["f16", "mixed"], default="f16",
                        help="mixed: F16 body and Q6_K final projection; default: f16")
    parser.add_argument("--gguf-py", type=Path, help="Path to Fabric's gguf-py directory")
    parser.add_argument("--ggml-library", type=Path, help="Shared GGML core for the native Q6_K quantizer")
    return parser.parse_args()


def native_quantizer(path):
    if path is None:
        raise ValueError("--ggml-library is required for mixed precision")
    path = path.resolve(strict=True)
    directory = os.add_dll_directory(str(path.parent)) if os.name == "nt" else None
    library = ctypes.CDLL(str(path))
    library.ggml_quantize_chunk.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                                           ctypes.c_int64, ctypes.c_int64, ctypes.c_int64, ctypes.c_void_p]
    library.ggml_quantize_chunk.restype = ctypes.c_size_t
    library.ggml_row_size.argtypes = [ctypes.c_int, ctypes.c_int64]
    library.ggml_row_size.restype = ctypes.c_size_t
    return library, directory


def convert(args):
    if args.gguf_py:
        sys.path.insert(0, str(args.gguf_py.resolve(strict=True)))
    import gguf
    import numpy as np
    import torch
    from safetensors import safe_open

    if args.output.exists():
        raise FileExistsError(f"Output already exists: {args.output}")
    with args.input.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != CHECKPOINT_SHA256:
        raise ValueError("Checkpoint does not match the supported MegaLoc revision and SHA256")
    library, directory = native_quantizer(args.ggml_library) if args.quant == "mixed" else (None, None)
    torch.set_num_threads(8)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Build next to the destination so rename publishes only a complete file.
    descriptor, temporary = tempfile.mkstemp(prefix=args.output.name + ".", suffix=".tmp", dir=args.output.parent)
    os.close(descriptor)
    temporary = Path(temporary)
    writer = None
    try:
        writer = gguf.GGUFWriter(str(temporary), "megaloc", use_temp_file=True)
        writer.add_name("MegaLoc")
        writer.add_string("general.license", "MIT")
        writer.add_string("megaloc.source.url", SOURCE_URL)
        writer.add_string("megaloc.source.sha256", digest)
        writer.add_string("megaloc.quantization", args.quant)
        writer.add_uint32("megaloc.image_size", 322)
        writer.add_uint32("megaloc.descriptor_length", 8448)
        with safe_open(args.input, framework="pt", device="cpu") as checkpoint:
            position = checkpoint.get_tensor("backbone.pos_embed").float()
            if tuple(position.shape) != (1, 1370, 768):
                raise ValueError("Unexpected positional embedding shape")
            with torch.inference_mode():
                grid = position[:, 1:].reshape(1, 37, 37, 768).permute(0, 3, 1, 2)
                resized = torch.nn.functional.interpolate(grid, scale_factor=(23.1 / 37, 23.1 / 37),
                                                          mode="bicubic", align_corners=False, antialias=False)
                positions = torch.cat((position[:, :1], resized.permute(0, 2, 3, 1).reshape(1, 529, 768)), 1)
            writer.add_tensor("megaloc.pos_embed", positions.squeeze(0).numpy())
            for name in checkpoint.keys():
                if name == "backbone.pos_embed":
                    continue
                array = checkpoint.get_tensor(name).float().numpy()
                if not np.isfinite(array).all():
                    raise ValueError(f"Non-finite checkpoint tensor: {name}")
                if name.endswith(".weight") and array.ndim == 4:
                    array = array.reshape(array.shape[0], -1)
                elif name == "backbone.cls_token":
                    array = array.reshape(-1)
                elif array.ndim == 0:
                    array = array.reshape(1)
                matrix = name.endswith(".weight") and array.ndim == 2 and "patch_embed" not in name
                if args.quant == "mixed" and name == "aggregator.linear.weight":
                    kind = gguf.GGMLQuantizationType.Q6_K
                    rows, width = array.shape
                    row_bytes = library.ggml_row_size(int(kind), width)
                    raw = np.empty((rows, row_bytes), dtype=np.uint8)
                    count = library.ggml_quantize_chunk(int(kind), array.ctypes.data, raw.ctypes.data,
                                                        0, rows, width, None)
                    if count != raw.nbytes:
                        raise RuntimeError("GGML Q6_K quantization returned an unexpected size")
                    writer.add_tensor(name, raw, raw_dtype=kind)
                else:
                    writer.add_tensor(name, array.astype(np.float16) if matrix else array)
        writer.write_header_to_file()
        writer.write_kv_data_to_file()
        writer.write_tensors_to_file(progress=False)
        writer.close()
        writer = None
        os.link(temporary, args.output)
    finally:
        if writer is not None:
            writer.close()
        temporary.unlink(missing_ok=True)
        if directory is not None:
            directory.close()
    print(f"Created {args.output} ({args.quant}, {args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    convert(arguments())
