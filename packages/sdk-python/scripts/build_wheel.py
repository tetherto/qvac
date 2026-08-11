#!/usr/bin/env python3
"""Build the self-contained per-platform wheel: the thin client plus the
Bare runtime binary and the built SDK worker bundled under tetherto/qvac_sdk/_bundle/, so
`pip install` needs no separately-provisioned worker.

Usage:
  python3 scripts/build_wheel.py [--sdk-dir ../sdk] [--out dist/] [--plat-name <tag>]

Requires `bun run build` to have produced ../sdk/dist and the platform's
bare-runtime package under ../sdk/node_modules. The wheel is tagged
`py3-none-<platform>` for the current platform only (via hatch_build.py, driven
by the QVAC_WHEEL_PLAT this script exports); models are never bundled. Only the
current platform's native prebuilds are staged -- the addon npm packages ship
every platform's `prebuilds/<platform>-<arch>/`, so the foreign ones are pruned
here to keep each wheel to one platform's binaries. Publishing is release
automation's job (per-OS runners; see build-sdk-python-fat-wheels.yml) -- this
script only builds and verifies locally.
"""

from __future__ import annotations

import argparse
import os
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


def _prebuild_host() -> str:
    """The `<platform>-<arch>` prebuild directory for this host (e.g.
    `darwin-arm64`) -- the one Bare's `require.addon()` loads. Same suffix as the
    bare-runtime package name."""
    return bare_runtime_package().removeprefix("bare-runtime-")


def _stage_ignore(prebuild_host: str):
    """copytree ignore that drops the usual noise AND every addon `prebuilds/`
    subdir except this host's. The addon npm packages bundle all platforms'
    prebuilds in one package (~0.5 GB each, ~4.5 GB total); keeping only the
    target host's keeps each wheel to one platform's binaries and under GitHub's
    2 GB asset limit.

    Also drops non-runtime dirs the addon npm packages over-publish -- test
    fixtures especially (asr-ggml ships a 28 MB test audio .raw), plus
    docs/coverage/CI config. Native prebuilds and each addon's own weights/ are
    kept; the worker only imports from package entry points, never test/."""
    base = shutil.ignore_patterns(
        ".git",
        "node_modules",
        "example",
        "examples",
        "test",
        "tests",
        "__tests__",
        "testAssets",
        "test-assets",
        "fixtures",
        "__fixtures__",
        "benchmark",
        "benchmarks",
        "docs",
        "doc",
        "coverage",
        ".github",
    )

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored = set(base(directory, names))
        if os.path.basename(directory) == "prebuilds":
            for name in names:
                if name in ignored:
                    continue
                full = os.path.join(directory, name)
                # Keep `<host>` and same-host variants (`<host>-vulkan`, ...);
                # drop other platforms (linux-arm64, android-*, ios-*, ...).
                if os.path.isdir(full) and not (
                    name == prebuild_host or name.startswith(f"{prebuild_host}-")
                ):
                    ignored.add(name)
        return ignored

    return ignore


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
    # prebuilds/ dir, pruned to this host by _stage_ignore.
    listing = subprocess.run(
        ["npm", "ls", "--omit=dev", "--parseable", "--all"],
        cwd=sdk_dir,
        capture_output=True,
        text=True,
        check=False,  # npm ls exits non-zero on peer quirks; paths still print
    )
    ignore = _stage_ignore(_prebuild_host())
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
            ignore=ignore,
            symlinks=False,
        )
    (BUNDLE_DIR / "__init__.py").write_text("")


def _default_plat_name() -> str:
    """Portable-ish default wheel platform tag. No native Python C-extension is
    built (the platform code is the bundled Bare binary + node prebuilds), so the
    tag is a pure install gate: lower the macOS floor well below the build host
    so older macOS still installs. Linux/Windows fall back to the host tag; CI
    passes an explicit --plat-name (e.g. manylinux_2_35_x86_64) for release."""
    if platform.system() == "Darwin":
        arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        return f"macosx_11_0_{arch}"
    return sysconfig.get_platform().replace("-", "_").replace(".", "_")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk-dir", default=str(PACKAGE_ROOT.parent / "sdk"))
    parser.add_argument("--out", default=str(PACKAGE_ROOT / "dist"))
    parser.add_argument(
        "--plat-name",
        default=None,
        help="wheel platform tag (default: derived; CI passes e.g. "
        "manylinux_2_35_x86_64 / macosx_11_0_arm64 / win_amd64)",
    )
    args = parser.parse_args()

    plat_name = args.plat_name or _default_plat_name()
    stage_bundle(Path(args.sdk_dir).resolve())
    try:
        # hatch_build.py reads QVAC_WHEEL_PLAT and stamps `py3-none-<plat>`.
        env = {**os.environ, "QVAC_WHEEL_PLAT": plat_name}
        subprocess.run(
            [
                sys.executable,
                "-m",
                "build",
                "--wheel",
                "--outdir",
                args.out,
                str(PACKAGE_ROOT),
            ],
            check=True,
            env=env,
        )
    finally:
        shutil.rmtree(BUNDLE_DIR, ignore_errors=True)
    print(f"wheel written to {args.out} (tagged py3-none-{plat_name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
