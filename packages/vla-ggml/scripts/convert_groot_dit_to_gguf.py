#!/usr/bin/env python3
"""Convert GR00T N1.7-3B's action-head weights (VL fusion + DiT + embodiment MLPs)
to a GGUF file, single-embodiment-sliced for v1. Covers `action_head.*`; the
backbone (Qwen3-VL vision + truncated-16-layer text decoder) is converted
separately via fabric's own convert_hf_to_gguf.py (see _repackage_groot_backbone.py).

Embodiment conditioning (`CategorySpecificLinear`) keeps a weight matrix per
embodiment (`self.W[cat_ids]`, up to 32). For v1 we slice out one embodiment's row
at conversion time and store it as a plain dense tensor — no runtime embodiment-ID
input is needed by the ggml loader.

Real dims (verified against the actual checkpoint's tensor shapes, not
inferred from the HF config prose):
    hidden_size (action_head)      = 1024
    input_embedding_dim (DiT dim)  = 1536  (= dit_num_heads * dit_head_dim = 32*48)
    backbone_embedding_dim         = 2048  (= vlfusion dim = DiT cross_attention_dim)
    max_state_dim = max_action_dim = 132
    action_horizon                 = 40
    dit: 32 layers, 32 heads, head_dim 48, ffn_mult 4 (inner 6144), output_dim 1024,
         norm_type ada_norm (norm_elementwise_affine=False -> no norm1.norm/norm3 weights),
         activation gelu-approximate (single proj, NOT geglu — net.0.proj is un-doubled),
         interleave_self_attention=True, attend_text_every_n_blocks=2
         (even blocks = cross-attn to backbone features, odd blocks = self-attn)
    vl_self_attention (vlfusion): 4 layers, 32 heads, head_dim 64, ffn_mult 4 (inner 8192),
         plain LayerNorm (norm_elementwise_affine=True -> norm1/norm3 have weight+bias),
         no cross-attention, no positional embeddings (vl_self_attention_cfg.positional_embeddings=null)
    timestep_encoder: Timesteps(256 channels) -> Linear(256,1536) -> SiLU -> Linear(1536,1536)
    position_embedding: nn.Embedding(1024, 1536), only rows [0:action_horizon) are
         ever indexed at inference (applied to action tokens only, before concat with state)

Usage:
    python convert_groot_dit_to_gguf.py \
        --checkpoint /path/to/GR00T-N1.7-3B \
        --embodiment-tag libero_sim \
        --out groot-action-head.gguf
"""

import argparse
import json
from pathlib import Path

import gguf
import numpy as np
import torch
from safetensors import safe_open

DIT_NUM_LAYERS = 32
DIT_NUM_HEADS = 32
DIT_HEAD_DIM = 48
DIT_INNER_DIM = DIT_NUM_HEADS * DIT_HEAD_DIM  # 1536
DIT_OUTPUT_DIM = 1024
DIT_FFN_INNER = DIT_INNER_DIM * 4  # 6144, single (non-gated) GELU-approximate
ATTEND_TEXT_EVERY_N_BLOCKS = 2
DIT_NUM_TIMESTEP_BUCKETS = 1000  # diffusers get_timestep_embedding buckets

VLFUSION_NUM_LAYERS = 4
VLFUSION_NUM_HEADS = 32
VLFUSION_HEAD_DIM = 64
VLFUSION_INNER_DIM = VLFUSION_NUM_HEADS * VLFUSION_HEAD_DIM  # 2048
VLFUSION_FFN_INNER = VLFUSION_INNER_DIM * 4  # 8192

HIDDEN_SIZE = 1024  # action_head.hidden_size (state_encoder/action_decoder MLP width)
MAX_STATE_DIM = 132
MAX_ACTION_DIM = 132
ACTION_HORIZON = 40
NUM_CAMERAS = 2  # LIBERO: image + wrist_image
NUM_EMBODIMENTS_TOTAL = 32
TIMESTEP_PROJ_CHANNELS = 256

# Backbone hparams (real Qwen3-VL / Cosmos-Reason2-2B config, text decoder
# truncated to 16 layers per GR00T's select_layer). fabric stamps these as
# `qwen3vl.*` keys into the backbone parts, but _merge_groot_gguf.py copies
# hparams only from THIS file — so the merged groot.gguf needs its own copy
# under `groot.*` for groot.cpp's loader to read.
TEXT_NUM_LAYERS = 16
TEXT_HIDDEN_SIZE = 2048
TEXT_NUM_HEADS = 16
TEXT_NUM_KV_HEADS = 8
TEXT_HEAD_DIM = 128
TEXT_FFN_LENGTH = 6144
TEXT_VOCAB_SIZE = 151936
TEXT_ROPE_FREQ_BASE = 5000000
TEXT_RMS_NORM_EPS = 1e-6
# Qwen3-VL image placeholder token id. infer() scans langTokens for runs of this
# id to splice vision embeds and to derive the M-RoPE spatial position ids.
IMAGE_TOKEN_ID = 151655

