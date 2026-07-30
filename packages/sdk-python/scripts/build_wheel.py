#!/usr/bin/env python3
"""Build the self-contained per-platform wheel: the thin client plus the
Bare runtime binary and the built SDK worker bundled under tetherto/qvac_sdk/_bundle/, so
`pip install` needs no separately-provisioned worker.

Usage:
  python3 scripts/build_wheel.py [--sdk-dir ../sdk] [--out dist/]

Requires `bun run build` to have produced ../sdk/dist and the platform's
bare-runtime package under ../sdk/node_modules. The wheel is tagged for the
current platform only (py3-none-<platform>); models are never bundled.
Publishing is release automation's job (cibuildwheel-style per-OS runners) --
this script only builds and verifies locally.
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
BUNDLE_DIR = PACKAGE_ROOT / "src" / "tetherto" / "qvac_sdk" / "_bundle"

_BARE_PACKAGE_BY_PLATFORM = {
    ("Darwin", "arm64"): "bare-runtime-darwin-arm64",
    ("Darwin", "x86_64"): "bare-runtime-darwin-x64",
    ("Linux", "x86_64"): "bare-runtime-linux-x64",
    ("Linux", "aarch64"): "bare-runtime-linux-arm64",
    ("Windows", "AMD64"): "bare-runtime-win32-x64",
}


def bare_runtime_package() -> str:
    key = (platform.system(), platform.machine())
    package = _BARE_PACKAGE_BY_PLATFORM.get(key)
    if package is None:
        raise SystemExit(f"unsupported platform for a bundled wheel: {key}")
    return package


def stage_bundle(sdk_dir: Path) -> None:
    """Copy the worker dist and the platform Bare runtime into the package
    tree. The bundle is build-time-only staging: it's gitignored, and the
    thin (unbundled) wheel simply builds without it present."""
    worker = sdk_dir / "dist"
    if not (worker / "server" / "worker.js").exists():
        raise SystemExit(
            f"no built worker at {worker} -- run `bun run build` in {sdk_dir}"
        )
    bare_pkg = sdk_dir / "node_modules" / bare_runtime_package()
    bare_bin = (
        bare_pkg / "bin" / ("bare.exe" if platform.system() == "Windows" else "bare")
    )
    if not bare_bin.exists():
        raise SystemExit(f"no Bare runtime binary at {bare_bin}")

    if BUNDLE_DIR.exists():
        shutil.rmtree(BUNDLE_DIR)
    (BUNDLE_DIR / "runtime").mkdir(parents=True)
    shutil.copytree(worker, BUNDLE_DIR / "worker" / "dist")
    # The worker dist is ESM; without the package.json that declares
    # `"type": "module"` above it, Bare loads .js files as CJS and dies on
    # the first import statement.
    shutil.copy2(sdk_dir / "package.json", BUNDLE_DIR / "worker" / "package.json")
    shutil.copy2(bare_bin, BUNDLE_DIR / "runtime" / bare_bin.name)
    # Runtime deps the worker resolves via Bare's node_modules walk-up, so
    # they must live at worker/node_modules exactly. Only the production
    # dependency closure ships (dev deps like electron would balloon the
    # wheel by gigabytes); native prebuilds ride inside each package's
    # prebuilds/ dir.
    listing = subprocess.run(
        ["npm", "ls", "--omit=dev", "--parseable", "--all"],
        cwd=sdk_dir,
        capture_output=True,
        text=True,
        check=False,  # npm ls exits non-zero on peer quirks; paths still print
    )
    node_modules = sdk_dir / "node_modules"
    dest_root = BUNDLE_DIR / "worker" / "node_modules"
    for line in sorted(set(listing.stdout.splitlines())):
        path = Path(line)
        if node_modules not in path.parents:
            continue
        relative = path.relative_to(node_modules)
        if relative.parts[0].startswith("bare-runtime-"):
            continue
        destination = dest_root / relative
        if destination.exists():
            continue
        shutil.copytree(
            path,
            destination,
            ignore=shutil.ignore_patterns(".git", "node_modules", "example*"),
            symlinks=False,
        )
    (BUNDLE_DIR / "__init__.py").write_text("")


def platform_tag() -> str:
    # e.g. macosx_15_0_arm64 / manylinux-ish local tag; good enough for a
    # locally-verified per-platform wheel (release runners refine tags).
    return sysconfig.get_platform().replace("-", "_").replace(".", "_")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk-dir", default=str(PACKAGE_ROOT.parent / "sdk"))
    parser.add_argument("--out", default=str(PACKAGE_ROOT / "dist"))
    args = parser.parse_args()

    stage_bundle(Path(args.sdk_dir).resolve())
    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "build",
                "--wheel",
                "--outdir",
                args.out,
                f"--config-setting=--build-option=--plat-name={platform_tag()}",
                str(PACKAGE_ROOT),
            ],
            check=True,
        )
    finally:
        shutil.rmtree(BUNDLE_DIR, ignore_errors=True)
    print(f"wheel written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
