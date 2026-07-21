"""Notebook / pandas / numpy ergonomics: a synchronous facade over the
async client with data-science-native inputs and outputs.

- `SyncClient` runs the async transport on a background event-loop thread,
  so every method is a plain blocking call -- no `await` in the notebook.
- Embeddings come back as numpy arrays (1-D for a single text, 2-D for a
  batch); `embed_frame()` wraps a batch as a pandas DataFrame.
- Completion streams display live in the cell (IPython display when
  available, incremental stdout otherwise).
- Audio interop: `transcribe()` accepts a numpy int16/float32 PCM array (or
  a file path / raw file bytes), and `text_to_speech()` returns float32 PCM
  as a numpy array.

numpy is required (the `notebook` extra); pandas and IPython are optional
and only needed by the features that use them.
"""

from __future__ import annotations

import asyncio
import base64
import io
import threading
import wave
from collections.abc import Coroutine
from typing import Any

from ._generated import methods as _methods
from ._transport import Transport
from .errors import EmbedFailedError
from .schemas import (
    CompletionStreamRequest,
    EmbedRequest,
    TextToSpeechRequest,
    TranscribeRequest,
)
from .vla import NumpyNotInstalledError

try:
    import numpy as np
except ImportError:  # the notebook extra is optional
    np = None  # type: ignore[assignment]


def _require_numpy() -> Any:
    if np is None:
        raise NumpyNotInstalledError()
    return np


class _LiveText:
    """Streams text into the current output area: an updating IPython
    display in notebooks, incremental prints elsewhere."""

    def __init__(self) -> None:
        self._text = ""
        self._handle = None
        try:
            from IPython.display import display  # type: ignore[import-not-found]

            self._handle = display({"text/plain": ""}, raw=True, display_id=True)
        except Exception:
            self._handle = None

    def append(self, piece: str) -> None:
        self._text += piece
        if self._handle is not None:
            self._handle.update({"text/plain": self._text}, raw=True)
        else:
            print(piece, end="", flush=True)

    def finish(self) -> str:
        if self._handle is None and self._text:
            print()
        return self._text