VISION_DEPTH = 24
VISION_HIDDEN_SIZE = 1024
VISION_NUM_HEADS = 16
VISION_PATCH_SIZE = 16
VISION_SPATIAL_MERGE_SIZE = 2
VISION_TEMPORAL_PATCH_SIZE = 2
VISION_NUM_POSITION_EMBEDDINGS = 2304
VISION_OUT_HIDDEN_SIZE = 2048
VISION_IMAGE_SIZE = 256  # image_target_size
VISION_DEEPSTACK_INDEXES = [5, 11, 17]


class Gr00tActionHeadReader:
    def __init__(self, checkpoint_dir: Path):
        self.checkpoint_dir = checkpoint_dir
        index = json.loads((checkpoint_dir / "model.safetensors.index.json").read_text())
        self.weight_map = index["weight_map"]
        self._open_files = {}

    def _file_for(self, key: str):
        shard = self.weight_map[key]
        if shard not in self._open_files:
            self._open_files[shard] = safe_open(self.checkpoint_dir / shard, framework="pt")
        return self._open_files[shard]

    def get(self, key: str) -> torch.Tensor:
        return self._file_for(key).get_tensor(key).float()

    def get_embodiment_slice(self, key: str, cat_id: int) -> torch.Tensor:
        """Index a CategorySpecificLinear weight/bias at one embodiment, drop the category dim."""
        t = self.get(key)
        return t[cat_id].contiguous()


