#!/usr/bin/env python3
"""Repackage GR00T-N1.7-3B's backbone weights as a standard Qwen3-VL HF checkpoint.

GR00T's Qwen3Backbone wraps a full `Qwen3VLForConditionalGeneration` at the
attribute path `backbone.model.*`, so GR00T's own safetensors store backbone
tensors as `backbone.model.model.language_model...`, `backbone.model.model.visual...`,
`backbone.model.lm_head.weight`. Stripping the `backbone.model.` prefix recovers
exactly the tensor names a standard Qwen3VLForConditionalGeneration checkpoint
uses (`model.language_model...`, `model.visual...`, `lm_head.weight`).

GR00T truncates the language decoder to `select_layer` layers at runtime
(gr00t_n1d7.py's `Qwen3Backbone.__init__` pops layers past `select_layer`) and
this checkpoint's own safetensors already only contain the retained layers
(verified: layers 0-15 present, matches config.json's select_layer=16) — so no
tensor-level truncation is needed here, only the text_config.num_hidden_layers
metadata must be corrected to match, or fabric's converter will expect (and
fail to find) the original 28 layers.

This produces a directory `convert_hf_to_gguf.py` can consume directly (as if
it were a real `nvidia/Cosmos-Reason2-2B`-shaped Qwen3-VL checkpoint), reusing
fabric's already-correct Qwen3VLVisionModel/Qwen3VLTextModel conversion logic
instead of writing a new tensor map from scratch.

Usage:
    python _repackage_groot_backbone.py \
        --groot-checkpoint /path/to/GR00T-N1.7-3B \
        --cosmos-config-dir /path/to/Cosmos-Reason2-2B-config \
        --out /path/to/repackaged-qwen3vl-backbone \
        --num-layers 16
"""

import argparse
import json
import shutil
from pathlib import Path

from safetensors import safe_open
from safetensors.torch import save_file

BACKBONE_PREFIX = "backbone.model."

# The backbone's real text-decoder dims. convert_groot_dit_to_gguf.py hardcodes
# the SAME numbers as groot.text.* GGUF metadata (TEXT_HIDDEN_SIZE / TEXT_NUM_HEADS
# / …) and groot.cpp reads them at load — but nothing there validates that copy
# against the actual backbone config. Cross-check the cosmos config here, at the
# one place that reads it, so a config whose factorization drifts from those
# constants fails loudly at repackage time instead of silently producing a GGUF
# with stale metadata. Keep in sync with convert_groot_dit_to_gguf.py's TEXT_*.
EXPECTED_TEXT_CONFIG = {
    "hidden_size": 2048,
    "num_attention_heads": 16,
    "num_key_value_heads": 8,
    "head_dim": 128,
    "intermediate_size": 6144,
    "vocab_size": 151936,
}
CONFIG_COPY_FILES = [
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "generation_config.json",
    "chat_template.json",
    "preprocessor_config.json",
]


def load_backbone_tensors(groot_checkpoint: Path):
    index_path = groot_checkpoint / "model.safetensors.index.json"
    weight_map = json.loads(index_path.read_text())["weight_map"]

    backbone_keys = {k: v for k, v in weight_map.items() if k.startswith(BACKBONE_PREFIX)}
    by_shard = {}
    for key, shard_file in backbone_keys.items():
        by_shard.setdefault(shard_file, []).append(key)

    tensors = {}
    for shard_file, keys in by_shard.items():
        # shard_file comes from the checkpoint's own index.json weight_map; a
        # crafted checkpoint could point it outside groot_checkpoint via a
        # relative-traversal or absolute path. Shards always sit beside the
        # index, so require a bare filename (rejects "../x", "/etc/x", "a/b").
        if shard_file != Path(shard_file).name:
            raise ValueError(f"unexpected shard path in weight_map: {shard_file!r}")
        with safe_open(groot_checkpoint / shard_file, framework="pt") as f:
            for key in keys:
                new_key = key[len(BACKBONE_PREFIX):]
                tensors[new_key] = f.get_tensor(key)
    return tensors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--groot-checkpoint", required=True, type=Path)
    ap.add_argument("--cosmos-config-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--num-layers", type=int, default=16)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    tensors = load_backbone_tensors(args.groot_checkpoint)
    present_layers = sorted(
        {int(k.split(".")[3]) for k in tensors if k.startswith("model.language_model.layers.")}
    )
    print(f"language_model layers present: {present_layers}")
    if present_layers != list(range(args.num_layers)):
        raise ValueError(
            f"Expected exactly layers 0..{args.num_layers - 1}, got {present_layers}. "
            "GR00T's own checkpoint truncation may differ from --num-layers."
        )

    save_file(tensors, args.out / "model.safetensors")
    print(f"Wrote {len(tensors)} tensors to {args.out / 'model.safetensors'}")

    config = json.loads((args.cosmos_config_dir / "config.json").read_text())
    text_config = config["text_config"]
    mismatches = {
        k: (text_config.get(k), v)
        for k, v in EXPECTED_TEXT_CONFIG.items()
        if k in text_config and text_config[k] != v
    }
    if mismatches:
        raise ValueError(
            "cosmos text_config diverges from the backbone dims hardcoded in "
            "convert_groot_dit_to_gguf.py (groot.text.* metadata). Update both "
            f"in lockstep. Mismatches (got, expected): {mismatches}"
        )
    config["text_config"]["num_hidden_layers"] = args.num_layers
    (args.out / "config.json").write_text(json.dumps(config, indent=2))
    print(f"Wrote truncated config.json (num_hidden_layers={args.num_layers})")

    for fname in CONFIG_COPY_FILES:
        src = args.cosmos_config_dir / fname
        if src.exists():
            shutil.copy(src, args.out / fname)
        else:
            print(f"warning: {fname} not found in cosmos config dir, skipping")

    print(f"Repackaged checkpoint ready at {args.out}")


if __name__ == "__main__":
    main()
