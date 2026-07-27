#!/usr/bin/env python3
"""Quantize a merged GR00T `groot.gguf` per a named profile, writing
`groot-<profile>.gguf`. Standalone + re-runnable: the merge step stays a pure
byte-copy, quantization is a separate profile-parameterized pass so we can sweep
types and gate each against the milestone parity tests (M4.x).

WHAT MUST STAY UNQUANTIZED (verified against groot.cpp weight usage — quantizing
any of these produces silent garbage, not a graceful degrade):

  1. `v.patch_embd.*` and `v.position_embd.weight` — read via RAW HOST
     MEMORY in grootBuildPatchEmbedLinear / grootBuildVisionPosEmbed
     (`static_cast<const float*>(t->data)` + `ggml_fp16_to_fp32`), which only
     understands F32/F16. A Q8_0 block layout read as F16 = garbage.
  2. `embodiment.*` weights — consumed via grootLinearXW, which does
     `ggml_cont(ggml_transpose(weight))`. ggml cannot make a *transposed*
     quantized tensor contiguous (quant blocks span the reduction axis), so
     these must remain F16/F32. They are single-embodiment and tiny anyway.
  3. Any 1-D tensor (norms, biases) — per-element math, negligible size, and
     Q8_0 requires the blocked axis be a multiple of 32.

Everything else (text/vision transformer blocks, `token_embd` via get_rows,
`dit.blk.*`, `vlfusion.*`, timestep MLPs, proj_out) flows through plain
`grootLinear` = `ggml_mul_mat(W, x)`, which dequantizes W natively — safe to
quantize. That bulk is ~8.7GB of the 8.9GB file.

Usage:
    python quantize_groot_gguf.py --in groot.gguf --profile q8_vf16
    # -> groot-q8_vf16.gguf  (3.76GB desktop model of record; see README table)
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import numpy as np
import gguf
from gguf import GGUFReader, GGUFValueType, GGMLQuantizationType as QT
from gguf import quants


# Tensor-name substrings that must NEVER be quantized (see module docstring).
KEEP_UNQUANTIZED = (
    "patch_embd",           # raw host read (conv halves): v.patch_embd.weight{,.1}
    "position_emb",         # raw host read: v.position_embd.weight (bilinear pos
                            # table). Also matches dit.position_embedding.weight
                            # (tiny; kept out of caution).
    "embodiment.",          # grootLinearXW transpose+cont — quant can't cont
)


# Map a tensor (by name) to a target quant type, or None = keep as-is.
# `q8_0` quantizes every eligible 2-D weight matrix to Q8_0 (the conservative
# floor). `q8_vf16` / `q5_vf16` / `q4_vf16` keep the vision tower at F16 (see
# below) and quantize the rest to Q8_0 / Q5_0 / Q4_0 respectively. `q8_vf16`
# is the desktop model of record; `q5_vf16` is the mobile profile (Q4_0 is too
# coarse for LIBERO's DiT action head — see below); `q4_vf16` is a backup.
# K-quants (Q4_K/Q5_K/Q6_K) are
# NOT usable: gguf-py's `quants.quantize` packer only implements the legacy
# Q4_0/Q4_1/Q5_0/Q8_0 layouts, so Q4_0 is the mobile floor until a K-quant
# packer (or a groot arch stub for the llama-quantize CLI) lands.
def target_type(name: str, ndim: int, ne0: int, profile: str) -> QT | None:
    if any(s in name for s in KEEP_UNQUANTIZED):
        return None
    if ndim < 2:            # norms, biases, 1-D — keep
        return None
    # The vision tower (`v.blk.*` + the `mm.*` mergers) is the one quant-sensitive
    # subgraph: 24 LayerNorm blocks accumulate error with no massive-activation
    # outlier to anchor cosine (unlike the text decoder). Q8_0 there pushes the
    # merged-vision parity gate from cos 0.999/rel4.6% (F16 floor) to 0.9958/9.6%
    # — the final *actions* are still cos 0.99999 (DiT washes it out), but the
    # intermediate M4.5/M4.6 gates fail. `q8_vf16`/`q4_vf16` keep vision at F16
    # (~+0.4GB) and quantize everything else, restoring every parity gate.
    if profile in ("q8_vf16", "q4_vf16", "q5_vf16") and (
        name.startswith("v.") or name.startswith("mm.")
    ):
        return None
    if profile in ("q8_0", "q8_vf16"):
        # Q8_0 blocks the reduction axis (ne0) in groups of 32.
        return QT.Q8_0 if ne0 % 32 == 0 else None
    if profile == "q5_vf16":
        # Q5_0 also blocks ne0 in 32. Q4_0 is too coarse for LIBERO's action
        # head (a low-magnitude action channel hits ~20% rel error); Q5_0's
        # extra bit restores parity at ~2.7 GB (vs 2.4 GB Q4_0).
        return QT.Q5_0 if ne0 % 32 == 0 else None
    if profile == "q4_vf16":
        # Q4_0 also blocks ne0 in groups of 32.
        return QT.Q4_0 if ne0 % 32 == 0 else None
    raise ValueError(f"unknown profile: {profile}")


def copy_metadata(reader: GGUFReader, writer: gguf.GGUFWriter):
    for field in reader.fields.values():
        if field.name.startswith("GGUF."):
            continue
        if field.name == "general.architecture":
            continue
        value_type = field.types[0]
        if len(field.types) > 1:
            arr_type = field.types[1]
            values = [field.parts[i] for i in field.data]
            if arr_type == GGUFValueType.STRING:
                values = [bytes(v).decode("utf-8") for v in values]
            else:
                values = [v.tolist()[0] if hasattr(v, "tolist") else v for v in values]
            writer.add_array(field.name, values)
        elif value_type == GGUFValueType.STRING:
            writer.add_string(field.name, bytes(field.parts[field.data[0]]).decode("utf-8"))
        else:
            v = field.parts[field.data[0]]
            v = v.tolist()[0] if hasattr(v, "tolist") else v
            writer.add_key_value(field.name, v, value_type)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="inp", required=True, type=Path)
    ap.add_argument(
        "--profile",
        default="q8_vf16",
        choices=["q8_0", "q8_vf16", "q5_vf16", "q4_vf16"],
    )
    ap.add_argument("--out", type=Path,
                    help="default: groot-<profile>.gguf next to --in")
    args = ap.parse_args()

    out = args.out or args.inp.with_name(f"groot-{args.profile}.gguf")
    reader = GGUFReader(str(args.inp))
    writer = gguf.GGUFWriter(str(out), "groot")
    copy_metadata(reader, writer)

    n_quant = 0
    n_keep = 0
    bytes_in = 0
    bytes_out = 0
    for t in reader.tensors:
        data = np.asarray(t.data)
        ndim = data.ndim
        ne0 = data.shape[-1]        # gguf numpy last axis == ggml ne[0] (reduction)
        tgt = target_type(t.name, ndim, ne0, args.profile)
        src_bytes = int(data.nbytes)
        bytes_in += src_bytes
        if tgt is None:
            # Keep original type (F16/F32) — add_tensor infers from numpy dtype.
            writer.add_tensor(t.name, data)
            bytes_out += src_bytes
            n_keep += 1
        else:
            f32 = data.astype(np.float32)
            q = quants.quantize(f32, tgt)
            # q is packed uint8 (…, bytes_per_row); raw_dtype tells the writer the
            # logical shape. Passing raw_shape here would be misread as a byte count.
            writer.add_tensor(t.name, q, raw_dtype=tgt)
            bytes_out += int(q.nbytes)
            n_quant += 1

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    print(f"profile={args.profile}  quantized={n_quant}  kept={n_keep}")
    print(f"tensor bytes: {bytes_in/1e9:.2f}GB -> {bytes_out/1e9:.2f}GB "
          f"({bytes_in/max(bytes_out,1):.2f}x)")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
