#!/usr/bin/env python3
"""PyTorch reference activation dumper for the π₀.₅ ggml port.

Loads LeRobot's ``Pi05Policy`` PyTorch reference in eager mode (no
``torch.compile``, no quantisation, float32 everywhere we can hold it) and
dumps every breakpoint named in ``plan.md §5`` into a single
``activations.safetensors`` keyed by stable strings such as
``vision.blk_0.out[cam0]`` or ``ode.step_3.x_next``.

The dump is deterministic for a given ``--seed`` and ``--checkpoint``;
``oracle_fixtures.json`` pins the SHA-256 of both the fixture and the
activations file together with the checkpoint commit. The C++ ggml port
will load these tensors back, layer by layer, as a parity contract.

Usage:

    python3 dump_pi05_activations.py \\
      --checkpoint lerobot/pi05_base \\
      --out-dir ./oracle_dump/ \\
      --seed 0

Outputs ``fixture.safetensors`` and ``activations.safetensors`` in
``--out-dir``. The actual ``.safetensors`` artefacts are gitignored; this
script + ``oracle_fixtures.json`` + ``README-oracle.md`` are the committed
contract.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from safetensors.numpy import save_file as st_save_file
from safetensors.numpy import load_file as st_load_file


# ---------------------------------------------------------------------------
# Fixture parameters (mirror the verified spec in plan.md §2 / §5)
# ---------------------------------------------------------------------------

NUM_CAMERAS = 3
IMAGE_SIZE = 224
STATE_DIM = 32
TOKEN_MAX_LEN = 200
CHUNK_SIZE = 50
ACTION_DIM = 32
NUM_INFERENCE_STEPS = 10

# The verified pi05 vocab — PaliGemma SentencePiece.
PALIGEMMA_VOCAB_SIZE = 257_152

# The breakpoints we slice into for VLM/expert blocks (plan.md §5).
VLM_BLOCK_PROBE_IDS = (0, 8, 17)
EXPERT_BLOCK_PROBE_IDS = (0, 8, 17)
VISION_BLOCK_PROBE_IDS = (0, 13, 26)
# Time-step probes inside the ODE loop, listed by index into [1.0, 0.9, ..., 0.1].
T10_INDICES_TO_DUMP = (0, 3, 7, 9)
EXPERT_COND_TIME_PROBES = (1.0, 0.5, 0.1)


def _required_activation_keys() -> list[str]:
    """Single source of truth for every breakpoint named in plan.md §5.
    Used as a contract check after the oracle run completes — any missing key
    is almost always a hook that silently failed to fire."""
    keys: list[str] = []
    for cam in range(NUM_CAMERAS):
        keys.append(f"vision.patch_embed_out[cam{cam}]")
        keys.append(f"vision.pos_embed_out[cam{cam}]")
        for blk in VISION_BLOCK_PROBE_IDS:
            keys.append(f"vision.blk_{blk}.out[cam{cam}]")
        keys.append(f"vision.post_ln_out[cam{cam}]")
        keys.append(f"vision.head_out[cam{cam}]")
    keys.append("vision.concat")
    keys.append("vlm.embed_out")
    keys.append("vlm.prefix_concat")
    for blk in VLM_BLOCK_PROBE_IDS:
        keys.append(f"vlm.blk_{blk}.attn_out")
        keys.append(f"vlm.blk_{blk}.ffn_out")
    keys.append("vlm.blk_17.kv_keys")
    keys.append("vlm.blk_17.kv_vals")
    keys.append("vlm.final_out")
    keys.append("vlm.kv_cache_full.keys")
    keys.append("vlm.kv_cache_full.values")
    for t in EXPERT_COND_TIME_PROBES:
        keys.append(f"expert.cond[t={t:.1f}]")
    keys.append("expert.blk_0.adarms_scale[t=1.0]")
    keys.append("expert.blk_0.adarms_shift[t=1.0]")
    keys.append("expert.blk_0.adarms_gate[t=1.0]")
    keys.append("expert.blk_0.attn_out[t=1.0]")
    for blk in EXPERT_BLOCK_PROBE_IDS:
        keys.append(f"expert.blk_{blk}.out[t=1.0]")
    keys.append("expert.final_out[t=1.0]")
    keys.append("expert.v_t[t=1.0]")
    for step in T10_INDICES_TO_DUMP:
        keys.append(f"ode.step_{step}.x_next")
    keys.append("ode.actions_final")
    return keys


# ---------------------------------------------------------------------------
# Deterministic fixture synthesis
# ---------------------------------------------------------------------------


def build_fixture(seed: int) -> dict[str, np.ndarray]:
    """Return a self-contained input bundle, all NumPy float32 / int32.

    Images live in [-1, 1] (post-SigLIP preprocess), state in [-1, 1]
    (post-quantile-norm), tokens are integers in [0, vocab) with a deterministic
    pattern that mimics ``"Task: ..., State: ...;\nAction: "`` plus padding,
    mask covers the non-padded portion, noise is a unit Gaussian.

    Synthetic data is sufficient for tensor-level parity — the C++ port will
    load these exact tensors, not derive them from any LIBERO frame.
    """
    rng = np.random.default_rng(seed)

    images = rng.uniform(
        low=-1.0,
        high=1.0,
        size=(NUM_CAMERAS, 3, IMAGE_SIZE, IMAGE_SIZE),
    ).astype(np.float32)
    img_masks = np.ones((NUM_CAMERAS,), dtype=np.bool_)

    state = rng.uniform(low=-1.0, high=1.0, size=(STATE_DIM,)).astype(np.float32)

    # Deterministic token sequence. We don't have public access to the
    # PaliGemma SentencePiece (gated repo); for parity-tensor purposes any
    # deterministic int32 array that fits in [0, vocab) works — the C++ port
    # will reuse this exact array. The prompt string is recorded next to the
    # tokens for documentation purposes (and so a future job with HF_TOKEN
    # can re-tokenise it for a bit-identical re-run).
    prompt = "pick up the alphabet soup and place it in the basket"
    # Use seed-derived deterministic ids; carve out a "real" prefix length and
    # leave the rest as zeros (pad) so the input_mask is non-trivial.
    real_len = 64
    tokens = np.zeros((TOKEN_MAX_LEN,), dtype=np.int32)
    tokens[:real_len] = rng.integers(
        low=1, high=PALIGEMMA_VOCAB_SIZE, size=(real_len,), dtype=np.int64
    ).astype(np.int32)
    mask = np.zeros((TOKEN_MAX_LEN,), dtype=np.bool_)
    mask[:real_len] = True

    noise = rng.standard_normal(size=(CHUNK_SIZE, ACTION_DIM)).astype(np.float32)

    time_grid = np.array(
        [1.0 + i * (-1.0 / NUM_INFERENCE_STEPS) for i in range(NUM_INFERENCE_STEPS)],
        dtype=np.float32,
    )

    return {
        "fixture.images": images,
        "fixture.img_masks": img_masks,
        "fixture.state": state,
        "fixture.tokens": tokens,
        "fixture.mask": mask,
        "fixture.noise": noise,
        "fixture.time_grid": time_grid,
        # also stash a short int32 array containing the prompt as UTF-8 bytes
        # so the test harness can reproduce the exact prompt string when needed.
        "fixture.prompt_utf8": np.frombuffer(prompt.encode("utf-8"), dtype=np.uint8).copy(),
    }


def to_numpy(t: torch.Tensor) -> np.ndarray:
    return t.detach().to(torch.float32).cpu().numpy()


# ---------------------------------------------------------------------------
# Activation capture
# ---------------------------------------------------------------------------


class ActivationStore:
    """Append-only sink for named activations. Last write wins (intentional —
    the ODE loop re-runs the same block 10 times; we either index by t-step
    or accept the final write)."""

    def __init__(self) -> None:
        self.data: dict[str, np.ndarray] = {}

    def put(self, key: str, value: torch.Tensor) -> None:
        if key in self.data:
            # Helpful diagnostic if we accidentally collide names.
            print(f"  [store] overwriting {key} (prev shape {self.data[key].shape})")
        self.data[key] = to_numpy(value)

    def has(self, key: str) -> bool:
        return key in self.data

    def keys(self) -> list[str]:
        return sorted(self.data.keys())


# ---------------------------------------------------------------------------
# Vision hooks
# ---------------------------------------------------------------------------


def install_vision_hooks(policy_model, store: ActivationStore) -> list:
    """Hook the SigLIP-So400m/14 vision tower so we capture the per-camera
    breakpoints in plan.md §5. We grab patch_embed, pos_embed, three
    spot-check transformer blocks, post_ln, and the projector (head).

    The per-camera index is filled in by ``set_cam`` from the caller before
    each forward; the hook closure reads it at fire time.
    """
    handles = []
    state = {"cam": -1}

    vision_tower = (
        policy_model.paligemma_with_expert.paligemma.model.vision_tower
    )
    multi_modal_projector = (
        policy_model.paligemma_with_expert.paligemma.model.multi_modal_projector
    )

    # Walk the SigLIP module tree to find the components we want.
    # HF SigLIP layout: vision_tower.vision_model.{embeddings,encoder,post_layernorm}
    vm = vision_tower.vision_model
    embeddings = vm.embeddings  # has patch_embedding (Conv2d) + position_embedding
    encoder_layers = vm.encoder.layers
    post_ln = vm.post_layernorm

    # patch_embed_out: Conv2d output, then flatten + transpose. We hook the
    # patch_embedding submodule directly (it produces the (B, 1152, 16, 16)
    # tensor before the flatten in HF SigLIP).
    def patch_hook(_module, _inp, out):
        # out: (B, 1152, 16, 16)  -- flatten to (256, 1152) for storage
        cam = state["cam"]
        if cam < 0:
            return
        flat = out.flatten(2).transpose(1, 2)  # (B, 256, 1152)
        store.put(f"vision.patch_embed_out[cam{cam}]", flat[0])

    handles.append(embeddings.patch_embedding.register_forward_hook(patch_hook))

    # pos_embed_out: the sum of patch_embed + position_embeddings. The full
    # ``embeddings`` module returns this tensor, so hook it directly.
    def pos_hook(_module, _inp, out):
        # out: (B, 256, 1152)
        cam = state["cam"]
        if cam < 0:
            return
        store.put(f"vision.pos_embed_out[cam{cam}]", out[0])

    handles.append(embeddings.register_forward_hook(pos_hook))

    # Per-block outputs. SigLIP HF blocks return (hidden_states,) tuple
    # (or sometimes a bare tensor depending on version).
    for blk_idx in VISION_BLOCK_PROBE_IDS:
        if blk_idx >= len(encoder_layers):
            continue
        layer = encoder_layers[blk_idx]

        def make_block_hook(i: int):
            def _hook(_module, _inp, out):
                cam = state["cam"]
                if cam < 0:
                    return
                h = out[0] if isinstance(out, tuple) else out
                store.put(f"vision.blk_{i}.out[cam{cam}]", h[0])

            return _hook

        handles.append(layer.register_forward_hook(make_block_hook(blk_idx)))

    # post_layernorm output
    def post_ln_hook(_module, _inp, out):
        cam = state["cam"]
        if cam < 0:
            return
        store.put(f"vision.post_ln_out[cam{cam}]", out[0])

    handles.append(post_ln.register_forward_hook(post_ln_hook))

    # Projector (the "head" linear: (256, 1152) -> (256, 2048)). HF SigLIP's
    # ``multi_modal_projector`` is the right hook target — it's called by
    # ``get_image_features`` right after the vision encoder.
    def head_hook(_module, _inp, out):
        cam = state["cam"]
        if cam < 0:
            return
        # out: (B, 256, 2048)
        store.put(f"vision.head_out[cam{cam}]", out[0])

    handles.append(multi_modal_projector.register_forward_hook(head_hook))

    def set_cam(idx: int) -> None:
        state["cam"] = idx

    return handles, set_cam


# ---------------------------------------------------------------------------
# VLM prefix / KV cache capture
# ---------------------------------------------------------------------------


def install_vlm_hooks(policy_model, store: ActivationStore) -> list:
    """Capture VLM prefill activations and the full KV cache. We do this by
    instrumenting the PaliGemma language model decoder layers.
    """
    handles = []
    vlm = policy_model.paligemma_with_expert.paligemma.model.language_model
    layers = vlm.layers  # ModuleList of length 18

    # Block input / output hooks (probe at indices 0, 8, 17).
    # We want pre-attention norm output (attn_out) and pre-ffw norm output
    # (ffn_out). The PiGemmaDecoderLayerBase forward in pi_gemma.py runs:
    #   residual1 = x
    #   x, gate = input_layernorm(x); x = attn(x); x = residual1 + x
    #   residual2 = x
    #   x, gate = post_attn_ln(x); x = mlp(x); x = residual2 + x
    # We capture x just after each of the two gated residual adds — that's
    # the "attn_out" / "ffn_out" the plan asks for. To get those exact
    # values we instead probe the modules: capture the o_proj output
    # (pre-residual) for attn_out, capture mlp output (pre-residual) for
    # ffn_out — but the plan says "(prefix_len, 2048)" which is the
    # *post-residual* hidden state. So we hook the whole DecoderLayer with
    # a forward hook and snapshot its output (the final residual sum, ready
    # to feed into the next layer).
    for blk_idx in VLM_BLOCK_PROBE_IDS:
        layer = layers[blk_idx]

        def make_layer_hook(i: int):
            def _hook(_module, _inp, out):
                # out is the post-residual hidden state (B, prefix_len, 2048).
                # PiGemmaDecoderLayer.forward returns a bare tensor today; older
                # transformers wrappers return ``(hidden,)`` — handle both so
                # the dump is shape (prefix_len, 2048) either way.
                h = out[0] if isinstance(out, tuple) else out
                store.put(f"vlm.blk_{i}.ffn_out", h[0])

            return _hook

        handles.append(layer.register_forward_hook(make_layer_hook(blk_idx)))

        # o_proj output captures attn projection (post O, pre residual). The
        # plan asks for the *post-residual* attn output but for a converter
        # parity ladder the pre-residual O-proj output is what isolates the
        # attention sub-graph cleanly, and is much easier to compare.
        o_proj = layer.self_attn.o_proj

        def make_o_hook(i: int):
            def _hook(_module, _inp, out):
                store.put(f"vlm.blk_{i}.attn_out", out[0])

            return _hook

        handles.append(o_proj.register_forward_hook(make_o_hook(blk_idx)))

    # NB: we deliberately do not register a forward hook for ``vlm.final_out``
    # here. PaligemmaWithExpertModel.forward() calls
    # ``self.paligemma.model.language_model.forward(...)`` *directly* (see
    # modeling_pi05.py:464 in lerobot 0.5.x), which bypasses hooks — PyTorch
    # only fires forward hooks through ``__call__`` / ``_call_impl``. The
    # value we want is already returned by ``pawe.forward(...)`` as
    # ``prefix_output``, so the caller stores it directly after the call.

    return handles


# ---------------------------------------------------------------------------
# Expert hooks — adaRMSNorm split, expert blocks, and v_t. Only fired at the
# t=1.0 ODE step (we install at start of step_idx == 0, capture, uninstall).
# ---------------------------------------------------------------------------


def install_expert_hooks(policy_model, store: ActivationStore) -> list:
    """Capture expert per-block activations at the first ODE step (t=1.0).

    We grab adaRMSNorm scale/shift/gate at block 0 by monkeypatching the
    PiGemmaRMSNorm.forward of layer 0's input_layernorm — it has to be a
    monkeypatch because (scale, shift, gate) are intermediate values inside
    that method, not a module output.
    """
    handles: list[Any] = []
    expert = policy_model.paligemma_with_expert.gemma_expert
    layers = expert.model.layers  # ModuleList of length 18

    # Monkeypatch input_layernorm of layer 0 to capture (scale, shift, gate).
    target_norm = layers[0].input_layernorm
    orig_forward = target_norm.forward

    def patched_forward(x, cond=None):  # noqa: ANN001
        # Mirror PiGemmaRMSNorm.forward exactly (see pi_gemma.py:111–128).
        dtype = x.dtype
        normed = target_norm._norm(x)  # noqa: SLF001
        if cond is None or target_norm.dense is None:
            normed = normed * (1.0 + target_norm.weight.float())
            return normed.type_as(x), None
        modulation = target_norm.dense(cond)
        if len(x.shape) == 3:
            modulation = modulation.unsqueeze(1)
        scale, shift, gate = modulation.chunk(3, dim=-1)
        # Capture once. Strip the batch dimension and the trivial seq-broadcast
        # axis: scale/shift/gate are (B, 1, W) → save (W,).
        if not store.has("expert.blk_0.adarms_scale[t=1.0]"):
            store.put("expert.blk_0.adarms_scale[t=1.0]", scale[0, 0])
            store.put("expert.blk_0.adarms_shift[t=1.0]", shift[0, 0])
            store.put("expert.blk_0.adarms_gate[t=1.0]", gate[0, 0])
        normed = normed * (1 + scale.float()) + shift.float()
        return normed.to(dtype), gate.to(dtype)

    target_norm.forward = patched_forward  # type: ignore[assignment]

    # Provide a cleanup that restores the original.
    class _Restore:
        def remove(self):
            target_norm.forward = orig_forward  # type: ignore[assignment]

    handles.append(_Restore())

    # Expert block outputs (post-residual). Capture only at t=1.0; the
    # capture is gated on a flag we flip from outside.
    state = {"capture_t1": True}

    for blk_idx in EXPERT_BLOCK_PROBE_IDS:
        layer = layers[blk_idx]

        def make_layer_hook(i: int):
            def _hook(_module, _inp, out):
                if not state["capture_t1"]:
                    return
                key = f"expert.blk_{i}.out[t=1.0]"
                if store.has(key):
                    return
                h = out[0] if isinstance(out, tuple) else out
                store.put(key, h[0])

            return _hook

        handles.append(layer.register_forward_hook(make_layer_hook(blk_idx)))

        # Also capture attn_out (o_proj) at block 0 only.
        if blk_idx == 0:
            o_proj = layer.self_attn.o_proj

            def attn_hook(_module, _inp, out):
                if not state["capture_t1"]:
                    return
                if store.has("expert.blk_0.attn_out[t=1.0]"):
                    return
                store.put("expert.blk_0.attn_out[t=1.0]", out[0])

            handles.append(o_proj.register_forward_hook(attn_hook))

    # Expert final norm output — we hook the model.norm submodule. But that
    # module returns a tuple (normed, gate); a forward_hook receives the
    # full output, so we extract [0].
    final_norm = expert.model.norm

    def final_norm_hook(_module, _inp, out):
        if not state["capture_t1"]:
            return
        if store.has("expert.final_out[t=1.0]"):
            return
        normed = out[0] if isinstance(out, tuple) else out
        store.put("expert.final_out[t=1.0]", normed[0])

    handles.append(final_norm.register_forward_hook(final_norm_hook))

    def set_capture_t1(flag: bool) -> None:
        state["capture_t1"] = flag

    return handles, set_capture_t1


# ---------------------------------------------------------------------------
# Manual reimplementation of the ODE loop with breakpoints
# ---------------------------------------------------------------------------


def run_oracle(policy_model, fixture: dict[str, np.ndarray], store: ActivationStore) -> np.ndarray:
    """Run the deterministic forward pass that mirrors
    ``PI05Pytorch.sample_actions``, with explicit breakpoints at every
    location named in plan.md §5.
    """
    device = next(policy_model.parameters()).device

    # ---- Inputs as torch tensors on device ----------------------------------
    images_np = fixture["fixture.images"]  # (3, 3, 224, 224)
    img_masks_np = fixture["fixture.img_masks"]  # (3,)
    tokens_np = fixture["fixture.tokens"]  # (200,)
    mask_np = fixture["fixture.mask"]  # (200,)
    noise_np = fixture["fixture.noise"]  # (50, 32)

    dtype = next(policy_model.parameters()).dtype
    images = [
        torch.from_numpy(images_np[i]).unsqueeze(0).to(device=device, dtype=dtype)
        for i in range(NUM_CAMERAS)
    ]
    img_masks = [
        torch.from_numpy(np.array([bool(img_masks_np[i])])).to(device=device)
        for i in range(NUM_CAMERAS)
    ]
    tokens = torch.from_numpy(tokens_np).unsqueeze(0).long().to(device=device)
    mask = torch.from_numpy(mask_np).unsqueeze(0).to(device=device)
    noise = torch.from_numpy(noise_np).unsqueeze(0).to(device=device, dtype=dtype)

    # ---- Vision: embed every camera, one at a time, so the per-camera hooks
    # fire deterministically. We then concat the features into a (3*256, 2048)
    # tensor exactly as PI05Pytorch.embed_prefix does internally, and store
    # the full ``vision.concat``.
    vision_hooks, set_cam = install_vision_hooks(policy_model, store)

    image_features = []
    pawe = policy_model.paligemma_with_expert
    for cam_i in range(NUM_CAMERAS):
        set_cam(cam_i)
        feat = pawe.embed_image(images[cam_i])  # (1, 256, 2048) post-sqrt-scale
        image_features.append(feat)
    set_cam(-1)
    for h in vision_hooks:
        h.remove()

    # Concat across cameras along the seq axis.
    vision_concat = torch.cat(image_features, dim=1)  # (1, 768, 2048)
    store.put("vision.concat", vision_concat[0])

    gc.collect()

    # ---- Language tokens: embed + scale by sqrt(width) ---------------------
    lang_emb = pawe.embed_language_tokens(tokens)
    lang_emb = lang_emb * torch.tensor(math.sqrt(lang_emb.shape[-1]), dtype=dtype)
    store.put("vlm.embed_out", lang_emb[0])

    # ---- Build prefix: cat(vision tokens, lang tokens) ---------------------
    embs = torch.cat([*image_features, lang_emb], dim=1)  # (1, 3*256+200, 2048)
    store.put("vlm.prefix_concat", embs[0])

    # ---- Build pad / att masks exactly as embed_prefix would --------------
    # pad_mask: per-camera (B, 256) of img_mask[:, None], cat with lang mask.
    bsize = 1
    pad_masks_list = []
    for cam_i in range(NUM_CAMERAS):
        pm = img_masks[cam_i][:, None].expand(bsize, image_features[cam_i].shape[1])
        pad_masks_list.append(pm)
    pad_masks_list.append(mask)
    pad_masks = torch.cat(pad_masks_list, dim=1)  # (1, prefix_len)

    # att_masks: zeros everywhere in the prefix (block-bidirectional).
    prefix_len = pad_masks.shape[1]
    att_masks = torch.zeros(bsize, prefix_len, dtype=torch.bool, device=device)

    from lerobot.policies.pi05.modeling_pi05 import make_att_2d_masks  # local import
    from lerobot.utils.constants import OPENPI_ATTENTION_MASK_VALUE

    att_2d_masks = make_att_2d_masks(pad_masks, att_masks)
    position_ids = torch.cumsum(pad_masks, dim=1) - 1

    att_2d_masks_4d = att_2d_masks[:, None, :, :]
    mask_fill = torch.tensor(OPENPI_ATTENTION_MASK_VALUE, dtype=dtype)
    att_2d_masks_4d = torch.where(att_2d_masks_4d, torch.zeros(1, dtype=dtype), mask_fill)

    # Ensure eager attention.
    policy_model.paligemma_with_expert.paligemma.model.language_model.config._attn_implementation = "eager"  # noqa: SLF001
    policy_model.paligemma_with_expert.gemma_expert.model.config._attn_implementation = "eager"  # noqa: SLF001

    # ---- VLM prefill -------------------------------------------------------
    vlm_hooks = install_vlm_hooks(policy_model, store)
    [prefix_out, _], past_key_values = pawe.forward(
        attention_mask=att_2d_masks_4d,
        position_ids=position_ids,
        past_key_values=None,
        inputs_embeds=[embs, None],
        use_cache=True,
    )
    for h in vlm_hooks:
        h.remove()

    # vlm.final_out: prefix_output from pawe is exactly the post-final-norm
    # hidden state of the language model. Captured here rather than via a
    # forward hook because pawe invokes language_model.forward() directly,
    # bypassing PyTorch's hook plumbing.
    store.put("vlm.final_out", prefix_out[0])

    # vlm.final_out should now be populated; also dump the KV cache.
    # past_key_values is a DynamicCache; access .layers[i].keys / .values.
    try:
        kv_layers = past_key_values.layers
    except AttributeError:
        kv_layers = None
    if kv_layers is not None:
        # Stack the 18 layers into a single (18, prefix_len, num_kv_heads, head_dim)
        # tensor for ease of comparison.
        ks = []
        vs = []
        for li in range(len(kv_layers)):
            # Each layer has .keys (1, kv_heads, seq, head_dim) and .values likewise.
            k = kv_layers[li].keys  # (1, 1, prefix_len, 256) for MQA
            v = kv_layers[li].values
            # Reshape to (prefix_len, num_kv_heads, head_dim) for storage.
            ks.append(k[0].permute(1, 0, 2).contiguous())  # (seq, heads, dim)
            vs.append(v[0].permute(1, 0, 2).contiguous())
        kv_keys_full = torch.stack(ks, dim=0)  # (18, seq, heads, dim)
        kv_vals_full = torch.stack(vs, dim=0)
        store.put("vlm.kv_cache_full.keys", kv_keys_full)
        store.put("vlm.kv_cache_full.values", kv_vals_full)
        # Plus the convenience aliases the plan calls out explicitly.
        store.put("vlm.blk_17.kv_keys", kv_keys_full[17])
        store.put("vlm.blk_17.kv_vals", kv_vals_full[17])

    gc.collect()

    # ---- ODE loop ---------------------------------------------------------
    expert_hooks, set_capture_t1 = install_expert_hooks(policy_model, store)

    import copy as _copy

    dt = -1.0 / NUM_INFERENCE_STEPS
    x_t = noise  # (1, 50, 32)

    action_in_proj = policy_model.action_in_proj
    time_mlp_in = policy_model.time_mlp_in
    time_mlp_out = policy_model.time_mlp_out

    from lerobot.policies.pi05.modeling_pi05 import create_sinusoidal_pos_embedding

    print(f"[ode] starting {NUM_INFERENCE_STEPS}-step ODE loop")
    for step in range(NUM_INFERENCE_STEPS):
        t_val = 1.0 + step * dt
        capture_this_step = abs(t_val - 1.0) < 1e-6
        set_capture_t1(capture_this_step)

        time_tensor = torch.tensor(t_val, dtype=dtype, device=device).expand(bsize)

        time_emb = create_sinusoidal_pos_embedding(
            time_tensor,
            action_in_proj.out_features,
            min_period=4e-3,
            max_period=4.0,
            device=device,
        )
        time_emb = time_emb.type(dtype=time_tensor.dtype)
        cond = time_mlp_in(time_emb)
        cond = F.silu(cond)
        cond = time_mlp_out(cond)
        cond = F.silu(cond)
        for probe_t in EXPERT_COND_TIME_PROBES:
            if abs(t_val - probe_t) < 1e-6:
                store.put(f"expert.cond[t={probe_t:.1f}]", cond[0])

        past_key_values_copy = _copy.deepcopy(past_key_values)
        v_t = policy_model.denoise_step(
            prefix_pad_masks=pad_masks,
            past_key_values=past_key_values_copy,
            x_t=x_t,
            timestep=time_tensor,
        )
        del past_key_values_copy
        if capture_this_step:
            store.put("expert.v_t[t=1.0]", v_t[0])

        x_t = x_t + dt * v_t
        del v_t

        if step in T10_INDICES_TO_DUMP:
            store.put(f"ode.step_{step}.x_next", x_t[0])

        if step % 3 == 0:
            gc.collect()
        print(f"  step {step}/{NUM_INFERENCE_STEPS} t={t_val:.2f} done")

    for h in expert_hooks:
        h.remove()

    actions_final = x_t  # (1, 50, 32)
    store.put("ode.actions_final", actions_final[0])

    return to_numpy(actions_final[0])


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", default="lerobot/pi05_base")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--write-fixtures-json",
        default=None,
        help="If set, also write a fixtures pin JSON to this path (defaults to "
        "scripts/oracle_fixtures.json next to this script).",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"== π₀.₅ parity oracle ==")
    print(f"checkpoint: {args.checkpoint}")
    print(f"out_dir:    {out_dir}")
    print(f"seed:       {args.seed}")

    t0 = time.time()

    # --- 1. Build & write the deterministic fixture ------------------------
    fixture = build_fixture(args.seed)
    fixture_path = out_dir / "fixture.safetensors"
    st_save_file(fixture, str(fixture_path))
    print(f"[fixture] wrote {fixture_path} "
          f"({sum(a.nbytes for a in fixture.values()) / 1e6:.2f} MB)")

    # --- 2. Load the LeRobot policy in eager mode --------------------------
    print("[load] importing lerobot.policies.pi05.modeling_pi05 ...")
    from lerobot.policies.pi05.configuration_pi05 import PI05Config
    from lerobot.policies.pi05.modeling_pi05 import PI05Policy

    # Load in bfloat16 (the model's native dtype) to halve memory from ~15 GB
    # to ~7.7 GB. Activations are still saved as float32 via to_numpy().
    cfg = PI05Config(
        dtype="bfloat16",
        compile_model=False,
        device="cpu",
    )
    print("[load] PI05Policy.from_pretrained(...)")
    policy = PI05Policy.from_pretrained(args.checkpoint, config=cfg, strict=False)
    policy.eval()
    inner = policy.model  # PI05Pytorch

    inner.to(torch.bfloat16)
    gc.collect()

    # --- 3. Run the deterministic forward pass with breakpoints ----------
    store = ActivationStore()
    with torch.no_grad():
        actions_final = run_oracle(inner, fixture, store)

    assert actions_final.shape == (CHUNK_SIZE, ACTION_DIM), (
        f"unexpected actions_final shape {actions_final.shape}"
    )

    # --- 4. Contract check: every breakpoint named in plan §5 must exist --
    required = _required_activation_keys()
    missing = [k for k in required if k not in store.data]
    if missing:
        print(f"[contract] MISSING {len(missing)} required keys:", file=sys.stderr)
        for k in missing:
            print(f"  - {k}", file=sys.stderr)
        return 1
    print(f"[contract] OK — all {len(required)} required keys present")

    # --- 5. Persist the activations dump ---------------------------------
    activations_path = out_dir / "activations.safetensors"
    st_save_file(store.data, str(activations_path))
    print(f"[activations] wrote {activations_path} "
          f"({activations_path.stat().st_size / 1e6:.2f} MB)")
    print(f"[activations] {len(store.data)} keys captured")

    # --- 6. Sanity-load + spot-check -------------------------------------
    reloaded = st_load_file(str(activations_path))
    print("[verify] reload OK")
    print(f"[verify] ode.actions_final shape = {reloaded['ode.actions_final'].shape}")

    # --- 7. Fixtures JSON ------------------------------------------------
    fixtures_json_path = (
        Path(args.write_fixtures_json).resolve()
        if args.write_fixtures_json
        else Path(__file__).resolve().parent / "oracle_fixtures.json"
    )

    import torch as _t
    import transformers as _tr
    import lerobot as _lr

    ckpt_path = Path(args.checkpoint)
    if ckpt_path.exists():
        ckpt_revision = f"local:{sha256_file(next(ckpt_path.glob('*.safetensors')))[:12]}"
    else:
        from huggingface_hub import HfApi
        ckpt_revision = HfApi().model_info(args.checkpoint).sha

    fixtures_payload = {
        "checkpoint": args.checkpoint,
        "checkpoint_revision": ckpt_revision,
        "lerobot_version": getattr(_lr, "__version__", "unknown"),
        "lerobot_commit": "n/a (installed from PyPI lerobot=="
                          + getattr(_lr, "__version__", "unknown")
                          + ")",
        "torch_version": _t.__version__,
        "transformers_version": _tr.__version__,
        "seed": args.seed,
        "fixture_sha256": sha256_file(fixture_path),
        "activations_sha256": sha256_file(activations_path),
        "num_keys": len(store.data),
        "python_executable": sys.executable,
    }
    with open(fixtures_json_path, "w", encoding="utf-8") as f:
        json.dump(fixtures_payload, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"[fixtures] wrote {fixtures_json_path}")
    print(json.dumps(fixtures_payload, indent=2))

    elapsed = time.time() - t0
    print(f"== done in {elapsed:.1f} s ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
