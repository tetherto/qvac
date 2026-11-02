"""Regenerate synthetic reference fixtures with the original MegaLoc PyTorch model."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""
import numpy as np
from PIL import Image
import torch
import torchvision.transforms as transforms
from safetensors.torch import load_file

parser = argparse.ArgumentParser()
parser.add_argument("--model-code", required=True, type=Path)
parser.add_argument("--checkpoint", required=True, type=Path)
args = parser.parse_args()
torch.set_num_threads(8)
spec = importlib.util.spec_from_file_location("megaloc_reference", args.model_code)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
model = module.MegaLoc().eval()
model.load_state_dict(load_file(args.checkpoint), strict=True)
transform = transforms.Compose([transforms.ToTensor(), transforms.Normalize([.485, .456, .406], [.229, .224, .225]),
                                transforms.Resize([322, 322], antialias=True)])
root = Path(__file__).resolve().parent
cases = []
samples = np.linspace(0, 529 * 588 - 1, 32, dtype=int)
header = ['#pragma once', '#include <array>', '',
          '// Original PyTorch antialiased bilinear preprocessing of synthetic RGB inputs.',
          'struct MegaLocPreprocessReference { int width; int height; std::array<float, 32> values; };',
          'inline constexpr std::array<int, 32> MEGALOC_SAMPLE_INDICES = {' + ', '.join(str(x) for x in samples) + '};',
          'inline constexpr std::array<MegaLocPreprocessReference, 3> MEGALOC_PREPROCESS_REFERENCE = {{']
for name, width, height in [('upscale', 64, 48), ('downscale', 640, 480), ('identity', 322, 322)]:
    indices = np.arange(width * height * 3, dtype=np.uint32)
    rgb = ((indices * 37 + indices // 19) % 256).astype(np.uint8).reshape(height, width, 3)
    image = Image.fromarray(rgb)
    x = transform(image).unsqueeze(0)
    patches = torch.nn.functional.unfold(x, kernel_size=14, stride=14).transpose(1, 2).contiguous().numpy().reshape(-1)
    with torch.inference_mode():
        descriptor = model(x).numpy().astype('<f4')
    filename = f'megaloc-{name}-f32.bin'
    descriptor.tofile(root / filename)
    if name == 'upscale':
        image.save(root / 'megaloc-input.png')
    cases.append({'name': name, 'width': width, 'height': height, 'reference': filename,
                  'sha256': hashlib.sha256(descriptor.tobytes()).hexdigest()})
    header.append('  {' + str(width) + ', ' + str(height) + ', {' + ', '.join(f'{value:.9e}F' for value in patches[samples]) + '}},')
header.append('}};')
(root / 'megaloc-preprocess.hpp').write_text('\n'.join(header) + '\n')
with args.checkpoint.open('rb') as source:
    checkpoint_sha256 = hashlib.file_digest(source, 'sha256').hexdigest()
(root / 'megaloc-reference.json').write_text(json.dumps({'reference': 'Original MegaLoc, CPU FP32',
    'source_revision': '5fe0dd697c4a70ba3e23607f6716ab3c606b16db', 'torch_version': torch.__version__,
    'checkpoint_sha256': checkpoint_sha256, 'cases': cases}, indent=2) + '\n')
print('Wrote three original PyTorch descriptor references and preprocessing samples')
