#!/usr/bin/env python3
"""Dump GR00T N1.7-3B PyTorch reference activations for ggml-port parity testing.

Runs Isaac-GR00T's `Gr00tPolicy` on a fixed synthetic fixture and dumps named
intermediate tensors to a safetensors file that the C++ milestone tests
(test/unit/test_groot_m*_*.cpp) and the infer-parity test diff their ggml
sub-graph outputs against. `--embodiment` selects the fixture preset (keys +
dims + tag): `droid` (base N1.7-3B, default), `libero` (the LIBERO ckpt), or
`real_g1` / `real_r1_pro` (further base-checkpoint embodiments with distinct
cat_ids, for end-to-end parity of a SELECTED non-default embodiment).

Must run on a CUDA GPU with Isaac-GR00T installed. Note the LIBERO checkpoint's
config sets `use_flash_attention: true`; flash-attn needs Ampere+, so on a
Turing GPU (e.g. T4) flip it to false (sdpa — exact attention, same numerics)
in the checkpoint's config.json before dumping.

Every GR00T checkpoint pulls its VLM backbone from the GATED
`nvidia/Cosmos-Reason2-2B` repo, so a box without access to it cannot load the
model at all. If you have the backbone on disk (e.g. copied from another
machine's HF cache) point the checkpoint at it instead of authenticating — there
are TWO independent references and missing either one sends the loader back to
the hub:

  * `config.json` -> `model_name`: the backbone weights. `get_backbone_cls`
    selects the class by substring, so the local path must still contain
    `nvidia/Cosmos-Reason2` (e.g. `/path/local-hf/nvidia/Cosmos-Reason2-2B`).
  * `processor_config.json` -> `processor_kwargs.model_name`: the tokenizer /
    processor. Checkpoints ship without this key and
    `Gr00tN1d7Processor.from_pretrained` re-`setdefault`s the gated repo id, so
    it must be set explicitly.

With both pointing at a local directory, `transformers` treats the backbone as
local and skips its hub metadata lookups, and the dump runs fully offline
(`HF_HUB_OFFLINE=1`). Only the lookup path changes; the weights are the same.

Usage:
    python dump_groot_activations.py \
        --checkpoint /path/to/GR00T-N1.7-3B \
        --embodiment droid \
        --out activations_v4.safetensors

    python dump_groot_activations.py \
        --checkpoint /path/to/GR00T-N1.7-LIBERO/libero_10 \
        --embodiment libero \
        --out activations_libero_v4.safetensors

`--mode sweep` instead dumps the multi-embodiment parity fixture: it runs ONLY
the three embodiment-conditioned submodules (state_encoder, action_encoder,
action_decoder — the only per-embodiment weights) on a FIXED synthetic input,
once per cat_id, so the C++ port can validate that every shipped embodiment row
slices + matmuls correctly. No cameras / real observation are needed because the
rest of the action head is embodiment-agnostic. Use the SAME checkpoint the
multi-embodiment GGUF was converted from (base N1.7-3B ships all trained rows):

    python dump_groot_activations.py \
        --checkpoint /path/to/GR00T-N1.7-3B \
        --mode sweep \
        --out activations_sweep.safetensors
"""

import argparse
import json

import numpy as np
import torch
from safetensors.torch import save_file

IMAGE_SIZE = 256
SEED = 0

