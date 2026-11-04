"""Python port of packages/sdk/examples/profiling/per-call.ts.

Profile individual `embed()` calls with the per-call `__profiling` envelope.

The JS SDK's process-wide `profiler` object (enable/disable, aggregation,
`exportSummary()`) is intentionally not ported to Python. The per-call path
is: `profiled_call()` from `tetherto.qvac_sdk.profiling` wraps one call and
returns its `ProfilingReport`, which this example prints in place of the JS
summary. The explicitly disabled call sends the `{"enabled": False}` meta, as
the JS `profiling: { enabled: false }` option does.

RUN: python examples/profiling_per_call.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    EmbedRequest,
    EmbedResponse,
    embed,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import GTE_LARGE_FP16
from tetherto.qvac_sdk.profiling import (
    create_profiling_disabled_meta,
    inject_profiling_meta,
    profiled_call,
    strip_profiling_meta,
)


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


def embed_payload(model_id: str, text: str) -> dict:
    request = EmbedRequest.model_validate(
        {"type": "embed", "modelId": model_id, "text": text}
    )
    return request.model_dump(mode="json", by_alias=True, exclude_unset=True)


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t, model_src=GTE_LARGE_FP16, on_progress=print_progress
            )
            print(f"▸ Model loaded: {model_id}")

            print("\n▸ Embed with per-call profiling")
            response, report = await profiled_call(
                t,
                embed_payload(model_id, "Profile this specific call"),
                include_server_breakdown=True,
            )
            embedding1 = EmbedResponse.model_validate(response).embedding
            print(f"▸ Embedding dimensions: {len(embedding1)}")

            print("\n▸ Embed without profiling")
            embedding2 = (
                await embed(
                    t,
                    EmbedRequest.model_validate(
                        {
                            "type": "embed",
                            "modelId": model_id,
                            "text": "This call is not profiled",
                        }
                    ),
                )
            ).embedding
            print(f"▸ Embedding dimensions: {len(embedding2)}")

            print("\n▸ Embed with profiling explicitly disabled")
            response = await t.call(
                inject_profiling_meta(
                    embed_payload(
                        model_id, "Profiling explicitly disabled for this call"
                    ),
                    create_profiling_disabled_meta(),
                )
            )
            embedding3 = EmbedResponse.model_validate(
                strip_profiling_meta(response)
            ).embedding
            print(f"▸ Embedding dimensions: {len(embedding3)}")

            await unload_model(t, model_id)

            print("\n▸ Profiling report (per-call data only)")
            print(f"  request: {report.request_type}")
            print(f"  total: {report.total_ms:.1f} ms")
            print(f"  server: {report.server}")
            print(f"  operation: {report.operation}")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
