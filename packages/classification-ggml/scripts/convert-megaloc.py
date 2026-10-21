#!/usr/bin/env python3
"""Convert the supported MegaLoc safetensors checkpoint to a local GGUF.

Requires numpy, safetensors and Fabric's gguf-py package. Mixed precision
also needs --ggml-library pointing to a shared GGML core with Q6_K quantization.
No model code is downloaded or executed, and no output is uploaded.
"""
import argparse
import ctypes
import errno
import hashlib
import os
from pathlib import Path
import shutil
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


def position_embeddings(position):
    import numpy as np

    if position.shape != (1, 1370, 768):
        raise ValueError("Unexpected positional embedding shape")
    # Fixed-order float64 bicubic interpolation avoids CPU-specific FP32 fusion.
    coordinates = (np.arange(23, dtype=np.float64) + 0.5) * (1.0 / (23.1 / 37)) - 0.5
    indices = np.floor(coordinates).astype(np.int64)[:, None] + np.arange(-1, 3)
    distance = np.abs(coordinates[:, None] - indices)
    inner = ((1.25 * distance - 2.25) * distance) * distance + 1.0
    outer = ((-0.75 * distance + 3.75) * distance - 6.0) * distance + 3.0
    weights = np.where(distance <= 1, inner, np.where(distance < 2, outer, 0.0))
    indices = np.clip(indices, 0, 36)
    grid = position[0, 1:].reshape(37, 37, 768).astype(np.float64)
    horizontal = np.zeros((37, 23, 768), dtype=np.float64)
    for tap in range(4):
        horizontal += grid[:, indices[:, tap], :] * weights[None, :, tap, None]
    resized = np.zeros((23, 23, 768), dtype=np.float64)
    for tap in range(4):
        resized += horizontal[indices[:, tap], :, :] * weights[:, tap, None, None]
    return np.concatenate((position[0, :1], resized.reshape(529, 768).astype(np.float32)))


def publish(temporary, output):
    try:
        os.link(temporary, output)
        return
    except FileExistsError:
        raise
    except OSError as error:
        if error.errno not in {errno.ENOSYS, errno.ENOTSUP, errno.EPERM, errno.EXDEV} and \
                getattr(error, "winerror", None) not in {1, 50, 1314}:
            raise
    with temporary.open("rb") as source:
        destination = output.open("xb")
        try:
            with destination:
                shutil.copyfileobj(source, destination, 8 * 1024 * 1024)
        except BaseException:
            output.unlink()
            raise


def convert(args):
    if args.gguf_py:
        sys.path.insert(0, str(args.gguf_py.resolve(strict=True)))
    import gguf
    import numpy as np
    from safetensors import safe_open

    if args.output.exists():
        raise FileExistsError(f"Output already exists: {args.output}")
    with args.input.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != CHECKPOINT_SHA256:
        raise ValueError("Checkpoint does not match the supported MegaLoc revision and SHA256")
    library, directory = native_quantizer(args.ggml_library) if args.quant == "mixed" else (None, None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Prefer publishing a complete file without replacing an existing output.
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
        writer.add_uint32("megaloc.converter.version", 1)
        with safe_open(args.input, framework="np") as checkpoint:
            writer.add_tensor("megaloc.pos_embed", position_embeddings(checkpoint.get_tensor("backbone.pos_embed")))
            for name in checkpoint.keys():
                if name == "backbone.pos_embed":
                    continue
                array = checkpoint.get_tensor(name).astype(np.float32, copy=False)
                flat = array.reshape(-1)
                for start in range(0, flat.size, 1024 * 1024):
                    if not np.isfinite(flat[start:start + 1024 * 1024]).all():
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
        publish(temporary, args.output)
    finally:
        if writer is not None:
            writer.close()
        temporary.unlink(missing_ok=True)
        if directory is not None:
            directory.close()
    print(f"Created {args.output} ({args.quant}, {args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    convert(arguments())
