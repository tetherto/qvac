#!/usr/bin/env python3
"""Convert GR00T N1.7-3B's action-head weights (VL fusion + DiT + embodiment MLPs)
to a GGUF file, single-embodiment-sliced for v1. Covers `action_head.*`; the
backbone (Qwen3-VL vision + truncated-16-layer text decoder) is converted
separately via fabric's own convert_hf_to_gguf.py (see _repackage_groot_backbone.py).

Embodiment conditioning (`CategorySpecificLinear`) keeps a weight matrix per
embodiment (`self.W[cat_ids]`, up to 32). Two modes:

  * multi-embodiment (default): store one weight row per DISTINCT trained cat_id
    (`[n_stored, in, out]` W / `[n_stored, out]` b) and an embodiment table
    (`groot.embodiment.{tags,cat_ids,stored_cat_ids,stored_num_cameras,count,
    default}`). One GGUF then carries every trained embodiment; groot.cpp maps a
    selected tag -> cat_id -> stored row and slices it at load. `--embodiments
    a,b` narrows the ship set to a subset (e.g. libero+droid only).
  * `--embodiment-tag <tag>`: v1 single-embodiment mode — slice out one row at
    conversion time and store it as a plain 2D dense tensor, no runtime selector.

groot.cpp distinguishes the two by tensor rank (3D = multi, 2D = v1 sliced).

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
    # multi-embodiment (default), default selection = libero_sim
    python convert_groot_dit_to_gguf.py \
        --checkpoint /path/to/GR00T-N1.7-3B \
        --out groot-action-head.gguf

    # v1 single-embodiment
    python convert_groot_dit_to_gguf.py \
        --checkpoint /path/to/GR00T-N1.7-3B \
        --embodiment-tag libero_sim \
        --out groot-action-head.gguf
"""

import argparse
import json
import re
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

# num_cameras means IMAGES PER INFER: cameras x video history, which is what the
# runtime consumes and what `hparams.numCameras` reports. It is a property of the
# DATA CONFIG a row was trained with, not of the weight row, and the checkpoint
# states it per embodiment tag in `processor_config.json`:
#
#     len(modality_configs[tag].video.modality_keys)
#         * len(modality_configs[tag].video.delta_indices)
#
# `read_num_cameras` below derives the counts from there rather than from a
# hand-maintained list, so any checkpoint describes itself. The fallback table is
# only for checkpoints predating that key.
#
# Because the GGUF stores ONE count per cat_id while several tags (hence several
# rigs) can share a cat_id, disagreement is expected and is stored as 0
# (unknown), never as an arbitrary pick: e.g. cat_id 26 is 3 cameras x 2 frames
# for `real_r1_pro_sharpa_relative_eef`/`_human` but 1 x 2 for `_mecka`/
# `_maxinsights`. A row with an unknown count still ships and the runtime will not
# guess one; it is selectable by stating the count
# (`embodiment: { tag, numCameras }`), because inheriting another embodiment's
# count would build the wrong image-token layout and infer silently wrong.
FALLBACK_NUM_CAMERAS = {
    "libero_sim": 2,  # 2 cameras x 1 frame
    "oxe_droid_relative_eef_relative_joint": 4,  # 2 x 2
}


