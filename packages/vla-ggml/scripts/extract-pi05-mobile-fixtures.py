#!/usr/bin/env python3
"""Extract the minimal set of parity-oracle tensors that the mobile
pi05.test.js needs, then write them as small JSON files small enough to
bundle into an APK.

Why this exists:

- The full ``activations.safetensors`` from the parity-oracle dump is
  ~138 MB. AWS Device Farm bundles the test APK and we can't ship that
  much in test assets.
- ``pi05.test.js`` only compares one tensor end-to-end:
  ``ode.actions_final`` (50 × 32 F32 = 6400 bytes).
- ``fixture.safetensors`` is ~1.8 MB — well under any APK budget, but
  the mobile runtime reads typed bytes from JSON / .bin assets rather
  than parsing safetensors, so we lower it to per-key files too.

Outputs (written under --out-dir):

    pi05-actions-ref.json     # { "ode.actions_final": [50][32] floats }
    pi05-fixture.json         # { images_chw_b64, state, tokens, mask,
                              #   noise, time_grid }  — base64 for the
                              #   3 × 224 × 224 × 3 image bytes; lists
                              #   for everything else.

Tracked artefacts that the mobile workflow then copies into
``test/mobile/testAssets/`` so the APK loads them via ``global.assetPaths``.

Usage:

    python3 scripts/extract-pi05-mobile-fixtures.py \\
      --activations /path/to/activations.safetensors \\
      --fixture     /path/to/fixture.safetensors \\
      --out-dir     /path/to/test/mobile/testAssets/
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import sys
from pathlib import Path

import numpy as np
from safetensors.numpy import load_file as st_load_numpy


log = logging.getLogger("pi05-mobile-fixtures")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--activations", type=Path, required=True,
                        help="Path to oracle activations.safetensors")
    parser.add_argument("--fixture", type=Path, required=True,
                        help="Path to oracle fixture.safetensors")
    parser.add_argument("--out-dir", type=Path, required=True,
                        help="Where to write the small JSON files")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="[%(name)s] %(message)s",
    )

    args.out_dir.mkdir(parents=True, exist_ok=True)

    # --- actions reference ----------------------------------------------------
    acts = st_load_numpy(str(args.activations))
    if "ode.actions_final" not in acts:
        log.error("activations.safetensors missing 'ode.actions_final' key")
        return 2
    final = np.asarray(acts["ode.actions_final"], dtype=np.float32)
    if final.shape != (50, 32):
        log.error("expected ode.actions_final shape (50, 32), got %s",
                  final.shape)
        return 2
    actions_path = args.out_dir / "pi05-actions-ref.json"
    actions_path.write_text(json.dumps({
        "ode.actions_final": final.tolist(),
    }))
    log.info("wrote %s (%d bytes)", actions_path,
             actions_path.stat().st_size)

    # --- fixture inputs -------------------------------------------------------
    fx = st_load_numpy(str(args.fixture))
    required = ["fixture.images", "fixture.tokens", "fixture.mask",
                "fixture.noise"]
    missing = [k for k in required if k not in fx]
    if missing:
        log.error("fixture.safetensors missing keys: %s", missing)
        return 2

    images = np.asarray(fx["fixture.images"], dtype=np.float32)
    if images.shape != (3, 3, 224, 224):
        log.error("expected fixture.images shape (3, 3, 224, 224), got %s",
                  images.shape)
        return 2

    fixture_path = args.out_dir / "pi05-fixture.json"
    fixture_path.write_text(json.dumps({
        # Float32 little-endian bytes, base64'd. The mobile loader can
        # decode this into a Float32Array view without parsing
        # safetensors. Per-camera split happens consumer-side (same as
        # desktop pi05.test.js).
        "images_chw_f32_b64": base64.b64encode(
            images.tobytes(order="C")
        ).decode("ascii"),
        "tokens": np.asarray(fx["fixture.tokens"], dtype=np.int32).tolist(),
        "mask":   np.asarray(fx["fixture.mask"],   dtype=np.uint8).tolist(),
        # noise is shape (50, 32) in the safetensors fixture — flatten
        # to a 1-D 1600-element list so Float32Array.from(fixture.noise)
        # in the JS loader produces the expected length. Without the
        # reshape, .tolist() preserves the 2-D nesting; Float32Array
        # then treats each inner row as a scalar coercion and yields 50
        # NaNs, tripping the noise.length === 50*32 assertion in
        # pi05.test.js (caught on the Android Device Farm run
        # 26242250852 — Manual-69 logcat shows "actual: 50,
        # expected: 1600").
        "noise":  np.asarray(fx["fixture.noise"],  dtype=np.float32).reshape(-1).tolist(),
        # State exists in the fixture but pi05 ignores it (state is
        # tokenised into the prompt). Don't include it.
    }))
    log.info("wrote %s (%d bytes)", fixture_path,
             fixture_path.stat().st_size)

    return 0


if __name__ == "__main__":
    sys.exit(main())
