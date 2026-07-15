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
from poc_heartbeat import DEFAULT_AUDIO, SDK, WORKER

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
    from qvac.methods import load_model
    from qvac.schemas import LoadModelRequest

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
    from qvac.methods import completion_stream
    from qvac.models import QWEN3_600M_INST_Q4
    from qvac.schemas import CompletionStreamRequest, ModelType

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
    from qvac.methods import embed
    from qvac.models import EMBEDDINGGEMMA_300M_Q4_0
    from qvac.schemas import EmbedRequest, ModelType

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
    from qvac.methods import transcribe
    from qvac.models import PARAKEET_CTC_0_6B_Q4_0
    from qvac.schemas import ModelType, TranscribeRequest

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


async def _as_async_iter(items):
    for item in items:
        yield item


async def test_transcribe_stream_duplex_produces_real_text(transport) -> None:
    """Parakeet's streaming session only decodes when fed s16le PCM at roughly
    real-time cadence (see transcription-parakeet's live-stream-simulation.test.js /
    duplex-streaming tests) -- chunks are paced with a real `asyncio.sleep` between
    writes, matching the SDK e2e runner's `writeInChunks(delayMs)`."""
    from qvac.methods import transcribe_stream
    from qvac.models import PARAKEET_CTC_0_6B_Q4_0
    from qvac.schemas import ModelType, TranscribeStreamRequest

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
    from qvac.methods import text_to_speech_stream
    from qvac.models import TTS_EN_SUPERTONIC_Q4_0
    from qvac.schemas import ModelType, TextToSpeechStreamRequest

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

    samples = []
    saw_done = False
    async for chunk in text_to_speech_stream(
        transport, request, _as_async_iter([text])
    ):
        samples.extend(chunk.buffer)
        saw_done = saw_done or chunk.done
    assert samples, "expected real synthesized audio via the PoC duplex stream"
    assert saw_done, "expected a terminal done=True event on the response stream"


async def test_classify_produces_real_labels(transport) -> None:
    """The classification model ships inside @qvac/classification-ggml itself.
    The plugin resolves its model path as `config.modelPath ?? (params.modelPath
    || undefined)` (ggml-classification/plugin.ts) -- an empty string is falsy,
    so it falls through to the addon's own bundled default. A non-empty
    modelSrc is instead treated as a literal path to the weights file and
    fails to resolve, since `skipPrimaryModelPathValidation` skips the normal
    registry/http resolution that would otherwise turn it into a real path."""
    import base64

    from qvac.methods import classify
    from qvac.schemas import ClassifyRequest, ModelType

    model_id = await _load(transport, "", ModelType.ggml_classification)

    image_path = f"{SDK}/e2e/assets/images/elephant.jpg"
    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("ascii")

    request = ClassifyRequest.model_validate(
        {"type": "classify", "modelId": model_id, "image": image_b64, "topK": 1}
    )
    results = []
    async for response in classify(transport, request):
        results.extend(response.results)
        if response.done:
            break
    assert results, "expected at least one real classification result"
    assert all(0 <= r.confidence <= 1 for r in results)


async def test_ocr_stream_produces_real_text(transport) -> None:
    from qvac.methods import ocr_stream
    from qvac.models import OCR_CRAFT, OCR_LATIN
    from qvac.schemas import ModelType, OcrStreamRequest

    model_id = await _load(
        transport,
        OCR_LATIN.src,
        ModelType.ggml_ocr,
        model_config={"langList": ["en"], "detectorModelSrc": OCR_CRAFT.src},
    )

    image_path = f"{SDK}/e2e/assets/images/ocr-single-language.png"
    request = OcrStreamRequest.model_validate(
        {
            "type": "ocrStream",
            "modelId": model_id,
            "image": {"type": "filePath", "value": image_path},
        }
    )
    text = ""
    async for response in ocr_stream(transport, request):
        for block in response.blocks or []:
            text += block.text
    for expected in ("SINGLE", "LANGUAGE", "TEST"):
        assert expected in text.upper(), f"expected {expected!r} in OCR text {text!r}"


