"""Python port of packages/sdk/examples/plugins.ts (plugin invocation).

The low-level plugin API. A model's `modelType` selects a plugin; each plugin
exposes named `handler`s with their own request/response schemas.
`invoke_plugin(t, model_id, handler, params)` runs one handler and returns its
result; `invoke_plugin_stream(...)` yields streamed chunks.

This example uses the `custom-echo-plugin` fixture (modelType `echo`), whose
handlers are `echo` ({message} -> {message}) and `echoStream` ({message} ->
{chunk} chunks). To run it you need a worker bundled with that plugin; point
the loader at it via argv, or adapt the handler/params to your own plugin.
(A production model that exposes handlers is VLA — see vla.py, which drives the
`vlaRun` / `vlaHparams` handlers through typed wrappers.)

RUN: python examples/plugins.py [model-src]
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import (
    Client,
    invoke_plugin,
    invoke_plugin_stream,
    load_model,
    unload_model,
)


async def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python examples/plugins.py <model-src>\n"
            "  <model-src> must resolve to a model whose plugin exposes the "
            "'echo'/'echoStream' handlers (the custom-echo-plugin fixture).",
            file=sys.stderr,
        )
        return 1
    model_src = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading plugin-backed model...")
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="echo",
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print("\n▸ 1. invoke_plugin (request/reply handler 'echo')")
            result = await invoke_plugin(
                t, model_id, "echo", params={"message": "hello from the python sdk"}
            )
            print(f"▸ echo -> {result}")

            print("\n▸ 2. invoke_plugin_stream (streaming handler 'echoStream')")
            print("▸ chunks: ", end="")
            async for chunk in invoke_plugin_stream(
                t, model_id, "echoStream", params={"message": "streamed message"}
            ):
                sys.stdout.write(str(getattr(chunk, "chunk", chunk)))
                sys.stdout.flush()
            print()

            await unload_model(t, model_id)
            print("▸ Model unloaded")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
