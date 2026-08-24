#!/usr/bin/env python3
"""Build the self-contained per-platform wheel: the thin client plus the
Bare runtime binary and the built SDK worker bundled under tetherto/qvac_sdk/_bundle/, so
`pip install` needs no separately-provisioned worker.

Usage:
  python3 scripts/build_wheel.py [--sdk-dir ../sdk] [--out-dir dist/] [--platform <tag>]

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


# Non-runtime dirs the addon npm packages over-publish. Dropped ONLY at a
# package root, never nested -- so a runtime dir that happens to be named e.g.
# `test`/`benchmark` inside another package's src/ or dist/ (zod/src/.../tests,
# tinyld/dist/benchmark) is kept. Validated against the production closure: every
# match with real size is a root-level `<pkg>/test` (asr-ggml, decoder-audio, ...).
_ROOT_ONLY_DROP = frozenset(
    {
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
    }
)


def _stage_ignore(package_root: Path, prebuild_host: str):
    """copytree ignore for a single addon package.

    - `.git` and nested `node_modules` are dropped at any depth (structural;
      nested deps are copied separately from the npm ls listing).
    - The `_ROOT_ONLY_DROP` non-runtime dirs are dropped only when they are a
      direct child of this package's root, so a package's own internals are never
      reached into.
    - Every `prebuilds/<host>/` except this host's is dropped (the npm packages
      bundle all platforms, ~4.5 GB total; keeping one host keeps each wheel small
      and under GitHub's 2 GB asset limit). Each addon's own weights/ are kept."""
    root = os.path.abspath(package_root)

    def ignore(directory: str, names: list[str]) -> set[str]:
        here = os.path.abspath(directory)
        ignored = {n for n in names if n in (".git", "node_modules")}
        if here == root:
            ignored.update(
                n
                for n in names
                if n in _ROOT_ONLY_DROP and os.path.isdir(os.path.join(directory, n))
            )
        # `prebuilds/` sits at the package root; host-prune only that one.
        if os.path.basename(here) == "prebuilds" and os.path.dirname(here) == root:
            for name in names:
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
    if not (worker / "src" / "worker" / "index.js").exists():
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
    # Resolve npm explicitly: on Windows it is `npm.cmd`, which subprocess can't
    # launch from the bare name "npm" (WinError 2) without shell resolution.
    npm = shutil.which("npm") or "npm"
    listing = subprocess.run(
        [npm, "ls", "--omit=dev", "--parseable", "--all"],
        cwd=sdk_dir,
        capture_output=True,
        text=True,
        check=False,  # npm ls exits non-zero on peer quirks; paths still print
    )
    host = _prebuild_host()
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
        # Per-package ignore so the non-runtime-dir prune is scoped to each
        # package's own root, not applied at every nested level.
        shutil.copytree(
            path,
            destination,
            ignore=_stage_ignore(path, host),
            symlinks=False,
        )
    (BUNDLE_DIR / "__init__.py").write_text("")


def _default_platform_tag() -> str:
    """Portable-ish default wheel platform tag. No native Python C-extension is
    built (the platform code is the bundled Bare binary + node prebuilds), so the
    tag is a pure install gate: lower the macOS floor well below the build host
    so older macOS still installs. Linux/Windows fall back to the host tag; CI
    passes an explicit --platform (e.g. manylinux_2_35_x86_64) for release."""
    if platform.system() == "Darwin":
        arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        return f"macosx_11_0_{arch}"
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
        help="PEP 425 wheel platform tag to stamp, e.g. macosx_11_0_arm64 / "
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