async def test_translate_produces_real_text(transport) -> None:
    """Uses the dedicated NMT engine (IndicTrans), not an LLM-based translator --
    smaller model, and the language pair is baked into which model is loaded."""
    from qvac.methods import translate
    from qvac.models import MARIAN_HI_EN_INDIC_200M_Q4_0
    from qvac.schemas import ModelType, TranslateRequest

    model_id = await _load(
        transport,
        MARIAN_HI_EN_INDIC_200M_Q4_0.src,
        ModelType.nmtcpp_translation,
        model_config={"engine": "IndicTrans", "from": "hin_Deva", "to": "eng_Latn"},
    )

    request = TranslateRequest.model_validate(
        {
            "type": "translate",
            "modelId": model_id,
            "text": "नमस्ते, आप कैसे हैं?",
            "stream": False,
            "modelType": "nmtcpp-translation",
        }
    )
    text = ""
    async for response in translate(transport, request):
        text += response.token
    assert any(
        word in text.lower() for word in ("hello", "how", "are", "you", "namaste")
    ), f"unexpected translation: {text!r}"


async def test_rag_ingest_and_search_round_trips_real_embeddings(transport) -> None:
    """RagRequest/RagResponse are RootModel unions over the `operation`
    discriminator (unlike LoadModelRequest's response, which is a single flat
    shape) -- construct via the top-level RagRequest wrapper, and unwrap
    `.root` to reach the operation-specific response fields."""
    import uuid

    # RagResponseIngest/Search are per-operation union members of RagResponse,
    # not one of the per-method Request/Response types qvac.schemas promotes --
    # qvac._generated.models is the flat namespace one level down that has them.
    from qvac._generated.models import RagResponseIngest, RagResponseSearch
    from qvac.methods import rag
    from qvac.models import EMBEDDINGGEMMA_300M_Q4_0
    from qvac.schemas import ModelType, RagRequest

    model_id = await _load(
        transport, EMBEDDINGGEMMA_300M_Q4_0.src, ModelType.llamacpp_embedding
    )
    workspace = f"pytest-rag-{uuid.uuid4().hex[:8]}"

    try:
        ingest_request = RagRequest.model_validate(
            {
                "type": "rag",
                "operation": "ingest",
                "modelId": model_id,
                "workspace": workspace,
                "documents": "QVAC is a local-first AI compute stack.",
                "chunk": True,
            }
        )
        ingest_response = (await rag(transport, ingest_request)).root
        assert isinstance(ingest_response, RagResponseIngest)
        assert ingest_response.success, ingest_response.error
        assert ingest_response.processed
        assert all(p.status.value == "fulfilled" for p in ingest_response.processed)

        search_request = RagRequest.model_validate(
            {
                "type": "rag",
                "operation": "search",
                "modelId": model_id,
                "workspace": workspace,
                "query": "What is QVAC?",
                "topK": 5,
                "n": 3,
            }
        )
        search_response = (await rag(transport, search_request)).root
        assert isinstance(search_response, RagResponseSearch)
        assert search_response.success, search_response.error
        assert search_response.results, "expected at least one real search result"
        assert any("QVAC" in r.content for r in search_response.results)
    finally:
        close_request = RagRequest.model_validate(
            {
                "type": "rag",
                "operation": "closeWorkspace",
                "workspace": workspace,
                "deleteOnClose": True,
            }
        )
        await rag(transport, close_request)


async def test_diffusion_stream_produces_real_image(transport) -> None:
    """Smallest config actually exercised by the SDK e2e suite (FLUX.2-klein at
    256x256, 2 steps) -- fast enough for a unit test, still a real generation."""
    from qvac.methods import diffusion_stream
    from qvac.models import FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M
    from qvac.schemas import DiffusionStreamRequest, ModelType

    model_id = await _load(
        transport,
        FLUX_2_KLEIN_4B_Q4_0.src,
        ModelType.sdcpp_generation,
        model_config={
            "device": "cpu",
            "threads": 4,
            "prediction": "flux2_flow",
            "llmModelSrc": QWEN3_4B_Q4_K_M.src,
            "vaeModelSrc": FLUX_2_KLEIN_4B_VAE.src,
        },
    )

    request = DiffusionStreamRequest.model_validate(
        {
            "type": "diffusionStream",
            "modelId": model_id,
            "prompt": "a blue circle",
            "width": 256,
            "height": 256,
            "steps": 2,
            "seed": 42,
        }
    )
    saw_done = False
    saw_data = False
    async for response in diffusion_stream(transport, request):
        saw_data = saw_data or bool(response.data)
        saw_done = saw_done or bool(response.done)
    assert saw_data, "expected at least one real image data chunk"
    assert saw_done, "expected a terminal done=True event"


