"""Generate deterministic per-stage LAM-A2E parity fixtures.

The fixture uses the first second of a trusted 16 kHz mono WAV so each
intermediate stage stays small enough to commit/store alongside test metadata.
Output feeds the `lam-a2e-parity` harness in qvac-ext-stable-diffusion.cpp,
which takes the fixture directory as an argument.

Requires a local checkout of the upstream LAM_Audio2Expression project (passed
as `project_root`) and a CUDA device — this is the trusted PyTorch reference,
so it deliberately runs the original code path rather than our port.

Usage:
    ./venv/bin/python scripts/dump-lam-a2e-stages.py \
        <lam-a2e-project-root> <checkpoint.tar> <audio.wav> <output.npz>
"""

from __future__ import annotations

import argparse
import json
import runpy
import sys
from pathlib import Path

import librosa
import numpy as np
import torch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_root", type=Path)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--seconds", type=float, default=1.0)
    parser.add_argument("--identity-index", type=int, default=0)
    return parser.parse_args()


def tensor_output(value: object) -> torch.Tensor:
    if isinstance(value, torch.Tensor):
        return value
    if hasattr(value, "last_hidden_state"):
        return value.last_hidden_state
    if isinstance(value, (tuple, list)) and value and isinstance(value[0], torch.Tensor):
        return value[0]
    raise TypeError(f"Cannot serialize hook output of type {type(value)!r}")


def main() -> None:
    args = parse_args()
    project_root = args.project_root.resolve()
    sys.path.insert(0, str(project_root))
    from models import build_model

    config = runpy.run_path(
        str(project_root / "configs" / "lam_audio2exp_config_streaming.py")
    )
    model = build_model(config["model"])
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.cuda().eval()

    stage_outputs: dict[str, np.ndarray] = {}

    def capture(name: str):
        def hook(_module: torch.nn.Module, _inputs: tuple[object, ...], output: object):
            stage_outputs[name] = (
                tensor_output(output).detach().float().cpu().numpy()
            )

        return hook

    def capture_input(name: str):
        def hook(_module: torch.nn.Module, inputs: tuple[object, ...]):
            stage_outputs[name] = (
                tensor_output(inputs[0]).detach().float().cpu().numpy()
            )

        return hook

    backbone = model.backbone
    hooks = [
        backbone.audio_encoder.feature_extractor.register_forward_hook(capture("frontend")),
        backbone.audio_encoder.feature_projection.layer_norm.register_forward_pre_hook(
            capture_input("interpolated_frontend")
        ),
        backbone.audio_encoder.feature_projection.layer_norm.register_forward_hook(
            capture("feature_layer_norm")
        ),
        backbone.audio_encoder.feature_projection.register_forward_hook(capture("wav2vec_projection")),
        backbone.audio_encoder.encoder.pos_conv_embed.register_forward_hook(capture("position")),
        backbone.feature_projection.register_forward_hook(capture("lam_projection")),
        backbone.identity_encoder.register_forward_hook(capture("identity")),
        backbone.decoder[0].register_forward_hook(capture("decoder")),
        backbone.output_proj.register_forward_hook(capture("output_projection")),
    ]
    for index, layer in enumerate(backbone.audio_encoder.feature_extractor.conv_layers):
        hooks.append(layer.conv.register_forward_hook(capture(f"frontend_conv_{index}")))
        if index == 0:
            hooks.append(layer.layer_norm.register_forward_hook(capture("frontend_group_norm_0")))
    for index, layer in enumerate(backbone.audio_encoder.encoder.layers):
        hooks.append(layer.register_forward_hook(capture(f"transformer_{index:02d}")))

    pcm, sample_rate = librosa.load(args.audio, sr=16000, mono=True)
    pcm = pcm[: int(args.seconds * sample_rate)]
    identity_class_count = config["model"]["backbone"]["num_identity_classes"]
    identity = torch.nn.functional.one_hot(
        torch.tensor(args.identity_index),
        identity_class_count,
    ).cuda()[None, ...]
    input_dict = {
        "id_idx": identity,
        "input_audio_array": torch.from_numpy(pcm).unsqueeze(0).cuda(),
    }

    with torch.no_grad():
        final_output = backbone(input_dict)
    for hook in hooks:
        hook.remove()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        args.output,
        pcm=pcm.astype(np.float32),
        final=final_output.detach().float().cpu().numpy(),
        **stage_outputs,
    )
    args.output.with_suffix(".json").write_text(
        json.dumps(
            {
                "sample_rate": sample_rate,
                "seconds": args.seconds,
                "identity_index": args.identity_index,
                "fps": 30,
                "stages": {name: list(value.shape) for name, value in stage_outputs.items()},
                "final_shape": list(final_output.shape),
                "checkpoint": args.checkpoint.name,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
