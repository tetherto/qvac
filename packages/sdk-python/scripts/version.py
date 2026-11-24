"""The @qvac/sdk version this package carries, for hatchling's `code` version source.

In the monorepo it is packages/sdk/package.json's. A source package has no SDK beside it, so there it is the generated
module's, which the generator stamped from that same package.json.
"""

import json
import re
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SDK_PACKAGE_JSON = PACKAGE_ROOT.parent / "sdk" / "package.json"
GENERATED_VERSION = (
    PACKAGE_ROOT / "src" / "tetherto" / "qvac_sdk" / "_generated" / "sdk_version.py"
)

if SDK_PACKAGE_JSON.exists():
    VERSION = json.loads(SDK_PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
else:
    match = re.search(
        r'SDK_VERSION = "([^"]+)"', GENERATED_VERSION.read_text(encoding="utf-8")
    )
    assert match, f"{GENERATED_VERSION} carries no SDK_VERSION"
    VERSION = match.group(1)
