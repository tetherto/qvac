"""Shared, platform-aware worker/bare paths for the real-worker tests.

Resolves in two modes, with no environment toggle, so the same suite runs both
in a dev checkout and against an installed self-contained wheel:

1. If the imported ``tetherto.qvac_sdk`` carries a bundled worker + Bare runtime
   (a fat wheel staged by scripts/build_wheel.py under ``_bundle/``), use those
   -- so ``pip install <fat wheel>`` can be exercised end-to-end with no
   ``@qvac/sdk`` checkout. A source/editable install has no ``_bundle``, so this
   branch never triggers in dev.
2. Otherwise the monorepo sibling ``@qvac/sdk`` at ``../sdk`` (honoring
   ``QVAC_POC_SDK_DIR``), built by scripts/build_worker.py -- the dev flow,
   unchanged.

The Bare runtime ships as a per-platform package (`bare-runtime-linux-x64`,
`bare-runtime-darwin-arm64`, …), so the sibling binary is resolved at runtime
rather than hardcoded. ``SDK_DIR`` (the sibling checkout) is always exported: the
e2e fixtures some tests read (conformance cases, audio/image assets) live in the
checkout, never in a wheel.
"""

from __future__ import annotations

import glob
import os
from pathlib import Path

# The sibling @qvac/sdk checkout: source of the dev worker AND of e2e fixtures
# that are never bundled in a wheel.
SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)


def _bundled_worker_and_bare() -> tuple[str, str] | None:
    """(bare, worker) from an installed fat wheel's ``_bundle/``, or None when
    this install has no bundle (a source/editable install -- the dev case)."""
    try:
        import tetherto.qvac_sdk as pkg
    except ImportError:
        return None
    if not getattr(pkg, "__file__", None):
        return None
    bundle = Path(pkg.__file__).resolve().parent / "_bundle"
    worker = bundle / "worker" / "dist" / "server" / "worker.js"
    bare = bundle / "runtime" / ("bare.exe" if os.name == "nt" else "bare")
    if worker.exists() and bare.exists():
        return str(bare), str(worker)
    return None


def _sibling_bare_bin() -> str:
    bin_glob = os.path.join(SDK_DIR, "node_modules", "bare-runtime-*", "bin")
    # `bare` on Unix, `bare.exe` on Windows -- match both so the Windows CI leg
    # resolves a real binary instead of silently skipping every real-worker test.
    matches = sorted(
        glob.glob(os.path.join(bin_glob, "bare"))
        + glob.glob(os.path.join(bin_glob, "bare.exe"))
    )
    # Missing sentinel keeps this importable when Bare isn't installed; the
    # WORKER_AVAILABLE guard below turns that into a skip, not an error.
    return (
        matches[0]
        if matches
        else os.path.join(
            SDK_DIR, "node_modules", "bare-runtime-missing", "bin", "bare"
        )
    )


_bundled = _bundled_worker_and_bare()
if _bundled is not None:
    BARE_BIN, WORKER_PATH = _bundled
else:
    BARE_BIN = _sibling_bare_bin()
    WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")

# Real-worker tests need both a built worker and a Bare runtime to spawn it.
WORKER_AVAILABLE = os.path.exists(WORKER_PATH) and os.path.exists(BARE_BIN)
