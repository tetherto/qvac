"""Shared `lam-audio2exp` GGUF layout for the LAM Audio2Expression tools.

Every entry point — `convert-lam-a2e-to-gguf.py` (PyTorch checkpoint),
`remap-lam-a2e-gguf.py` (a raw GGUF that still carries PyTorch tensor names),
and `make-tiny-lam-a2e-gguf.py` (random weights for tests) — has to emit
byte-identical metadata and tensor names, because the loader in
`qvac-ext-stable-diffusion.cpp` (`src/lam_audio2expression.cpp`) keys off them.
Keeping the name map and KV writer here means the paths cannot drift.

Layer widths are carried in `Dims` rather than hardcoded, because the loader
reads all of them from GGUF KV (`ggufGetU32Or`) and so will happily run a
scaled-down model. `Dims()` is the real checkpoint; the tiny test model passes
a narrower one.

Layout notes:

- `general.architecture = "lam-audio2exp"` selects the LAM-A2E loader.
- PyTorch conv1d weights are (C_out, C_in, K) row-major, which lands as ggml
  ne = [K, C_in, C_out] on a straight copy — exactly what `ggml_conv_1d`
  expects. No transposes happen anywhere; this is a 1:1 map of the state dict.
- The positional-conv weight norm (weight_g/weight_v, dim=2) is folded into a
  plain conv weight at conversion time.
- Inference-unused tensors (`lm_head`, `identity_encoder.grus`,
  `masked_spec_embed`) are dropped.
"""

from __future__ import annotations

import dataclasses
import os

import numpy as np
from gguf import GGUFWriter

ARCH = "lam-audio2exp"
MODEL_NAME = "LAM Audio2Expression (streaming)"

# Fixed by the contract rather than by the weights: the engine emits 30fps and
# `lam_a2e_frame::arkit_52` is a fixed-size array, so these are not tunable.
SAMPLE_RATE = 16000
FPS = 30
N_COEFFS = 52


@dataclasses.dataclass(frozen=True)
class Dims:
    """Layer widths written to GGUF KV and read back by the engine loader.

    Defaults are the real upstream checkpoint. `enc_hidden` must divide evenly
    by both `enc_heads` and `pos_conv_groups`, and `pos_conv_kernel` must be
    even — the encoder drops one trailing sample to undo the `k/2` padding.
    """

    n_identity: int = 12
    identity_feat_dim: int = 64
    hidden_dim: int = 512
    window_frames: int = 64
    enc_layers: int = 12
    enc_heads: int = 12
    enc_hidden: int = 768
    enc_ffn: int = 3072
    pos_conv_kernel: int = 128
    pos_conv_groups: int = 16

    def __post_init__(self) -> None:
        if self.enc_hidden % self.enc_heads:
            raise ValueError(f"enc_hidden {self.enc_hidden} not divisible by enc_heads {self.enc_heads}")
        if self.enc_hidden % self.pos_conv_groups:
            raise ValueError(
                f"enc_hidden {self.enc_hidden} not divisible by pos_conv_groups {self.pos_conv_groups}"
            )
        if self.pos_conv_kernel % 2:
            raise ValueError(f"pos_conv_kernel must be even, got {self.pos_conv_kernel}")


REAL_DIMS = Dims()

ARKIT_BLENDSHAPES = [
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft",
    "browOuterUpRight", "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
    "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen",
    "jawRight", "mouthClose", "mouthDimpleLeft", "mouthDimpleRight",
    "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft",
    "mouthPressRight", "mouthPucker", "mouthRight", "mouthRollLower",
    "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
    "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft",
    "noseSneerRight", "tongueOut",
]

# wav2vec2-base feature extractor geometry (configs/wav2vec2_config.json)
FE_KERNELS = [10, 3, 3, 3, 3, 2, 2]
FE_STRIDES = [5, 2, 2, 2, 2, 2, 2]

SKIP_PREFIXES = (
    "audio_encoder.lm_head.",
    "identity_encoder.grus.",
)
SKIP_KEYS = ("audio_encoder.masked_spec_embed",)

POS_CONV_WEIGHT_G = "audio_encoder.encoder.pos_conv_embed.conv.weight_g"
POS_CONV_WEIGHT_V = "audio_encoder.encoder.pos_conv_embed.conv.weight_v"
POS_CONV_WEIGHT = "audio_encoder.encoder.pos_conv_embed.conv.weight"

POS_CONV_G_SHAPE = (1, 1, 128)
POS_CONV_V_SHAPE = (768, 48, 128)


