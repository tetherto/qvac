#!/usr/bin/env python3
"""Merge the 3 GR00T GGUF parts (text backbone, vision mmproj, action head) into
one unified `groot.gguf`, matching the single-file convention the other vla-ggml
architectures (SmolVLA, π₀.₅) ship as. Pure byte-copy, no numerics recomputed.

Each part already uses a disjoint tensor-name namespace (`blk.*`/`token_embd` for
text, `v.*`/`mm.*` for vision, `dit.*`/`vlfusion.*`/`embodiment.*` for the action
head), so names are copied as-is, NOT prefixed — Phase 2 ports fabric's
graph-building code verbatim (literal `ggml_get_tensor(ctx, "blk.0...")` lookups),
so renaming would mean re-deriving every string literal for no benefit.

`general.architecture="groot"` and all `groot.*` metadata come from the action-head
part; the text/vision parts' `general.architecture` is intentionally dropped —
groot.cpp's loader doesn't use llama.cpp's model-loading machinery, so those keys
are irrelevant noise once merged.

Usage:
    python _merge_groot_gguf.py \
        --text groot-backbone-text.gguf \
        --vision groot-backbone-vision.gguf \
        --action-head groot-action-head.gguf \
        --out groot.gguf
"""

import argparse
from pathlib import Path

import gguf
from gguf import GGUFReader, GGUFValueType

# Prefixes skipped from text/vision parts: arch-specific hparams for a loading
# path groot.cpp doesn't use, irrelevant once merged.
SKIP_KEY_PREFIXES = ("general.", "tokenizer.", "clip.", "vision.")


def copy_metadata(reader: GGUFReader, writer: gguf.GGUFWriter, keep_all: bool):
    for field in reader.fields.values():
        # GGUFReader synthesizes pseudo-fields (GGUF.version/tensor_count/kv_count)
        # that aren't real KV pairs; GGUFWriter emits the real header itself, so
        # re-adding these as KV entries would corrupt the file.
        if field.name.startswith("GGUF."):
            continue
        if field.name in ("general.architecture",):
            continue
        if not keep_all and field.name.startswith(SKIP_KEY_PREFIXES):
            continue
        value_type = field.types[0]
        if len(field.types) > 1:
            # array field
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


def copy_tensors(reader: GGUFReader, writer: gguf.GGUFWriter):
    for t in reader.tensors:
        writer.add_tensor(t.name, t.data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True, type=Path)
    ap.add_argument("--vision", required=True, type=Path)
    ap.add_argument("--action-head", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    text_reader = GGUFReader(str(args.text))
    vision_reader = GGUFReader(str(args.vision))
    head_reader = GGUFReader(str(args.action_head))

    writer = gguf.GGUFWriter(str(args.out), "groot")

    # action-head part carries all the groot.* metadata we actually use
    copy_metadata(head_reader, writer, keep_all=False)

    copy_tensors(text_reader, writer)
    copy_tensors(vision_reader, writer)
    copy_tensors(head_reader, writer)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    total = len(text_reader.tensors) + len(vision_reader.tensors) + len(head_reader.tensors)
    print(f"Merged {total} tensors into {args.out}")


if __name__ == "__main__":
    main()