async def test_upscale_stream_produces_real_image(transport) -> None:
    import base64

    from qvac.methods import upscale_stream
    from qvac.models import REALESRGAN_X4PLUS_ANIME_6B
    from qvac.schemas import ModelType, UpscaleStreamRequest

    model_id = await _load(
        transport,
        REALESRGAN_X4PLUS_ANIME_6B.src,
        ModelType.sdcpp_generation,
        model_config={
            "mode": "upscale",
            "device": "cpu",
            "upscaler": {"tile_size": 64},
        },
    )

    image_path = f"{SDK}/e2e/assets/images/small-64.jpg"
    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("ascii")

    request = UpscaleStreamRequest.model_validate(
        {
            "type": "upscaleStream",
            "modelId": model_id,
            "image": image_b64,
            "repeats": 1,
        }
    )
    saw_done = False
    saw_data = False
    async for response in upscale_stream(transport, request):
        saw_data = saw_data or bool(response.data)
        saw_done = saw_done or bool(response.done)
    assert saw_data, "expected at least one real upscaled image data chunk"
    assert saw_done, "expected a terminal done=True event"


def _bci_load_config():
    return {
        "whisperConfig": {"language": "en", "temperature": 0.0},
        "miscConfig": {"caption_enabled": False},
        # neural-not-too-controversial.bin was recorded on session day 1.
        "bciConfig": {"day_idx": 1},
    }


async def test_bci_transcribe_produces_real_text(transport) -> None:
    from qvac.methods import bci_transcribe
    from qvac.models import BCI_WINDOWED
    from qvac.schemas import BciTranscribeRequest, ModelType

    model_id = await _load(
        transport,
        BCI_WINDOWED.src,
        ModelType.bci_whispercpp_transcription,
        model_config=_bci_load_config(),
    )

    neural_path = f"{SDK}/e2e/assets/neural/neural-not-too-controversial.bin"
    request = BciTranscribeRequest.model_validate(
        {
            "type": "bciTranscribe",
            "modelId": model_id,
            "neuralData": {"type": "filePath", "value": neural_path},
        }
    )
    text = ""
    async for response in bci_transcribe(transport, request):
        if response.text:
            text += response.text
    assert "controversial" in text.lower(), f"unexpected BCI transcript: {text!r}"


async def test_bci_transcribe_stream_duplex_produces_real_text(transport) -> None:
    """The BCI addon's sliding-window driver is fed arbitrary-size chunks with
    no real-time pacing requirement, unlike parakeet's transcribeStream."""
    from qvac.methods import bci_transcribe_stream
    from qvac.models import BCI_WINDOWED
    from qvac.schemas import BciTranscribeStreamRequest, ModelType

    model_id = await _load(
        transport,
        BCI_WINDOWED.src,
        ModelType.bci_whispercpp_transcription,
        model_config=_bci_load_config(),
    )

    neural_path = f"{SDK}/e2e/assets/neural/neural-not-too-controversial.bin"
    with open(neural_path, "rb") as f:
        neural_bytes = f.read()
    chunk_size = 64 * 1024
    chunks = [
        neural_bytes[i : i + chunk_size]
        for i in range(0, len(neural_bytes), chunk_size)
    ]

    request = BciTranscribeStreamRequest.model_validate(
        {
            "type": "bciTranscribeStream",
            "modelId": model_id,
            "streamOpts": {"emit": "delta"},
        }
    )
    text = ""
    async for response in bci_transcribe_stream(
        transport, request, _as_async_iter(chunks)
    ):
        piece = response.text or (response.segment.text if response.segment else None)
        if piece:
            text += piece
    assert "controversial" in text.lower(), f"unexpected BCI transcript: {text!r}"


