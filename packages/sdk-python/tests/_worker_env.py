"""Shared worker for the real-worker tests.

Resolves in two modes, with no environment toggle, so the same suite runs both
in a dev checkout and against an installed self-contained wheel:

1. If the imported ``tetherto.qvac_sdk`` carries a bundled worker (a fat wheel
   staged by scripts/build_wheel.py under ``_worker/``), use it -- so
   ``pip install <fat wheel>`` can be exercised end-to-end with no
   ``@qvac/sdk`` checkout. A source/editable install has no ``_worker``, so this
   branch never triggers in dev.
2. Otherwise the monorepo sibling ``@qvac/sdk`` at ``../sdk`` (honoring
   ``QVAC_POC_SDK_DIR``), built by scripts/build_worker.py and run without a
   bundle -- the dev flow.

Either way the Bare runtime is the ``bare-sidecar`` wheel's. ``SDK_DIR`` (the
sibling checkout) is always exported: the e2e fixtures some tests read
(conformance cases, audio/image assets) live in the checkout, never in a wheel.
"""

from __future__ import annotations

import os
from pathlib import Path

from tetherto.qvac_sdk.client import BundledWorker, UnbundledWorker, _harness_in

# The sibling @qvac/sdk checkout: source of the dev worker AND of e2e fixtures
# that are never bundled in a wheel.
SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)


def _bundled_harness() -> Path | None:
    """The installed fat wheel's bundled worker harness, or None when this
    install has no bundle (a source/editable install -- the dev case)."""
    try:
        import tetherto.qvac_sdk as pkg
    except ImportError:
        return None
    if not getattr(pkg, "__file__", None):
        return None
    return _harness_in(Path(pkg.__file__).resolve().parent / "_worker")


_HARNESS = _bundled_harness()
_WORKER_DIR = Path(SDK_DIR) / "dist" / "src" / "worker"

WORKER: BundledWorker | UnbundledWorker
if _HARNESS is not None:
    WORKER = BundledWorker(_HARNESS)
    # The folder Client(worker_path=...) starts through its harness.
    WORKER_PATH = str(_HARNESS.parent)
    WORKER_AVAILABLE = True
else:
    WORKER = UnbundledWorker(
        _WORKER_DIR / "unbundled-shim.js", _WORKER_DIR / "index.js"
    )
    WORKER_PATH = str(WORKER.entry)
    # Real-worker tests need a built worker and its shim.
    WORKER_AVAILABLE = WORKER.entry.exists() and WORKER.shim.exists()
