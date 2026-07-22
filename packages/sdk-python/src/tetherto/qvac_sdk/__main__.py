"""`python -m tetherto.qvac_sdk install-worker` — fetch the pinned `@qvac/sdk`
worker via npm into a version-scoped cache dir, so a thin install can start a
worker without a bundled wheel or a checkout. Requires node/npm.
"""

from __future__ import annotations

import subprocess
import sys

from ._generated.sdk_version import SDK_VERSION
from .client import managed_worker_prefix


def install_worker() -> int:
    prefix = managed_worker_prefix()
    prefix.mkdir(parents=True, exist_ok=True)
    spec = f"@qvac/sdk@{SDK_VERSION}"
    print(f"Installing {spec} into {prefix} ...")
    try:
        result = subprocess.run(
            ["npm", "install", spec, "--prefix", str(prefix), "--omit=dev"]
        )
    except FileNotFoundError:
        print(
            "npm was not found. Install Node.js/npm, or install the worker "
            f"globally yourself:\n  npm install -g {spec}",
            file=sys.stderr,
        )
        return 1
    if result.returncode == 0:
        print(f"Installed. `Client()` will now resolve the {SDK_VERSION} worker.")
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args == ["install-worker"]:
        return install_worker()
    print("usage: python -m tetherto.qvac_sdk install-worker", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
