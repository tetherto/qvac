"""Python port of packages/sdk/examples/runtime-capabilities.ts.

List the capability contracts the runtime provides, then check for the
contracts and majors this app was built against. `get_runtime_capabilities`
reads plugin registration only; it loads no model.

RUN: python examples/runtime_capabilities.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    CapabilityId,
    Client,
    GetRuntimeCapabilitiesRequest,
    get_runtime_capabilities,
)

# The contracts and majors this app was built against.
REQUIRED = [(CapabilityId.completion.value, 1), (CapabilityId.transcription.value, 1)]


async def main() -> int:
    async with Client() as client:
        response = await get_runtime_capabilities(
            client.transport, GetRuntimeCapabilitiesRequest()
        )

    print("▸ Capability contracts the runtime provides")
    for capability in response.capabilities:
        partial = (
            f"; only some plugins: {', '.join(capability.partial_operations)}"
            if capability.partial_operations
            else ""
        )
        operations = ", ".join(capability.operations)
        print(f"  {capability.id}@{capability.version}: {operations}{partial}")

    provided = {(c.id, c.version) for c in response.capabilities}
    missing = [
        f"{name}@{version}"
        for name, version in REQUIRED
        if (name, version) not in provided
    ]
    if missing:
        print(f"✖ Missing: {', '.join(missing)}", file=sys.stderr)
        return 1

    print("\n▸ Every required contract is available.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