# Per-embodiment fixture spec. The hook machinery + graph are embodiment-
# agnostic; only the observation keys/dims and the embodiment tag differ.
# Values come from each checkpoint's modality config (video/state keys +
# delta_indices) — verified against the oracle shapes. Note gripper is 2-D for
# LIBERO (state group min/max shape (2,)).
PRESETS = {
    "droid": {
        "embodiment_tag": "OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT",
        "video_keys": ["exterior_image_1_left", "wrist_image_left"],
        "video_history": 2,  # delta_indices [-15, 0]
        "state_keys": {"eef_9d": 9, "gripper_position": 1, "joint_position": 7},
        "language_key": "annotation.language.language_instruction",
        "instruction": "pick up the red block and place it in the bin",
    },
    "libero": {
        "embodiment_tag": "LIBERO_PANDA",
        "video_keys": ["image", "wrist_image"],
        "video_history": 1,  # delta_indices [0]
        "state_keys": {"x": 1, "y": 1, "z": 1, "roll": 1, "pitch": 1, "yaw": 1, "gripper": 2},
        "language_key": "annotation.human.action.task_description",
        "instruction": "pick up the black bowl and place it on the plate",
    },
    # Two further base-checkpoint embodiments with distinct cat_ids, so an
    # end-to-end parity run can gate a SELECTED non-default embodiment rather
    # than only the GGUF's default one. Both keep the shared weights of the base
    # checkpoint, so they pair with a base-derived multi GGUF (see
    # make_multi_embodiment_fixture.py). Keys/dims/history come from the
    # checkpoint's own processor_config.json modality_configs and statistics.json
    # — do not hand-edit them; a mismatch makes Gr00tPolicy reject the fixture.
    # Image count per infer = len(video_keys) * video_history, which is the
    # embodiment's num_cameras from the GGUF's point of view: 2 for real_g1,
    # 6 for real_r1_pro, against LIBERO's 2 and DROID's 4.
    "real_g1": {
        "embodiment_tag": "REAL_G1_RELATIVE_EEF_RELATIVE_JOINTS",
        "video_keys": ["ego_view"],
        "video_history": 2,  # delta_indices [-20, 0]
        "state_keys": {
            "left_wrist_eef_9d": 9,
            "right_wrist_eef_9d": 9,
            "left_hand": 7,
            "right_hand": 7,
            "left_arm": 7,
            "right_arm": 7,
            "waist": 3,
        },
        "language_key": "annotation.human.task_description",
        "instruction": "pick up the cup and hand it over",
    },
    "real_r1_pro": {
        "embodiment_tag": "REAL_R1_PRO_SHARPA_RELATIVE_EEF",
        "video_keys": [
            "ego_view_res320x240_freq20",
            "left_wrist_view_res320x240_freq20",
            "right_wrist_view_res320x240_freq20",
        ],
        "video_history": 2,  # delta_indices [-20, 0]
        "state_keys": {
            "left_wrist_eef": 9,
            "right_wrist_eef": 9,
            "left_hand_joints": 22,
            "right_hand_joints": 22,
        },
        "language_key": "annotation.human.coarse_action",
        "instruction": "pick up the bottle and place it on the tray",
    },
}


def build_fixture(preset):
    rng = np.random.default_rng(SEED)
    video = {
        k: rng.integers(
            0, 256, size=(1, preset["video_history"], IMAGE_SIZE, IMAGE_SIZE, 3), dtype=np.uint8
        )
        for k in preset["video_keys"]
    }
    state = {
        k: rng.uniform(-1.0, 1.0, size=(1, 1, d)).astype(np.float32)
        for k, d in preset["state_keys"].items()
    }
    language = {preset["language_key"]: [[preset["instruction"]]]}
    return {"video": video, "state": state, "language": language}