def strip_prefix(name: str) -> str:
    """Drop the DataParallel / wrapper prefixes used by the upstream checkpoint."""
    if name.startswith("module."):
        name = name[len("module."):]
    if name.startswith("backbone."):
        name = name[len("backbone."):]
    return name


def is_skipped(name: str) -> bool:
    return name in SKIP_KEYS or name.startswith(SKIP_PREFIXES)


def build_name_map(enc_layers: int = REAL_DIMS.enc_layers) -> dict[str, tuple[str, bool]]:
    """checkpoint key -> (gguf tensor name, is_matmul_weight)."""
    m: dict[str, tuple[str, bool]] = {}
    for i in range(7):
        m[f"audio_encoder.feature_extractor.conv_layers.{i}.conv.weight"] = (f"fe.conv{i}.weight", True)
    m["audio_encoder.feature_extractor.conv_layers.0.layer_norm.weight"] = ("fe.gn.weight", False)
    m["audio_encoder.feature_extractor.conv_layers.0.layer_norm.bias"] = ("fe.gn.bias", False)

    m["audio_encoder.feature_projection.layer_norm.weight"] = ("fp.ln.weight", False)
    m["audio_encoder.feature_projection.layer_norm.bias"] = ("fp.ln.bias", False)
    m["audio_encoder.feature_projection.projection.weight"] = ("fp.proj.weight", True)
    m["audio_encoder.feature_projection.projection.bias"] = ("fp.proj.bias", False)

    m[POS_CONV_WEIGHT] = ("enc.pos_conv.weight", True)
    m["audio_encoder.encoder.pos_conv_embed.conv.bias"] = ("enc.pos_conv.bias", False)
    m["audio_encoder.encoder.layer_norm.weight"] = ("enc.ln.weight", False)
    m["audio_encoder.encoder.layer_norm.bias"] = ("enc.ln.bias", False)

    for i in range(enc_layers):
        src = f"audio_encoder.encoder.layers.{i}"
        dst = f"enc.blk{i}"
        for proj in ("q", "k", "v"):
            m[f"{src}.attention.{proj}_proj.weight"] = (f"{dst}.attn_{proj}.weight", True)
            m[f"{src}.attention.{proj}_proj.bias"] = (f"{dst}.attn_{proj}.bias", False)
        m[f"{src}.attention.out_proj.weight"] = (f"{dst}.attn_o.weight", True)
        m[f"{src}.attention.out_proj.bias"] = (f"{dst}.attn_o.bias", False)
        m[f"{src}.layer_norm.weight"] = (f"{dst}.ln1.weight", False)
        m[f"{src}.layer_norm.bias"] = (f"{dst}.ln1.bias", False)
        m[f"{src}.feed_forward.intermediate_dense.weight"] = (f"{dst}.ffn_up.weight", True)
        m[f"{src}.feed_forward.intermediate_dense.bias"] = (f"{dst}.ffn_up.bias", False)
        m[f"{src}.feed_forward.output_dense.weight"] = (f"{dst}.ffn_down.weight", True)
        m[f"{src}.feed_forward.output_dense.bias"] = (f"{dst}.ffn_down.bias", False)
        m[f"{src}.final_layer_norm.weight"] = (f"{dst}.ln2.weight", False)
        m[f"{src}.final_layer_norm.bias"] = (f"{dst}.ln2.bias", False)

    m["feature_projection.weight"] = ("head.proj.weight", True)
    m["feature_projection.bias"] = ("head.proj.bias", False)
    m["identity_encoder.id_mlp.weight"] = ("head.id_mlp.weight", True)
    m["identity_encoder.id_mlp.bias"] = ("head.id_mlp.bias", False)
    for i in range(3):
        src = f"identity_encoder.first_net.conv_layers.{i}"
        m[f"{src}.conv.weight"] = (f"head.first{i}.conv.weight", True)
        m[f"{src}.conv.bias"] = (f"head.first{i}.conv.bias", False)
        m[f"{src}.norm.weight"] = (f"head.first{i}.ln.weight", False)
        m[f"{src}.norm.bias"] = (f"head.first{i}.ln.bias", False)
    m["identity_encoder.first_net.conv_layers.0.residual_layer.0.weight"] = ("head.first0.res.weight", True)
    m["identity_encoder.first_net.conv_layers.0.residual_layer.0.bias"] = ("head.first0.res.bias", False)
    for i in range(3):
        m[f"decoder.0.{i}.conv.weight"] = (f"head.dec{i}.conv.weight", True)
        m[f"decoder.0.{i}.conv.bias"] = (f"head.dec{i}.conv.bias", False)
        m[f"decoder.0.{i}.norm.weight"] = (f"head.dec{i}.ln.weight", False)
        m[f"decoder.0.{i}.norm.bias"] = (f"head.dec{i}.ln.bias", False)
    m["output_proj.weight"] = ("head.out.weight", True)
    m["output_proj.bias"] = ("head.out.bias", False)
    return m


