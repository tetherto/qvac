#!/usr/bin/env python3
"""Dump a real-LIBERO fixture for the integration test.

Spins up one LIBERO MuJoCo task, resets it with a fixed seed, runs the
SmolVLA policy preprocessor on the very first observation, then calls
``policy.model.sample_actions(...)`` with a deterministic seeded noise
tensor. Writes the exact inputs the model saw plus the resulting action
chunk so the JS integration test can replay the same forward pass and
diff the C++ addon's output against PyTorch ground truth — but with a
*real* image + real instruction + non-zero state, not the synthetic
gray fixture used by ``scripts/generate_reference.py``.

Why this lives in ``sim/`` and not ``scripts/``: the synthetic generator
needs only torch + lerobot. This one additionally needs MuJoCo + LIBERO
+ the headless rendering stack listed in ``sim/requirements.txt``.

Usage (from the package root, in the LIBERO sim venv):

    export MUJOCO_GL=egl
    python sim/dump_fixture.py
    python sim/dump_fixture.py --task libero_spatial --task-id 0 --noise-seed 42

Outputs (default ``test/integration/assets/``):

    pt_actions_libero_real.json   model id, hparams, instruction, tokens,
                                  mask, state, noise, action ground truth
    libero_real_left.bin          512x512x3 raw uint8 RGB (overhead view)
    libero_real_right.bin         512x512x3 raw uint8 RGB (wrist view)

The ``.bin`` files are raw pre-resized uint8 buffers so the JS test can
slurp them with ``fs.readFileSync`` and feed them straight to
``preprocessImage`` — no PNG decoder needed on Bare/mobile.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np


# Match the addon's hparams (also asserted at runtime against
# ``hp.visionImageSize`` etc. in addon.test.js).
IMAGE_SIZE = 512
CHUNK_SIZE = 50
MAX_ACTION_DIM = 32
MAX_STATE_DIM = 32
TOKEN_MAX_LEN = 48


def _import_heavy():
    """Lazy import so ``--help`` works without the LIBERO venv activated."""
    try:
        import torch  # noqa: F401
        from libero.libero import benchmark  # noqa: F401
        from lerobot.envs.libero import LiberoEnv  # noqa: F401
        from lerobot.policies.smolvla.modeling_smolvla import (
            SmolVLAPolicy, resize_with_pad, pad_vector,
        )  # noqa: F401
    except ImportError as exc:  # pragma: no cover — only runs on the dev env
        sys.stderr.write(
            "ERROR: missing LIBERO sim deps.\n"
            "       Activate the venv described in sim/README.md and install\n"
            "       sim/requirements.txt.\n"
            f"       underlying error: {exc}\n"
        )
        sys.exit(2)


def _resize_with_pad_uint8(pixels_hwc: np.ndarray, target: int) -> np.ndarray:
    """Letterbox-resize an HxWx3 uint8 array to target×target×3 uint8.

    Matches the bilinear + zero-pad-on-(left,top) behaviour of the JS
    ``preprocessImage`` and lerobot's ``resize_with_pad`` so both sides see
    the same final pixels regardless of source aspect ratio.
    """
    if pixels_hwc.dtype != np.uint8 or pixels_hwc.ndim != 3 or pixels_hwc.shape[-1] != 3:
        raise ValueError(
            f"expected HxWx3 uint8, got dtype={pixels_hwc.dtype} shape={pixels_hwc.shape}"
        )
    h, w, _ = pixels_hwc.shape
    if h == target and w == target:
        return pixels_hwc

    from PIL import Image
    ratio = max(w / target, h / target)
    new_w = max(1, int(w / ratio))
    new_h = max(1, int(h / ratio))
    resized = np.asarray(
        Image.fromarray(pixels_hwc, mode="RGB").resize((new_w, new_h), Image.BILINEAR),
        dtype=np.uint8,
    )
    out = np.zeros((target, target, 3), dtype=np.uint8)
    out[:new_h, :new_w] = resized  # left/top pad with 0 — same as JS / lerobot
    return out


def _build_state_vector(robot_state: dict) -> np.ndarray:
    """Assemble a SmolVLA-compatible 8-dim state from a LIBERO observation.

    Mirrors what ``lerobot/envs/libero.py`` exposes under ``robot_state`` for
    the ``pixels_agent_pos`` obs type: end-effector position (3) + quaternion
    (4) + gripper finger position (1, mean of the two finger qpos values).
    Padding to ``MAX_STATE_DIM`` happens later.
    """
    eef = robot_state["eef"]
    eef_pos = np.asarray(eef["pos"], dtype=np.float32).reshape(-1)  # (3,)
    eef_quat = np.asarray(eef["quat"], dtype=np.float32).reshape(-1)  # (4,)
    grip_qpos = np.asarray(robot_state["gripper"]["qpos"], dtype=np.float32).reshape(-1)
    # LIBERO has two finger joints; their mean is what the policy was trained on.
    grip_scalar = np.float32(grip_qpos.mean())
    return np.concatenate([eef_pos, eef_quat, [grip_scalar]], axis=0)  # (8,)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--policy", default="HuggingFaceVLA/smolvla_libero",
        help="HF policy id or local path",
    )
    parser.add_argument(
        "--task", default="libero_spatial",
        help="LIBERO task suite (libero_spatial, libero_object, libero_goal, libero_10, libero_90)",
    )
    parser.add_argument("--task-id", type=int, default=0, help="task index inside the suite")
    parser.add_argument("--noise-seed", type=int, default=42, help="RNG seed for the flow-matching noise")
    parser.add_argument("--env-seed", type=int, default=42, help="RNG seed for env.reset()")
    parser.add_argument(
        "--output-dir", default="test/integration/assets",
        help="Where to write the JSON + .bin files (relative to package root)",
    )
    parser.add_argument(
        "--device", default="cpu", choices=("cpu", "cuda"),
        help="Torch device (default: cpu — sim runs MuJoCo on CPU regardless)",
    )
    parser.add_argument(
        "--action-dim", type=int, default=7,
        help="How many leading action dims to keep (matches C++ hparams.action_dim)",
    )
    args = parser.parse_args()

    os.environ.setdefault("MUJOCO_GL", "egl")
    _import_heavy()
    import torch
    from libero.libero import benchmark
    from lerobot.envs.libero import LiberoEnv
    from lerobot.policies.smolvla.modeling_smolvla import (
        SmolVLAPolicy, resize_with_pad, pad_vector,
    )

    print(f"Loading SmolVLA policy {args.policy!r} on {args.device}…", flush=True)
    policy = SmolVLAPolicy.from_pretrained(args.policy).to(args.device)
    policy.eval()

    print(f"Building LIBERO env: suite={args.task} task_id={args.task_id}…", flush=True)
    suites = benchmark.get_benchmark_dict()
    if args.task not in suites:
        sys.stderr.write(
            f"ERROR: unknown task suite {args.task!r}; "
            f"available: {sorted(suites.keys())}\n"
        )
        return 2
    task_suite = suites[args.task]()
    env = LiberoEnv(
        task_suite=task_suite,
        task_id=args.task_id,
        task_suite_name=args.task,
        obs_type="pixels_agent_pos",
        observation_height=256,
        observation_width=256,
    )

    print(f"Resetting env with seed={args.env_seed}…", flush=True)
    obs, _info = env.reset(seed=args.env_seed)
    instruction = env.task_description
    print(f"  instruction: {instruction!r}", flush=True)

    # ---- images ------------------------------------------------------------
    pixels = obs["pixels"]
    if "image" not in pixels or "image2" not in pixels:
        sys.stderr.write(
            f"ERROR: env returned camera keys {list(pixels.keys())}; "
            "expected both 'image' (overhead) and 'image2' (wrist).\n"
        )
        return 2
    raw_left = np.asarray(pixels["image"], dtype=np.uint8)    # (256, 256, 3)
    raw_right = np.asarray(pixels["image2"], dtype=np.uint8)  # (256, 256, 3)

    # Letterbox-resize once on this side so the .bin files are exactly what
    # the model will see; JS preprocessImage will just normalise them.
    left_512 = _resize_with_pad_uint8(raw_left, IMAGE_SIZE)
    right_512 = _resize_with_pad_uint8(raw_right, IMAGE_SIZE)

    def _to_model(uint8_512: np.ndarray) -> "torch.Tensor":
        # JS preprocessImage does (p/255)*2 - 1 in HWC order, then the addon
        # transposes to CHW internally. lerobot's prepare_images applies the
        # same normalisation but expects CHW. Result is byte-identical with
        # JS as long as both sides start from the same uint8 buffer.
        chw = np.transpose(uint8_512.astype(np.float32) / 255.0 * 2.0 - 1.0, (2, 0, 1))
        return torch.from_numpy(chw).unsqueeze(0).to(args.device)

    images = [_to_model(left_512), _to_model(right_512)]
    img_masks = [
        torch.ones(1, dtype=torch.bool, device=args.device),
        torch.ones(1, dtype=torch.bool, device=args.device),
    ]

    # ---- instruction + tokens ---------------------------------------------
    # SmolVLA's preprocessor appends "\n" to every task string
    # (NewLineTaskProcessorStep). Match that here for a reproducible token
    # sequence.
    tok_input = instruction if instruction.endswith("\n") else instruction + "\n"
    tokenizer = policy.model.vlm_with_expert.processor.tokenizer
    tok = tokenizer(
        tok_input,
        padding="max_length",
        max_length=TOKEN_MAX_LEN,
        truncation=True,
        return_tensors="pt",
    )
    lang_tokens = tok["input_ids"].to(args.device)
    lang_masks = tok["attention_mask"].to(args.device, dtype=torch.bool)

    # ---- state -------------------------------------------------------------
    raw_state = _build_state_vector(obs["robot_state"])  # (8,)
    state_padded = np.zeros(MAX_STATE_DIM, dtype=np.float32)
    state_padded[: raw_state.size] = raw_state
    state = torch.from_numpy(state_padded).unsqueeze(0).to(args.device)

    # NOTE: this is the *raw* (un-normalised) robot state. The lerobot eval
    # pipeline normalises it via NormalizerProcessorStep using dataset stats
    # before handing it to the policy. We skip that step on purpose — the
    # test compares C++ vs PyTorch on byte-identical inputs, so as long as
    # both sides see the same state vector the comparison is valid. The
    # actions produced won't be physically meaningful (out-of-distribution
    # state), but the per-tensor numerical agreement still proves the C++
    # forward pass is correct.

    # ---- noise (deterministic, seeded) ------------------------------------
    gen = torch.Generator(device=args.device).manual_seed(args.noise_seed)
    noise = torch.randn(
        (1, CHUNK_SIZE, MAX_ACTION_DIM),
        generator=gen, device=args.device,
    )

    # ---- forward pass ------------------------------------------------------
    print("Running sample_actions on real LIBERO observation…", flush=True)
    with torch.no_grad():
        actions = policy.model.sample_actions(
            images, img_masks, lang_tokens, lang_masks, state, noise=noise,
        )
    actions_np = actions.detach().float().cpu().numpy()  # (1, chunk_size, max_action_dim)
    actions_trimmed = actions_np[0, :, : args.action_dim]
    mn, mx = float(np.min(actions_trimmed)), float(np.max(actions_trimmed))
    print(f"  action chunk shape: {actions_trimmed.shape}, range [{mn:.4f}, {mx:.4f}]")

    # ---- write outputs -----------------------------------------------------
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    json_path = out_dir / "pt_actions_libero_real.json"
    out = {
        "model": args.policy,
        "action_dim": int(args.action_dim),
        "chunk_size": int(CHUNK_SIZE),
        "image_size": int(IMAGE_SIZE),
        "tokenizer_max_length": int(TOKEN_MAX_LEN),
        "fixture": {
            "kind": "real",
            "task_suite": args.task,
            "task_id": args.task_id,
            "env_seed": args.env_seed,
            "noise_seed": args.noise_seed,
            "raw_state_dim": int(raw_state.size),
            "state_normalised": False,
        },
        "inputs": {
            "instruction": instruction,
            "tokens": [int(x) for x in lang_tokens[0].cpu().tolist()],
            "token_mask": [bool(x) for x in lang_masks[0].cpu().tolist()],
            "state": [float(x) for x in state_padded.tolist()],
            "noise": [float(x) for x in noise.detach().float().cpu().reshape(-1).tolist()],
        },
        "actions": [[float(x) for x in row] for row in actions_trimmed.tolist()],
    }
    with json_path.open("w") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {json_path}")

    for suffix, buf in (("left", left_512), ("right", right_512)):
        bin_path = out_dir / f"libero_real_{suffix}.bin"
        bin_path.write_bytes(buf.tobytes())
        print(f"Wrote {bin_path} ({buf.nbytes} bytes, shape={buf.shape})")

    env.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
