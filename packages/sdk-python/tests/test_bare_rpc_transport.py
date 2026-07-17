"""Same real-worker rigor as test_poc_smoke.py/test_poc_progress.py, but
exercising the production `qvac.bare_rpc_transport.BareRpcTransport`
against a real spawned SDK worker for all three wire call shapes,
including both duplex-shaped methods beyond text-to-speech: parakeet's
`transcribeStream` and the BCI addon's `bciTranscribeStream`.
"""

from __future__ import annotations

import array
import asyncio
import os
import wave
from pathlib import Path

import pytest
import pytest_asyncio

from qvac.bare_rpc_transport import BARE_RPC_AVAILABLE, BareRpcTransport
from qvac.methods import (
    bci_transcribe_stream,
    completion_stream,
    heartbeat,
    load_model,
    text_to_speech_stream,
    transcribe_stream,
)
from qvac.models import (
    BCI_WINDOWED,
    PARAKEET_CTC_0_6B_Q4_0,
    QWEN3_600M_INST_Q4,
    TTS_EN_SUPERTONIC_Q4_0,
)
from qvac.schemas import (
    BciTranscribeStreamRequest,
    CompletionStreamRequest,
    HeartbeatRequest,
    LoadModelRequest,
    ModelType,
    TextToSpeechStreamRequest,
    TranscribeStreamRequest,
)

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)
BARE_BIN = f"{SDK_DIR}/node_modules/bare-runtime-darwin-arm64/bin/bare"
WORKER_PATH = f"{SDK_DIR}/dist/server/worker.js"
AUDIO_FIXTURE = f"{SDK_DIR}/e2e/assets/audio/transcription-short-wav.wav"
NEURAL_FIXTURE = f"{SDK_DIR}/e2e/assets/neural/neural-not-too-controversial.bin"

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not BARE_RPC_AVAILABLE,
        reason="bare_rpc not installed -- install the 'bare-rpc' extra "
        "(`pip install -e '.[bare-rpc]'`) to run these tests",
    ),
    pytest.mark.skipif(
        not os.path.exists(WORKER_PATH),
        reason=f"no built SDK worker found at {WORKER_PATH!r} -- run `bun run build` in packages/sdk, or set QVAC_POC_SDK_DIR",
    ),
]


@pytest_asyncio.fixture
async def transport():
    async with BareRpcTransport([BARE_BIN, WORKER_PATH]) as t:
        yield t


async def test_heartbeat_unary(transport) -> None:
    response = await heartbeat(transport, HeartbeatRequest(type="heartbeat"))
    assert response.type == "heartbeat"
    assert isinstance(response.number, float)


async def test_load_model_and_completion_stream(transport) -> None:
    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": QWEN3_600M_INST_Q4.src,
            "modelType": "llamacpp-completion",
            # Qwen3 is a thinking model: the worker reserves context for the
            # reasoning trace, so the metadata-default budget overflows even a
            # tiny prompt. Give it an explicit window (matches the SDK e2e).
            "modelConfig": {"n_ctx": 2048},
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    model_id = load_response.model_id

    completion_request = CompletionStreamRequest.model_validate(
        {
            "type": "completionStream",
            "modelId": model_id,
            "history": [{"role": "user", "content": "Say hello in five words."}],
            "stream": True,
            # Bound + seed the generation: Qwen3's thinking trace otherwise
            # rambles nondeterministically and can outgrow n_ctx mid-stream,
            # surfacing as a flaky CONTEXT_OVERFLOW.
            "generationParams": {"predict": 512, "temp": 0, "seed": 42},
        }
    )

    text = ""
    async for chunk in completion_stream(transport, completion_request):
        for event in chunk.events:
            if event.type == "contentDelta":
                text += event.text
    assert text.strip(), "expected real completion text via the bare_rpc server-stream"


async def _as_async_iter(items):
    for item in items:
        yield item


async def _paced_chunks(chunks, delay_s):
    for i, chunk in enumerate(chunks):
        yield chunk
        if delay_s > 0 and i < len(chunks) - 1:
            await asyncio.sleep(delay_s)


async def test_load_model_and_tts_stream_duplex(transport) -> None:
    """Exercises call_duplex end to end: text goes up the request stream while
    synthesized audio comes down the response stream, concurrently."""
    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": TTS_EN_SUPERTONIC_Q4_0.src,
            "modelType": ModelType.tts_ggml,
            "modelConfig": {"ttsEngine": "supertonic", "language": "en"},
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    model_id = load_response.model_id

    tts_request = TextToSpeechStreamRequest.model_validate(
        {"type": "textToSpeechStream", "modelId": model_id}
    )
    text = b"Hello from QVAC. This is streaming text to speech."

    samples = []
    saw_done = False
    async for chunk in text_to_speech_stream(
        transport, tts_request, _as_async_iter([text])
    ):
        samples.extend(chunk.buffer)
        saw_done = saw_done or chunk.done
    assert samples, "expected real synthesized audio via the bare_rpc duplex stream"
    assert saw_done, "expected a terminal done=True event on the response stream"


