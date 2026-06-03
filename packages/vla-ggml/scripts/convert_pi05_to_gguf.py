#!/usr/bin/env python3
"""LeRobot π₀.₅ PyTorch checkpoint → GGUF converter (Phase 2).

Reads a LeRobot ``Pi05Policy`` checkpoint (e.g. ``lerobot/pi05_base``,
``lerobot/pi05_libero``) and emits a single GGUF that the C++ pi05.cpp
implementation will consume.

**The full quantisation scheme — including every profile's per-tensor
dtype, the universal guardrails, the 2026-05-21 sweep results, and the
K-quant follow-up — lives in ``README-pi05-converter.md`` next to this
script.** Read that first if you're touching anything quant-related.

Short version:

- ``general.architecture = "pi05"`` — selected by the addon's model factory.
- ``pi05.quant_profile`` records which profile produced the GGUF.
- Tensor names follow the ``vision.* / vlm.* / expert.* / proj.*`` pattern
  from plan §4, with one small divergence: K/V (MQA) and MLP gate/up are
  stored *unpacked* so the converter is a 1:1 map of the PyTorch state
  dict. The runtime can pack them on load if it prefers.
- The default profile is ``q_aggressive`` (= Q5_0 vision + Q8_0 VLM +
  Q8_0 expert linears + F32 norms/ada; ~3.7 GB for ``pi05_base``,
  cos > 0.999 end-to-end).

Usage:

    # Default (q_aggressive) — recommended for testing & shipping.
    python3 convert_pi05_to_gguf.py \\
      --checkpoint lerobot/pi05_base \\
      --out        ./pi05_base.gguf

    # Pick a different profile explicitly.
    python3 convert_pi05_to_gguf.py \\
      --checkpoint lerobot/pi05_base \\
      --out        ./pi05_base.gguf \\
      --profile    current

    # Structural self-check: re-load the GGUF and assert every tensor is
    # present with the right shape/dtype (does NOT do a PT forward).
    python3 convert_pi05_to_gguf.py \\
      --checkpoint lerobot/pi05_base \\
      --out        ./pi05_base.gguf \\
      --verify-vs-pt

The conversion is deterministic for a fixed checkpoint revision and a
fixed profile (no randomness in the mapping or quantisation).
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch

from gguf import GGMLQuantizationType, GGUFWriter
from gguf.quants import quantize as gguf_quantize


log = logging.getLogger("pi05-converter")


# ---------------------------------------------------------------------------
# Architecture constants — cross-checked against plan §2 / openpi gemma.py.
# These are not parameters; if you change them, you're targeting a different
# model and the converter will not load.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Pi05Spec:
    # Vision (SigLIP-So400m/14)
    vision_embed_dim: int = 1152
    vision_num_layers: int = 27
    vision_num_heads: int = 16
    vision_mlp_dim: int = 4304
    vision_patch_size: int = 14
    vision_image_size: int = 224
    vision_head_out_dim: int = 2048  # connector — Linear(1152→2048)

    # VLM (PaliGemma / Gemma-1 2B)
    vlm_hidden: int = 2048
    vlm_layers: int = 18
    vlm_heads: int = 8
    vlm_kv_heads: int = 1  # MQA
    vlm_head_dim: int = 256
    vlm_mlp_dim: int = 16384

    # Action expert (Gemma-1 300M)
    expert_hidden: int = 1024
    expert_layers: int = 18
    expert_heads: int = 8
    expert_kv_heads: int = 1
    expert_head_dim: int = 256
    expert_mlp_dim: int = 4096
    expert_adarms_cond_dim: int = 1024  # equals expert_hidden

    # Common
    rms_norm_eps: float = 1e-6
    vocab_size: int = 257_152  # PaliGemma SentencePiece
    action_dim: int = 32
    action_horizon: int = 50
    max_token_len: int = 200
    num_cameras: int = 3


SPEC = Pi05Spec()


# Tensors whose *row length* (last dim) is a multiple of 32 → eligible for
# Q8_0. Anything else gets F16 (or F32 for norms).
Q8_OK_BLOCK = 32


# ---------------------------------------------------------------------------
# Tensor name mapping. The PyTorch parameter path is on the left; the GGUF
# tensor name is on the right. ``{i}`` is the layer index (substituted at
# expansion time). One entry per tensor — no implicit fallbacks.
# ---------------------------------------------------------------------------


def _vision_layer_map() -> dict[str, str]:
    """HF SigLIP encoder layer i → vision.blk.i.* GGUF names."""
    pt_base = (
        "model.paligemma_with_expert.paligemma.model.vision_tower.vision_model.encoder.layers"
    )
    gg_base = "vision.blk"
    m: dict[str, str] = {}
    for i in range(SPEC.vision_num_layers):
        m[f"{pt_base}.{i}.layer_norm1.weight"] = f"{gg_base}.{i}.ln1.weight"
        m[f"{pt_base}.{i}.layer_norm1.bias"] = f"{gg_base}.{i}.ln1.bias"
        m[f"{pt_base}.{i}.self_attn.q_proj.weight"] = f"{gg_base}.{i}.attn_q.weight"
        m[f"{pt_base}.{i}.self_attn.q_proj.bias"] = f"{gg_base}.{i}.attn_q.bias"
        m[f"{pt_base}.{i}.self_attn.k_proj.weight"] = f"{gg_base}.{i}.attn_k.weight"
        m[f"{pt_base}.{i}.self_attn.k_proj.bias"] = f"{gg_base}.{i}.attn_k.bias"
        m[f"{pt_base}.{i}.self_attn.v_proj.weight"] = f"{gg_base}.{i}.attn_v.weight"
        m[f"{pt_base}.{i}.self_attn.v_proj.bias"] = f"{gg_base}.{i}.attn_v.bias"
        m[f"{pt_base}.{i}.self_attn.out_proj.weight"] = f"{gg_base}.{i}.attn_out.weight"
        m[f"{pt_base}.{i}.self_attn.out_proj.bias"] = f"{gg_base}.{i}.attn_out.bias"
        m[f"{pt_base}.{i}.layer_norm2.weight"] = f"{gg_base}.{i}.ln2.weight"
        m[f"{pt_base}.{i}.layer_norm2.bias"] = f"{gg_base}.{i}.ln2.bias"
        m[f"{pt_base}.{i}.mlp.fc1.weight"] = f"{gg_base}.{i}.fc1.weight"
        m[f"{pt_base}.{i}.mlp.fc1.bias"] = f"{gg_base}.{i}.fc1.bias"
        m[f"{pt_base}.{i}.mlp.fc2.weight"] = f"{gg_base}.{i}.fc2.weight"
        m[f"{pt_base}.{i}.mlp.fc2.bias"] = f"{gg_base}.{i}.fc2.bias"
    return m


def _vlm_layer_map() -> dict[str, str]:
    pt_base = (
        "model.paligemma_with_expert.paligemma.model.language_model.layers"
    )
    gg_base = "vlm.blk"
    m: dict[str, str] = {}
    for i in range(SPEC.vlm_layers):
        m[f"{pt_base}.{i}.input_layernorm.weight"] = f"{gg_base}.{i}.pre_attn_norm.scale"
        m[f"{pt_base}.{i}.self_attn.q_proj.weight"] = f"{gg_base}.{i}.attn.q.weight"
        m[f"{pt_base}.{i}.self_attn.k_proj.weight"] = f"{gg_base}.{i}.attn.k.weight"
        m[f"{pt_base}.{i}.self_attn.v_proj.weight"] = f"{gg_base}.{i}.attn.v.weight"
        m[f"{pt_base}.{i}.self_attn.o_proj.weight"] = f"{gg_base}.{i}.attn.o.weight"
        m[f"{pt_base}.{i}.post_attention_layernorm.weight"] = (
            f"{gg_base}.{i}.pre_ffw_norm.scale"
        )
        m[f"{pt_base}.{i}.mlp.gate_proj.weight"] = f"{gg_base}.{i}.mlp.gate.weight"
        m[f"{pt_base}.{i}.mlp.up_proj.weight"] = f"{gg_base}.{i}.mlp.up.weight"
        m[f"{pt_base}.{i}.mlp.down_proj.weight"] = f"{gg_base}.{i}.mlp.down.weight"
    return m


def _expert_layer_map() -> dict[str, str]:
    pt_base = "model.paligemma_with_expert.gemma_expert.model.layers"
    gg_base = "expert.blk"
    m: dict[str, str] = {}
    for i in range(SPEC.expert_layers):
        m[f"{pt_base}.{i}.input_layernorm.weight"] = (
            f"{gg_base}.{i}.pre_attn_norm.scale"
        )
        # adaRMSNorm modulator: PiGemmaRMSNorm.dense — Linear(cond_dim, 3*dim)
        m[f"{pt_base}.{i}.input_layernorm.dense.weight"] = (
            f"{gg_base}.{i}.pre_attn_norm.ada.weight"
        )
        m[f"{pt_base}.{i}.input_layernorm.dense.bias"] = (
            f"{gg_base}.{i}.pre_attn_norm.ada.bias"
        )
        m[f"{pt_base}.{i}.self_attn.q_proj.weight"] = f"{gg_base}.{i}.attn.q.weight"
        m[f"{pt_base}.{i}.self_attn.k_proj.weight"] = f"{gg_base}.{i}.attn.k.weight"
        m[f"{pt_base}.{i}.self_attn.v_proj.weight"] = f"{gg_base}.{i}.attn.v.weight"
        m[f"{pt_base}.{i}.self_attn.o_proj.weight"] = f"{gg_base}.{i}.attn.o.weight"
        m[f"{pt_base}.{i}.post_attention_layernorm.weight"] = (
            f"{gg_base}.{i}.pre_ffw_norm.scale"
        )
        m[f"{pt_base}.{i}.post_attention_layernorm.dense.weight"] = (
            f"{gg_base}.{i}.pre_ffw_norm.ada.weight"
        )
        m[f"{pt_base}.{i}.post_attention_layernorm.dense.bias"] = (
            f"{gg_base}.{i}.pre_ffw_norm.ada.bias"
        )
        m[f"{pt_base}.{i}.mlp.gate_proj.weight"] = f"{gg_base}.{i}.mlp.gate.weight"
        m[f"{pt_base}.{i}.mlp.up_proj.weight"] = f"{gg_base}.{i}.mlp.up.weight"
        m[f"{pt_base}.{i}.mlp.down_proj.weight"] = f"{gg_base}.{i}.mlp.down.weight"
    return m


def _global_map() -> dict[str, str]:
    pre_vlm = "model.paligemma_with_expert.paligemma.model"
    pre_exp = "model.paligemma_with_expert.gemma_expert.model"

    m: dict[str, str] = {
        # Vision tower outer pieces
        f"{pre_vlm}.vision_tower.vision_model.embeddings.patch_embedding.weight":
            "vision.patch_embed.weight",
        f"{pre_vlm}.vision_tower.vision_model.embeddings.patch_embedding.bias":
            "vision.patch_embed.bias",
        f"{pre_vlm}.vision_tower.vision_model.embeddings.position_embedding.weight":
            "vision.pos_embed",
        f"{pre_vlm}.vision_tower.vision_model.post_layernorm.weight":
            "vision.post_ln.weight",
        f"{pre_vlm}.vision_tower.vision_model.post_layernorm.bias":
            "vision.post_ln.bias",
        f"{pre_vlm}.multi_modal_projector.linear.weight": "vision.head.weight",
        f"{pre_vlm}.multi_modal_projector.linear.bias":   "vision.head.bias",

        # VLM outer pieces
        f"{pre_vlm}.language_model.embed_tokens.weight": "vlm.embed_tokens",
        f"{pre_vlm}.language_model.norm.weight":         "vlm.final_norm.scale",

        # Expert outer pieces — note ``norm.weight``/``norm.dense.*`` mirror
        # the input/post layernorms but apply at the end of the expert stack.
        f"{pre_exp}.norm.weight":        "expert.final_norm.scale",
        f"{pre_exp}.norm.dense.weight":  "expert.final_norm.ada.weight",
        f"{pre_exp}.norm.dense.bias":    "expert.final_norm.ada.bias",

        # Action / time projections live one level up from the inner model.
        "model.action_in_proj.weight":  "proj.action_in.weight",
        "model.action_in_proj.bias":    "proj.action_in.bias",
        "model.action_out_proj.weight": "proj.action_out.weight",
        "model.action_out_proj.bias":   "proj.action_out.bias",
        "model.time_mlp_in.weight":     "proj.time_mlp_in.weight",
        "model.time_mlp_in.bias":       "proj.time_mlp_in.bias",
        "model.time_mlp_out.weight":    "proj.time_mlp_out.weight",
        "model.time_mlp_out.bias":      "proj.time_mlp_out.bias",
    }
    m.update(_vision_layer_map())
    m.update(_vlm_layer_map())
    m.update(_expert_layer_map())
    return m


# Tensors to skip silently when walking the state dict. These are buffers,
# RoPE caches, or HF housekeeping that the runtime recomputes itself.
SKIP_PT_KEYS_SUFFIX = (
    ".rotary_emb.inv_freq",  # HF-precomputed, regenerated on load
    ".attn.bias",             # SigLIP attn module sometimes has a buffer here
)
SKIP_PT_KEYS_EXACT = {
    # Some HF revisions stash version markers as tensors — ignore.
}


def _optional_pt_keys_with_shape() -> dict[str, tuple[int, ...]]:
    """PT keys we *would* like in the state dict but which legitimately may
    be absent in released checkpoints — synthesised as zeros if missing.

    The expert path's plain RMSNorm ``.weight`` scales fall here. In an
    adaRMSNorm layer the effective per-element multiplier is
    ``(1 + base_scale) * (1 + ada_scale) + ada_shift`` (plan §2, RMSNorm
    formula). Released ``pi05_base`` only stores ``input_layernorm.dense.*``
    / ``post_attention_layernorm.dense.*`` / ``norm.dense.*`` — the plain
    ``.weight`` is omitted because it would have been zero anyway. We
    materialise zeros so the GGUF schema stays uniform (pi05.cpp can always
    read ``expert.blk.N.pre_attn_norm.scale`` etc., with no
    "tensor may be missing" branch).
    """
    pt_base = "model.paligemma_with_expert.gemma_expert.model.layers"
    pre_exp = "model.paligemma_with_expert.gemma_expert.model"
    out: dict[str, tuple[int, ...]] = {}
    for i in range(SPEC.expert_layers):
        out[f"{pt_base}.{i}.input_layernorm.weight"] = (SPEC.expert_hidden,)
        out[f"{pt_base}.{i}.post_attention_layernorm.weight"] = (SPEC.expert_hidden,)
    out[f"{pre_exp}.norm.weight"] = (SPEC.expert_hidden,)
    return out


# ---------------------------------------------------------------------------
# Quantisation policy. Profile-driven: a profile is a function that, given a
# (gguf_name, numpy_array), returns the target GGML dtype.
#
# Universal guardrails apply across ALL profiles — quantising these blows up
# cos-sim downstream regardless of profile aggression:
#   - norms (.scale)                  → F32
#   - adaRMSNorm modulator (.ada.*)   → F32
#   - biases                          → F16
#   - 4-D patch_embed weight          → F16 (not block-quantizable)
#   - small position embedding        → F16
#   - expert linears                  → F16 (residual path, precision-sensitive)
#   - action / time projections       → F16 (residual path)
#
# Profile-specific rules apply only to the VLM linears, vision linears, and
# token embedder. Order matters: guardrails are checked first.
# ---------------------------------------------------------------------------


# All Python-native legacy quants use block size 32 along the last dim.
LEGACY_QUANT_BLOCK = 32

# K-quants (Q*_K) are *named* in gguf-py but their Python packers raise
# NotImplementedError. Listed here so the validator catches us before runtime.
PYTHON_NATIVE_QUANTS: frozenset[GGMLQuantizationType] = frozenset({
    GGMLQuantizationType.F32,
    GGMLQuantizationType.F16,
    GGMLQuantizationType.Q4_0,
    GGMLQuantizationType.Q4_1,
    GGMLQuantizationType.Q5_0,
    GGMLQuantizationType.Q5_1,
    GGMLQuantizationType.Q8_0,
})


def _is_q_eligible(arr: np.ndarray, block: int = LEGACY_QUANT_BLOCK) -> bool:
    return arr.ndim == 2 and arr.shape[-1] % block == 0


def _guardrail_dtype(name: str, arr: np.ndarray) -> GGMLQuantizationType | None:
    """Return the forced dtype if a universal guardrail applies; else None."""
    if name.endswith(".scale"):
        return GGMLQuantizationType.F32
    if ".ada." in name:
        return GGMLQuantizationType.F32
    if name.endswith(".bias"):
        return GGMLQuantizationType.F16
    if name == "vision.patch_embed.weight":
        return GGMLQuantizationType.F16
    if name == "vision.pos_embed":
        return GGMLQuantizationType.F16
    # Expert linears: never quantize. The 300M action expert sits on the
    # residual path with adaRMSNorm modulation; precision loss here is the
    # one place cos-sim regresses most violently.
    if name.startswith("expert.") and name.endswith(".weight") and arr.ndim == 2:
        return GGMLQuantizationType.F16
    # Action in/out + time MLP projections: tiny + residual path.
    if name.startswith("proj.") and name.endswith(".weight"):
        return GGMLQuantizationType.F16
    return None


def _profile_f16(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """P0 — every weight F16. Numerical ceiling baseline."""
    return GGMLQuantizationType.F16


def _profile_current(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """P1 — historical default. Q8_0 on the vision attn projections + fc1
    + head; F16 everywhere else. Reproduces the existing pi05_base.gguf
    bit-for-bit."""
    if arr.ndim == 2 and name.startswith("vision."):
        last_dim = arr.shape[-1]
        is_q8_eligible_kind = (
            ".attn_q.weight" in name
            or ".attn_k.weight" in name
            or ".attn_v.weight" in name
            or ".attn_out.weight" in name
            or ".fc1.weight" in name
            or name == "vision.head.weight"
        )
        if is_q8_eligible_kind and last_dim % LEGACY_QUANT_BLOCK == 0:
            return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens":
        return GGMLQuantizationType.F16
    return GGMLQuantizationType.F16


def _profile_q8_broad(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """P2 — Q8_0 on every 2-D linear in vision/VLM (incl. embedder)
    whose last dim is /32-divisible. Expert linears already F16 via
    guardrail. Vision fc2 (last_dim 4304, not /32) stays F16."""
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _is_vlm_mlp(name: str) -> bool:
    return name.startswith("vlm.blk.") and ".mlp." in name


def _profile_q5_mlp(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """P3 — P2 + Q5_0 on the VLM MLP linears (biggest mass)."""
    if _is_q_eligible(arr) and _is_vlm_mlp(name):
        return GGMLQuantizationType.Q5_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _profile_q4_mlp_emb(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """P4 — most aggressive Python-native: Q4_0 on VLM MLP + token
    embedder; Q8_0 everywhere else block-eligible."""
    if _is_q_eligible(arr) and _is_vlm_mlp(name):
        return GGMLQuantizationType.Q4_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q4_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


# ---------------------------------------------------------------------------
# Diagnostic profiles (from the second sweep, 2026-05-21). Each one flips a
# *single* knob off the q8_broad baseline (which clears the cos > 0.999 bar)
# so we can attribute any cos-sim regression to one specific component.
# ---------------------------------------------------------------------------


def _is_vlm_attn(name: str) -> bool:
    return name.startswith("vlm.blk.") and ".attn." in name


_VLM_MLP_LAYER_RE = re.compile(r"^vlm\.blk\.(\d+)\.mlp\.")


def _vlm_mlp_layer_index(name: str) -> int | None:
    m = _VLM_MLP_LAYER_RE.match(name)
    return int(m.group(1)) if m else None


def _profile_q8b_q5_embed(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Diag — q8_broad + token embedder dropped Q8_0 → Q5_0."""
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q5_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _profile_q8b_q4_embed(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Diag — q8_broad + token embedder dropped Q8_0 → Q4_0."""
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q4_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _profile_q8b_q5_vision(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Diag — every Q8_0-eligible vision linear dropped to Q5_0. The
    vision tower feeds the VLM through one Linear and 18 attention
    layers smooth its output, so it has the most error-tolerance."""
    if _is_q_eligible(arr) and name.startswith("vision."):
        return GGMLQuantizationType.Q5_0
    if _is_q_eligible(arr) and name.startswith("vlm."):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _is_expert_linear(name: str) -> bool:
    """An expert *linear* weight (attn or mlp), not a norm scale, not an
    adaRMSNorm modulator. Used by both the bypass-guardrail allow-list
    and the q8b_q8_expert profile."""
    if not (name.startswith("expert.") and name.endswith(".weight")):
        return False
    if ".ada." in name:
        return False
    return True


def _profile_q8b_q8_expert(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Diag — expert linears F16 → Q8_0. Off the guardrail: the expert
    sits on the residual path with adaRMSNorm gates and is the path
    that emits actions, so this is the highest-risk knob."""
    # NOTE: this profile deliberately overrides the F16 guardrail on
    # expert linears. We achieve that by short-circuiting in
    # select_target_dtype below; see the special-case there.
    if _is_q_eligible(arr) and _is_expert_linear(name):
        return GGMLQuantizationType.Q8_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _profile_q8b_q5_vlm_attn(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Diag — VLM attn linears Q8_0 → Q5_0. Small win (~50 MB) but
    cheap to test."""
    if _is_q_eligible(arr) and _is_vlm_attn(name):
        return GGMLQuantizationType.Q5_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


# Middle six layers (6..11) of the 18-layer VLM. Hypothesis: edges
# (layer 0 = right after embed; layer 17 = right before expert sees it)
# are more sensitive than middle layers that do abstract processing.
_MID_LAYERS: frozenset[int] = frozenset(range(6, 12))


def _profile_q8b_q5_mlp_mid(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Diag — VLM MLP in *middle* layers only (6..11) dropped to Q5_0;
    edge layers (0..5, 12..17) stay at Q8_0. Tests whether the previous
    q5_mlp failure was driven by edges rather than the middle."""
    layer = _vlm_mlp_layer_index(name)
    if layer is not None and layer in _MID_LAYERS and _is_q_eligible(arr):
        return GGMLQuantizationType.Q5_0
    if _is_q_eligible(arr) and (name.startswith("vision.") or name.startswith("vlm.")):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


def _profile_q_aggressive(name: str, arr: np.ndarray) -> GGMLQuantizationType:
    """Final candidate after the 2026-05-21 diagnostic sweep. Stacks
    every knob that individually passed plan §5's cos > 0.999 bar:

    - Expert linears: F16 → Q8_0          (~−290 MB; cos 0.999892 alone)
    - Vision Q8_0-eligible: Q8_0 → Q5_0   (~−105 MB; cos 0.999680 alone)
    - Everything else q8_broad-style: Q8_0 on VLM/embedder/non-vision

    Knobs that failed individually and are deliberately NOT stacked:
    embedder below Q8_0, VLM attn below Q8_0, MLP edges, MLP middle below Q8_0.
    """
    # Bypass-eligible expert linear → Q8_0 (guardrail handled in
    # select_target_dtype via the bypass list below).
    if _is_q_eligible(arr) and _is_expert_linear(name):
        return GGMLQuantizationType.Q8_0
    # Vision Q5_0 where block-eligible.
    if _is_q_eligible(arr) and name.startswith("vision."):
        return GGMLQuantizationType.Q5_0
    # VLM linears + embedder: Q8_0.
    if _is_q_eligible(arr) and name.startswith("vlm."):
        return GGMLQuantizationType.Q8_0
    if name == "vlm.embed_tokens" and _is_q_eligible(arr):
        return GGMLQuantizationType.Q8_0
    return GGMLQuantizationType.F16


PROFILES: dict[str, Any] = {
    "f16":              _profile_f16,
    "current":          _profile_current,
    "q8_broad":         _profile_q8_broad,
    "q5_mlp":           _profile_q5_mlp,
    "q4_mlp_emb":       _profile_q4_mlp_emb,
    # Diagnostic profiles (one knob off q8_broad each)
    "q8b_q5_embed":     _profile_q8b_q5_embed,
    "q8b_q4_embed":     _profile_q8b_q4_embed,
    "q8b_q5_vision":    _profile_q8b_q5_vision,
    "q8b_q8_expert":    _profile_q8b_q8_expert,
    "q8b_q5_vlm_attn":  _profile_q8b_q5_vlm_attn,
    "q8b_q5_mlp_mid":   _profile_q8b_q5_mlp_mid,
    # Final stacked candidate (only the ✅ diagnostic knobs).
    "q_aggressive":     _profile_q_aggressive,
}


# Profiles that *intentionally* override the expert guardrail. The default
# guardrail forces all expert linears to F16; this set is allowed to break
# that. Treated as a single exception so the guardrail logic stays simple
# and other profiles get the protection by default.
PROFILES_BYPASS_EXPERT_GUARDRAIL: frozenset[str] = frozenset({
    "q8b_q8_expert", "q_aggressive",
})


def select_target_dtype(
    name: str, arr: np.ndarray, profile: str = "current"
) -> GGMLQuantizationType:
    """Pick a target GGML dtype for a given tensor under a named profile."""
    # The expert-linear guardrail is intentionally bypassable by a small,
    # explicit allow-list of *diagnostic* profiles (see
    # PROFILES_BYPASS_EXPERT_GUARDRAIL). Every other profile must respect it.
    # Only the actual expert linears (attn + mlp .weight) are bypassed —
    # norms and adaRMSNorm modulators stay protected.
    bypass_expert = (
        profile in PROFILES_BYPASS_EXPERT_GUARDRAIL
        and _is_expert_linear(name)
        and arr.ndim == 2
    )
    if not bypass_expert:
        forced = _guardrail_dtype(name, arr)
        if forced is not None:
            return forced
    rule = PROFILES.get(profile)
    if rule is None:
        raise ValueError(
            f"unknown quant profile {profile!r}; valid: {sorted(PROFILES)}"
        )
    dt = rule(name, arr)
    if dt not in PYTHON_NATIVE_QUANTS:
        raise ValueError(
            f"profile {profile!r} selected {dt.name} for {name!r}, which "
            f"gguf-py cannot pack in Python. Only legacy quants "
            f"(Q4_0/Q4_1/Q5_0/Q5_1/Q8_0) + F16/F32 are supported."
        )
    return dt


def encode_for_gguf(
    arr: np.ndarray, target: GGMLQuantizationType
) -> tuple[np.ndarray, GGMLQuantizationType | None]:
    """Convert an F32 numpy array into the chosen storage dtype.

    Returns ``(payload, raw_dtype)``. ``raw_dtype`` is passed to
    ``add_tensor(raw_dtype=...)`` only for quantised kinds; for native float
    dtypes we let GGUFWriter derive the dtype from ``payload.dtype``.
    """
    if target == GGMLQuantizationType.F32:
        return arr.astype(np.float32, copy=False), None
    if target == GGMLQuantizationType.F16:
        return arr.astype(np.float16, copy=False), None
    # All Python-native legacy quants share the same packing call: pass a
    # 2-D float32 matrix in, get a packed uint8 buffer out. The writer needs
    # raw_dtype so it records the right type code.
    if target in {
        GGMLQuantizationType.Q4_0,
        GGMLQuantizationType.Q4_1,
        GGMLQuantizationType.Q5_0,
        GGMLQuantizationType.Q5_1,
        GGMLQuantizationType.Q8_0,
    }:
        if arr.ndim != 2:
            raise ValueError(
                f"{target.name} requested for non-2D tensor (ndim={arr.ndim})"
            )
        if arr.shape[-1] % LEGACY_QUANT_BLOCK != 0:
            raise ValueError(
                f"{target.name} requested for tensor with last_dim "
                f"{arr.shape[-1]} (not /{LEGACY_QUANT_BLOCK}-divisible)"
            )
        packed = gguf_quantize(arr.astype(np.float32, copy=False), target)
        return packed, target
    raise NotImplementedError(f"unsupported target dtype {target}")


# ---------------------------------------------------------------------------
# State-dict loader. Uses LeRobot's own PI05Policy.from_pretrained so any
# revision changes flow through the canonical loader; for fast iteration on
# the conversion logic alone you can pass ``--state-dict <path.safetensors>``
# instead.
# ---------------------------------------------------------------------------


def load_state_dict_from_lerobot(checkpoint: str) -> dict[str, torch.Tensor]:
    log.info(f"loading PI05Policy from {checkpoint!r} (float32, eager)...")
    from lerobot.policies.pi05.configuration_pi05 import PI05Config
    from lerobot.policies.pi05.modeling_pi05 import PI05Policy

    cfg = PI05Config(dtype="float32", compile_model=False, device="cpu")
    policy = PI05Policy.from_pretrained(checkpoint, config=cfg, strict=False)
    policy.eval()
    sd = policy.state_dict()
    # Detach + cast to float32 on CPU for deterministic downstream encoding.
    return {k: v.detach().to(torch.float32).cpu() for k, v in sd.items()}


def load_state_dict_from_safetensors(path: Path) -> dict[str, torch.Tensor]:
    log.info(f"loading raw state dict from {path}")
    from safetensors.torch import load_file as st_load_file

    sd = st_load_file(str(path))
    return {k: v.to(torch.float32) for k, v in sd.items()}


# ---------------------------------------------------------------------------
# Conversion driver
# ---------------------------------------------------------------------------


def stamp_metadata(writer: GGUFWriter, checkpoint: str, profile: str) -> None:
    """All ``pi05.*`` keys consumed by the addon's load path."""
    writer.add_string("general.architecture", "pi05")
    writer.add_string("general.name", checkpoint)
    writer.add_string("pi05.quant_profile", profile)
    writer.add_string("pi05.paligemma_variant", "gemma_2b")
    writer.add_string("pi05.action_expert_variant", "gemma_300m")

    writer.add_uint32("pi05.action_dim", SPEC.action_dim)
    writer.add_uint32("pi05.action_horizon", SPEC.action_horizon)
    writer.add_uint32("pi05.max_token_len", SPEC.max_token_len)
    writer.add_uint32("pi05.image_resolution", SPEC.vision_image_size)
    writer.add_uint32("pi05.num_cameras", SPEC.num_cameras)
    writer.add_uint32("pi05.vocab_size", SPEC.vocab_size)

    writer.add_uint32("pi05.vision.embed_dim", SPEC.vision_embed_dim)
    writer.add_uint32("pi05.vision.num_layers", SPEC.vision_num_layers)
    writer.add_uint32("pi05.vision.num_heads", SPEC.vision_num_heads)
    writer.add_uint32("pi05.vision.mlp_dim", SPEC.vision_mlp_dim)
    writer.add_uint32("pi05.vision.patch_size", SPEC.vision_patch_size)
    writer.add_uint32("pi05.vision.head_out_dim", SPEC.vision_head_out_dim)

    writer.add_uint32("pi05.vlm.hidden_size", SPEC.vlm_hidden)
    writer.add_uint32("pi05.vlm.num_layers", SPEC.vlm_layers)
    writer.add_uint32("pi05.vlm.num_heads", SPEC.vlm_heads)
    writer.add_uint32("pi05.vlm.num_kv_heads", SPEC.vlm_kv_heads)
    writer.add_uint32("pi05.vlm.head_dim", SPEC.vlm_head_dim)
    writer.add_uint32("pi05.vlm.mlp_dim", SPEC.vlm_mlp_dim)

    writer.add_uint32("pi05.expert.hidden_size", SPEC.expert_hidden)
    writer.add_uint32("pi05.expert.num_layers", SPEC.expert_layers)
    writer.add_uint32("pi05.expert.num_heads", SPEC.expert_heads)
    writer.add_uint32("pi05.expert.num_kv_heads", SPEC.expert_kv_heads)
    writer.add_uint32("pi05.expert.head_dim", SPEC.expert_head_dim)
    writer.add_uint32("pi05.expert.mlp_dim", SPEC.expert_mlp_dim)
    writer.add_uint32("pi05.expert.adarms_cond_dim", SPEC.expert_adarms_cond_dim)

    writer.add_float32("pi05.rms_norm_eps", SPEC.rms_norm_eps)


def convert(
    state_dict: dict[str, torch.Tensor],
    out_path: Path,
    checkpoint: str,
    profile: str = "current",
) -> tuple[int, dict[str, tuple[GGMLQuantizationType, tuple[int, ...]]]]:
    """Walk the state dict, encode each tensor, write the GGUF.

    Returns ``(n_written, per_tensor_info)`` for the caller's report.
    """
    writer = GGUFWriter(out_path, arch="pi05")
    stamp_metadata(writer, checkpoint, profile)

    name_map = _global_map()
    written: dict[str, tuple[GGMLQuantizationType, tuple[int, ...]]] = {}
    unmapped: list[str] = []
    expected_pt_keys = set(name_map.keys())
    seen_pt_keys: set[str] = set()

    for pt_name, t in state_dict.items():
        if pt_name.endswith(SKIP_PT_KEYS_SUFFIX) or pt_name in SKIP_PT_KEYS_EXACT:
            continue

        gg_name = name_map.get(pt_name)
        if gg_name is None:
            unmapped.append(pt_name)
            continue

        seen_pt_keys.add(pt_name)
        arr = t.numpy()
        target = select_target_dtype(gg_name, arr, profile)
        payload, raw_dtype = encode_for_gguf(arr, target)
        # For quantised tensors ``payload`` is a packed uint8 buffer whose
        # last dim is bytes (not elements); GGUFWriter does the byte→element
        # conversion via ``raw_dtype`` so we deliberately do NOT pass
        # ``raw_shape`` (the default falls through to ``payload.shape``,
        # which is exactly what the writer wants).
        writer.add_tensor(gg_name, payload, raw_dtype=raw_dtype)
        written[gg_name] = (target, tuple(arr.shape))

    missing_pt = expected_pt_keys - seen_pt_keys

    # Expert RMSNorm `.weight` scales are absent in released pi05_base —
    # synthesise zeros for them so the GGUF schema stays uniform. See
    # `_optional_pt_keys_with_shape` for the rationale.
    optional = _optional_pt_keys_with_shape()
    synthesised = missing_pt & optional.keys()
    truly_missing = missing_pt - optional.keys()

    if synthesised:
        log.info(
            "synthesising %d zero tensors for expert norm scales absent in "
            "the checkpoint (adaRMSNorm convention; see comment on "
            "_optional_pt_keys_with_shape)",
            len(synthesised),
        )
        for pt_name in sorted(synthesised):
            gg_name = name_map[pt_name]
            shape = optional[pt_name]
            arr = np.zeros(shape, dtype=np.float32)
            target = select_target_dtype(gg_name, arr, profile)
            payload, raw_dtype = encode_for_gguf(arr, target)
            writer.add_tensor(gg_name, payload, raw_dtype=raw_dtype)
            written[gg_name] = (target, shape)

    if truly_missing:
        log.error(
            "%d expected PyTorch tensors are missing from the state dict:",
            len(truly_missing),
        )
        for k in sorted(truly_missing):
            log.error("  - %s", k)
        raise RuntimeError(
            "conversion aborted: state dict is missing tensors the converter expected"
        )

    if unmapped:
        # Anything left over is suspicious — log it but don't fail, since
        # newer LeRobot revisions sometimes add LoRA / decoder-pruning
        # auxiliary tensors we don't need. The list goes into the report
        # so reviewers see it.
        log.warning("%d state-dict tensors had no mapping (skipped):", len(unmapped))
        for k in unmapped[:32]:
            log.warning("  - %s", k)
        if len(unmapped) > 32:
            log.warning("  ... (+%d more)", len(unmapped) - 32)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    return len(written), written


# ---------------------------------------------------------------------------
# Self-verification: re-open the GGUF and assert every name/shape matches
# what we intended. This is the "tensor-name + shape parity" smoke test
# from plan §2 (the full PT-forward parity gate lives in Phase 3 unit
# tests, not here).
# ---------------------------------------------------------------------------


def verify_gguf_matches_intent(
    out_path: Path,
    intended: dict[str, tuple[GGMLQuantizationType, tuple[int, ...]]],
) -> None:
    log.info("verifying %s against intended layout (%d tensors)...",
             out_path, len(intended))
    from gguf.gguf_reader import GGUFReader

    reader = GGUFReader(str(out_path), "r")
    got: dict[str, tuple[GGMLQuantizationType, tuple[int, ...]]] = {}
    for ti in reader.tensors:
        # GGUFReader stores shape as numpy int array; cast to tuple.
        shape = tuple(int(d) for d in ti.shape)
        # Reverse: GGUF stores in reverse order from numpy convention.
        shape = shape[::-1]
        got[ti.name] = (GGMLQuantizationType(ti.tensor_type), shape)

    missing = sorted(set(intended) - set(got))
    extra = sorted(set(got) - set(intended))
    bad_shape: list[tuple[str, tuple[int, ...], tuple[int, ...]]] = []
    bad_dtype: list[tuple[str, GGMLQuantizationType, GGMLQuantizationType]] = []
    for name, (want_dt, want_shape) in intended.items():
        if name not in got:
            continue
        got_dt, got_shape = got[name]
        if got_dt != want_dt:
            bad_dtype.append((name, want_dt, got_dt))
        if got_shape != want_shape:
            bad_shape.append((name, want_shape, got_shape))

    n_problems = len(missing) + len(extra) + len(bad_shape) + len(bad_dtype)
    if n_problems == 0:
        log.info("✓ verify OK — every intended tensor present at the right shape/dtype")
        return

    if missing:
        log.error("missing %d tensors in GGUF:", len(missing))
        for n in missing[:16]:
            log.error("  - %s", n)
    if extra:
        log.error("unexpected %d tensors in GGUF:", len(extra))
        for n in extra[:16]:
            log.error("  - %s", n)
    if bad_shape:
        log.error("%d tensors with wrong shape:", len(bad_shape))
        for n, w, g in bad_shape[:16]:
            log.error("  - %s: want %s got %s", n, w, g)
    if bad_dtype:
        log.error("%d tensors with wrong dtype:", len(bad_dtype))
        for n, w, g in bad_dtype[:16]:
            log.error("  - %s: want %s got %s", n, w.name, g.name)
    raise RuntimeError("verify failed: GGUF does not match intended layout")


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="[%(name)s] %(message)s",
    )


def synthesize_state_dict() -> dict[str, torch.Tensor]:
    """Build a synthetic state dict whose names and shapes match the
    LeRobot PI05Policy state dict. Values are zeros — we only verify the
    converter's *structural* contract, not numerics.

    Used by ``--self-test`` so contributors and CI can run the converter
    end-to-end without downloading the 12 GB PaliGemma 2B checkpoint.
    """
    sd: dict[str, torch.Tensor] = {}
    s = SPEC

    def zeros(*shape: int) -> torch.Tensor:
        return torch.zeros(shape, dtype=torch.float32)

    pre_vlm = "model.paligemma_with_expert.paligemma.model"
    pre_exp = "model.paligemma_with_expert.gemma_expert.model"

    # Vision tower outer
    sd[f"{pre_vlm}.vision_tower.vision_model.embeddings.patch_embedding.weight"] = \
        zeros(s.vision_embed_dim, 3, s.vision_patch_size, s.vision_patch_size)
    sd[f"{pre_vlm}.vision_tower.vision_model.embeddings.patch_embedding.bias"] = \
        zeros(s.vision_embed_dim)
    n_patches = (s.vision_image_size // s.vision_patch_size) ** 2
    sd[f"{pre_vlm}.vision_tower.vision_model.embeddings.position_embedding.weight"] = \
        zeros(n_patches, s.vision_embed_dim)
    sd[f"{pre_vlm}.vision_tower.vision_model.post_layernorm.weight"] = zeros(s.vision_embed_dim)
    sd[f"{pre_vlm}.vision_tower.vision_model.post_layernorm.bias"] = zeros(s.vision_embed_dim)
    sd[f"{pre_vlm}.multi_modal_projector.linear.weight"] = \
        zeros(s.vision_head_out_dim, s.vision_embed_dim)
    sd[f"{pre_vlm}.multi_modal_projector.linear.bias"] = zeros(s.vision_head_out_dim)

    # Vision encoder layers
    for i in range(s.vision_num_layers):
        L = f"{pre_vlm}.vision_tower.vision_model.encoder.layers.{i}"
        sd[f"{L}.layer_norm1.weight"] = zeros(s.vision_embed_dim)
        sd[f"{L}.layer_norm1.bias"] = zeros(s.vision_embed_dim)
        sd[f"{L}.self_attn.q_proj.weight"] = zeros(s.vision_embed_dim, s.vision_embed_dim)
        sd[f"{L}.self_attn.q_proj.bias"] = zeros(s.vision_embed_dim)
        sd[f"{L}.self_attn.k_proj.weight"] = zeros(s.vision_embed_dim, s.vision_embed_dim)
        sd[f"{L}.self_attn.k_proj.bias"] = zeros(s.vision_embed_dim)
        sd[f"{L}.self_attn.v_proj.weight"] = zeros(s.vision_embed_dim, s.vision_embed_dim)
        sd[f"{L}.self_attn.v_proj.bias"] = zeros(s.vision_embed_dim)
        sd[f"{L}.self_attn.out_proj.weight"] = zeros(s.vision_embed_dim, s.vision_embed_dim)
        sd[f"{L}.self_attn.out_proj.bias"] = zeros(s.vision_embed_dim)
        sd[f"{L}.layer_norm2.weight"] = zeros(s.vision_embed_dim)
        sd[f"{L}.layer_norm2.bias"] = zeros(s.vision_embed_dim)
        sd[f"{L}.mlp.fc1.weight"] = zeros(s.vision_mlp_dim, s.vision_embed_dim)
        sd[f"{L}.mlp.fc1.bias"] = zeros(s.vision_mlp_dim)
        sd[f"{L}.mlp.fc2.weight"] = zeros(s.vision_embed_dim, s.vision_mlp_dim)
        sd[f"{L}.mlp.fc2.bias"] = zeros(s.vision_embed_dim)

    # VLM
    sd[f"{pre_vlm}.language_model.embed_tokens.weight"] = zeros(s.vocab_size, s.vlm_hidden)
    sd[f"{pre_vlm}.language_model.norm.weight"] = zeros(s.vlm_hidden)
    vlm_kv_out = s.vlm_kv_heads * s.vlm_head_dim  # MQA → 256
    vlm_q_out = s.vlm_heads * s.vlm_head_dim       # 2048
    for i in range(s.vlm_layers):
        L = f"{pre_vlm}.language_model.layers.{i}"
        sd[f"{L}.input_layernorm.weight"] = zeros(s.vlm_hidden)
        sd[f"{L}.self_attn.q_proj.weight"] = zeros(vlm_q_out, s.vlm_hidden)
        sd[f"{L}.self_attn.k_proj.weight"] = zeros(vlm_kv_out, s.vlm_hidden)
        sd[f"{L}.self_attn.v_proj.weight"] = zeros(vlm_kv_out, s.vlm_hidden)
        sd[f"{L}.self_attn.o_proj.weight"] = zeros(s.vlm_hidden, vlm_q_out)
        sd[f"{L}.post_attention_layernorm.weight"] = zeros(s.vlm_hidden)
        sd[f"{L}.mlp.gate_proj.weight"] = zeros(s.vlm_mlp_dim, s.vlm_hidden)
        sd[f"{L}.mlp.up_proj.weight"] = zeros(s.vlm_mlp_dim, s.vlm_hidden)
        sd[f"{L}.mlp.down_proj.weight"] = zeros(s.vlm_hidden, s.vlm_mlp_dim)

    # Expert
    sd[f"{pre_exp}.norm.weight"] = zeros(s.expert_hidden)
    sd[f"{pre_exp}.norm.dense.weight"] = zeros(3 * s.expert_hidden, s.expert_adarms_cond_dim)
    sd[f"{pre_exp}.norm.dense.bias"] = zeros(3 * s.expert_hidden)
    exp_kv_out = s.expert_kv_heads * s.expert_head_dim
    exp_q_out = s.expert_heads * s.expert_head_dim
    for i in range(s.expert_layers):
        L = f"{pre_exp}.layers.{i}"
        sd[f"{L}.input_layernorm.weight"] = zeros(s.expert_hidden)
        sd[f"{L}.input_layernorm.dense.weight"] = zeros(3 * s.expert_hidden, s.expert_adarms_cond_dim)
        sd[f"{L}.input_layernorm.dense.bias"] = zeros(3 * s.expert_hidden)
        sd[f"{L}.self_attn.q_proj.weight"] = zeros(exp_q_out, s.expert_hidden)
        sd[f"{L}.self_attn.k_proj.weight"] = zeros(exp_kv_out, s.expert_hidden)
        sd[f"{L}.self_attn.v_proj.weight"] = zeros(exp_kv_out, s.expert_hidden)
        sd[f"{L}.self_attn.o_proj.weight"] = zeros(s.expert_hidden, exp_q_out)
        sd[f"{L}.post_attention_layernorm.weight"] = zeros(s.expert_hidden)
        sd[f"{L}.post_attention_layernorm.dense.weight"] = zeros(3 * s.expert_hidden, s.expert_adarms_cond_dim)
        sd[f"{L}.post_attention_layernorm.dense.bias"] = zeros(3 * s.expert_hidden)
        sd[f"{L}.mlp.gate_proj.weight"] = zeros(s.expert_mlp_dim, s.expert_hidden)
        sd[f"{L}.mlp.up_proj.weight"] = zeros(s.expert_mlp_dim, s.expert_hidden)
        sd[f"{L}.mlp.down_proj.weight"] = zeros(s.expert_hidden, s.expert_mlp_dim)

    # Action / time projections
    sd["model.action_in_proj.weight"] = zeros(s.expert_hidden, s.action_dim)
    sd["model.action_in_proj.bias"] = zeros(s.expert_hidden)
    sd["model.action_out_proj.weight"] = zeros(s.action_dim, s.expert_hidden)
    sd["model.action_out_proj.bias"] = zeros(s.action_dim)
    sd["model.time_mlp_in.weight"] = zeros(s.expert_hidden, s.expert_hidden)
    sd["model.time_mlp_in.bias"] = zeros(s.expert_hidden)
    sd["model.time_mlp_out.weight"] = zeros(s.expert_hidden, s.expert_hidden)
    sd["model.time_mlp_out.bias"] = zeros(s.expert_hidden)

    return sd


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--checkpoint",
        help="HuggingFace repo or local dir for a LeRobot PI05Policy "
             "(e.g. lerobot/pi05_base, lerobot/pi05_libero).",
    )
    src.add_argument(
        "--state-dict",
        type=Path,
        help="Path to a single safetensors state-dict file (skips the LeRobot "
             "loader; faster for iterating on conversion logic).",
    )
    src.add_argument(
        "--self-test",
        action="store_true",
        help="Convert a synthetic (all-zeros) state dict that matches the "
             "expected PI05Policy names/shapes. Verifies the converter's "
             "structural contract end-to-end without needing a real "
             "checkpoint or HuggingFace access.",
    )
    parser.add_argument("--out", type=Path, required=True, help="Output GGUF path.")
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILES),
        default="q_aggressive",
        help="Quantisation profile. Default 'q_aggressive' (Q5_0 vision + "
             "Q8_0 VLM + Q8_0 expert linears + F32 norms/ada; ~3.7 GB for "
             "pi05_base, cos > 0.999 end-to-end) is what we recommend for "
             "testing and shipping. See README-pi05-converter.md for the "
             "full profile table, the 2026-05-21 sweep results, and the "
             "K-quant follow-up. K-quants (Q*_K) are NOT supported because "
             "gguf-py lacks Python packers for them and llama-quantize "
             "doesn't know the pi05 architecture.",
    )
    parser.add_argument(
        "--verify-vs-pt",
        action="store_true",
        help="After writing, reload the GGUF and assert tensor names/shapes "
             "match the intended layout. Cheap smoke test — does NOT do a "
             "PyTorch forward (that lives in the Phase 3 C++ unit tests).",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    setup_logging(args.verbose)

    if args.checkpoint is not None:
        sd = load_state_dict_from_lerobot(args.checkpoint)
        source_label = args.checkpoint
    elif args.self_test:
        sd = synthesize_state_dict()
        source_label = "synthetic"
    else:
        sd = load_state_dict_from_safetensors(args.state_dict)
        source_label = str(args.state_dict)

    log.info("loaded %d state-dict entries from %s", len(sd), source_label)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    n_written, intended = convert(sd, args.out, source_label, args.profile)
    elapsed = time.time() - t0
    log.info("wrote %d tensors → %s (%.1f MB) in %.1f s [profile=%s]",
             n_written, args.out, args.out.stat().st_size / 1e6, elapsed,
             args.profile)

    # Per-quant breakdown for the report.
    by_dt: dict[GGMLQuantizationType, int] = {}
    for _, (dt, _) in intended.items():
        by_dt[dt] = by_dt.get(dt, 0) + 1
    for dt, n in sorted(by_dt.items(), key=lambda kv: kv[0].name):
        log.info("  %s: %d tensors", dt.name, n)

    if args.verify_vs_pt:
        verify_gguf_matches_intent(args.out, intended)

    return 0


if __name__ == "__main__":
    sys.exit(main())
