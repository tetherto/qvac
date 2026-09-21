#!/usr/bin/env python3
"""Rewrite a v1 (single-embodiment) GR00T GGUF into a multi-embodiment one.

A test-fixture builder for end-to-end parity of a NON-default embodiment, which
needs a GGUF whose shared weights match the oracle being compared against.

The shipped multi GGUF is converted from the LIBERO post-trained checkpoint, so
its shared weights (vision, backbone, VL fusion, DiT) differ from the base
N1.7-3B ones the DROID oracle was dumped against. Running the DROID oracle
against the shipped file therefore cannot pass no matter how correct the
embodiment machinery is (measured: cos 0.881, i.e. the shared-weight delta), and
producing a matching oracle would mean re-dumping from the LIBERO checkpoint with
DROID's data config — which that checkpoint's metadata doesn't carry.

So build the other side instead, without re-running the multi-GB convert
pipeline: take the BASE-derived v1 DROID GGUF (whose shared weights DO match the
DROID oracle), drop its 14 already-sliced `embodiment.*` tensors, and write them
back as real multi rows stacked from the base checkpoint's CategorySpecificLinear
banks, plus the `groot.embodiment.*` table. The result exercises the whole multi
path (resolver -> row slice -> pre-transpose -> infer) against a real oracle.

The default embodiment is deliberately libero_sim, NOT droid, so the DROID oracle
only passes if the requested selection actually reached the DROID row (measured:
cos 0.999993 selected, 0.794 on the default row).

Usage:
    python make_multi_embodiment_fixture.py \
        --in  groot-checkpoints/gguf/droid/groot-q8_vf16.gguf \
        --checkpoint groot-checkpoints/hf-models/GR00T-N1.7-3B \
        --embodiments libero_sim,oxe_droid_relative_eef_relative_joint \
        --default-embodiment libero_sim \
        --out /tmp/groot-multi-base-q8_vf16.gguf

then gate it with the existing parity test:
    GROOT_TEST_GGUF=/tmp/groot-multi-base-q8_vf16.gguf \
    GROOT_TEST_ACTIVATIONS_V4=<droid activations_v4.safetensors> \
    GROOT_TEST_EMBODIMENT=oxe_droid_relative_eef_relative_joint \
    build/test/unit/addon-test --gtest_filter='GrootInferParity.*'
"""

import argparse
import json
import sys
from pathlib import Path

import torch
from gguf import GGUFReader, GGUFValueType, GGUFWriter
from safetensors import safe_open

EMBODIMENT_PREFIX = "embodiment."

# dst GGUF prefix -> checkpoint CategorySpecificLinear prefix (mirrors
# convert_groot_dit_to_gguf.py's add_embodiment_linear calls).
LAYERS = [
    ("embodiment.state_encoder.layer1", "action_head.state_encoder.layer1"),
    ("embodiment.state_encoder.layer2", "action_head.state_encoder.layer2"),
    ("embodiment.action_encoder.w1", "action_head.action_encoder.W1"),
    ("embodiment.action_encoder.w2", "action_head.action_encoder.W2"),
    ("embodiment.action_encoder.w3", "action_head.action_encoder.W3"),
    ("embodiment.action_decoder.layer1", "action_head.action_decoder.layer1"),
    ("embodiment.action_decoder.layer2", "action_head.action_decoder.layer2"),
]

# Images per infer, i.e. cameras x video history, mirroring the converter's table.
KNOWN_NUM_CAMERAS = {
    "libero_sim": 2,
    "oxe_droid_relative_eef_relative_joint": 4,
    "real_g1_relative_eef_relative_joints": 2,
    "real_r1_pro_sharpa_relative_eef": 6,
    "xdof_relative_eef_relative_joint": 6,
}

# KV keys this script writes itself; anything else is copied verbatim.
OWNED_KEYS = {
    "groot.embodiment.tags",
    "groot.embodiment.cat_ids",
    "groot.embodiment.stored_cat_ids",
    "groot.embodiment.stored_num_cameras",
    "groot.embodiment.count",
    "groot.embodiment.default",
    "groot.embodiment_tag",
    "groot.embodiment_cat_id",
    "groot.num_cameras",
    "GGUF.version",
    "GGUF.tensor_count",
    "GGUF.kv_count",
    "general.architecture",
}


