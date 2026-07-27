#!/usr/bin/env python3
"""Generate a tiny random-weight `lam-audio2exp` GGUF for tests.

The real checkpoint is ~390MB, needs a GPU box to produce reference
activations, and cannot be committed. But most regressions worth catching in CI
are structural — wrong frame count, wrong coefficient count, NaNs, a tensor the
loader can no longer find — and none of those need trained weights.

The engine reads every layer width from GGUF KV, so this emits the same
architecture at a fraction of the width: same tensor names, same metadata keys,
same feature-extractor kernels and strides (so the 16kHz -> 50Hz -> 30fps time
axis stays exact), just narrow layers filled with deterministic noise. The
result is well under a megabyte and builds in about a second.

Weights are seeded, so the file is byte-reproducible for a given seed.

This is NOT a substitute for numerical parity against the PyTorch reference —
random weights say nothing about correctness of the math. It is the cheap tier
that runs on every PR.

    python scripts/make-tiny-lam-a2e-gguf.py --out models/lam-a2e-tiny.gguf
"""

from __future__ import annotations

import argparse

import numpy as np

from _lam_a2e_arch import (
    FE_KERNELS,
    N_COEFFS,
    POS_CONV_WEIGHT,
    Dims,
    write_gguf,
)

# Narrow enough to be fast, wide enough that a transposed matmul still fails
# loudly: every dimension below is distinct, so a swapped axis cannot broadcast
# its way to a passing test.
TINY_DIMS = Dims(
    n_identity=12,  # bounds identityIndex; keep real so index tests are honest
    identity_feat_dim=16,
    hidden_dim=32,
    window_frames=64,
    enc_layers=2,
    enc_heads=4,
    enc_hidden=64,
    enc_ffn=128,
    pos_conv_kernel=16,
    pos_conv_groups=4,
)

FE_CHANNELS = 40
HEAD_FIRST_CHANNELS = 24
HEAD_DEC_CHANNELS = 20
CONV_NORM_RELU_KERNEL = 3


