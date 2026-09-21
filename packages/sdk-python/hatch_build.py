"""Hatchling build hook that stamps a single-platform wheel tag when a bundled
Bare runtime + worker is staged under _bundle/.

By default this package builds a pure-Python `py3-none-any` wheel -- the thin
client published to PyPI. scripts/build_wheel.py stages the platform Bare
runtime + built worker under src/tetherto/qvac_sdk/_bundle/ and exports
QVAC_WHEEL_PLAT with the target platform tag; this hook then marks the wheel
non-pure and stamps `py3-none-<plat>`, so pip installs the fat wheel only on the
matching OS/arch and prefers it over the `any` thin wheel there. No native
Python extension is compiled (the platform-specific code is the bundled Bare
binary + node prebuilds), so the ABI stays `none` and one wheel serves every
Python 3 on that platform.

Without QVAC_WHEEL_PLAT set (the normal PyPI build) the hook is inert and the
wheel stays pure `py3-none-any`.
"""

from __future__ import annotations

import os
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        plat = os.environ.get("QVAC_WHEEL_PLAT")
        if not plat:
            return
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{plat}"
