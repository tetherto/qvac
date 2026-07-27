#!/usr/bin/env python3
"""Remap a raw LAM-A2E GGUF (PyTorch/backbone tensor names) into the
``lam-audio2exp`` dialect that `@qvac/diffusion-cpp` loads.

Use this when a GGUF was produced by a generic state-dict dumper and still
carries the original checkpoint tensor names. If you have the upstream
``.tar`` checkpoint instead, use `convert-lam-a2e-to-gguf.py` directly —
this script is the no-torch fallback (numpy + gguf only).

Usage:
    ./venv/bin/python scripts/remap-lam-a2e-gguf.py \
        --in raw-lam-a2e.gguf --out models/lam-audio2exp-f32.gguf --dtype f32
"""

from __future__ import annotations

import argparse

import numpy as np
from gguf import GGUFReader

from _lam_a2e_arch import fold_pos_conv_weight_norm, is_skipped, strip_prefix, write_gguf


def load_state(gguf_path: str) -> dict:
    reader = GGUFReader(gguf_path)
    state = {}
    for tensor in reader.tensors:
        key = strip_prefix(tensor.name)
        if is_skipped(key):
            continue
        state[key] = np.array(tensor.data, dtype=np.float32, copy=True)
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--in", dest="inp", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dtype", choices=["f32", "f16"], default="f32")
    args = parser.parse_args()

    state = fold_pos_conv_weight_norm(load_state(args.inp))
    write_gguf(state, args.out, args.dtype)


if __name__ == "__main__":
    main()
