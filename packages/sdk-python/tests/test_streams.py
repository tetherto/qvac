"""Run handles in tetherto.qvac_sdk._streams against a fake transport."""

from __future__ import annotations

import base64
from typing import Any

import pytest

from tetherto.qvac_sdk import _streams as streams
from tetherto.qvac_sdk import schemas
from tetherto.qvac_sdk.errors import (
    CompletionFailedError,
    InferenceCancelledError,
    InvalidResponseError,
    StreamEndedError,
)


class FakeTransport:
    def __init__(self, frames: list[Any] | None = None) -> None:
        self.frames = frames or []
        self.sent: list[Any] = []

    async def call(self, payload: Any) -> Any:
        raise NotImplementedError

    async def call_stream(self, payload: Any):
        self.sent.append(payload)
        for frame in self.frames:
            yield frame

    async def call_duplex(self, payload: Any, up: Any):
        raise NotImplementedError
        yield


def frames(model: Any, *payloads: dict[str, Any]) -> list[Any]:
    return [model.model_validate(payload) for payload in payloads]


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


async def test_every_handle_fails_together_when_the_transport_raises():
    class Broken(FakeTransport):
        async def call_stream(self, payload: Any):
            raise RuntimeError("worker gone")
            yield

    run = streams.upscale(Broken(), model_id="m", image=b"png")
    for handle in (run.collected, run.result, run.stats, run.done):
        with pytest.raises(RuntimeError, match="worker gone"):
            _ = await handle
    with pytest.raises(RuntimeError):
        async for _ in run.stream:
            pass


async def test_a_stream_without_its_terminal_frame_fails():
    transport = FakeTransport(
        frames(
            schemas.UpscaleStreamResponse, {"type": "upscaleStream", "data": b64(b"a")}
        )
    )
    run = streams.upscale(transport, model_id="m", image=b"png")
    with pytest.raises(StreamEndedError):
        await run.result


async def test_upscale_collects_the_images_and_sends_bare_base64():
    transport = FakeTransport(
        frames(
            schemas.UpscaleStreamResponse,
            {"type": "upscaleStream", "data": b64(b"one")},
            {"type": "upscaleStream", "done": True},
        )
    )
    run = streams.upscale(transport, model_id="m", image=b"png")
    assert await run.result == [b"one"]
    assert transport.sent[0]["image"] == b64(b"png")
    streams.upscale(FakeTransport(), model_id="m", image="aGVsbG8=")


async def test_ocr_flattens_the_block_batches():
    block = {"text": "hi", "bbox": [0, 0, 1, 1], "confidence": 1}
    transport = FakeTransport(
        frames(
            schemas.OcrStreamResponse,
            {"type": "ocrStream", "blocks": [block]},
            {"type": "ocrStream", "blocks": [block, block], "done": True},
        )
    )
    run = streams.ocr(transport, model_id="m", image="/tmp/page.png")
    assert len(await run.result) == 3
    assert [len(batch) async for batch in run.stream] == [1, 2]
    assert transport.sent[0]["image"] == {"type": "filePath", "value": "/tmp/page.png"}


async def test_transcribe_uses_the_upfront_audio_method():
    transport = FakeTransport(
        frames(
            schemas.TranscribeResponse,
            {"type": "transcribe", "text": "hello "},
            {"type": "transcribe", "text": "world"},
            {"type": "transcribe", "done": True},
        )
    )
    run = streams.transcribe(transport, model_id="m", audio=b"\x00\x01")
    assert await run.result == ["hello ", "world"]
    sent = transport.sent[0]
    assert sent["type"] == "transcribe"
    assert sent["audioChunk"] == {"type": "base64", "value": b64(b"\x00\x01")}


async def test_text_to_speech_folds_samples_and_rate():
    transport = FakeTransport(
        frames(
            schemas.TextToSpeechResponse,
            {
                "type": "textToSpeech",
                "buffer": [1, 2],
                "sampleRate": 24000,
                "done": False,
            },
            {"type": "textToSpeech", "buffer": [3], "done": True},
        )
    )
    run = streams.text_to_speech(transport, model_id="m", text="hi", request_id="r-1")
    audio = await run.result
    assert audio == streams.TtsAudio([1, 2, 3], 24000)
    assert transport.sent[0]["requestId"] == "r-1"


AUDIO = {
    "type": "audioGenStream",
    "sampleRate": 48000,
    "channels": 2,
    "bitsPerSample": 16,
    "done": False,
}
TICK = {"stage": "decode", "step": 1, "total": 2}


async def test_audio_gen_folds_the_audio_and_its_format():
    transport = FakeTransport(
        frames(
            schemas.AudioGenStreamResponse,
            {**AUDIO, "data": b64(b"ab"), "progress": TICK},
            {**AUDIO, "data": b64(b"cd")},
            {"type": "audioGenStream", "done": True, "stopReason": "completed"},
        )
    )
    run = streams.audio_gen(transport, model_id="m", caption="rain")
    assert await run.result == streams.GeneratedAudio(b"abcd", 48000, 2, 16)
    assert len([tick async for tick in run.progress_stream]) == 1