async def test_get_model_info_returns_real_registry_metadata(transport) -> None:
    from qvac.methods import get_model_info
    from qvac.models import QWEN3_600M_INST_Q4
    from qvac.schemas import GetModelInfoRequest

    request = GetModelInfoRequest.model_validate(
        {"type": "getModelInfo", "name": QWEN3_600M_INST_Q4.name}
    )
    response = await get_model_info(transport, request)
    assert response.model_info is not None


async def test_get_loaded_model_info_returns_real_loaded_model(transport) -> None:
    from qvac.methods import get_loaded_model_info
    from qvac.models import QWEN3_600M_INST_Q4
    from qvac.schemas import GetLoadedModelInfoRequest, ModelType

    model_id = await _load(
        transport, QWEN3_600M_INST_Q4.src, ModelType.llamacpp_completion
    )

    request = GetLoadedModelInfoRequest.model_validate(
        {"type": "getLoadedModelInfo", "modelId": model_id}
    )
    response = await get_loaded_model_info(transport, request)
    assert response.info.model_id == model_id


async def test_download_asset_succeeds_on_a_real_registry_src(transport) -> None:
    from qvac.methods import download_asset
    from qvac.models import QWEN3_600M_INST_Q4
    from qvac.schemas import DownloadAssetRequest

    request = DownloadAssetRequest.model_validate(
        {"type": "downloadAsset", "assetSrc": QWEN3_600M_INST_Q4.src}
    )
    response = await download_asset(transport, request)
    assert response.success, response.error
    assert response.asset_id


async def test_finetune_completes_a_real_training_run(transport, tmp_path) -> None:
    """Uses the SDK e2e suite's own tiny fixtures (4 train / 4 eval examples) so
    one real epoch finishes quickly -- a plain `finetune()` call blocks for the
    whole run (dispatchPluginReply calls the addon directly when there's no
    progress callback), unlike the `finetune_with_progress` variant.

    `learningRate` must be set explicitly -- omitting it hits a native
    GGML_ASSERT(opt_pars.adamw.alpha > 0.0f) crash, since the addon has no
    default. Mirrors the exact known-good config from the SDK e2e suite's own
    `finetune-executor.ts` `buildOptions()`."""
    from qvac.methods import finetune
    from qvac.models import QWEN3_1_7B_INST_Q4
    from qvac.schemas import FinetuneRequest, ModelType

    model_id = await _load(
        transport,
        QWEN3_1_7B_INST_Q4.src,
        ModelType.llamacpp_completion,
        model_config={"verbosity": 0, "ctx_size": 2048, "n_discarded": 256},
    )

    train_dataset = f"{SDK}/e2e/assets/documents/finetune_train_tiny_HF.jsonl"
    eval_dataset = f"{SDK}/e2e/assets/documents/finetune_eval_tiny_HF.jsonl"
    output_dir = tmp_path / "output"
    checkpoint_dir = tmp_path / "checkpoints"
    output_dir.mkdir()
    checkpoint_dir.mkdir()

    request = FinetuneRequest.model_validate(
        {
            "type": "finetune",
            "modelId": model_id,
            "operation": "start",
            "options": {
                "trainDatasetDir": train_dataset,
                "validation": {"type": "dataset", "path": eval_dataset},
                "outputParametersDir": str(output_dir),
                "checkpointSaveDir": str(checkpoint_dir),
                "checkpointSaveSteps": 2,
                "numberOfEpochs": 1,
                "learningRate": 1e-5,
                "lrMin": 1e-8,
                "assistantLossOnly": True,
                "loraModules": "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
            },
        }
    )
    response = await finetune(transport, request)
    assert response.status.value in ("RUNNING", "COMPLETED"), response.status
    assert response.stats is not None
    assert response.stats.epochs_completed >= 0