def fold_pos_conv_weight_norm(state: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Collapse weight = g * v / ||v|| (norm over dims (0,1), i.e. per kernel position)."""
    g = state.pop(POS_CONV_WEIGHT_G)
    v = state.pop(POS_CONV_WEIGHT_V)
    if g.shape != POS_CONV_G_SHAPE or v.shape != POS_CONV_V_SHAPE:
        raise RuntimeError(
            f"unexpected pos-conv shapes g={g.shape} v={v.shape}; "
            f"expected g={POS_CONV_G_SHAPE} v={POS_CONV_V_SHAPE}"
        )
    norm = np.linalg.norm(v, axis=(0, 1), keepdims=True)
    state[POS_CONV_WEIGHT] = (g * v / np.maximum(norm, 1e-12)).astype(np.float32, copy=True)
    return state


def _add_metadata(writer: GGUFWriter, dtype: str, dims: Dims) -> None:
    writer.add_name(MODEL_NAME)
    writer.add_string(f"{ARCH}.dtype", dtype)
    writer.add_uint32(f"{ARCH}.sample_rate", SAMPLE_RATE)
    writer.add_uint32(f"{ARCH}.fps", FPS)
    writer.add_uint32(f"{ARCH}.n_coeffs", N_COEFFS)
    writer.add_uint32(f"{ARCH}.n_identity", dims.n_identity)
    writer.add_uint32(f"{ARCH}.identity_feat_dim", dims.identity_feat_dim)
    writer.add_uint32(f"{ARCH}.hidden_dim", dims.hidden_dim)
    writer.add_uint32(f"{ARCH}.window_frames", dims.window_frames)
    writer.add_float32(f"{ARCH}.layer_norm_eps", 1e-5)
    writer.add_uint32(f"{ARCH}.enc.n_layers", dims.enc_layers)
    writer.add_uint32(f"{ARCH}.enc.n_heads", dims.enc_heads)
    writer.add_uint32(f"{ARCH}.enc.hidden", dims.enc_hidden)
    writer.add_uint32(f"{ARCH}.enc.ffn", dims.enc_ffn)
    writer.add_uint32(f"{ARCH}.enc.pos_conv_kernel", dims.pos_conv_kernel)
    writer.add_uint32(f"{ARCH}.enc.pos_conv_groups", dims.pos_conv_groups)
    writer.add_array(f"{ARCH}.fe.kernels", FE_KERNELS)
    writer.add_array(f"{ARCH}.fe.strides", FE_STRIDES)
    writer.add_array(f"{ARCH}.coeff_names", ARKIT_BLENDSHAPES)


def write_gguf(
    state: dict[str, np.ndarray],
    out_path: str,
    dtype: str,
    dims: Dims = REAL_DIMS,
) -> None:
    """Validate `state` against the name map and write the `lam-audio2exp` GGUF.

    `dtype == "f16"` stores matmul/conv weights as f16 and keeps norms and
    biases at f32.
    """
    name_map = build_name_map(dims.enc_layers)

    unmapped = sorted(set(state) - set(name_map))
    if unmapped:
        raise RuntimeError(f"unmapped tensors ({len(unmapped)}): {unmapped[:30]}")
    missing = sorted(set(name_map) - set(state))
    if missing:
        raise RuntimeError(f"expected tensors not found ({len(missing)}): {missing[:30]}")

    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    writer = GGUFWriter(out_path, ARCH)
    _add_metadata(writer, dtype, dims)

    total_bytes = 0
    for key in sorted(state, key=lambda k: name_map[k][0]):
        gguf_name, is_matmul = name_map[key]
        arr = np.ascontiguousarray(state[key])
        if dtype == "f16" and is_matmul:
            arr = arr.astype(np.float16)
        writer.add_tensor(gguf_name, arr)
        total_bytes += arr.nbytes
        print(f"  {gguf_name}: {list(arr.shape)} {arr.dtype}")

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"wrote {out_path} ({total_bytes / 1e6:.1f} MB tensor data, dtype={dtype})")