async def test_audio_gen_fails_on_a_truncated_stream():
    transport = FakeTransport(
        frames(schemas.AudioGenStreamResponse, {**AUDIO, "data": b64(b"ab")})
    )
    run = streams.audio_gen(transport, model_id="m", caption="rain")
    with pytest.raises(InvalidResponseError, match="audioGenStream terminal response"):
        await run.result


async def test_audio_gen_rejects_a_cancelled_generation():
    transport = FakeTransport(
        frames(
            schemas.AudioGenStreamResponse,
            {**AUDIO, "data": b64(b"ab")},
            {"type": "audioGenStream", "done": True, "stopReason": "cancelled"},
        )
    )
    run = streams.audio_gen(transport, model_id="m", caption="rain", request_id="r-9")
    with pytest.raises(InferenceCancelledError) as caught:
        await run.result
    assert caught.value.request_id == "r-9"


async def test_audio_gen_requires_the_audio_format():
    transport = FakeTransport(
        frames(
            schemas.AudioGenStreamResponse,
            {"type": "audioGenStream", "data": b64(b"ab"), "done": False},
            {"type": "audioGenStream", "done": True},
        )
    )
    run = streams.audio_gen(transport, model_id="m", caption="rain")
    with pytest.raises(InvalidResponseError, match="audioGenStream audio chunk"):
        await run.result


def understood(caption: str) -> dict[str, Any]:
    return {
        "caption": caption,
        "bpm": 120,
        "duration": 1,
        "keyscale": "C major",
        "timesignature": "4",
        "vocalLanguage": "en",
        "audioCodes": [],
    }


async def test_audio_understand_takes_the_last_description():
    transport = FakeTransport(
        frames(
            schemas.AudioUnderstandResponse,
            {"type": "audioUnderstand", "understand": understood("a"), "done": False},
            {"type": "audioUnderstand", "understand": understood("b"), "done": True},
        )
    )
    run = streams.audio_understand(
        transport, model_id="m", source_audio="/tmp/clip.wav"
    )
    assert (await run.result).model_dump()["caption"] == "b"


async def test_world_scene_joins_the_pack():
    transport = FakeTransport(
        frames(
            schemas.WorldSceneStreamResponse,
            {"type": "worldSceneStream", "data": b64(b"ab")},
            {"type": "worldSceneStream", "data": b64(b"cd"), "done": True},
        )
    )
    run = streams.world_create_scene(
        transport, model_id="m", prompt="a room", image="aW1n"
    )
    assert await run.result == b"abcd"


def delta(prompt: str, text: str) -> dict[str, Any]:
    return {"id": prompt, "event": {"type": "contentDelta", "seq": 0, "text": text}}


def done(prompt: str, stop: str = "eos") -> dict[str, Any]:
    event: dict[str, Any] = {"type": "completionDone", "seq": 1, "stopReason": stop}
    if stop == "error":
        event["error"] = {"message": "addon failed"}
    return {"id": prompt, "event": event}


def batch(*payloads: dict[str, Any]) -> list[Any]:
    return frames(
        schemas.BatchCompletionStreamResponse,
        *({"type": "batchCompletionStream", **payload} for payload in payloads),
    )


PROMPTS = [{"id": "a", "history": []}, {"id": "b", "history": []}]


async def test_batch_folds_one_final_per_prompt_in_prompt_order():
    transport = FakeTransport(
        batch(
            {"ids": ["a", "b"], "events": [delta("b", "B"), delta("a", "A")]},
            {"events": [done("a"), done("b")], "done": True},
        )
    )
    run = streams.batch_completion(transport, model_id="m", prompts=PROMPTS)
    results = await run.result
    assert [(r.id, r.final.content_text) for r in results] == [("a", "A"), ("b", "B")]
    assert (await run.by_id("b")).content_text == "B"


async def test_batch_falls_back_to_the_prompts_ids_without_an_ids_frame():
    transport = FakeTransport(
        batch(
            {
                "events": [delta("a", "A"), done("a"), delta("b", "B"), done("b")],
                "done": True,
            }
        )
    )
    run = streams.batch_completion(transport, model_id="m", prompts=PROMPTS)
    assert [r.id for r in await run.result] == ["a", "b"]
    assert await run.ids == ["a", "b"]


async def test_batch_rejects_when_a_prompt_failed_and_by_id_settles_per_prompt():
    transport = FakeTransport(
        batch(
            {
                "ids": ["a", "b"],
                "events": [delta("a", "A"), done("a"), done("b", "error")],
            },
            {"events": [], "done": True},
        )
    )
    run = streams.batch_completion(transport, model_id="m", prompts=PROMPTS)
    with pytest.raises(CompletionFailedError):
        await run.result
    assert (await run.by_id("a")).content_text == "A"
    with pytest.raises(CompletionFailedError):
        await run.by_id("b")


async def test_batch_rejects_a_cancelled_prompt():
    transport = FakeTransport(
        batch(
            {
                "ids": ["a", "b"],
                "events": [done("a"), done("b", "cancelled")],
                "done": True,
            }
        )
    )
    run = streams.batch_completion(
        transport, model_id="m", prompts=PROMPTS, request_id="r-2"
    )
    with pytest.raises(InferenceCancelledError):
        await run.result
    with pytest.raises(InferenceCancelledError):
        await run.by_id("b")
