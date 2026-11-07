"""Regenerate the BridgeDepth test fixtures with the original PyTorch model.

Writes a synthetic rectified stereo pair (smooth random texture at 8 px
disparity, a nearer rectangle at 20 px, seed 26696) and the fp32 CPU reference:
bridgedepth-seeds-f32.bin, the DPN top-k seeds [H/8 * W/8, 2] after padding, and
bridgedepth-disparity-f32.bin, the unpadded left disparity [100, 200]. The
100x200 size pads to 112x208, so the fixture exercises the input padding and
the window padding of the 1/8 grid (14x26 is not a multiple of 6).

Usage: python generate-bridgedepth-reference.py --fork <BridgeDepth checkout>
The fork must be gbionics/BridgeDepth bench-vits at f6d8cdd (see
docs/bridgedepth.md), with its requirements installed; it downloads
rvc_pretrain and Depth-Anything-V2-Small from Hugging Face.
"""
import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("--fork", required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent

rng = np.random.default_rng(26696)
H, W, PAD = 100, 200, 40


def texture(h, w):
    t = rng.random((h // 4 + 2, w // 4 + 2, 3)).astype(np.float32)
    t = cv2.resize(t, (w + 8, h + 8), interpolation=cv2.INTER_CUBIC)[4:4 + h, 4:4 + w]
    return np.clip(t * 255, 0, 255)


background = texture(H, W + PAD)
foreground = texture(40, 60)


def view(shift_background, shift_foreground):
    image = background[:, shift_background:shift_background + W].copy()
    x0 = 80 - shift_foreground
    image[30:70, x0:x0 + 60] = foreground
    return image.astype(np.uint8)


for name, image in (("left", view(0, 0)), ("right", view(8, 20))):
    cv2.imwrite(str(root / f"bridgedepth-{name}.png"), cv2.cvtColor(image, cv2.COLOR_RGB2BGR))

FORK_COMMIT = "f6d8cddfcfbe2f6d4b7b6b7be091e5aadd76fd70"
head = subprocess.run(
    ["git", "-C", str(args.fork), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
).stdout.strip()
if head != FORK_COMMIT:
    sys.exit(f"--fork is at {head}, expected bench-vits {FORK_COMMIT}")
sys.path.insert(0, str(args.fork))
import torch  # noqa: E402
from bridgedepth.bridgedepth import BridgeDepth  # noqa: E402

torch.set_num_threads(4)
model = BridgeDepth.from_pretrained("rvc_pretrain", encoder="vits").eval()
mono_infer = model.mono.infer
model.mono.infer = lambda image, use_fp16=False: mono_infer(image, use_fp16=False)
seeds = {}
model.stereo_encoder.dpn.propagation.register_forward_hook(
    lambda module, inputs, output: seeds.__setitem__("value", output[1].detach().float().numpy()))

views = []
for name in ("left", "right"):
    image = cv2.cvtColor(cv2.imread(str(root / f"bridgedepth-{name}.png")), cv2.COLOR_BGR2RGB)
    views.append(torch.from_numpy(image).permute(2, 0, 1)[None].float())
with torch.no_grad():
    result = model({"img1": views[0], "img2": views[1]})
disparity = result["disp_pred"].detach().float().numpy().reshape(H, W)
seeds["value"].reshape(-1, 2).astype("<f4").tofile(root / "bridgedepth-seeds-f32.bin")
disparity.astype("<f4").tofile(root / "bridgedepth-disparity-f32.bin")
print(f"disparity min {disparity.min():.3f} max {disparity.max():.3f} mean {disparity.mean():.3f}")