def _pcm_to_wav_bytes(audio: Any, sample_rate: int) -> bytes:
    """Wrap a mono PCM numpy array (int16, or float32 in [-1, 1]) into an
    in-memory 16-bit WAV file -- the wire carries audio *files*, so raw
    arrays need a container the worker's decoder recognizes."""
    numpy = _require_numpy()
    arr = numpy.asarray(audio)
    if arr.dtype != numpy.int16:
        floats = numpy.clip(arr.astype(numpy.float64), -1.0, 1.0)
        arr = (floats * 32767.0).astype(numpy.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(arr.tobytes())
    return out.getvalue()


class SyncClient:
    """Blocking facade for notebooks. Wrap an existing connected transport
    (`SyncClient(transport=...)`) or let it own a `tetherto.qvac_sdk.Client`
    (`SyncClient(sdk_dir=...)` etc. -- any `tetherto.qvac_sdk.Client` kwargs), then call
    plain methods; a daemon thread runs the event loop.

        client = SyncClient(sdk_dir="~/qvac/packages/sdk")
        model = client.load_model(model_src=QWEN3_600M_INST_Q4)
        vectors = client.embed(embed_model, ["hello", "world"])
        client.close()
    """

    def __init__(
        self, transport: Transport | None = None, **client_kwargs: Any
    ) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever, name="qvac-sync-client", daemon=True
        )
        self._thread.start()
        self._client: Any = None
        if transport is not None:
            self._transport: Transport = transport
        else:
            from .client import Client

            self._client = Client(**client_kwargs)
            self._run(self._client.connect())
            self._transport = self._client.transport

    def _run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def close(self) -> None:
        if self._client is not None:
            self._run(self._client.close())
            self._client = None
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)

    def __enter__(self) -> SyncClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- models ------------------------------------------------------------

    def load_model(self, **kwargs: Any) -> str:
        from . import _api

        return self._run(_api.load_model(self._transport, **kwargs))

    def unload_model(self, model_id: str, clear_storage: bool = False) -> None:
        from . import _api

        self._run(_api.unload_model(self._transport, model_id, clear_storage))

    # ---- embeddings ----------------------------------------------------------

    def embed(self, model_id: str, text: str | list[str]) -> Any:
        """Embed one text (1-D float32 array) or a batch (2-D, one row per
        text)."""
        numpy = _require_numpy()
        request = EmbedRequest.model_validate(
            {"type": "embed", "modelId": model_id, "text": text}
        )

        async def call() -> Any:
            return await _methods.embed(self._transport, request)

        response = self._run(call())
        if not response.success:
            raise EmbedFailedError(response.error)
        return numpy.asarray(response.embedding, dtype=numpy.float32)

    def embed_frame(self, model_id: str, texts: list[str]) -> Any:
        """Batch embeddings as a pandas DataFrame indexed by the input texts,
        one column per dimension."""
        try:
            import pandas as pd
        except ImportError as error:
            raise ImportError(
                "pandas is not installed -- install the 'notebook' extra "
                "(`pip install qvac[notebook]`) for DataFrame results"
            ) from error
        vectors = self.embed(model_id, texts)
        return pd.DataFrame(vectors, index=pd.Index(texts, name="text"))

    # ---- completion ------------------------------------------------------------

    def completion(
        self,
        model_id: str,
        prompt: str | list[dict[str, str]],
        *,
        live: bool = True,
        **generation_params: Any,
    ) -> str:
        """Run a completion and return the full text; streams deltas live
        into the cell while generating. `prompt` is a plain user string or a
        full chat history."""
        history = (
            [{"role": "user", "content": prompt}] if isinstance(prompt, str) else prompt
        )
        payload: dict[str, Any] = {
            "type": "completionStream",
            "modelId": model_id,
            "history": history,
            "stream": True,
        }
        if generation_params:
            payload["generationParams"] = generation_params
        request = CompletionStreamRequest.model_validate(payload)

        display = _LiveText() if live else None
        pieces: list[str] = []

        async def run() -> None:
            async for chunk in _methods.completion_stream(self._transport, request):
                for event in chunk.events:
                    if event.type == "contentDelta":
                        pieces.append(event.text)
                        if display is not None:
                            # Display updates must happen on the caller's
                            # thread in real notebooks too, but IPython's
                            # display protocol is thread-safe for updates.
                            display.append(event.text)

        self._run(run())
        if display is not None:
            display.finish()
        return "".join(pieces)

    # ---- audio ---------------------------------------------------------------

    def transcribe(
        self,
        model_id: str,
        audio: Any,
        *,
        sample_rate: int = 16000,
        prompt: str | None = None,
    ) -> str:
        """Transcribe audio given as a file path (str), raw audio-file bytes,
        or a mono numpy PCM array (int16, or float32 in [-1, 1]) with
        `sample_rate`."""
        numpy = _require_numpy()
        if isinstance(audio, str):
            chunk: dict[str, Any] = {"type": "filePath", "value": audio}
        else:
            file_bytes = (
                bytes(audio)
                if isinstance(audio, (bytes, bytearray))
                else _pcm_to_wav_bytes(numpy.asarray(audio), sample_rate)
            )
            chunk = {
                "type": "base64",
                "value": base64.b64encode(file_bytes).decode("ascii"),
            }
        payload: dict[str, Any] = {
            "type": "transcribe",
            "modelId": model_id,
            "audioChunk": chunk,
        }
        if prompt:
            payload["prompt"] = prompt
        request = TranscribeRequest.model_validate(payload)

        async def run() -> str:
            text = ""
            async for response in _methods.transcribe(self._transport, request):
                if response.text:
                    text += response.text
                if response.done:
                    break
            return text

        return self._run(run())

    def text_to_speech(self, model_id: str, text: str) -> Any:
        """Synthesize `text` and return the PCM samples as a float32 numpy
        array."""
        numpy = _require_numpy()
        request = TextToSpeechRequest.model_validate(
            {
                "type": "textToSpeech",
                "modelId": model_id,
                "inputType": "text",
                "text": text,
                "stream": True,
                "sentenceStream": False,
            }
        )

        async def run() -> list[Any]:
            # Convert each frame to a float32 array as it arrives and
            # concatenate once, instead of growing one big list of boxed
            # Python floats across the whole (potentially long) synthesis.
            chunks: list[Any] = []
            async for response in _methods.text_to_speech(self._transport, request):
                chunks.append(numpy.asarray(response.buffer, dtype=numpy.float32))
                if response.done:
                    break
            return chunks

        chunks = self._run(run())
        if not chunks:
            return numpy.empty(0, dtype=numpy.float32)
        return numpy.concatenate(chunks)


__all__ = ["SyncClient", "EmbedFailedError"]
