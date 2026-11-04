"""Python port of packages/sdk/examples/bci/bci-filesystem-streaming.ts.

Streaming BCI transcription from a neural-signal file.

Reads a raw neural-signal `.bin` file and feeds it to the BCI (whisper.cpp)
addon chunk-by-chunk through a duplex `bci_transcribe_stream_session`,
printing transcript text as the sliding window decodes successive windows.

RUN: python examples/bci_filesystem_streaming.py <neural-bin-file-path>
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    bci_transcribe_stream_session,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import BCI_WINDOWED

# Feed the neural buffer in fixed-size chunks to simulate a live stream.
CHUNK_SIZE = 64 * 1024


async def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python examples/bci_filesystem_streaming.py <neural-bin-file-path>",
            file=sys.stderr,
        )
        return 1

    neural_file_path = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            print("▸ BCI transcribeStream file test")
            print(f"▸ File: {neural_file_path}")
            print(f"▸ Chunk size: {CHUNK_SIZE} bytes")

            print("▸ Loading model...")
            model_id = await load_model(
                t,
                model_src=BCI_WINDOWED,
                model_config={
                    "whisperConfig": {
                        "language": "en",
                        "n_threads": 4,
                        "temperature": 0.0,
                    },
                    # Session day index selects the day-specific projection
                    # matrices. Set this to match the recording session your
                    # neural file came from.
                    "bciConfig": {"day_idx": 1},
                },
            )
            print(f"▸ Model loaded: {model_id}")
            print("▸ Opening live session...")
            session = bci_transcribe_stream_session(t, model_id=model_id, emit="delta")
            print("▸ Session open. Streaming neural signal...")

            # Drain the session concurrently with writing so the sliding-window
            # decode can make progress as chunks arrive instead of stalling.
            async def consume() -> str:
                transcript = ""
                async for text in session:
                    transcript += text
                    sys.stdout.write(text)
                    sys.stdout.flush()
                return transcript

            consumer = asyncio.create_task(consume())

            data = Path(neural_file_path).read_bytes()

            total_bytes = 0
            for offset in range(0, len(data), CHUNK_SIZE):
                chunk = data[offset : offset + CHUNK_SIZE]
                session.write(chunk)
                total_bytes += len(chunk)
                await asyncio.sleep(0.01)

            print(f"\n\n▸ Neural signal streamed: {total_bytes} bytes")
            print("▸ Waiting for transcription to finish...")
            session.end()

            transcript = await consumer

            print("\n▸ Results")
            print(transcript.strip() or "(no text received)")

            print("▸ Unloading model...")
            await unload_model(t, model_id)
            print("▸ Done.")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
