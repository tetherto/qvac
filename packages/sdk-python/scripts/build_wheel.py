#!/usr/bin/env python3
"""Build the self-contained per-platform wheel: the thin client plus the SDK
worker, bundled by bare-stow under tetherto/qvac_sdk/_worker/, so `pip install`
needs no separately-provisioned worker.

Usage:
  python3 scripts/build_wheel.py [--sdk-dir ../sdk] [--out-dir dist/] [--platform <tag>]

Requires `npm run build` to have produced ../sdk/dist, and ../sdk/node_modules
installed. bare-stow writes its `bare-sidecar` package for Python: the worker
with every built-in plugin, bundled for this host with the native addons it
loads, and the `start()` that runs it on the Bare runtime of the `bare-sidecar`
wheel. The wheel is tagged `py3-none-<platform>` for the current platform only
(via hatch_build.py, driven by the QVAC_WHEEL_PLAT this script exports); models
are never bundled. Publishing is release automation's job (per-OS runners; see
build-sdk-python-fat-wheels.yml) -- this script only builds and verifies
locally.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
BUNDLE_DIR = PACKAGE_ROOT / "src" / "tetherto" / "qvac_sdk" / "_worker"


def stage_bundle(sdk_dir: Path) -> None:
    """Write bare-stow's Python package for the worker to BUNDLE_DIR. The bundle
    is build-time-only staging: it's gitignored, and the thin (unbundled) wheel
    simply builds without it present."""
    if not (sdk_dir / "dist" / "src" / "commands" / "index.js").exists():
        raise SystemExit(f"no built SDK at {sdk_dir} -- run `npm run build` in it")

    shutil.rmtree(BUNDLE_DIR, ignore_errors=True)
    with tempfile.TemporaryDirectory() as staging:
        out = Path(staging) / "qvac_worker"
        # Resolve node explicitly: on Windows subprocess can't launch a bare
        # name that only resolves through the shell.
        node = shutil.which("node") or "node"
        subprocess.run(
            [
                node,
                str(PACKAGE_ROOT / "scripts" / "bundle_worker.mjs"),
                str(sdk_dir),
                str(out),
            ],
            check=True,
        )
        # bare-stow writes the Python package inside its output folder, next to
        # a pyproject.toml of its own that this wheel replaces.
        shutil.copytree(out / "qvac_worker", BUNDLE_DIR)


def _default_platform_tag() -> str:
    """Portable-ish default wheel platform tag. No native Python C-extension is
    built (the platform code is the bundled addons), so the tag is a pure
    install gate, matching the macOS floor of the `bare-sidecar` wheel.
    Linux/Windows fall back to the host tag; CI passes an explicit --platform
    (e.g. manylinux_2_35_x86_64) for release."""
    if platform.system() == "Darwin":
        arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        return f"macosx_13_0_{arch}"
    return sysconfig.get_platform().replace("-", "_").replace(".", "_")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sdk-dir",
        default=str(PACKAGE_ROOT.parent / "sdk"),
        help="built @qvac/sdk checkout to bundle (needs dist/ + node_modules/)",
    )
    parser.add_argument(
        "--out-dir",
        default=str(PACKAGE_ROOT / "dist"),
        help="directory to write the built wheel into (default: ./dist)",
    )
    parser.add_argument(
        "--platform",
        default=None,
        help="PEP 425 wheel platform tag to stamp, e.g. macosx_13_0_arm64 / "
        "manylinux_2_35_x86_64 / win_amd64 (default: derived from this host)",
    )
    args = parser.parse_args()

    platform_tag = args.platform or _default_platform_tag()
    stage_bundle(Path(args.sdk_dir).resolve())
    try:
        # hatch_build.py reads QVAC_WHEEL_PLAT and stamps `py3-none-<tag>`.
        env = {**os.environ, "QVAC_WHEEL_PLAT": platform_tag}
        subprocess.run(
            [
                sys.executable,
                "-m",
                "build",
                "--wheel",
                "--outdir",
                args.out_dir,
                str(PACKAGE_ROOT),
            ],
            check=True,
            env=env,
        )
    finally:
        shutil.rmtree(BUNDLE_DIR, ignore_errors=True)
    print(f"wheel written to {args.out_dir} (tagged py3-none-{platform_tag})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
