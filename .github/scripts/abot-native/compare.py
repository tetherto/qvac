"""Compare diagnostic activations; reject incomplete/non-finite captures."""
import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import re
import sys

PAIRS = [('resident-no-kv', 'stream-no-kv'), ('resident-kv', 'stream-kv'), ('resident-kv', 'disk-kv')]


def read_f32(path):
    raw = Path(path).read_bytes()
    if not raw or len(raw) % 4:
        raise ValueError(f'Invalid float capture: {path}')
    values = array('f')
    values.frombytes(raw)
    if sys.byteorder != 'little':
        values.byteswap()
    return values, hashlib.sha256(raw).hexdigest()


def compare_files(expected, actual):
    a, ah = read_f32(expected)
    b, bh = read_f32(actual)
    if len(a) != len(b):
        raise ValueError(f'Tensor size differs: {expected.name}')
    total = squared = maximum = 0.0
    first = None
    for i, (x, y) in enumerate(zip(a, b)):
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError(f'Non-finite tensor value: {expected.name}, element {i}')
        delta = abs(x - y)
        if delta and first is None:
            first = i
        maximum = max(maximum, delta)
        total += delta
        squared += delta * delta
    return {'elements': len(a), 'expectedSha256': ah, 'actualSha256': bh,
            'maxAbs': maximum, 'meanAbs': total / len(a), 'rmse': math.sqrt(squared / len(a)),
            'firstDifferentElement': first}


def stage_order(name):
    match = re.fullmatch(r'b(\d+)-s(-?\d+)-(.+)\.f32', name)
    if not match:
        raise ValueError(f'Unexpected capture name: {name}')
    block, step, stage = match.groups()
    order = {'initial-noise': 0, 'final-latents': 100, 'decoder-input': 101, 'decoder-output': 102}
    return int(block), order.get(stage, 1 + int(step) * 2 + (stage == 'renoise')), name


def compare_capture(root, blocks=4, reference=None):
    results = []
    # Across processes, compare each lane with its own earlier execution. A
    # resident reference can drift even when a within-process pair agrees.
    pairs = PAIRS if reference is None else [(lane, lane) for lane in sorted({x for pair in PAIRS for x in pair})]
    for baseline, candidate in pairs:
        a = {p.name: p for p in ((reference or root) / baseline).glob('*.f32') if not p.name.endswith('-node.f32')}
        b = {p.name: p for p in (root / candidate).glob('*.f32') if not p.name.endswith('-node.f32')}
        if not a or a.keys() != b.keys():
            raise ValueError(f'Missing/unmatched captures for {baseline}/{candidate}')
        required = {f'b{i}-s-1-{stage}.f32' for i in range(blocks)
                    for stage in ('initial-noise', 'final-latents', 'decoder-input', 'decoder-output')}
        required |= {f'b{i}-s{s}-flow.f32' for i in range(blocks) for s in range(4)}
        required |= {f'b{i}-s{s}-renoise.f32' for i in range(blocks) for s in range(3)}
        if not required.issubset(a):
            raise ValueError(f'Incomplete denoise/decoder capture for {candidate}')
        tensors = [{'file': name, **compare_files(a[name], b[name])} for name in sorted(a, key=stage_order)]
        results.append({'baseline': baseline, 'candidate': candidate, 'tensors': tensors,
                        'firstDifference': next((x for x in tensors if x['maxAbs'] > 0), None)})
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('capture', type=Path)
    parser.add_argument('--blocks', type=int, default=4)
    args = parser.parse_args()
    print(json.dumps(compare_capture(args.capture, args.blocks), indent=2, allow_nan=False))
