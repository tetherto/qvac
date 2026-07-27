#!/usr/bin/env python3
"""LAM Audio2Expression PyTorch checkpoint -> GGUF converter.

Reads the upstream ``lam_audio2exp_streaming.tar`` checkpoint (Apache-2.0,
https://github.com/aigc3d/LAM_Audio2Expression) and emits a single GGUF
consumed by the isolated LAM-A2E target in qvac-ext-stable-diffusion.cpp,
which `@qvac/diffusion-cpp` exposes as the `LamAudio2Expression` class.

See `_lam_a2e_arch.py` for the tensor name map and metadata layout, and
`README-lam-a2e.md` for the end-to-end workflow.

Usage:
    npm run convert:lam-a2e -- \
        --checkpoint pretrained_models/lam_audio2exp_streaming.tar \
        --out models/lam-audio2exp-f32.gguf --dtype f32
"""

from __future__ import annotations

import argparse

import torch

from _lam_a2e_arch import fold_pos_conv_weight_norm, is_skipped, strip_prefix, write_gguf


def load_state(checkpoint_path: str) -> dict:
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    state = {}
    for key, value in ckpt["state_dict"].items():
        key = strip_prefix(key)
        if is_skipped(key):
            continue
        state[key] = value.detach().cpu().float().numpy()
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--dtype", choices=["f32", "f16"], default="f32")
    args = parser.parse_args()

    state = fold_pos_conv_weight_norm(load_state(args.checkpoint))
    write_gguf(state, args.out, args.dtype)


if __name__ == "__main__":
    main()
