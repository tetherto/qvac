"""Unit tests for tetherto.qvac_sdk.notebook.SyncClient: the blocking facade (called from
plain sync code, no pytest-asyncio), numpy/pandas result shapes, numpy audio
interop, and live streaming fallback -- all over a fake transport running on
the facade's own background loop. Plus a real-worker e2e at the bottom,
gated the same way as the bare-rpc transport suite."""

from __future__ import annotations

import base64
import importlib.util
import io
import os
import wave
from typing import Any

import numpy as np
import pandas as pd
import pytest
from _worker_env import BARE_BIN, WORKER_AVAILABLE

from tetherto.qvac_sdk.notebook import EmbedFailedError, SyncClient

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "sdk"),
)
WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")

BARE_RPC_AVAILABLE = importlib.util.find_spec("bare_rpc") is not None


class FakeTransport:
    def __init__(self, response=None, stream_items=None):
        self.response = response
        self.stream_items = stream_items or []
        self.sent: Any = None

    async def call(self, payload):
        self.sent = payload
        return self.response

    async def call_stream(self, payload):
        self.sent = payload
        for item in self.stream_items:
            yield item

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


def test_embed_single_returns_1d_float32():
    transport = FakeTransport(
        response={"type": "embed", "success": True, "embedding": [0.1, 0.2, 0.3]}
    )
    with SyncClient(transport=transport) as client:
        vector = client.embed("m-1", "hello")
    assert vector.dtype == np.float32
    assert vector.shape == (3,)
    assert transport.sent["text"] == "hello"


def test_embed_batch_returns_2d_and_frame_indexes_by_text():
    transport = FakeTransport(
        response={
            "type": "embed",
            "success": True,
            "embedding": [[1.0, 2.0], [3.0, 4.0]],
        }
    )
    with SyncClient(transport=transport) as client:
        matrix = client.embed("m-1", ["a", "b"])
        assert matrix.shape == (2, 2)

        frame = client.embed_frame("m-1", ["a", "b"])
    assert isinstance(frame, pd.DataFrame)
    assert list(frame.index) == ["a", "b"]
    assert frame.loc["b", 1] == 4.0


def test_embed_failure_raises_typed_error():
    transport = FakeTransport(
        response={"type": "embed", "success": False, "embedding": [], "error": "nope"}
    )
    with SyncClient(transport=transport) as client:
        with pytest.raises(EmbedFailedError, match="nope"):
            client.embed("m-1", "hello")


def test_completion_streams_live_to_stdout_and_returns_text(capsys):
    chunks = [
        {
            "type": "completionStream",
            "events": [{"type": "contentDelta", "seq": seq, "text": piece}],
        }
        for seq, piece in enumerate(("Hel", "lo!"))
    ]
    transport = FakeTransport(stream_items=chunks)
    with SyncClient(transport=transport) as client:
        text = client.completion("m-1", "greet me", predict=32)
    assert text == "Hello!"
    # No IPython here, so the live display falls back to incremental stdout.
    assert "Hello!" in capsys.readouterr().out
    assert transport.sent["generationParams"] == {"predict": 32}
    assert transport.sent["history"] == [{"role": "user", "content": "greet me"}]


def test_transcribe_wraps_numpy_pcm_into_wav_wire_bytes():
    transport = FakeTransport(
        stream_items=[{"type": "transcribe", "text": "hi there", "done": True}]
    )
    tone = (np.sin(np.linspace(0, 440 * 2 * np.pi, 1600)) * 0.5).astype(np.float32)
    with SyncClient(transport=transport) as client:
        text = client.transcribe("m-1", tone, sample_rate=16000)
    assert text == "hi there"

    chunk = transport.sent["audioChunk"]
    assert chunk["type"] == "base64"
    with wave.open(io.BytesIO(base64.b64decode(chunk["value"])), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getframerate() == 16000
        assert wav.getsampwidth() == 2
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    # The int16 samples must be the float PCM scaled by 32767.
    assert pcm.shape == (1600,)
    assert np.allclose(pcm / 32767.0, np.clip(tone, -1, 1), atol=1 / 32767)


def test_transcribe_accepts_file_path_verbatim():
    transport = FakeTransport(
        stream_items=[{"type": "transcribe", "text": "ok", "done": True}]
    )
    with SyncClient(transport=transport) as client:
        client.transcribe("m-1", "/audio/sample.wav")
    assert transport.sent["audioChunk"] == {
        "type": "filePath",
        "value": "/audio/sample.wav",
    }


def test_text_to_speech_returns_float32_pcm_array():
    frames = [
        {"type": "textToSpeech", "buffer": [0.1, 0.2], "done": False},
        {"type": "textToSpeech", "buffer": [0.3], "done": True},
    ]
    transport = FakeTransport(stream_items=frames)
    with SyncClient(transport=transport) as client:
        audio = client.text_to_speech("m-1", "Hello.")
    assert audio.dtype == np.float32
    assert np.allclose(audio, [0.1, 0.2, 0.3])


# ---- real-worker e2e ----------------------------------------------------------


@pytest.mark.skipif(not BARE_RPC_AVAILABLE, reason="bare_rpc extra not installed")
@pytest.mark.skipif(
    not WORKER_AVAILABLE,
    reason=f"no built SDK worker + Bare runtime (worker={WORKER_PATH!r}, bare={BARE_BIN!r})",
)
def test_sync_client_notebook_flow_against_real_worker():
    """The notebook quickstart, blocking end to end from plain sync code:
    spawn a worker, load a model, run a live-streamed completion, unload."""
    from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

    with SyncClient(worker_path=WORKER_PATH, bare_path=BARE_BIN) as client:
        model_id = client.load_model(
            model_src=QWEN3_600M_INST_Q4, model_config={"n_ctx": 2048}
        )
        text = client.completion(
            model_id,
            "Say hello in five words.",
            live=False,
            predict=512,
            temp=0,
            seed=42,
        )
        assert text.strip(), "expected real completion text through SyncClient"
        client.unload_model(model_id)
