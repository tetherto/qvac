#!/usr/bin/env python3
"""Ensure a built QVAC SDK worker exists for the real-worker tests/examples.

The real-worker tests (`test_bare_rpc_transport.py`, the poc tests, the
conformance corpus, the orchestrate e2e) and every example spawn a real worker
from the sibling `@qvac/sdk` package's `dist/server/worker.js`. That file is a
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
import os
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SDK_DIR = PACKAGE_ROOT.parent / "sdk"


def sdk_dir() -> Path:
    return Path(os.environ.get("QVAC_POC_SDK_DIR", str(DEFAULT_SDK_DIR))).resolve()


def worker_path(sdk: Path) -> Path:
    return sdk / "dist" / "server" / "worker.js"


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"▸ {' '.join(cmd)}  (in {cwd})", file=sys.stderr)
    subprocess.run(cmd, cwd=cwd, check=True)


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
    _run(["bun", "install"], sdk)
    # bun/npm don't reliably set the exec bit on the prebuilt Bare binary, and
    # the client execs it directly (node_modules/bare-runtime-<plat>/bin/bare),
    # so it fails with EACCES on Linux CI. Make every installed bare runnable.
    for bare in glob.glob(
        str(sdk / "node_modules" / "bare-runtime-*" / "bin" / "bare")
    ):
        os.chmod(bare, 0o755)
    _run(["bunx", "tsc", "--project", "tsconfig.json"], sdk)
    _run(["node", "scripts/resolve-aliases.mjs"], sdk)
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
