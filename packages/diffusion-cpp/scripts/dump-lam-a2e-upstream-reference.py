#!/usr/bin/env python3
"""Dump ARKit-52 reference fixtures from the upstream LAM_Audio2Expression repo.

This is the authoritative reference for scripts/check-lam-a2e-parity.js. Unlike
dump-lam-a2e-stages.py, which drives a hand-mirrored PyTorch transcription of
the network, this imports aigc3d/LAM_Audio2Expression's own models/network.py
and models/encoder/wav2vec.py. A parity pass here means the GGML engine agrees
with upstream, not merely with our reading of upstream.

The upstream clone is provisioned automatically into .cache/lam-a2e/upstream
and pinned to UPSTREAM_REF, matching how convert-lam-a2e.sh fetches and caches
the checkpoint. Pass --upstream to point at a clone you manage yourself.

The pin is the point: "validated against upstream" only means something if the
upstream in question is identifiable. Tracking main would let the reference move
under us, so a future parity failure could mean our regression or merely their
new commit -- and telling those apart after the fact is expensive.

The Python deps live in scripts/requirements-upstream.txt.

Upstream's own inference.py is not reusable here: engines/launch.py sets up
distributed training and engines/infer.py hardcodes .cuda(), so this drives the
model module directly. Everything that computes is upstream's untouched code;
only the harness around it is ours.

The comparison point is pred_exp -- exactly what Audio2ExpressionInfer reads out
of the model (engines/infer.py:136) before its cosmetic post-processing
(Savitzky-Golay smoothing, blendshape symmetrisation, and *random* eye blinks).
That post-processing is not part of the network, is not deterministic, and is
deliberately absent from the GGML engine.

Usage:

    ./venv/bin/pip install -r scripts/requirements-upstream.txt
    ./venv/bin/python scripts/dump-lam-a2e-upstream-reference.py \
      --checkpoint .cache/lam-a2e/pretrained_models/lam_audio2exp_streaming.tar \
      --pcm fixtures/jfk.pcm \
      --out-dir fixtures/upstream-reference
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np

UPSTREAM_URL = "https://github.com/aigc3d/LAM_Audio2Expression.git"
# main @ 2025-10-24. Bump deliberately, and re-dump fixtures when you do.
UPSTREAM_REF = "02a703c3ea7d8e360eb43098eca85ee98a083529"

SAMPLE_RATE = 16000
FPS = 30
N_COEFFS = 52

# Mirrors configs/lam_audio2exp_config_streaming.py -> model.backbone.
BACKBONE = dict(
    pretrained_encoder_type="wav2vec",
    pretrained_encoder_path="facebook/wav2vec2-base-960h",
    num_identity_classes=12,
    identity_feat_dim=64,
    hidden_dim=512,
    expression_dim=N_COEFFS,
    norm_type="ln",
    use_transformer=False,
    num_attention_heads=8,
    num_transformer_layers=6,
)

# name:seconds:identity_index -- "full" means the whole clip. Cases vary both
# length and identity so a pass cannot be a single-input coincidence: identity
# exercises the conditioning path, length exercises conv padding and the
# 50Hz->30Hz interpolation at frame-count boundaries.
DEFAULT_CASES = [
    "full_id0:full:0",
    "full_id7:full:7",
    "sec2_id0:2.0:0",
    "sec2_id3:2.0:3",
    "half_sec_id0:0.5:0",
]


def parse_case(spec: str) -> tuple[str, float | None, int]:
    parts = spec.split(":")
    if len(parts) != 3:
        raise ValueError(f"case must be name:seconds:identity_index, got {spec!r}")
    name, seconds, identity = parts
    return name, None if seconds == "full" else float(seconds), int(identity)


def git(*args: str, cwd: Path | None = None) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return proc.stdout.strip()


def provision_upstream(dest: Path, ref: str) -> str:
    """Clone upstream at `ref` if absent, and report the resolved commit.

    A pre-existing clone is left alone rather than force-checked-out, so a
    working tree someone is poking at never gets reset underneath them; the
    mismatch is reported instead.
    """
    if (dest / ".git").is_dir():
        head = git("rev-parse", "HEAD", cwd=dest)
        if head != ref:
            print(f"WARNING: {dest} is at {head[:12]}, not the pinned {ref[:12]}.\n"
                  f"         Fixtures will describe {head[:12]}. "
                  f"Delete the directory to re-provision at the pin.")
        return head

    if dest.exists() and any(dest.iterdir()):
        sys.exit(f"{dest} exists but is not a git clone; move it aside")

    print(f"cloning {UPSTREAM_URL} -> {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Full clone: the repo is ~10MB, and a --depth 1 clone of a branch cannot
    # then check out a pinned commit, which is the whole point here.
    git("clone", "--quiet", UPSTREAM_URL, str(dest))
    git("checkout", "--quiet", ref, cwd=dest)
    head = git("rev-parse", "HEAD", cwd=dest)
    print(f"checked out {head[:12]}")
    return head


def require_deps() -> None:
    missing = []
    for module in ("torch", "transformers", "torchaudio"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        sys.exit(
            f"missing Python module(s): {', '.join(missing)}\n"
            "install them with:\n"
            "  ./venv/bin/pip install -r scripts/requirements.txt "
            "-r scripts/requirements-upstream.txt"
        )


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--upstream", type=Path, default=None,
                    help="existing clone of github.com/aigc3d/LAM_Audio2Expression; "
                         "omit to auto-provision into .cache/lam-a2e/upstream")
    ap.add_argument("--upstream-ref", default=UPSTREAM_REF,
                    help=f"commit to check out when cloning (default: {UPSTREAM_REF[:12]})")
    ap.add_argument("--checkpoint", type=Path, required=True,
                    help="lam_audio2exp_streaming.tar (the inner one)")
    ap.add_argument("--pcm", type=Path, required=True,
                    help="raw little-endian f32 mono 16kHz PCM")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--case", action="append", dest="cases",
                    metavar="NAME:SECONDS:ID",
                    help=f"repeatable; defaults to {' '.join(DEFAULT_CASES)}")
    return ap.parse_args()


def build_model(upstream: Path, checkpoint: Path):
    import torch
    from models.network import Audio2Expression

    model = Audio2Expression(
        wav2vec2_config_path=str(upstream / "configs/wav2vec2_config.json"),
        **BACKBONE,
    )

    ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)

    # Saved from a DDP-wrapped DefaultEstimator, so keys are
    # module.backbone.<name>; Audio2Expression wants bare <name>. Mirrors
    # engines/infer.py:74-84, minus the DDP branch.
    weight = OrderedDict()
    for key, value in ckpt["state_dict"].items():
        name = key[len("module.") :] if key.startswith("module.") else key
        if not name.startswith("backbone."):
            continue  # criteria.* etc
        weight[name[len("backbone.") :]] = value

    missing, unexpected = model.load_state_dict(weight, strict=False)
    # Wav2Vec2Model allocates masked_spec_embed for SpecAugment during training;
    # it is unused at inference and absent from the checkpoint. Anything else
    # missing means the architecture does not match the weights.
    missing = [k for k in missing if "masked_spec_embed" not in k]
    if missing or unexpected:
        sys.exit(f"state_dict mismatch\n  missing: {missing[:8]}\n  unexpected: {list(unexpected)[:8]}")

    print(f"loaded {len(weight)} tensors from {checkpoint.name}")
    model.eval()
    return model


def run_case(model, samples: np.ndarray, identity_index: int) -> np.ndarray:
    import torch
    import torch.nn.functional as F

    with torch.no_grad():
        # Mirrors engines/infer.py:119-122 without the .cuda() calls.
        pred_exp = model({
            "id_idx": F.one_hot(
                torch.tensor(identity_index), BACKBONE["num_identity_classes"]
            )[None, ...],
            "input_audio_array": torch.FloatTensor(samples)[None, ...],
        })
    return pred_exp.squeeze(0).cpu().numpy().astype(np.float32)


def main() -> None:
    args = parse_args()
    require_deps()

    # Resolve everything before the chdir below, so relative arguments keep
    # meaning what the caller meant.
    pkg_dir = Path(__file__).resolve().parent.parent
    upstream = (
        args.upstream.resolve()
        if args.upstream is not None
        else pkg_dir / ".cache/lam-a2e/upstream"
    )
    checkpoint = args.checkpoint.resolve()
    pcm_path = args.pcm.resolve()
    out_dir = args.out_dir.resolve()

    if args.upstream is not None and not upstream.is_dir():
        sys.exit(f"not a directory: {upstream}")
    upstream_commit = provision_upstream(upstream, args.upstream_ref)

    sys.path.insert(0, str(upstream))
    # Upstream resolves some model-relative paths from the process cwd.
    os.chdir(upstream)

    pcm = np.fromfile(pcm_path, dtype="<f4")
    if pcm.size == 0:
        sys.exit(f"empty or unreadable PCM: {pcm_path}")
    print(f"input {pcm_path}: {pcm.size} samples ({pcm.size / SAMPLE_RATE:.3f}s)")

    model = build_model(upstream, checkpoint)

    out_dir.mkdir(parents=True, exist_ok=True)

    cases = []
    for spec in args.cases or DEFAULT_CASES:
        name, seconds, identity = parse_case(spec)
        samples = pcm if seconds is None else pcm[: int(seconds * SAMPLE_RATE)]
        if samples.size == 0:
            sys.exit(f"case {name}: {seconds}s slice is empty")

        expr = run_case(model, samples, identity)

        expected = math.ceil(samples.size / SAMPLE_RATE * FPS)
        if expr.shape != (expected, N_COEFFS):
            sys.exit(f"case {name}: got {expr.shape}, expected {(expected, N_COEFFS)}")

        pcm_file = f"{name}_input_pcm.bin"
        expr_file = f"{name}_expr.bin"
        samples.astype("<f4").tofile(out_dir / pcm_file)
        expr.tofile(out_dir / expr_file)

        cases.append({
            "case": name,
            "id_idx": identity,
            "sample_rate": SAMPLE_RATE,
            "fps": FPS,
            "tensors": {
                "input_pcm": {"file": pcm_file, "shape": [int(samples.size)]},
                "expr": {"file": expr_file, "shape": list(expr.shape)},
            },
        })
        print(f"  {name}: {expr.shape} id={identity} "
              f"range [{expr.min():.6f}, {expr.max():.6f}]")

    manifest = {
        "source": "https://github.com/aigc3d/LAM_Audio2Expression",
        # Records the commit these numbers actually came from, so a parity
        # failure can be attributed rather than guessed at.
        "source_commit": upstream_commit,
        "checkpoint": checkpoint.name,
        "note": "pred_exp straight off Audio2Expression, before upstream's "
                "non-deterministic cosmetic post-processing",
        "dtype": "float32",
        "layout": "row-major [frames, coeffs]",
        "cases": cases,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(cases)} case(s) + manifest.json to {out_dir}")


if __name__ == "__main__":
    main()