class BankReader:
    def __init__(self, checkpoint: Path):
        index = json.loads((checkpoint / "model.safetensors.index.json").read_text())
        self.weight_map = index["weight_map"]
        self.checkpoint = checkpoint
        self._open = {}

    def rows(self, key: str, cat_ids) -> torch.Tensor:
        shard = self.weight_map[key]
        if shard not in self._open:
            self._open[shard] = safe_open(self.checkpoint / shard, framework="pt")
        t = self._open[shard].get_tensor(key).float()
        return t[torch.tensor(list(cat_ids), dtype=torch.long)].contiguous()


ADDERS = {
    GGUFValueType.STRING: "add_string",
    GGUFValueType.UINT8: "add_uint8",
    GGUFValueType.INT8: "add_int8",
    GGUFValueType.UINT16: "add_uint16",
    GGUFValueType.INT16: "add_int16",
    GGUFValueType.UINT32: "add_uint32",
    GGUFValueType.INT32: "add_int32",
    GGUFValueType.UINT64: "add_uint64",
    GGUFValueType.INT64: "add_int64",
    GGUFValueType.FLOAT32: "add_float32",
    GGUFValueType.FLOAT64: "add_float64",
    GGUFValueType.BOOL: "add_bool",
}


def copy_kv(reader: GGUFReader, writer: GGUFWriter) -> int:
    """Copy every KV field except the ones this script rewrites."""
    copied = 0
    for field in reader.fields.values():
        if field.name in OWNED_KEYS or not field.types:
            continue
        value = field.contents()
        vtype = field.types[0]
        if vtype == GGUFValueType.ARRAY:
            writer.add_array(field.name, value)
        else:
            getattr(writer, ADDERS[vtype])(field.name, value)
        copied += 1
    return copied


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True, type=Path)
    ap.add_argument("--checkpoint", required=True, type=Path)
    ap.add_argument("--embodiments", required=True)
    ap.add_argument("--default-embodiment", required=True)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    embodiment_ids = json.loads((args.checkpoint / "embodiment_id.json").read_text())
    want_tags = [t.strip() for t in args.embodiments.split(",") if t.strip()]
    want_cids = sorted({embodiment_ids[t] for t in want_tags})
    default_cid = embodiment_ids[args.default_embodiment]
    if default_cid not in want_cids:
        raise SystemExit("default embodiment must be in --embodiments")

    def cam_for(cid):
        for t, c in embodiment_ids.items():
            if c == cid and t in KNOWN_NUM_CAMERAS:
                return KNOWN_NUM_CAMERAS[t]
        return 0

    stored_cams = [cam_for(c) for c in want_cids]
    print(f"stored_cat_ids={want_cids} stored_num_cameras={stored_cams} "
          f"default='{args.default_embodiment}' (cat {default_cid})")

    reader = GGUFReader(str(args.src), "r")
    writer = GGUFWriter(str(args.out), "groot")

    n_kv = copy_kv(reader, writer)
    writer.add_string("groot.embodiment_tag", args.default_embodiment)
    writer.add_uint32("groot.embodiment_cat_id", default_cid)
    writer.add_array("groot.embodiment.tags", list(embodiment_ids.keys()))
    writer.add_array("groot.embodiment.cat_ids", list(embodiment_ids.values()))
    writer.add_uint32("groot.embodiment.count", len(want_cids))
    writer.add_array("groot.embodiment.stored_cat_ids", want_cids)
    writer.add_array("groot.embodiment.stored_num_cameras", stored_cams)
    writer.add_string("groot.embodiment.default", args.default_embodiment)
    writer.add_uint32("groot.num_cameras", cam_for(default_cid))
    print(f"copied {n_kv} KV fields, wrote 9 embodiment KV fields")

    # Shared tensors: copy bytes verbatim. data.shape is already the byte shape
    # for quantized types, so pass raw_dtype and NO raw_shape.
    kept = 0
    for t in reader.tensors:
        if t.name.startswith(EMBODIMENT_PREFIX):
            continue
        writer.add_tensor(t.name, t.data, raw_dtype=t.tensor_type)
        kept += 1

    banks = BankReader(args.checkpoint)
    for dst_prefix, src_prefix in LAYERS:
        w = banks.rows(f"{src_prefix}.W", want_cids).half()   # [n, in, out]
        b = banks.rows(f"{src_prefix}.b", want_cids)          # [n, out]
        writer.add_tensor(f"{dst_prefix}.weight", w.numpy())
        writer.add_tensor(f"{dst_prefix}.bias", b.numpy())
        print(f"  {dst_prefix}: weight {tuple(w.shape)} f16, bias {tuple(b.shape)} f32")

    print(f"copied {kept} shared tensors + 14 embodiment tensors")
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    sys.exit(main())
