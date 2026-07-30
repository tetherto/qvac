"""Shared, platform-aware worker/bare paths for the real-worker tests.

The Bare runtime ships as a per-platform package (`bare-runtime-linux-x64`,
`bare-runtime-darwin-arm64`, …), so the binary path must be resolved at runtime
rather than hardcoded — otherwise tests that pass on one OS error out on CI's
linux runner. `SDK_DIR` defaults to the monorepo sibling `../sdk` and honors
`QVAC_POC_SDK_DIR`.
"""

from __future__ import annotations

import glob
import os
from pathlib import Path

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)
WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")


def _resolve_bare_bin() -> str:
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


BARE_BIN = _resolve_bare_bin()

# Real-worker tests need both a built worker and a Bare runtime to spawn it.
WORKER_AVAILABLE = os.path.exists(WORKER_PATH) and os.path.exists(BARE_BIN)
