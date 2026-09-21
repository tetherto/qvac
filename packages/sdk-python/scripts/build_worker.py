#!/usr/bin/env python3
"""Ensure a built QVAC SDK worker exists for the real-worker tests/examples.

The real-worker tests (`test_bare_rpc_transport.py`, the poc tests, the
conformance corpus, the orchestrate e2e) and every example spawn a real worker
from the sibling `@qvac/sdk` package's `dist/src/worker/index.js`. That file is a
build artifact -- if it's missing the tests skip themselves, which silently
hides real integration coverage (notably in CI). This script builds it so they
actually run.

Idempotent: does nothing if the worker already exists, unless `--force`.

    python3 scripts/build_worker.py            # build if missing
    python3 scripts/build_worker.py --force     # rebuild
    python3 scripts/build_worker.py --print     # just print the worker path

Honors `QVAC_POC_SDK_DIR` (same override the tests read) to point at a
different `@qvac/sdk` checkout; defaults to the monorepo sibling `../sdk`.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SDK_DIR = PACKAGE_ROOT.parent / "sdk"


def sdk_dir() -> Path:
    return Path(os.environ.get("QVAC_POC_SDK_DIR", str(DEFAULT_SDK_DIR))).resolve()


def worker_path(sdk: Path) -> Path:
    return sdk / "dist" / "src" / "worker" / "index.js"


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"▸ {' '.join(cmd)}  (in {cwd})", file=sys.stderr)
    subprocess.run(cmd, cwd=cwd, check=True)


def links_workspace_inference(sdk: Path) -> bool:
    """Whether the sibling engine can be linked into this SDK checkout.

    The directory alone is not enough: QVAC_POC_SDK_DIR can point at a checkout
    with `packages/inference` but no script to link it.
    """
    if not (sdk.parent / "inference").is_dir():
        return False
    try:
        pkg = json.loads((sdk / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(pkg, dict):
        return False
    deps = pkg.get("dependencies")
    scripts = pkg.get("scripts")
    return (
        isinstance(deps, dict)
        and isinstance(scripts, dict)
        and "@qvac/inference" in deps
        and "sdk-source:workspace" in scripts
    )


def build(sdk: Path, *, force: bool) -> Path:
    worker = worker_path(sdk)
    if worker.exists() and not force:
        print(f"▸ worker already built: {worker}", file=sys.stderr)
        return worker
    if not sdk.exists():
        raise SystemExit(
            f"SDK checkout not found at {sdk}. Set QVAC_POC_SDK_DIR to a "
            "@qvac/sdk checkout, or run from the monorepo."
        )
    # `bun run build` is lint + tsc + alias resolution; run the worker-producing
    # steps directly so a build here doesn't depend on the SDK's lint passing
    # (the SDK has its own lint CI). `bun install` pulls the addon prebuilds.
    #
    # Compile against the sibling engine where there is one: the published
    # release lags the engine API the SDK source already consumes.
    if links_workspace_inference(sdk):
        # The helper rewrites the manifest and leaves it rewritten. Restoring is
        # safe: node_modules keeps the link, so tsc still gets the workspace engine.
        manifest = sdk / "package.json"
        saved = manifest.read_text(encoding="utf-8")
        try:
            _run(["bun", "run", "sdk-source:workspace"], sdk)
        finally:
            manifest.write_text(saved, encoding="utf-8")
    else:
        _run(["bun", "install"], sdk)
    # bun/npm don't reliably set the exec bit on the prebuilt Bare binary, and
    # the client execs it directly (node_modules/bare-runtime-<plat>/bin/bare),
    # so it fails with EACCES on Linux CI. Make every installed bare runnable.
    for bare in glob.glob(
        str(sdk / "node_modules" / "bare-runtime-*" / "bin" / "bare")
    ):
        os.chmod(bare, 0o755)
    _run(["bunx", "tsc", "--project", "tsconfig.json"], sdk)
    _run(["bunx", "tsc-alias", "-p", "tsconfig.alias.json"], sdk)
    if not worker.exists():
        raise SystemExit(f"build finished but {worker} is still missing")
    print(f"▸ built worker: {worker}", file=sys.stderr)
    return worker


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="rebuild even if present")
    parser.add_argument(
        "--print", action="store_true", dest="print_only", help="print path, no build"
    )
    args = parser.parse_args()

    sdk = sdk_dir()
    if args.print_only:
        print(worker_path(sdk))
        return 0
    build(sdk, force=args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
