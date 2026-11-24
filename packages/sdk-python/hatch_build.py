"""Hatchling build hook for the source package and the wheel.

Both carry the generated client, which is gitignored and written by
scripts/generate.py, so the hook refuses to build a release package without it.
Beside packages/sdk, the hook also exports the SDK contract and refuses a client
generated from a different one. A build from the source package has no SDK
beside it and packages the client it carries. An editable install builds without
the client: it points at src/, which the generator fills in place.

By default this package builds a pure-Python `py3-none-any` wheel -- the thin
client published to PyPI. scripts/build_wheel.py stages bare-stow's Python
package for the worker, bundled for one platform, under
src/tetherto/qvac_sdk/_worker/ and exports QVAC_WHEEL_PLAT with the target
platform tag; this hook then marks the wheel non-pure and stamps
`py3-none-<plat>`, so pip installs the fat wheel only on the matching OS/arch
and prefers it over the `any` thin wheel there. No native Python extension is
compiled (the platform-specific code is the bundled addons), so the ABI stays
`none` and one wheel serves every Python 3 on that platform.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

GENERATED_DIR = Path("src") / "tetherto" / "qvac_sdk" / "_generated"


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if version != "editable":
            self.require_current_client()
        plat = os.environ.get("QVAC_WHEEL_PLAT")
        if self.target_name != "wheel" or not plat:
            return
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{plat}"

    def require_current_client(self) -> None:
        root = Path(self.root)
        generated = root / GENERATED_DIR
        if not (generated / "__init__.py").exists():
            raise RuntimeError(
                "The generated client is missing. Run 'python scripts/generate.py' first."
            )
        if not (root.parent / "sdk" / "package.json").exists():
            return
        spec = importlib.util.spec_from_file_location(
            "generate", root / "scripts" / "generate.py"
        )
        assert spec is not None and spec.loader is not None
        generate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generate)
        generate.export_contract()
        recorded = generated / generate.CONTRACT_DIGEST_NAME
        if not recorded.exists() or recorded.read_text(encoding="utf-8").strip() != (
            generate.contract_digest()
        ):
            raise RuntimeError(
                "The generated client is older than the SDK contract. "
                "Run 'python scripts/generate.py' first."
            )