def _wav_to_s16le_mono_16k(path: str) -> bytes:
    """Decode a 16-bit PCM wav to 16 kHz mono s16le -- the wire format parakeet's
    duplex `transcribeStream` expects (see the SDK e2e `parakeet-stream-runner.ts`,
    which converts its f32 fixture samples to s16le bytes before writing them)."""
    with wave.open(path, "rb") as wf:
        channels, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise RuntimeError(f"expected 16-bit PCM wav, got sampwidth={width}")
    samples = array.array("h")
    samples.frombytes(raw)
    mono = array.array("h", samples[0::channels]) if channels > 1 else samples
    target = 16000
    if rate != target:
        if rate % target != 0:
            raise RuntimeError(f"can't cleanly decimate {rate}Hz to {target}Hz")
        mono = array.array("h", mono[0 :: rate // target])
    return mono.tobytes()


async def test_transcribe_stream_duplex(transport) -> None:
    """Parakeet's streaming session only decodes when fed at roughly real-time
    cadence (see transcription-parakeet's live-stream-simulation.test.js /
    duplex-streaming tests) -- chunks are paced with a real `asyncio.sleep`
    between writes, matching the SDK e2e runner's `writeInChunks(delayMs)`."""
    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": PARAKEET_CTC_0_6B_Q4_0.src,
            "modelType": ModelType.parakeet_transcription,
            "modelConfig": {},
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    model_id = load_response.model_id

    chunk_ms = 1000
    pcm = _wav_to_s16le_mono_16k(AUDIO_FIXTURE)
    bytes_per_chunk = int(16000 * chunk_ms / 1000) * 2
    trailing_silence = bytes(
        int(16000 * 1.5) * 2
    )  # settle time so the stream finalizes
    chunks = [pcm[i : i + bytes_per_chunk] for i in range(0, len(pcm), bytes_per_chunk)]
    chunks += [
        trailing_silence[i : i + bytes_per_chunk]
        for i in range(0, len(trailing_silence), bytes_per_chunk)
    ]

    transcribe_request = TranscribeStreamRequest.model_validate(
        {
            "type": "transcribeStream",
            "modelId": model_id,
            "parakeetStreamingConfig": {"chunkMs": chunk_ms, "emitPartials": True},
        }
    )

    text = ""
    async for response in transcribe_stream(
        transport, transcribe_request, _paced_chunks(chunks, chunk_ms / 1000)
    ):
        piece = response.text or (response.segment.text if response.segment else None)
        if piece:
            text += piece
    assert text.strip(), "expected real transcript text via the bare_rpc duplex stream"


async def test_bci_transcribe_stream_duplex(transport) -> None:
    """The BCI addon's sliding-window driver is fed arbitrary-size chunks with
    no real-time pacing requirement (see the SDK e2e `bci-executor.ts`, which
    writes 64 KiB slices back-to-back) -- unlike parakeet's transcribeStream."""
    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": BCI_WINDOWED.src,
            "modelType": ModelType.bci_whispercpp_transcription,
            "modelConfig": {
                "whisperConfig": {"language": "en", "temperature": 0.0},
                "miscConfig": {"caption_enabled": False},
                # neural-not-too-controversial.bin was recorded on session day 1.
                "bciConfig": {"day_idx": 1},
            },
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    model_id = load_response.model_id

    bci_request = BciTranscribeStreamRequest.model_validate(
        {
            "type": "bciTranscribeStream",
            "modelId": model_id,
            "streamOpts": {"emit": "delta"},
        }
    )

    with open(NEURAL_FIXTURE, "rb") as f:
        neural_bytes = f.read()
    chunk_size = 64 * 1024
    chunks = [
        neural_bytes[i : i + chunk_size]
        for i in range(0, len(neural_bytes), chunk_size)
    ]

    text = ""
    async for response in bci_transcribe_stream(
        transport, bci_request, _as_async_iter(chunks)
    ):
        piece = response.text or (response.segment.text if response.segment else None)
        if piece:
            text += piece
    assert "controversial" in text.lower(), f"unexpected BCI transcript: {text!r}"
