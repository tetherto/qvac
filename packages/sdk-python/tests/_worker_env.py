"""Shared, platform-aware worker/bare paths for the real-worker tests.

Resolves in two modes, with no environment toggle, so the same suite runs both
in a dev checkout and against an installed self-contained wheel:

1. If the imported ``tetherto.qvac_sdk`` carries a bundled SDK (a fat wheel
   staged by scripts/build_wheel.py under ``_bundle/worker/``), use it -- so
   ``pip install <fat wheel>`` can be exercised end-to-end with no
   ``@qvac/sdk`` checkout. A source/editable install has no ``_bundle``, so this
   branch never triggers in dev.
2. Otherwise the monorepo sibling ``@qvac/sdk`` at ``../sdk`` (honoring
   ``QVAC_POC_SDK_DIR``), built by scripts/build_worker.py -- the dev flow.

The Bare runtime is bare-sidecar's, under
``node_modules/bare-sidecar/prebuilds/<platform>-<arch>/``. ``SDK_DIR`` (the
sibling checkout) is always exported: the e2e fixtures some tests read
(conformance cases, audio/image assets) live in the checkout, never in a wheel.
"""

from __future__ import annotations

import os
from pathlib import Path

from tetherto.qvac_sdk.client import _sidecar_bare

# The sibling @qvac/sdk checkout: source of the dev worker AND of e2e fixtures
# that are never bundled in a wheel.
SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)


def _bundled_sdk() -> Path | None:
    """The installed fat wheel's bundled SDK, or None when this install has no
    bundle (a source/editable install -- the dev case)."""
    try:
        import tetherto.qvac_sdk as pkg
    except ImportError:
        return None
    if not getattr(pkg, "__file__", None):
        return None
    sdk = Path(pkg.__file__).resolve().parent / "_bundle" / "worker"
    if (sdk / "dist" / "src" / "worker" / "index.js").exists():
        return sdk
    return None


_SDK = _bundled_sdk() or Path(SDK_DIR)
BARE_BIN = str(_sidecar_bare(_SDK))
SHIM_PATH = str(_SDK / "dist" / "src" / "worker" / "tcp-shim.js")
WORKER_PATH = str(_SDK / "dist" / "src" / "worker" / "index.js")
WORKER_COMMAND = [BARE_BIN, SHIM_PATH, WORKER_PATH]

# Real-worker tests need a built worker, its shim and a Bare runtime to spawn it.
WORKER_AVAILABLE = all(os.path.exists(path) for path in WORKER_COMMAND)