def read_num_cameras(checkpoint_dir: Path) -> list:
    """Per-tag images-per-infer from the checkpoint, most authoritative first.

    Returns `[(source_name, {tag: images_per_infer})]` in precedence order:

      1. `processor_config.json` — how the checkpoint is SERVED now.
      2. `experiment_cfg/final_processor_config.json` — the training-time data
         configs, which cover further embodiments but describe historical mixes.

    Kept as separate tiers rather than merged because the two disagree for rows
    that were trained under several data configs: the base checkpoint's cat_id 24
    is 2 cameras x 2 frames as served, but the training config also lists a
    1-frame `oxe_droid_joint_position_relative` and a 3-camera `xdof` on that same
    row. Merging would make cat_id 24 look ambiguous and drop its count, so a
    lower tier is consulted only for cat_ids the higher tier says nothing about.
    """
    tiers = []
    for rel in ("processor_config.json", "experiment_cfg/final_processor_config.json"):
        path = checkpoint_dir / rel
        if not path.exists():
            continue
        raw = json.loads(path.read_text())
        configs = raw.get("processor_kwargs", raw).get("modality_configs")
        if configs is None:
            continue
        counts = {}
        # The live config stores real JSON; the training-time one stores a Python
        # repr of the same structure, so parse the video entries out textually.
        if isinstance(configs, dict):
            for tag, cfg in configs.items():
                video = cfg.get("video") or {}
                keys = video.get("modality_keys") or []
                deltas = video.get("delta_indices") or []
                if keys and deltas:
                    counts[tag] = len(keys) * len(deltas)
        elif isinstance(configs, str):
            for m in re.finditer(
                r"'([A-Za-z0-9_.\-]+)': \{'video': ModalityConfig\("
                r"delta_indices=\[([^\]]*)\], modality_keys=\[([^\]]*)\]",
                configs,
            ):
                tag, deltas, keys = m.group(1), m.group(2), m.group(3)
                n_deltas = len([d for d in deltas.split(",") if d.strip()])
                n_keys = len([k for k in keys.split(",") if k.strip()])
                if n_keys and n_deltas:
                    counts[tag] = n_keys * n_deltas
        if counts:
            tiers.append((rel, counts))
    return tiers
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

    def get_embodiment_rows(self, key: str, cat_ids: list) -> torch.Tensor:
        """Select the given cat_id rows from a CategorySpecificLinear weight/bias.

        W is [num_categories, in, out], b is [num_categories, out]. Returns
        [len(cat_ids), ...] in cat_ids order (the tensor row order the GGUF's
        stored_cat_ids table records); groot.cpp slices the load-time-selected
        row.
        """
        t = self.get(key)
        # NUM_EMBODIMENTS_TOTAL (and so `--embodiments all`) assumes the
        # architecture's 32-category bank without consulting the checkpoint. On a
        # smaller bank the bare index below raises IndexError with no hint of which
        # flag caused it, so name the mismatch instead.
        n_rows = t.shape[0]
        over = sorted(c for c in cat_ids if not 0 <= c < n_rows)
        if over:
            raise SystemExit(
                f"'{key}' has {n_rows} category rows but the requested ship set "
                f"names cat_id(s) {over}: this checkpoint's category bank is "
                f"smaller than the expected {NUM_EMBODIMENTS_TOTAL}, so pass an "
                "explicit --embodiments subset instead of 'all'"
            )
        return t[torch.tensor(cat_ids, dtype=torch.long)].contiguous()


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
    ap.add_argument(
        "--embodiment-tag",
        help="v1 single-embodiment mode: slice this one embodiment into a 2D "
        "dense tensor. Omit for multi-embodiment mode (the default).",
    )
    ap.add_argument(
        "--embodiments",
        help="multi-embodiment mode: which rows to STORE, as comma-separated "
        "embodiment tags and/or numeric cat_ids, or `all` for every physical row "
        "of the 32-entry category bank (including untagged ones). Default: every "
        "distinct trained cat_id in embodiment_id.json. A subset is taken "
        "literally and must include the default embodiment.",
    )
    ap.add_argument(
        "--default-embodiment",
        default="libero_sim",
        help="multi-embodiment mode: the embodiment selected when the runtime "
        "doesn't specify one (default: libero_sim).",
    )
    ap.add_argument(
        "--embodiment-cameras",
        action="append",
        default=[],
        metavar="TAG=N",
        help="stamp num_cameras (images per infer) for an embodiment whose count "
        "the checkpoint does not state, or to pin one rig when tags sharing a "
        "cat_id disagree (repeatable, or comma-separated). A row with no known "
        "count ships as a latent weight row: it is selectable at runtime only if "
        "the caller passes an explicit camera count. Required for the default "
        "embodiment, whose count must be known for the GGUF to load unselected.",
    )
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if args.embodiment_tag and args.embodiments:
        raise ValueError("--embodiment-tag and --embodiments are mutually exclusive")
    multi = not args.embodiment_tag  # multi-embodiment is the default

    embodiment_ids = json.loads((args.checkpoint / "embodiment_id.json").read_text())

    # Camera-count sources, most authoritative first: explicit
    # --embodiment-cameras, then what the checkpoint says about itself, then the
    # fallback table for checkpoints that say nothing. cam_for consults a lower
    # tier only for cat_ids the higher ones do not cover.
    overrides = {}
    for entry in args.embodiment_cameras:
        for pair in entry.split(","):
            pair = pair.strip()
            if not pair:
                continue
            if "=" not in pair:
                raise ValueError(f"--embodiment-cameras expects TAG=N, got '{pair}'")
            tag, _, count = pair.partition("=")
            tag = tag.strip()
            try:
                n = int(count)
            except ValueError:
                raise ValueError(
                    f"--embodiment-cameras: '{count}' is not an integer (tag '{tag}')"
                ) from None
            if not 1 <= n <= 64:
                raise ValueError(
                    f"--embodiment-cameras: num_cameras {n} for '{tag}' is out of "
                    "range (1..64)"
                )
            if tag not in embodiment_ids:
                raise ValueError(
                    f"--embodiment-cameras: unknown embodiment tag '{tag}'. "
                    f"Known: {sorted(embodiment_ids.keys())}"
                )
            overrides[tag] = n

    cam_tiers = (
        [("--embodiment-cameras", overrides)]
        + read_num_cameras(args.checkpoint)
        + [("built-in fallback", FALLBACK_NUM_CAMERAS)]
    )
    print(
        "num_cameras sources: "
        + ", ".join(f"{name}={len(tier)} tag(s)" for name, tier in cam_tiers if tier)
    )

    def resolve(tag: str) -> int:
        if tag not in embodiment_ids:
            raise ValueError(
                f"Unknown embodiment tag '{tag}'. "
                f"Known: {sorted(embodiment_ids.keys())}"
            )
        return embodiment_ids[tag]

    # A representative tag per cat_id (first tag in file order) — drives the
    # per-cat_id num_cameras lookup and human-readable logging.
    rep_tag = {}
    for t, cid in embodiment_ids.items():
        rep_tag.setdefault(cid, t)

    def cam_for(cid: int) -> int:
        # Walk the sources in precedence order and take the first that says
        # anything about this cat_id, so a historical training config never
        # contradicts how the checkpoint is served today.
        for name, tier in cam_tiers:
            found = {t: tier[t] for t, c in embodiment_ids.items() if c == cid and t in tier}
            if not found:
                continue
            counts = set(found.values())
            if len(counts) == 1:
                return counts.pop()
            # Several rigs share this row and genuinely differ in view count. One
            # stored number cannot describe both, and picking one silently would
            # hand a caller the wrong image-token layout, so store 0 (unknown)
            # and let the caller state the count.
            print(
                f"  cat_id {cid}: {name} disagrees on num_cameras {found} -> storing "
                "0 (unknown); pass --embodiment-cameras TAG=N to pin one rig"
            )
            return 0
        return 0

    def cam_for_tag(tag: str) -> int:
        # Exact-tag lookup, v1 only. cam_for answers for a cat_id, which is the
        # right question for a stored ROW: several rigs can share a row, so a
        # row whose tags disagree has no one true count and stores 0. A v1 GGUF
        # bakes ONE tag, though, and that tag's own count is not ambiguous just
        # because a sibling tag on the same row differs. Falling back to it is
        # therefore not the guess L1 rules out; it is the more specific answer.
        for _name, tier in cam_tiers:
            if tier.get(tag):
                return tier[tag]
        return 0

    # The default entry backs the v1 groot.embodiment_tag/_cat_id keys and the
    # top-level groot.num_cameras, so old loaders and the multi table agree.
    default_tag = args.default_embodiment if multi else args.embodiment_tag
    default_cat_id = resolve(default_tag)
    # Resolve by cat_id first, not by the literal default tag: tags sharing a
    # cat_id usually share a view count, so an alias tag would otherwise miss a
    # tier that names only its sibling and fall through to a lower one.
    default_num_cameras = cam_for(default_cat_id)
    if not default_num_cameras and not multi:
        # Only after the cat_id came back unknown, and only in v1. Multi is left
        # alone deliberately: its stored_num_cameras row would still be 0, so
        # rescuing just the top-level key would desync the two and skip the
        # default-row check below.
        default_num_cameras = cam_for_tag(default_tag)
        if default_num_cameras:
            print(
                f"  cat_id {default_cat_id} has no single num_cameras, but "
                f"'{default_tag}' itself is described as {default_num_cameras}; "
                "using that for this single-embodiment GGUF"
            )
    if not default_num_cameras:
        # Fail instead of stamping NUM_CAMERAS. A wrong camera count fails
        # SILENTLY at inference: it drives the JS image-count validation and the
        # image-token layout, so a 6-view rig converted as 2 would be rejected for
        # passing 6 buffers, or produce plausible-looking garbage for 2. Multi mode
        # already raises here; v1 used to fall through to a hardcoded 2, which put
        # exactly the guess back that "the runtime never guesses" rules out — just
        # at conversion time instead.
        raise SystemExit(
            f"embodiment '{default_tag}' (cat_id {default_cat_id}) has no known "
            "num_cameras in this checkpoint: pass "
            f"--embodiment-cameras {default_tag}=N to pin its view count "
            "(images per infer = len(video.modality_keys) * len(video.delta_indices))"
        )
    if multi:
        # Ship set = cat_ids to STORE (one weight row each). Default is every
        # distinct TRAINED cat_id from embodiment_id.json; `--embodiments` names a
        # subset by tag or by numeric cat_id, and `all` stores every physical row
        # of the checkpoint's category bank including untagged/untrained ones. The
        # full tag -> cat_id map (all tags) still ships so the runtime can select
        # by any tag string and map it to a stored row.
        if args.embodiments:
            want = args.embodiments.strip()
            if want.lower() == "all":
                want_cids = set(range(NUM_EMBODIMENTS_TOTAL))
            else:
                want_cids = set()
                for item in (s.strip() for s in want.split(",")):
                    if not item:
                        continue
                    if item.isdigit():
                        cid = int(item)
                        if not 0 <= cid < NUM_EMBODIMENTS_TOTAL:
                            raise ValueError(
                                f"--embodiments: cat_id {cid} is out of range "
                                f"(0..{NUM_EMBODIMENTS_TOTAL - 1})"
                            )
                        want_cids.add(cid)
                    else:
                        want_cids.add(resolve(item))
            # An explicit subset is taken literally: silently adding the default
            # row would ship a set the caller did not ask for. Tell them instead.
            if default_cat_id not in want_cids:
                raise ValueError(
                    f"--embodiments does not include the default embodiment "
                    f"'{default_tag}' (cat_id {default_cat_id}); add it or pass "
                    "--default-embodiment naming one of the requested rows"
                )
        else:
            want_cids = set(embodiment_ids.values())
        stored_cat_ids = sorted(want_cids)  # tensor row order
        stored_num_cameras = [cam_for(c) for c in stored_cat_ids]
        # A multi GGUF whose DEFAULT row has no camera count cannot be loaded
        # without an explicit selector plus count, because the loader treats the
        # per-row value as authoritative and ignores the legacy top-level
        # fallback. Fail at conversion rather than ship that.
        if stored_num_cameras[stored_cat_ids.index(default_cat_id)] <= 0:
            raise ValueError(
                f"default embodiment '{default_tag}' (cat_id {default_cat_id}) has "
                "no known num_cameras, so the GGUF could not be loaded without an "
                "explicit selector. Pass --embodiment-cameras "
                f"{default_tag}=<images per infer>, or pick a --default-embodiment "
                "whose count is known"
            )

        emb_tags = list(embodiment_ids.keys())
        emb_cat_ids = [embodiment_ids[t] for t in emb_tags]
        print(
            f"Multi-embodiment: {len(emb_tags)} tags -> "
            f"{len(stored_cat_ids)} stored cat_ids {stored_cat_ids}; "
            f"default '{default_tag}' -> cat_id {default_cat_id}"
        )
        # Say plainly which rows the file cannot serve on its own, so a ship set
        # is never assumed runnable end to end just because it converted.
        unknown = [c for c, n in zip(stored_cat_ids, stored_num_cameras) if n <= 0]
        if unknown:
            print(
                f"  num_cameras unknown for {len(unknown)}/{len(stored_cat_ids)} "
                f"stored cat_ids {unknown}: selecting one of these at runtime "
                "requires an explicit camera count "
                "(embodiment: { catId, numCameras }). Pass "
                "--embodiment-cameras TAG=N to stamp counts into the GGUF instead."
            )
    else:
        print(f"Embodiment '{default_tag}' -> cat_id {default_cat_id}")

    reader = Gr00tActionHeadReader(args.checkpoint)
    writer = gguf.GGUFWriter(str(args.out), "groot")

    writer.add_string("groot.embodiment_tag", default_tag)
    writer.add_uint32("groot.embodiment_cat_id", default_cat_id)
    if multi:
        # Full tag -> cat_id map (all tags) for runtime tag lookup.
        writer.add_array("groot.embodiment.tags", emb_tags)
        writer.add_array("groot.embodiment.cat_ids", emb_cat_ids)
        # Stored rows: which cat_ids are physically in the weight tensors, in
        # tensor row order, plus their per-row num_cameras (0 = unknown). The
        # runtime maps a selected tag -> cat_id -> row via stored_cat_ids.
        writer.add_uint32("groot.embodiment.count", len(stored_cat_ids))
        writer.add_array("groot.embodiment.stored_cat_ids", stored_cat_ids)
        writer.add_array("groot.embodiment.stored_num_cameras", stored_num_cameras)
        writer.add_string("groot.embodiment.default", default_tag)
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
    writer.add_uint32("groot.num_cameras", default_num_cameras)

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

    # --- Embodiment-conditioned encode/decode ---
    # Multi mode keeps the category dim, storing only the ship-set rows
    # ([n_stored, in, out] / [n_stored, out], rank 3 / rank 2, row order =
    # stored_cat_ids); v1 mode slices one embodiment ([in, out] / [out],
    # rank 2 / 1). groot.cpp switches on tensor rank. In BOTH modes the last two
    # axes carry the CategorySpecificLinear W as [in, out]: forward is x @ W (not
    # nn.Linear's x @ W^T), so gguf-py reverses numpy shape into ggml ne=[out, in]
    # — the OPPOSITE of what ggml_mul_mat wants ([in, out]) — and grootLinearXW
    # applies the compensating ggml_cont(ggml_transpose(...)) at graph-build time.
    # This is a two-sided invariant: DO NOT "simplify" either side without the
    # other. See grootLinearXW in groot.cpp. (Transposing here changes the on-disk
    # layout and requires reconverting every GGUF + a parity run.)
    def add_embodiment_linear(src_prefix: str, dst_prefix: str):
        if multi:
            w = reader.get_embodiment_rows(f"{src_prefix}.W", stored_cat_ids)  # [n_stored, in, out]
            b = reader.get_embodiment_rows(f"{src_prefix}.b", stored_cat_ids)  # [n_stored, out]
            # Store the stacked rows F16, halving the multi weight footprint
            # (~680 MB -> ~340 MB for 17 rows). quantize_groot_gguf.py never
            # touches embodiment.* (KEEP_UNQUANTIZED), so this F16 is what ships;
            # grootSliceEmbodiment copies the load-time-selected row by
            # ggml_nbytes, handling F16/F32 alike. Bias stays F32 (1-D, tiny).
            w = w.half()
        else:
            w = reader.get_embodiment_slice(f"{src_prefix}.W", default_cat_id)  # [in, out]
            b = reader.get_embodiment_slice(f"{src_prefix}.b", default_cat_id)  # [out]
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
