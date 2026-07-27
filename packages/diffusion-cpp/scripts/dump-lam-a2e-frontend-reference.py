"""Create a Wav2Vec2 frontend parity fixture from trusted LAM-A2E PyTorch.

Narrower counterpart to `dump-lam-a2e-stages.py`: captures only the
`feature_extractor` output, which is what the `lam-a2e-frontend-smoke`
harness in qvac-ext-stable-diffusion.cpp compares against.

Requires a local checkout of the upstream LAM_Audio2Expression project and a
CUDA device.

Usage:
    ./venv/bin/python scripts/dump-lam-a2e-frontend-reference.py \
        <lam-a2e-project-root> <checkpoint.tar> <audio.wav> <output.npz>
"""

from __future__ import annotations

import json
import runpy
import sys
from pathlib import Path

import librosa
import numpy as np
import torch


def main() -> None:
    project_root = Path(sys.argv[1]).resolve()
    checkpoint_path = Path(sys.argv[2]).resolve()
    audio_path = Path(sys.argv[3]).resolve()
    output_path = Path(sys.argv[4]).resolve()

    sys.path.insert(0, str(project_root))
    from models import build_model

    config = runpy.run_path(
        str(project_root / "configs" / "lam_audio2exp_config_streaming.py")
    )
    model = build_model(config["model"])
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.cuda().eval()

    pcm, sample_rate = librosa.load(audio_path, sr=16000, mono=True)
    pcm_tensor = torch.from_numpy(pcm).unsqueeze(0).cuda()
    with torch.no_grad():
        frontend = model.backbone.audio_encoder.feature_extractor(pcm_tensor)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        output_path,
        pcm=pcm.astype(np.float32),
        frontend=frontend.cpu().numpy().astype(np.float32),
        sample_rate=np.array(sample_rate, dtype=np.int32),
    )
    output_path.with_suffix(".json").write_text(
        json.dumps(
            {
                "sample_rate": sample_rate,
                "pcm_shape": list(pcm.shape),
                "frontend_shape": list(frontend.shape),
                "weights": checkpoint_path.name,
                "stage": "Wav2Vec2 feature_extractor",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
