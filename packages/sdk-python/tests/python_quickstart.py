#!/usr/bin/env python3
"""Python port of packages/sdk/examples/quickstart.ts, as close to the JS
shape as the current typed surface allows: load a model (with progress),
run a streaming completion, unload the model.

Asyncio-native, matching the JS SDK's Promises/async iterators. The one
remaining structural difference from the JS version: loadModel there takes
an onProgress *callback*; the generated Python stub is pull-based (an async
iterator mixing progress events with the terminal reply) since there's no
ergonomic loadModel() wrapper yet (see qvac.api's module docstring) --
everything else below is a direct translation.

Talks to a real worker via poc_heartbeat.QvacWorker + poc_transport.PocTransport
(the production transport, bare-rpc-python, isn't built yet); everything above
that -- qvac.models, qvac.schemas, qvac.methods, qvac.api -- is the real package.

RUN:
  python3 python_quickstart.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_SRC_DIR = str(Path(__file__).resolve().parent.parent / "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from poc_heartbeat import QvacWorker
from poc_transport import PocTransport
from qvac.models import LLAMA_3_2_1B_INST_Q4_0
from qvac.schemas import (
    CompletionStreamRequest,
    LoadModelRequest,
    ModelProgressResponse,
    ModelType,
)
from qvac.methods import completion_stream, load_model_with_progress
from qvac.api import unload_model


async def main() -> int:
    async with QvacWorker() as worker:
        transport = PocTransport(worker)
        try:
            # Load a model into memory
            load_request = LoadModelRequest.model_validate(
                {
                    "type": "loadModel",
                    "modelSrc": LLAMA_3_2_1B_INST_Q4_0.src,
                    "modelType": ModelType.llamacpp_completion,
                    "modelConfig": {},
                }
            )
            model_id = None
            async for event in load_model_with_progress(transport, load_request):
                if isinstance(event, ModelProgressResponse):
                    downloaded_mb = event.downloaded / 1e6
                    total_mb = event.total / 1e6
                    line = f"▸ Downloading {event.percentage:.0f}% ({downloaded_mb:.1f}/{total_mb:.1f} MB)"
                    end = "\r" if sys.stderr.isatty() else "\n"
                    print(line, end=end, file=sys.stderr)
                    if event.percentage >= 100:
                        print(file=sys.stderr)
                else:
                    if not event.success:
                        raise RuntimeError(f"loadModel failed: {event.error}")
                    model_id = event.model_id

            # You can use the loaded model multiple times
            history = [
                {"role": "user", "content": "Explain quantum computing in one sentence"}
            ]
            completion_request = CompletionStreamRequest.model_validate(
                {
                    "type": "completionStream",
                    "modelId": model_id,
                    "history": history,
                    "stream": True,
                }
            )
            async for chunk in completion_stream(transport, completion_request):
                for event in chunk.events:
                    if event.type == "contentDelta":
                        sys.stdout.write(event.text)
                        sys.stdout.flush()
            print()

            # Unload model to free up system resources
            await unload_model(transport, model_id)
        except Exception as e:
            print(f"✖ {e}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
