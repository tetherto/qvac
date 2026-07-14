"""Real end-to-end coverage for the generated method stubs that
`poc_heartbeat.py`'s demo functions already exercise manually
(`python3 poc_heartbeat.py`) but that no pytest test asserted on: unary
`embed`, server-stream `transcribe`/`completion_stream`, and the two
duplex methods `transcribe_stream`/`text_to_speech_stream`.

Same real-worker rigor as test_poc_smoke.py/test_poc_progress.py, via the
hand-written PoC transport (poc_heartbeat.py/poc_transport.py) -- the
production socket transport isn't built yet.
"""

from __future__ import annotations

import array
import asyncio
import os
import wave

import pytest

from poc_heartbeat import DEFAULT_AUDIO, WORKER

pytestmark = pytest.mark.skipif(
    not os.path.exists(WORKER),
    reason=f"no built SDK worker found at {WORKER!r} -- run `bun run build` in packages/sdk, or set QVAC_POC_SDK_DIR",
)


@pytest.fixture
async def worker():
    from poc_heartbeat import QvacWorker

    async with QvacWorker() as w:
        yield w


@pytest.fixture
def transport(worker):
    from poc_transport import PocTransport

    return PocTransport(worker)


async def _load(transport, model_src, model_type, model_config=None):
    from qvac.schemas import LoadModelRequest
    from qvac.methods import load_model

    request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": model_src,
            "modelType": model_type,
            "modelConfig": model_config or {},
        }
    )
    response = await load_model(transport, request)
    assert response.success, response.error
    return response.model_id


async def test_completion_stream_produces_real_text(transport) -> None:
    from qvac.models import QWEN3_600M_INST_Q4
    from qvac.schemas import CompletionStreamRequest, ModelType
    from qvac.methods import completion_stream

    model_id = await _load(
        transport, QWEN3_600M_INST_Q4.src, ModelType.llamacpp_completion
    )

    request = CompletionStreamRequest.model_validate(
        {
            "type": "completionStream",
            "modelId": model_id,
            "history": [{"role": "user", "content": "Say hello in five words."}],
            "stream": True,
        }
    )
    text = ""
    async for chunk in completion_stream(transport, request):
        for event in chunk.events:
            if event.type == "contentDelta":
                text += event.text
    assert text.strip(), "expected real completion text via the PoC server-stream"


async def test_embed_produces_real_vector(transport) -> None:
    from qvac.models import EMBEDDINGGEMMA_300M_Q4_0
    from qvac.schemas import EmbedRequest, ModelType
    from qvac.methods import embed

    model_id = await _load(
        transport, EMBEDDINGGEMMA_300M_Q4_0.src, ModelType.llamacpp_embedding
    )

    request = EmbedRequest.model_validate(
        {"type": "embed", "modelId": model_id, "text": "hello world"}
    )
    response = await embed(transport, request)
    assert response.success, response.error
    assert len(response.embedding) > 0
    assert any(x != 0 for x in response.embedding)


async def test_transcribe_produces_real_text(transport) -> None:
    from qvac.models import PARAKEET_CTC_0_6B_Q4_0
    from qvac.schemas import ModelType, TranscribeRequest
    from qvac.methods import transcribe

    model_id = await _load(
        transport, PARAKEET_CTC_0_6B_Q4_0.src, ModelType.parakeet_transcription
    )

    request = TranscribeRequest.model_validate(
        {
            "type": "transcribe",
            "modelId": model_id,
            "audioChunk": {"type": "filePath", "value": DEFAULT_AUDIO},
        }
    )
    text = ""
    async for response in transcribe(transport, request):
        if response.text:
            text += response.text
    assert text.strip(), "expected real transcript text via the PoC server-stream"


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


async def _paced_chunks(chunks, delay_s):
    for i, chunk in enumerate(chunks):
        yield chunk
        if delay_s > 0 and i < len(chunks) - 1:
            await asyncio.sleep(delay_s)


async def test_transcribe_stream_duplex_produces_real_text(transport) -> None:
    """Parakeet's streaming session only decodes when fed s16le PCM at roughly
    real-time cadence (see transcription-parakeet's live-stream-simulation.test.js /
    duplex-streaming tests) -- chunks are paced with a real `asyncio.sleep` between
    writes, matching the SDK e2e runner's `writeInChunks(delayMs)`."""
    from qvac.models import PARAKEET_CTC_0_6B_Q4_0
    from qvac.schemas import ModelType, TranscribeStreamRequest
    from qvac.methods import transcribe_stream

    model_id = await _load(
        transport, PARAKEET_CTC_0_6B_Q4_0.src, ModelType.parakeet_transcription
    )

    chunk_ms = 1000
    pcm = _wav_to_s16le_mono_16k(DEFAULT_AUDIO)
    bytes_per_chunk = int(16000 * chunk_ms / 1000) * 2
    trailing_silence = bytes(
        int(16000 * 1.5) * 2
    )  # settle time so the stream finalizes
    chunks = [pcm[i : i + bytes_per_chunk] for i in range(0, len(pcm), bytes_per_chunk)]
    chunks += [
        trailing_silence[i : i + bytes_per_chunk]
        for i in range(0, len(trailing_silence), bytes_per_chunk)
    ]

    request = TranscribeStreamRequest.model_validate(
        {
            "type": "transcribeStream",
            "modelId": model_id,
            "parakeetStreamingConfig": {"chunkMs": chunk_ms, "emitPartials": True},
        }
    )
    text = ""
    async for response in transcribe_stream(
        transport, request, _paced_chunks(chunks, chunk_ms / 1000)
    ):
        piece = response.text or (response.segment.text if response.segment else None)
        if piece:
            text += piece
    assert text.strip(), "expected real transcript text via the PoC duplex stream"


async def test_text_to_speech_stream_duplex_produces_real_audio(transport) -> None:
    from qvac.models import TTS_EN_SUPERTONIC_Q4_0
    from qvac.schemas import ModelType, TextToSpeechStreamRequest
    from qvac.methods import text_to_speech_stream

    model_id = await _load(
        transport,
        TTS_EN_SUPERTONIC_Q4_0.src,
        ModelType.tts_ggml,
        model_config={"ttsEngine": "supertonic", "language": "en"},
    )

    request = TextToSpeechStreamRequest.model_validate(
        {"type": "textToSpeechStream", "modelId": model_id}
    )
    text = b"Hello from QVAC. This is streaming text to speech."

    async def _as_async_iter(items):
        for item in items:
            yield item

    samples = []
    saw_done = False
    async for chunk in text_to_speech_stream(
        transport, request, _as_async_iter([text])
    ):
        samples.extend(chunk.buffer)
        saw_done = saw_done or chunk.done
    assert samples, "expected real synthesized audio via the PoC duplex stream"
    assert saw_done, "expected a terminal done=True event on the response stream"
