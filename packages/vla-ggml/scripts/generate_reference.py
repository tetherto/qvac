#!/usr/bin/env python3
"""Generate a deterministic PyTorch reference output for the integration
test's end-to-end inference smoke.  The test fixture is fully synthetic
(2 identical flat-gray images, BOS-only tokens, zero state, zero noise) so
the reference is reproducible to within PyTorch numerical noise.

The dumped JSON is tiny (~2 KB) and committed alongside the test. CI uses
it as ground truth for a tolerance-based assertion against the GGML output.

Usage (one-off, from the package root):

    ./scripts/generate_reference.py                              # default: HuggingFaceVLA/smolvla_libero
    ./scripts/generate_reference.py --model lerobot/smolvla_base
    ./scripts/generate_reference.py --output test/integration/assets/pt_actions_libero_fixed.json
    ./scripts/generate_reference.py --action-dim 7               # match C++ hparams.action_dim

Requires the same conda/venv that runs LeRobot (torch + lerobot installed).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

try:
    from lerobot.policies.smolvla.modeling_smolvla import SmolVLAPolicy
except ImportError as exc:  # pragma: no cover — only runs on the dev env
    sys.stderr.write(
        "ERROR: could not import SmolVLAPolicy from lerobot.\n"
        "       activate the lerobot venv (see smolvla-env/) and try again.\n"
        f"       underlying error: {exc}\n"
    )
    sys.exit(2)


IMAGE_SIZE = 512
CHUNK_SIZE = 50
MAX_ACTION_DIM = 32
MAX_STATE_DIM = 32
TOKEN_MAX_LEN = 48

# Mirrors the JS test fixture exactly:
#   dummy = Uint8Array(size*size*3).fill(128)
#   preprocessImage -> every pixel (128/255)*2 - 1
FIXED_PIXEL_VALUE = (128.0 / 255.0) * 2.0 - 1.0


def build_fixture(batch_size: int = 1, *, device: str, dtype: torch.dtype):
    """Build the PyTorch inputs that mirror the JS test fixture."""

    img = torch.full(
        (batch_size, 3, IMAGE_SIZE, IMAGE_SIZE),
        FIXED_PIXEL_VALUE,
        dtype=dtype,
        device=device,
    )
    images = [img, img.clone()]
    img_masks = [
        torch.ones(batch_size, dtype=torch.bool, device=device),
        torch.ones(batch_size, dtype=torch.bool, device=device),
    ]

    lang_tokens = torch.zeros(
        (batch_size, TOKEN_MAX_LEN), dtype=torch.long, device=device
    )
    lang_tokens[:, 0] = 1  # BOS-ish — matches the JS test
    lang_masks = torch.zeros(
        (batch_size, TOKEN_MAX_LEN), dtype=torch.bool, device=device
    )
    lang_masks[:, 0] = True

    state = torch.zeros(
        (batch_size, MAX_STATE_DIM), dtype=dtype, device=device
    )
    noise = torch.zeros(
        (batch_size, CHUNK_SIZE, MAX_ACTION_DIM), dtype=dtype, device=device
    )

    return images, img_masks, lang_tokens, lang_masks, state, noise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default="HuggingFaceVLA/smolvla_libero",
        help="HF model id or local path (default: HuggingFaceVLA/smolvla_libero)",
    )
    parser.add_argument(
        "--output",
        default="test/integration/assets/pt_actions_libero_fixed.json",
        help="Where to write the JSON (relative to package root)",
    )
    parser.add_argument(
        "--action-dim",
        type=int,
        default=7,
        help="How many leading action dims to keep (matches C++ hparams.action_dim).",
    )
    parser.add_argument(
        "--device",
        default="cuda" if torch.cuda.is_available() else "cpu",
        help="Torch device (default: cuda if available, else cpu)",
    )
    parser.add_argument(
        "--dtype",
        default="float32",
        choices=("float32", "bfloat16"),
        help="Torch dtype for the forward pass (default: float32)",
    )
    args = parser.parse_args()

    dtype = {"float32": torch.float32, "bfloat16": torch.bfloat16}[args.dtype]
    device = torch.device(args.device)

    print(f"Loading SmolVLA policy from {args.model} on {device}…", flush=True)
    policy = SmolVLAPolicy.from_pretrained(args.model).to(device=device, dtype=dtype)
    policy.eval()

    images, img_masks, lang_tokens, lang_masks, state, noise = build_fixture(
        batch_size=1, device=device, dtype=dtype
    )

    print("Running sample_actions on fixed fixture…", flush=True)
    with torch.no_grad():
        actions = policy.model.sample_actions(
            images, img_masks, lang_tokens, lang_masks, state, noise=noise
        )

    actions = actions.detach().float().cpu().numpy()  # (1, chunk_size, max_action_dim)
    # Match the C++ addon which returns (chunk_size, action_dim).
    actions_trimmed = actions[0, :, : args.action_dim]

    out = {
        "model": args.model,
        "action_dim": int(args.action_dim),
        "chunk_size": int(CHUNK_SIZE),
        "image_size": int(IMAGE_SIZE),
        "tokenizer_max_length": int(TOKEN_MAX_LEN),
        "fixture": {
            "pixel_value": float(FIXED_PIXEL_VALUE),
            "bos_token_id": 1,
            "state_zero": True,
            "noise_zero": True,
        },
        "actions": [
            [float(x) for x in row] for row in actions_trimmed.tolist()
        ],
    }

    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {out_path} ({actions_trimmed.shape})", flush=True)

    mn, mx = float(np.min(actions_trimmed)), float(np.max(actions_trimmed))
    print(f"  action range: [{mn:.4f}, {mx:.4f}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