def add_basic_transformer_block(
    writer: gguf.GGUFWriter,
    reader: Gr00tActionHeadReader,
    src_prefix: str,
    dst_prefix: str,
    has_ada_norm: bool,
    has_cross_attn: bool,
    inner_dim: int = None,
    ffn_inner: int = None,
):
    """Port one diffusers BasicTransformerBlock's weights to `dst_prefix.*` GGUF tensors."""
    def cp(src_suffix, dst_suffix, transpose=False, expect=None):
        t = reader.get(f"{src_prefix}.{src_suffix}")
        if transpose:
            t = t.t().contiguous()
        # Guard the hardcoded arch constants against the real checkpoint: these
        # dims are written verbatim into groot.* GGUF metadata and read by
        # groot.cpp, which only cross-checks their internal consistency (e.g.
        # num_heads*head_dim == inner_dim), never against an actual tensor. A
        # checkpoint whose inner/ffn width differs would otherwise convert and
        # load clean, then mis-shape attention/FFN at runtime with no error.
        # NOTE: this catches wrong inner_dim/ffn_inner PRODUCTS only — the
        # num_heads vs head_dim factorization (e.g. 48x32 vs 32x48) is a
        # metadata-only choice with no weight-shape footprint, so it stays a
        # hand-set constant that no assert here can verify.
        if expect is not None:
            assert tuple(t.shape) == tuple(expect), (
                f"{src_prefix}.{src_suffix} shape {tuple(t.shape)} != expected "
                f"{tuple(expect)} — checkpoint arch differs from the hardcoded "
                f"constants in this converter")
        writer.add_tensor(f"{dst_prefix}.{dst_suffix}", t.numpy())

    if has_ada_norm:
        cp("norm1.linear.weight", "norm1_linear.weight")
        cp("norm1.linear.bias", "norm1_linear.bias")
    else:
        cp("norm1.weight", "norm1.weight")
        cp("norm1.bias", "norm1.bias")
        cp("norm3.weight", "norm3.weight")
        cp("norm3.bias", "norm3.bias")

    # nn.Linear weight is [out, in]; to_q maps inner_dim -> inner_dim.
    cp("attn1.to_q.weight", "attn_q.weight",
       expect=(inner_dim, inner_dim) if inner_dim else None)
    cp("attn1.to_q.bias", "attn_q.bias")
    cp("attn1.to_k.weight", "attn_k.weight")
    cp("attn1.to_k.bias", "attn_k.bias")
    cp("attn1.to_v.weight", "attn_v.weight")
    cp("attn1.to_v.bias", "attn_v.bias")
    cp("attn1.to_out.0.weight", "attn_out.weight")
    cp("attn1.to_out.0.bias", "attn_out.bias")

    # ff.net.0.proj maps inner_dim -> ffn_inner (single non-gated GELU proj).
    cp("ff.net.0.proj.weight", "ffn_in.weight",
       expect=(ffn_inner, inner_dim) if (ffn_inner and inner_dim) else None)
    cp("ff.net.0.proj.bias", "ffn_in.bias")
    cp("ff.net.2.weight", "ffn_out.weight")
    cp("ff.net.2.bias", "ffn_out.bias")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True, type=Path)
    ap.add_argument("--embodiment-tag", required=True)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    embodiment_ids = json.loads((args.checkpoint / "embodiment_id.json").read_text())
    if args.embodiment_tag not in embodiment_ids:
        raise ValueError(
            f"Unknown embodiment tag '{args.embodiment_tag}'. "
            f"Known: {sorted(embodiment_ids.keys())}"
        )
    cat_id = embodiment_ids[args.embodiment_tag]
    print(f"Embodiment '{args.embodiment_tag}' -> cat_id {cat_id}")

    reader = Gr00tActionHeadReader(args.checkpoint)
    writer = gguf.GGUFWriter(str(args.out), "groot")

    writer.add_string("groot.embodiment_tag", args.embodiment_tag)
    writer.add_uint32("groot.embodiment_cat_id", cat_id)
    writer.add_uint32("groot.hidden_size", HIDDEN_SIZE)
    writer.add_uint32("groot.input_embedding_dim", DIT_INNER_DIM)
    writer.add_uint32("groot.backbone_embedding_dim", VLFUSION_INNER_DIM)
    writer.add_uint32("groot.max_state_dim", MAX_STATE_DIM)
    writer.add_uint32("groot.max_action_dim", MAX_ACTION_DIM)
    writer.add_uint32("groot.action_horizon", ACTION_HORIZON)
    writer.add_uint32("groot.dit.num_layers", DIT_NUM_LAYERS)
    writer.add_uint32("groot.dit.num_heads", DIT_NUM_HEADS)
    writer.add_uint32("groot.dit.head_dim", DIT_HEAD_DIM)
    writer.add_uint32("groot.dit.ffn_inner", DIT_FFN_INNER)
    writer.add_uint32("groot.dit.output_dim", DIT_OUTPUT_DIM)
    writer.add_uint32("groot.dit.attend_text_every_n_blocks", ATTEND_TEXT_EVERY_N_BLOCKS)
    writer.add_uint32("groot.dit.num_timestep_buckets", DIT_NUM_TIMESTEP_BUCKETS)
    writer.add_uint32("groot.vlfusion.num_layers", VLFUSION_NUM_LAYERS)
    writer.add_uint32("groot.vlfusion.num_heads", VLFUSION_NUM_HEADS)
    writer.add_uint32("groot.vlfusion.head_dim", VLFUSION_HEAD_DIM)
    writer.add_uint32("groot.vlfusion.ffn_inner", VLFUSION_FFN_INNER)
    writer.add_uint32("groot.timestep_proj_channels", TIMESTEP_PROJ_CHANNELS)
    writer.add_uint32("groot.num_inference_timesteps", 4)
    writer.add_uint32("groot.num_cameras", NUM_CAMERAS)

    writer.add_uint32("groot.text.num_layers", TEXT_NUM_LAYERS)
    writer.add_uint32("groot.text.hidden_size", TEXT_HIDDEN_SIZE)
    writer.add_uint32("groot.text.num_heads", TEXT_NUM_HEADS)
    writer.add_uint32("groot.text.num_kv_heads", TEXT_NUM_KV_HEADS)
    writer.add_uint32("groot.text.head_dim", TEXT_HEAD_DIM)
    writer.add_uint32("groot.text.ffn_length", TEXT_FFN_LENGTH)
    writer.add_uint32("groot.text.vocab_size", TEXT_VOCAB_SIZE)
    writer.add_uint32("groot.image_token_id", IMAGE_TOKEN_ID)
    writer.add_float32("groot.text.rope_freq_base", float(TEXT_ROPE_FREQ_BASE))
    writer.add_float32("groot.text.rms_norm_eps", TEXT_RMS_NORM_EPS)

    writer.add_uint32("groot.vision.depth", VISION_DEPTH)
    writer.add_uint32("groot.vision.hidden_size", VISION_HIDDEN_SIZE)
    writer.add_uint32("groot.vision.num_heads", VISION_NUM_HEADS)
    writer.add_uint32("groot.vision.patch_size", VISION_PATCH_SIZE)
    writer.add_uint32("groot.vision.spatial_merge_size", VISION_SPATIAL_MERGE_SIZE)
    writer.add_uint32("groot.vision.temporal_patch_size", VISION_TEMPORAL_PATCH_SIZE)
    writer.add_uint32("groot.vision.num_position_embeddings", VISION_NUM_POSITION_EMBEDDINGS)
    writer.add_uint32("groot.vision.out_hidden_size", VISION_OUT_HIDDEN_SIZE)
    writer.add_uint32("groot.vision.image_size", VISION_IMAGE_SIZE)
    writer.add_array("groot.vision.deepstack_indexes", VISION_DEEPSTACK_INDEXES)

    # --- VL fusion: vlln (plain LayerNorm) + 4-layer SelfAttentionTransformer ---
    writer.add_tensor("vlfusion.vlln.weight", reader.get("action_head.vlln.weight").numpy())
    writer.add_tensor("vlfusion.vlln.bias", reader.get("action_head.vlln.bias").numpy())
    for i in range(VLFUSION_NUM_LAYERS):
        add_basic_transformer_block(
            writer, reader,
            src_prefix=f"action_head.vl_self_attention.transformer_blocks.{i}",
            dst_prefix=f"vlfusion.blk.{i}",
            has_ada_norm=False,
            has_cross_attn=False,
            inner_dim=VLFUSION_INNER_DIM,
            ffn_inner=VLFUSION_FFN_INNER,
        )

    # --- Timestep encoder: sinusoidal proj (no weights) + 2-layer MLP ---
    writer.add_tensor(
        "dit.timestep_embedder.linear_1.weight",
        reader.get("action_head.model.timestep_encoder.timestep_embedder.linear_1.weight").numpy(),
    )
    writer.add_tensor(
        "dit.timestep_embedder.linear_1.bias",
        reader.get("action_head.model.timestep_encoder.timestep_embedder.linear_1.bias").numpy(),
    )
    writer.add_tensor(
        "dit.timestep_embedder.linear_2.weight",
        reader.get("action_head.model.timestep_encoder.timestep_embedder.linear_2.weight").numpy(),
    )
    writer.add_tensor(
        "dit.timestep_embedder.linear_2.bias",
        reader.get("action_head.model.timestep_encoder.timestep_embedder.linear_2.bias").numpy(),
    )

    # --- DiT: 32 alternating self-/cross-attention blocks (AdaLayerNorm) ---
    for i in range(DIT_NUM_LAYERS):
        is_self_attn_block = (i % 2 == 1)  # AlternateVLDiT: odd blocks are self-attention
        add_basic_transformer_block(
            writer, reader,
            src_prefix=f"action_head.model.transformer_blocks.{i}",
            dst_prefix=f"dit.blk.{i}",
            has_ada_norm=True,
            has_cross_attn=not is_self_attn_block,
            inner_dim=DIT_INNER_DIM,
            ffn_inner=DIT_FFN_INNER,
        )

    writer.add_tensor("dit.proj_out_1.weight", reader.get("action_head.model.proj_out_1.weight").numpy())
    writer.add_tensor("dit.proj_out_1.bias", reader.get("action_head.model.proj_out_1.bias").numpy())
    writer.add_tensor("dit.proj_out_2.weight", reader.get("action_head.model.proj_out_2.weight").numpy())
    writer.add_tensor("dit.proj_out_2.bias", reader.get("action_head.model.proj_out_2.bias").numpy())

    writer.add_tensor(
        "dit.position_embedding.weight",
        reader.get("action_head.position_embedding.weight").numpy(),
    )

    # --- Embodiment-conditioned encode/decode, sliced to one embodiment ---
    def add_embodiment_linear(src_prefix: str, dst_prefix: str):
        w = reader.get_embodiment_slice(f"{src_prefix}.W", cat_id)  # [in, out]
        b = reader.get_embodiment_slice(f"{src_prefix}.b", cat_id)  # [out]
        # CategorySpecificLinear.forward does x @ W (not nn.Linear's x @ W^T), so
        # the sliced weight is numpy [in, out]. gguf-py reverses numpy shape into
        # ggml ne, giving ne=[out, in] — the OPPOSITE of what ggml_mul_mat wants
        # ([in, out]). We store it as-is here; groot.cpp's grootLinearXW applies
        # the compensating ggml_cont(ggml_transpose(...)) at graph-build time.
        # This is a two-sided invariant: DO NOT "simplify" either side without
        # the other. See grootLinearXW in groot.cpp. (Emitting w.numpy().T here
        # and dropping the C++ transpose would encode it once, but changes the
        # on-disk tensor layout — requires reconverting the GGUF + a parity run.)
        writer.add_tensor(f"{dst_prefix}.weight", w.numpy())
        writer.add_tensor(f"{dst_prefix}.bias", b.numpy())

    add_embodiment_linear("action_head.state_encoder.layer1", "embodiment.state_encoder.layer1")
    add_embodiment_linear("action_head.state_encoder.layer2", "embodiment.state_encoder.layer2")
    add_embodiment_linear("action_head.action_encoder.W1", "embodiment.action_encoder.w1")
    add_embodiment_linear("action_head.action_encoder.W2", "embodiment.action_encoder.w2")
    add_embodiment_linear("action_head.action_encoder.W3", "embodiment.action_encoder.w3")
    add_embodiment_linear("action_head.action_decoder.layer1", "embodiment.action_decoder.layer1")
    add_embodiment_linear("action_head.action_decoder.layer2", "embodiment.action_decoder.layer2")

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
