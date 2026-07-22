"""Real-worker coverage through the production
`tetherto.qvac_sdk.bare_rpc_transport.BareRpcTransport`, against a real spawned
SDK worker, for all three wire call shapes -- including both duplex-shaped
methods beyond text-to-speech: parakeet's `transcribeStream` and the BCI addon's
`bciTranscribeStream` (both marked `heavy`).
"""

from __future__ import annotations

import array
import asyncio
import os
import wave
from pathlib import Path

import pytest
import pytest_asyncio
from _worker_env import BARE_BIN, WORKER_AVAILABLE

from tetherto.qvac_sdk.bare_rpc_transport import BARE_RPC_AVAILABLE, BareRpcTransport
from tetherto.qvac_sdk.methods import (
    bci_transcribe_stream,
    completion_stream,
    heartbeat,
    load_model,
    text_to_speech_stream,
    transcribe_stream,
)
from tetherto.qvac_sdk.models import (
    BCI_WINDOWED,
    PARAKEET_CTC_0_6B_Q4_0,
    QWEN3_600M_INST_Q4,
    TTS_EN_SUPERTONIC_Q4_0,
    WHISPER_EN_TINY_Q8_0,
)
from tetherto.qvac_sdk.schemas import (
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
        not WORKER_AVAILABLE,
        reason=f"no built SDK worker + Bare runtime found (worker={WORKER_PATH!r}, bare={BARE_BIN!r}) -- run scripts/build_worker.py, or set QVAC_POC_SDK_DIR",
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


@pytest.mark.heavy
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

    async def _stream_once() -> str:
        # Fresh request + paced generator per attempt (the generator is
        # single-use). emitPartials so we accumulate incremental text.
        request = TranscribeStreamRequest.model_validate(
            {
                "type": "transcribeStream",
                "modelId": model_id,
                "parakeetStreamingConfig": {
                    "chunkMs": chunk_ms,
                    "emitPartials": True,
                },
            }
        )
        text = ""
        async for response in transcribe_stream(
            transport, request, _paced_chunks(chunks, chunk_ms / 1000)
        ):
            piece = response.text or (
                response.segment.text if response.segment else None
            )
            if piece:
                text += piece
        return text

    # A parakeet streaming session can yield zero events on the first attempt
    # (a known warm-up quirk the SDK's own runner recovers from via
    # `recoveryMaxAttempts`); retry a few times before failing.
    text = ""
    for _attempt in range(3):
        text = await _stream_once()
        if text.strip():
            break
    assert text.strip(), "expected real transcript text via the bare_rpc duplex stream"


@pytest.mark.heavy
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


async def test_calls_fail_fast_when_the_worker_disconnects() -> None:
    """A worker crash (socket EOF) must reject in-flight and subsequent calls
    instead of leaving them awaiting a reply that never comes. The read loop
    closes the RPC on EOF, and RPC.close() fails every pending future. Manages
    its own transport (not the fixture) because it kills the worker mid-life."""
    t = await BareRpcTransport([BARE_BIN, WORKER_PATH]).connect()
    try:
        alive = await heartbeat(t, HeartbeatRequest(type="heartbeat"))
        assert alive.type == "heartbeat"

        assert t._proc is not None
        t._proc.kill()
        await t._proc.wait()

        with pytest.raises(Exception) as excinfo:
            await asyncio.wait_for(
                heartbeat(t, HeartbeatRequest(type="heartbeat")), timeout=10
            )
        assert not isinstance(
            excinfo.value, asyncio.TimeoutError
        ), "call hung after the worker disconnected instead of failing fast"
    finally:
        await t.close()


async def test_config_cache_directory_redirects_model_storage(tmp_path) -> None:
    """SDK config (QvacConfig) is applied on connect via the `__init_config`
    message, mirroring the JS client: a `cacheDirectory` redirects where the
    worker stores models. Manages its own transport (the fixture takes no
    config)."""
    cache_dir = str(tmp_path / "cfg-cache")
    os.makedirs(cache_dir, exist_ok=True)
    async with BareRpcTransport(
        [BARE_BIN, WORKER_PATH], config={"cacheDirectory": cache_dir}
    ) as t:
        load_response = await load_model(
            t,
            LoadModelRequest.model_validate(
                {
                    "type": "loadModel",
                    "modelSrc": WHISPER_EN_TINY_Q8_0.src,
                    "modelType": "whispercpp-transcription",
                }
            ),
        )
        assert load_response.success, load_response.error
        assert any(
            os.scandir(cache_dir)
        ), "cacheDirectory config had no effect -- model was not stored there"


async def test_completion_orchestrate_without_tools(transport) -> None:
    """The worker-orchestrated duplex path end to end: one generation turn,
    events forwarded through the orchestrate frames, the worker's terminal
    done frame folding the final. Lives in this suite (not the poc one)
    because orchestration keeps the upstream open for tool results, which
    needs a transport that pumps upstream concurrently -- the PoC harness
    exhausts the upstream before reading any response, by design."""
    from tetherto.qvac_sdk._completion import completion_orchestrate

    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": QWEN3_600M_INST_Q4.src,
            "modelType": "llamacpp-completion",
            "modelConfig": {"n_ctx": 2048},
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    assert load_response.model_id is not None

    run = completion_orchestrate(
        transport,
        model_id=load_response.model_id,
        history=[{"role": "user", "content": "Say hello in five words."}],
        tools=[],
        generation_params={"predict": 512, "temp": 0, "seed": 42},
    )
    saw_delta = False
    async for event in run.events:
        if event.type == "contentDelta":
            saw_delta = True
    final = await run.final
    assert saw_delta, "expected streamed deltas through the orchestrate frames"
    assert final.content_text.strip()


async def test_completion_orchestrate_runs_the_tool_loop(transport) -> None:
    """The full worker-orchestrated tool loop end to end: the model requests a
    tool, the worker emits a toolCallback frame, this client runs the local
    handler and writes the result upstream, and the worker continues to a final
    answer that reflects that result -- the whole point of completionOrchestrate,
    exercised against a real tools-capable model."""
    from tetherto.qvac_sdk._completion import completion_orchestrate

    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": QWEN3_600M_INST_Q4.src,
            "modelType": "llamacpp-completion",
            "modelConfig": {"n_ctx": 4096, "tools": True},
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    assert load_response.model_id is not None

    invoked: list[dict] = []

    async def get_secret_code(arguments: dict) -> str:
        invoked.append(arguments)
        return "the secret code is 4242"

    run = completion_orchestrate(
        transport,
        model_id=load_response.model_id,
        history=[
            {
                "role": "user",
                "content": "Call the get_secret_code tool, then tell me the code.",
            }
        ],
        tools=[
            {
                "name": "get_secret_code",
                "description": "Returns the current secret code.",
                "parameters": {"type": "object", "properties": {}},
                "handler": get_secret_code,
            }
        ],
        generation_params={"predict": 512, "temp": 0, "seed": 42},
    )
    async for _event in run.events:
        pass
    final = await run.final

    assert invoked, "worker never called back into the local tool handler"
    assert (
        "4242" in final.content_text
    ), f"final answer did not reflect the tool result: {final.content_text!r}"


async def test_completion_orchestrate_cancel_stops_generation(transport) -> None:
    """cancel(request_id=...) against a running orchestrate must abort the turn
    that is currently generating. The orchestrate handler threads its requestId
    into each inner completionStream turn, so the registry entry the client can
    target is the turn actually decoding -- without that plumbing the inner turn
    ran under a server-generated id the client never saw, and Stop did nothing."""
    from tetherto.qvac_sdk import cancel
    from tetherto.qvac_sdk._completion import completion_orchestrate
    from tetherto.qvac_sdk.errors import InferenceCancelledError

    load_request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": QWEN3_600M_INST_Q4.src,
            "modelType": "llamacpp-completion",
            "modelConfig": {"n_ctx": 2048},
        }
    )
    load_response = await load_model(transport, load_request)
    assert load_response.success, load_response.error
    assert load_response.model_id is not None

    run = completion_orchestrate(
        transport,
        model_id=load_response.model_id,
        history=[
            {
                "role": "user",
                "content": "Write an extremely long, detailed essay about "
                "the entire history of the Roman Empire.",
            }
        ],
        tools=[],
        # A large predict budget so generation is still running when the cancel
        # lands -- the run must not finish on its own before we cancel it.
        generation_params={"predict": 4096, "temp": 0, "seed": 42},
    )

    async def wait_for_generation_start() -> None:
        async for event in run.events:
            if event.type == "contentDelta":
                return

    # Once a content delta has arrived the turn's requestId is registered and it
    # is decoding, so the cancel has a live target.
    await asyncio.wait_for(wait_for_generation_start(), timeout=60)
    await cancel(transport, request_id=run.request_id)

    with pytest.raises(InferenceCancelledError):
        await asyncio.wait_for(run.final, timeout=30)