class ActivationRecorder:
    """Registers forward hooks and records each hooked tensor as a float32 CPU tensor.

    Two capture modes:
      * ``attach``       — forward hook; records a single-call module's output.
      * ``attach_input`` — forward PRE hook; records a module's inputs (args +
                           kwargs). Needed when the *input* is the oracle gate
                           (e.g. state_encoder's normalized-state input, which the
                           C++ side can't re-derive without the normalization stats).

    Both modes are step-aware: the flow-matching sampler calls the DiT / action
    coder once per denoising step, so a plain hook would keep only the last step.
    Each capture is suffixed with a per-name call counter (``<name>.callN``) so all
    steps survive — letting the DiT-block and Euler-loop milestones reproduce a
    specific step. Single-call modules also emit a bare ``<name>`` alias (back-compat
    with the v1 dump the M4.1 VL-fusion test consumes).
    """

    def __init__(self):
        self.activations = {}
        self._handles = []
        self._counts = {}

    def _next_index(self, name):
        i = self._counts.get(name, 0)
        self._counts[name] = i + 1
        return i

    def _hook(self, name):
        def fn(module, inputs, output):
            idx = self._next_index(name)
            self._store(f"{name}.call{idx}", output)
            if idx == 0:
                self._store(name, output)  # bare alias for single-call modules

        return fn

    def _pre_hook(self, name):
        def fn(module, args, kwargs):
            idx = self._next_index(name)
            self._store(f"{name}.call{idx}.args", list(args))
            if kwargs:
                self._store(f"{name}.call{idx}.kwargs", kwargs)

        return fn

    def _store(self, name, value):
        if isinstance(value, torch.Tensor):
            # .clone() so no two dumped keys share storage — safetensors'
            # save_file rejects aliased tensors, and the bare-name alias for
            # call0 would otherwise point at the same buffer as `<name>.call0`.
            self.activations[name] = value.detach().float().cpu().clone()
        elif isinstance(value, bool):
            pass  # bool is an int subclass; skip flags, they aren't parity data
        elif isinstance(value, (int, float)):
            # e.g. a per-step timestep scalar — keep as a 1-elem tensor so the
            # schedule is recoverable from the dump.
            self.activations[name] = torch.tensor([float(value)])
        elif isinstance(value, (tuple, list)):
            for i, v in enumerate(value):
                self._store(f"{name}.{i}", v)
        elif hasattr(value, "items"):
            for k, v in value.items():
                self._store(f"{name}.{k}", v)

    def attach(self, name, module):
        self._handles.append(module.register_forward_hook(self._hook(name)))

    def attach_input(self, name, module):
        # with_kwargs=True so keyword-passed tensors (timestep=..., etc.) are also
        # captured — the DiT mixes positional/keyword args and we don't hardcode
        # its signature here.
        self._handles.append(
            module.register_forward_pre_hook(self._pre_hook(name), with_kwargs=True)
        )

    def remove(self):
        for h in self._handles:
            h.remove()
        self._handles = []


# ── Multi-embodiment sweep fixture ────────────────────────────────────────
# The only per-embodiment weights are the 3 CategorySpecific submodules; the
# rest of the action head is shared. So the parity fixture feeds these three a
# FIXED synthetic input and records the output for every cat_id — cameras / real
# observations aren't needed. Dims match the GR00T N1.7-3B action head and the
# C++ test constants (test_groot_embodiment_sweep.cpp): max_state_dim =
# max_action_dim = 132, action horizon = 40, dit_output_dim = 1024. The
# action-encoder timestep is a fixed float in (0, 1).
SWEEP_MAX_STATE_DIM = 132
SWEEP_MAX_ACTION_DIM = 132
SWEEP_N_ACTION_TOKENS = 40
SWEEP_DIT_OUTPUT_DIM = 1024
SWEEP_TIMESTEP = 0.5