def build_state(dims: Dims, rng: np.random.Generator) -> dict[str, np.ndarray]:
    """Random tensors keyed by *checkpoint* name, for `write_gguf` to remap.

    Going through the same name map as the real converter is the point: if a
    tensor is renamed upstream, the tiny model stops building too.
    """

    def w(*shape: int) -> np.ndarray:
        # Small values keep the untrained forward pass away from inf/NaN, which
        # would make a finiteness assertion pass or fail for the wrong reason.
        return rng.standard_normal(shape).astype(np.float32) * 0.02

    def ones(n: int) -> np.ndarray:
        return np.ones(n, dtype=np.float32)

    def zeros(n: int) -> np.ndarray:
        return np.zeros(n, dtype=np.float32)

    state: dict[str, np.ndarray] = {}

    # --- wav2vec2 feature extractor: 1 -> FE_CHANNELS, real kernels/strides ---
    for i, k in enumerate(FE_KERNELS):
        c_in = 1 if i == 0 else FE_CHANNELS
        state[f"audio_encoder.feature_extractor.conv_layers.{i}.conv.weight"] = w(FE_CHANNELS, c_in, k)
    state["audio_encoder.feature_extractor.conv_layers.0.layer_norm.weight"] = ones(FE_CHANNELS)
    state["audio_encoder.feature_extractor.conv_layers.0.layer_norm.bias"] = zeros(FE_CHANNELS)

    # --- feature projection: FE_CHANNELS -> enc_hidden ---
    state["audio_encoder.feature_projection.layer_norm.weight"] = ones(FE_CHANNELS)
    state["audio_encoder.feature_projection.layer_norm.bias"] = zeros(FE_CHANNELS)
    state["audio_encoder.feature_projection.projection.weight"] = w(dims.enc_hidden, FE_CHANNELS)
    state["audio_encoder.feature_projection.projection.bias"] = zeros(dims.enc_hidden)

    # --- positional conv (grouped) + encoder pre-norm ---
    # Already folded: the tiny model never carries weight_g/weight_v.
    state[POS_CONV_WEIGHT] = w(
        dims.enc_hidden, dims.enc_hidden // dims.pos_conv_groups, dims.pos_conv_kernel
    )
    state["audio_encoder.encoder.pos_conv_embed.conv.bias"] = zeros(dims.enc_hidden)
    state["audio_encoder.encoder.layer_norm.weight"] = ones(dims.enc_hidden)
    state["audio_encoder.encoder.layer_norm.bias"] = zeros(dims.enc_hidden)

    # --- transformer encoder ---
    for i in range(dims.enc_layers):
        src = f"audio_encoder.encoder.layers.{i}"
        for proj in ("q", "k", "v", "out"):
            state[f"{src}.attention.{proj}_proj.weight"] = w(dims.enc_hidden, dims.enc_hidden)
            state[f"{src}.attention.{proj}_proj.bias"] = zeros(dims.enc_hidden)
        state[f"{src}.layer_norm.weight"] = ones(dims.enc_hidden)
        state[f"{src}.layer_norm.bias"] = zeros(dims.enc_hidden)
        state[f"{src}.feed_forward.intermediate_dense.weight"] = w(dims.enc_ffn, dims.enc_hidden)
        state[f"{src}.feed_forward.intermediate_dense.bias"] = zeros(dims.enc_ffn)
        state[f"{src}.feed_forward.output_dense.weight"] = w(dims.enc_hidden, dims.enc_ffn)
        state[f"{src}.feed_forward.output_dense.bias"] = zeros(dims.enc_hidden)
        state[f"{src}.final_layer_norm.weight"] = ones(dims.enc_hidden)
        state[f"{src}.final_layer_norm.bias"] = zeros(dims.enc_hidden)

    # --- LAM head: encoder features + identity embedding -> 52 coefficients ---
    state["feature_projection.weight"] = w(dims.hidden_dim, dims.enc_hidden)
    state["feature_projection.bias"] = zeros(dims.hidden_dim)

    # Reshaped by the loader to [n_identity, identity_feat_dim], so only the
    # element count has to line up.
    state["identity_encoder.id_mlp.weight"] = w(dims.identity_feat_dim, dims.n_identity)
    state["identity_encoder.id_mlp.bias"] = zeros(dims.identity_feat_dim)

    # Encoder features and the broadcast identity vector are concatenated on
    # the channel axis before the head convolutions.
    concat_channels = dims.hidden_dim + dims.identity_feat_dim

    k = CONV_NORM_RELU_KERNEL
    first_shapes = [
        (HEAD_FIRST_CHANNELS, concat_channels),
        (HEAD_FIRST_CHANNELS, HEAD_FIRST_CHANNELS),  # identity residual: in == out
        (HEAD_FIRST_CHANNELS, HEAD_FIRST_CHANNELS),
    ]
    for i, (c_out, c_in) in enumerate(first_shapes):
        src = f"identity_encoder.first_net.conv_layers.{i}"
        state[f"{src}.conv.weight"] = w(c_out, c_in, k)
        state[f"{src}.conv.bias"] = zeros(c_out)
        state[f"{src}.norm.weight"] = ones(c_out)
        state[f"{src}.norm.bias"] = zeros(c_out)

    # Projection shortcut around the first block, applied to its input.
    state["identity_encoder.first_net.conv_layers.0.residual_layer.0.weight"] = w(
        HEAD_FIRST_CHANNELS, concat_channels, k
    )
    state["identity_encoder.first_net.conv_layers.0.residual_layer.0.bias"] = zeros(HEAD_FIRST_CHANNELS)

    dec_shapes = [
        (HEAD_DEC_CHANNELS, HEAD_FIRST_CHANNELS),
        (HEAD_DEC_CHANNELS, HEAD_DEC_CHANNELS),
        (HEAD_DEC_CHANNELS, HEAD_DEC_CHANNELS),
    ]
    for i, (c_out, c_in) in enumerate(dec_shapes):
        state[f"decoder.0.{i}.conv.weight"] = w(c_out, c_in, k)
        state[f"decoder.0.{i}.conv.bias"] = zeros(c_out)
        state[f"decoder.0.{i}.norm.weight"] = ones(c_out)
        state[f"decoder.0.{i}.norm.bias"] = zeros(c_out)

    state["output_proj.weight"] = w(N_COEFFS, HEAD_DEC_CHANNELS)
    state["output_proj.bias"] = zeros(N_COEFFS)

    return state


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="output .gguf path")
    ap.add_argument("--dtype", choices=("f32", "f16"), default="f32")
    ap.add_argument("--seed", type=int, default=0, help="RNG seed (output is reproducible)")
    args = ap.parse_args()

    state = build_state(TINY_DIMS, np.random.default_rng(args.seed))
    write_gguf(state, args.out, args.dtype, dims=TINY_DIMS)


if __name__ == "__main__":
    main()
