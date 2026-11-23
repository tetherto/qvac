#!/usr/bin/env python3
"""Convert the BridgeDepth rvc_pretrain checkpoint with the Depth Anything V2 ViT-S mono branch to GGUF.

Source: https://github.com/gbionics/BridgeDepth/tree/bench-vits at f6d8cdd (MIT),
which runs the upstream BridgeDepth checkpoints with Depth-Anything-V2-Small
(Apache-2.0) through a linear adapter. The model is loaded through that
checkout's ``BridgeDepth.from_pretrained(<checkpoint>, encoder="vits")``, so the
adapter fold into ``depth_feature_down`` and the Hugging Face downloads are its
own code. Needs torch, the checkout's requirements and Fabric's gguf-py. The
result is one F32 GGUF, about 196 MB. No output is uploaded.

The addon's loader depends on these choices:

- Tensor names are the torch ``state_dict`` names, with one rename: a leading
  ``stereo_encoder.`` becomes ``stereo.``. ggml caps names at GGML_MAX_NAME = 64 bytes
  including the NUL, and 34 backbone names are 64 to 68 chars long.
- Every float tensor is F32 in torch memory order, so a torch ``[OC, IC, KH, KW]`` conv
  weight reads as ggml ``ne = [KW, KH, IC, OC]`` with no transpose.
- ``relative_position_index`` buffers are written as I32 tensors from the checkpoint,
  not rebuilt in C++: the stride 0.5 and stride 2 cross-window indices use
  half-pixel coordinates and are easy to get subtly wrong. The block-average matrices
  for the group correlations are constants built in C++.
- Dropped, unused at inference: ``mono.pretrained.mask_token``,
  ``mono.depth_head.scratch.output_conv2.*`` (commented out in DPTHead.forward),
  ``mono_output.*`` (training only), ``stereo_encoder.device_indicator_tensor``, and the
  three duplicate ``mean``/``std`` buffers, which go to KV instead. Anything else left
  unmapped is an error.
- The addon accepts a GGUF only when its tensor layout fingerprint matches this
  script's output (BridgeDepthGraph.cpp ``EXPECTED_LAYOUT``). Update both together.

Usage:
    python convert-bridgedepth.py --fork <BridgeDepth checkout> --output bridgedepth-vits-f32.gguf \
        --gguf-py <qvac-fabric-llm.cpp>/gguf-py

After writing, the GGUF is read back and compared bit-exact with the state dict.
Then every model parameter is zeroed, the GGUF tensors are loaded back into the
torch model and the test fixture pair is rerun: an identical disparity proves the
GGUF holds every tensor the forward pass reads, and that the dropped ones are dead.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

ARCH = "bridgedepth"
RENAMES = [("stereo_encoder.", "stereo.")]
DROP_EXACT = {
    "mean", "std",
    "stereo_encoder.backbone.mean", "stereo_encoder.backbone.std",
    "stereo_encoder.device_indicator_tensor",
    "mono.pretrained.mask_token",
}
DROP_PREFIX = ("mono.depth_head.scratch.output_conv2.", "mono_output.")
MEAN = [123.675, 116.28, 103.53]
STD = [58.395, 57.12, 57.375]


def gguf_name(torch_name: str) -> str:
    for a, b in RENAMES:
        if torch_name.startswith(a):
            torch_name = b + torch_name[len(a):]
    assert len(torch_name.encode()) < 64, torch_name
    return torch_name


def torch_name_of(gname: str) -> str:
    for a, b in RENAMES:
        if gname.startswith(b):
            return a + gname[len(b):]
    return gname


def is_dropped(k: str) -> bool:
    return k in DROP_EXACT or k.startswith(DROP_PREFIX)


# The checkout's own code builds the model, so only the commit the converter was
# validated against is imported.
FORK_COMMIT = "f6d8cddfcfbe2f6d4b7b6b7be091e5aadd76fd70"


def check_fork(fork: str) -> None:
    head = subprocess.run(
        ["git", "-C", fork, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if head != FORK_COMMIT:
        sys.exit(f"--fork is at {head}, expected bench-vits {FORK_COMMIT}")


def load_model(fork: str, checkpoint: str):
    check_fork(fork)
    sys.path.insert(0, fork)
    from bridgedepth.bridgedepth import BridgeDepth
    return BridgeDepth.from_pretrained(checkpoint, encoder="vits").eval()


def collect(model) -> tuple[dict[str, np.ndarray], dict]:
    import torch

    sd = model.state_dict()
    cfg = model.model_config
    # the KV below are only correct for this exact architecture; fail loudly otherwise
    assert cfg.BRIDGEDEPTH.ENCODER_VIT == "vits"
    assert cfg.BACKBONE.MODEL_TYPE == "convnext", cfg.BACKBONE.MODEL_TYPE
    for k in ("mean", "std", "stereo_encoder.backbone.mean", "stereo_encoder.backbone.std"):
        ref = MEAN if k.endswith("mean") else STD
        assert torch.allclose(sd[k].flatten(), torch.tensor(ref)), k

    tensors: dict[str, np.ndarray] = {}
    for k, v in sd.items():
        if is_dropped(k):
            continue
        if v.is_floating_point():
            a = v.detach().to(torch.float32).contiguous().numpy()
        else:
            assert k.endswith("relative_position_index"), f"unexpected non-float tensor {k}"
            assert int(v.min()) >= 0 and int(v.max()) < 2**31
            a = v.detach().to(torch.int32).contiguous().numpy()
        tensors[gguf_name(k)] = a

    mono = model.mono
    kv = {
        "encoder": "vits",
        "checkpoint_encoder": "vitl",
        "mono.embed_dim": mono.pretrained.embed_dim,
        "mono.depth": len(mono.pretrained.blocks),
        "mono.n_heads": mono.pretrained.blocks[0].attn.num_heads,
        "mono.patch_size": 14,
        "mono.pos_grid": 37,
        "mono.intermediate_layers": mono.intermediate_layer_idx["vits"],
        "mono.dpt_features": mono.model_configs["vits"]["features"],
        "mono.dpt_out_channels": mono.model_configs["vits"]["out_channels"],
        "mono.feature_dim": mono.feature_dim,
        "mono.eps": 1e-6,
        "backbone.out_channels": cfg.BACKBONE.OUT_CHANNELS,
        "dpn.num_disp": cfg.DPN.MAX_DISP // 8,
        "dpn.cost_group": cfg.DPN.COST_GROUP,
        "dpn.num_proposals": cfg.DPN.NUM_PROPOSALS,
        "nmp.infer_embed_dim": cfg.NMP.INFER_EMBED_DIM,
        "nmp.prop_embed_dim": cfg.NMP.PROP_EMBED_DIM,
        "nmp.mlp_ratio": cfg.NMP.MLP_RATIO,
        "nmp.split_size": cfg.NMP.SPLIT_SIZE,
        "nmp.window_size": cfg.NMP.WINDOW_SIZE,
        "nmp.refine_window_size": cfg.NMP.REFINE_WINDOW_SIZE,
        "nmp.prop_n_heads": cfg.NMP.PROP_N_HEADS,
        "nmp.infer_n_heads": cfg.NMP.INFER_N_HEADS,
        "nmp.num_prop_layers": cfg.NMP.NUM_PROP_LAYERS,
        "nmp.num_infer_layers": cfg.NMP.NUM_INFER_LAYERS,
        "nmp.num_refine_layers": cfg.NMP.NUM_REFINE_LAYERS,
        "norm_eps": 1e-6,
        "norm_eps_torch_default": 1e-5,
        "instance_norm_eps": 1e-5,
        "image_mean": MEAN,
        "image_std": STD,
        "pad_divisor": 16,
    }
    # cross-check against the instantiated modules, not just the config
    assert kv["mono.embed_dim"] == 384 and kv["mono.depth"] == 12 and kv["mono.n_heads"] == 6
    assert mono.pretrained.pos_embed.shape[1] == 1 + 37 * 37
    assert kv["mono.feature_dim"] == 32 and kv["dpn.num_disp"] == 40
    assert model.align_0.layers[0].attn.self_nmp.norm1.eps == 1e-5
    assert model.stereo_encoder.dpn.propagation.norm.eps == 1e-5
    assert model.align_0.norm.eps == 1e-6
    return tensors, kv


def write(out: Path, tensors: dict[str, np.ndarray], kv: dict, checkpoint: str) -> None:
    from gguf import GGUFWriter

    w = GGUFWriter(str(out), arch=ARCH)
    w.add_name(f"BridgeDepth {checkpoint} DAv2-S")
    w.add_string(f"{ARCH}.checkpoint", checkpoint)
    for k, v in kv.items():
        key = f"{ARCH}.{k}"
        if isinstance(v, str):
            w.add_string(key, v)
        elif isinstance(v, float):
            w.add_float32(key, v)
        elif isinstance(v, int):
            w.add_uint32(key, v)
        elif all(isinstance(x, int) for x in v):
            w.add_array(key, [int(x) for x in v])
        else:
            w.add_array(key, [float(x) for x in v])
    for name, a in tensors.items():
        w.add_tensor(name, a)
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()


def verify(out: Path, model, tensors: dict[str, np.ndarray]) -> None:
    import torch
    from gguf import GGUFReader

    r = GGUFReader(str(out))
    got = {}
    for t in r.tensors:
        # GGUFReader returns data in torch order already (ne reversed)
        got[t.name] = np.asarray(t.data).reshape([int(x) for x in reversed(t.shape)])
    assert set(got) == set(tensors), set(got) ^ set(tensors)
    for k, a in tensors.items():
        assert got[k].dtype == a.dtype and got[k].shape == a.shape, (k, got[k].shape, a.shape)
        assert np.array_equal(got[k], a), k
    print(f"verify: {len(got)} tensors bit-exact, "
          f"{sum(a.size for a in got.values())} elements")

    import cv2

    fixtures = Path(__file__).resolve().parent.parent / "test" / "fixtures"
    views = []
    for name in ("left", "right"):
        image = cv2.cvtColor(cv2.imread(str(fixtures / f"bridgedepth-{name}.png")), cv2.COLOR_BGR2RGB)
        views.append(torch.from_numpy(image).permute(2, 0, 1)[None].float())

    def run():
        with torch.no_grad():
            return model({"img1": views[0].clone(), "img2": views[1].clone()})["disp_pred"].numpy()

    # the mono branch must run fp32 to match the reference dump
    mono_infer = model.mono.infer
    model.mono.infer = lambda image, use_fp16=False: mono_infer(image, use_fp16=False)
    d_orig = run()
    with torch.no_grad():
        for p in model.parameters():
            p.zero_()
        sd = {torch_name_of(k): torch.from_numpy(np.array(v)) for k, v in got.items()}
        sd = {k: (v.to(torch.int64) if k.endswith("relative_position_index") else v) for k, v in sd.items()}
        missing, unexpected = model.load_state_dict(sd, strict=False)
    assert not unexpected, unexpected
    assert all(is_dropped(k) for k in missing), [k for k in missing if not is_dropped(k)]
    d_gguf = run()
    same = np.abs(d_gguf - d_orig).max()
    print(f"verify: fixture disparity, GGUF weights vs original weights: max abs {same:.3g}")
    print(f"verify: {len(missing)} dropped params stayed zero")
    assert same == 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--fork", required=True, help="BridgeDepth bench-vits checkout")
    ap.add_argument("--checkpoint", default="rvc_pretrain", choices=["rvc_pretrain"])
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--gguf-py", type=Path, help="Path to Fabric's gguf-py directory")
    args = ap.parse_args()
    if args.gguf_py:
        sys.path.insert(0, str(args.gguf_py.resolve()))

    model = load_model(args.fork, args.checkpoint)
    tensors, kv = collect(model)
    write(args.output, tensors, kv, args.checkpoint)
    n_drop = sum(is_dropped(k) for k in model.state_dict())
    print(f"wrote {args.output}: {len(tensors)} tensors, {args.output.stat().st_size / 1e6:.1f} MB, "
          f"{n_drop} state-dict entries dropped")
    verify(args.output, model, tensors)


if __name__ == "__main__":
    main()