def dump_embodiment_sweep(action_head, device, cat_ids, out_path):
    """Run the 3 embodiment-conditioned submodules per cat_id on fixed inputs."""
    rng = np.random.default_rng(SEED)
    param_dtype = next(action_head.state_encoder.parameters()).dtype

    def synth(*shape):
        a = rng.uniform(-1.0, 1.0, size=shape).astype(np.float32)
        return torch.from_numpy(a).to(device=device, dtype=param_dtype)

    # Fixed synthetic inputs, shared across every cat_id (batch = 1).
    state_in = synth(1, 1, SWEEP_MAX_STATE_DIM)
    actions_in = synth(1, SWEEP_N_ACTION_TOKENS, SWEEP_MAX_ACTION_DIM)
    decoder_in = synth(1, SWEEP_N_ACTION_TOKENS + 1, SWEEP_DIT_OUTPUT_DIM)
    timesteps = torch.full((1,), SWEEP_TIMESTEP, device=device, dtype=param_dtype)

    def f32(t):
        return t.detach().float().cpu().clone()

    tensors = {
        "sweep.input.state": f32(state_in),
        "sweep.input.actions": f32(actions_in),
        "sweep.input.decoder": f32(decoder_in),
        "sweep.input.timestep": torch.tensor([float(SWEEP_TIMESTEP)]),
    }

    with torch.no_grad():
        for cid in cat_ids:
            # CategorySpecific* forward takes the embodiment id as a LongTensor of
            # shape (batch,); it indexes the per-category weight row. (If a future
            # Isaac-GR00T revision renames/reorders this arg, only these 3 calls
            # need touching.)
            emb = torch.full((1,), int(cid), dtype=torch.long, device=device)
            se = action_head.state_encoder(state_in, emb)
            ae = action_head.action_encoder(actions_in, timesteps, emb)
            ad = action_head.action_decoder(decoder_in, emb)
            tensors[f"sweep.cat{int(cid)}.state_encoder_output"] = f32(se)
            tensors[f"sweep.cat{int(cid)}.action_encoder_output"] = f32(ae)
            tensors[f"sweep.cat{int(cid)}.action_decoder_output"] = f32(ad)

    meta = {"seed": str(SEED), "cat_ids": json.dumps([int(c) for c in cat_ids])}
    save_file(tensors, out_path, metadata=meta)
    print(f"Saved sweep fixture: {len(cat_ids)} cat_ids -> {out_path}")
    for name, t in tensors.items():
        print(f"  {name:44s} {tuple(t.shape)} {t.dtype}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    # v4 default: v1 activations feed the M4.1 VL-fusion test; v2/v3 feed the
    # DiT/Euler/backbone milestones. v4 additionally dumps the tokenized backbone
    # INPUT (input_ids + pixel_values + grids) alongside the final actions so the
    # e2e infer() parity test can drive the C++ port from the exact same tokenized
    # input the oracle consumed and diff its actions.
    ap.add_argument("--out", default="activations_v4.safetensors")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument(
        "--embodiment", default="droid", choices=sorted(PRESETS.keys()),
        help="fixture preset: droid (base N1.7-3B) or libero (LIBERO ckpt)")
    ap.add_argument(
        "--mode", default="full", choices=["full", "sweep"],
        help="full: the milestone/e2e activation dump; sweep: per-cat_id "
             "embodiment-parity fixture (see module docstring)")
    ap.add_argument(
        "--cat-ids", default=",".join(str(i) for i in range(32)),
        help="sweep mode: comma-separated cat_ids to dump (default 0..31; the "
             "C++ test only checks the ones its GGUF actually ships)")
    args = ap.parse_args()
    preset = PRESETS[args.embodiment]

    import gr00t.model  # noqa: F401 registers Gr00tN1d7 with AutoModel
    from gr00t.policy.gr00t_policy import Gr00tPolicy

    policy = Gr00tPolicy(
        embodiment_tag=preset["embodiment_tag"],
        model_path=args.checkpoint,
        device=args.device,
    )

    model = policy.model
    action_head = model.action_head

    if args.mode == "sweep":
        cat_ids = [int(c) for c in args.cat_ids.split(",") if c.strip() != ""]
        dump_embodiment_sweep(action_head, args.device, cat_ids, args.out)
        return

    recorder = ActivationRecorder()
    recorder.attach("backbone_output", model.backbone)
    recorder.attach("vlln_output", action_head.vlln)
    recorder.attach("vl_self_attention_output", action_head.vl_self_attention)
    recorder.attach("state_encoder_output", action_head.state_encoder)
    for i, block in enumerate(action_head.model.transformer_blocks):
        recorder.attach(f"dit_block_{i}_output", block)
    recorder.attach("action_decoder_output", action_head.action_decoder)

    # ── E2E PyTorch-parity gate: tokenized backbone INPUT ────────────────────
    # Dump the backbone's actual forward input (input_ids, attention_mask,
    # pixel_values, image_grid_thw) so the e2e test can drive infer() from the
    # identical input the oracle saw — bypassing tokenizer / image-preprocessor
    # drift between PyTorch and the C++ port — and diff its integrated action
    # sample against the oracle's final normalized sample (reconstructed
    # x_3 + dt·vel_3) at bf16 tolerance. final_action.* below is
    # post-unnormalization, i.e. consumer-side.
    recorder.attach_input("backbone_input", model.backbone)

    # ── Augmented captures for the DiT / Euler / encoder milestones ──────────
    # These stages can't be isolated by output-only hooks: the DiT and action
    # coder run once per denoising step, and several stages are gated by their
    # INPUT, not their output.
    #
    # state_encoder INPUT — the per-embodiment-normalized state vector; the C++
    # side gets the raw state and can't reproduce the normalization without the
    # data-config stats.
    recorder.attach_input("state_encoder_input", action_head.state_encoder)
    # timestep_encoder OUTPUT + INPUT (the raw timestep scalar per step).
    recorder.attach("timestep_encoder_output", action_head.model.timestep_encoder)
    recorder.attach_input("timestep_encoder_input", action_head.model.timestep_encoder)
    # action_encoder INPUT (x_t in ACTION space per step; call0 == initial noise)
    # and OUTPUT (embedded action tokens fed to the DiT).
    recorder.attach_input("action_encoder_input", action_head.action_encoder)
    recorder.attach("action_encoder_output", action_head.action_encoder)
    # DiT stack INPUT per step (hidden_states, timestep, encoder_hidden_states);
    # args+kwargs captured generically rather than hardcoding the signature.
    recorder.attach_input("dit_model_input", action_head.model)
    # action_decoder INPUT per step (final DiT hidden → decoded velocity).
    recorder.attach_input("action_decoder_input", action_head.action_decoder)

    # ── Backbone intermediates (de-risk the M4.5 Qwen3-VL port) ──────────────
    # Split the single coarse backbone_features gate into independently-checkable
    # pieces: vision tower output, text-decoder INPUT (the trickiest interface,
    # post image/text merge + deepstack), and every vision block / text layer.
    qwen = model.backbone.model.model  # Qwen3VLModel
    recorder.attach("vision_output", qwen.visual)
    recorder.attach_input("vision_input", qwen.visual)
    recorder.attach_input("text_model_input", qwen.language_model)
    recorder.attach("text_model_output", qwen.language_model)
    if hasattr(qwen.visual, "blocks"):
        for i, blk in enumerate(qwen.visual.blocks):
            recorder.attach(f"vision_block_{i}", blk)
    if hasattr(qwen.language_model, "layers"):
        for i, lyr in enumerate(qwen.language_model.layers):
            recorder.attach(f"text_layer_{i}", lyr)

    observation = build_fixture(preset)
    policy.check_observation(observation)
    action, _info = policy.get_action(observation)
    policy.check_action(action)

    recorder.remove()

    tensors = dict(recorder.activations)
    for key, value in action.items():
        tensors[f"final_action.{key}"] = torch.from_numpy(value)

    meta = {
        "embodiment_tag": preset["embodiment_tag"],
        "seed": str(SEED),
        "instruction": preset["instruction"],
        "video_keys": json.dumps(preset["video_keys"]),
        "state_keys": json.dumps(preset["state_keys"]),
    }
    save_file(tensors, args.out, metadata=meta)

    print(f"Saved {len(tensors)} tensors to {args.out}")
    for name, t in tensors.items():
        print(f"  {name:40s} {tuple(t.shape)} {t.dtype}")


if __name__ == "__main__":
    main()
