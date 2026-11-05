"""Payloads built by the generated method stubs carry their constant labels
and no other field the caller did not set."""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterator
from typing import Any, Literal, get_args

import pytest
from pydantic import RootModel

from tetherto.qvac_sdk import methods
from tetherto.qvac_sdk._generated.models import (
    CancelRequestBroad,
    LoadModelSrcRequestLlamacppEmbedding,
    RagRequestSearch,
    TranscribeRequestAudioChunkFilePath,
    VectorIndexRequestDispose,
)
from tetherto.qvac_sdk._generated_base import GeneratedBaseModel, constant_fields
from tetherto.qvac_sdk.schemas import (
    CancelRequest,
    EmbedRequest,
    RagRequest,
    TranscribeRequest,
    TranscribeStreamRequest,
    VectorIndexRequest,
)


class Sent(Exception):
    pass


class RecordingTransport:
    """Records the outgoing payload, then stops the call before any response
    is validated."""

    def __init__(self) -> None:
        self.sent: dict[str, Any] | None = None

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.sent = payload
        raise Sent

    async def call_stream(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        self.sent = payload
        raise Sent
        yield  # pragma: no cover -- unreachable; makes this an async generator

    async def call_duplex(
        self, payload: dict[str, Any], up: Any
    ) -> AsyncIterator[dict[str, Any]]:
        self.sent = payload
        raise Sent
        yield  # pragma: no cover -- unreachable; makes this an async generator


async def no_chunks() -> AsyncIterator[bytes]:
    return
    yield  # pragma: no cover -- unreachable; makes this an async generator


async def send(func: Any, params: Any) -> dict[str, Any]:
    transport = RecordingTransport()
    args: list[Any] = [transport, params]
    if "up" in inspect.signature(func).parameters:
        args.append(no_chunks())
    with pytest.raises(Sent):
        if inspect.isasyncgenfunction(func):
            async for _ in func(*args):
                pass
        else:
            await func(*args)
    assert transport.sent is not None
    return transport.sent


def request_models(cls: Any) -> list[Any]:
    """The concrete models a request class can hold: itself, or every
    variant of a union request, nested unions included."""
    if issubclass(cls, RootModel):
        return [
            model
            for variant in get_args(cls.model_fields["root"].annotation)
            for model in request_models(variant)
        ]
    return [cls]


@pytest.mark.parametrize("name", methods.__all__)
def test_default_constant_fields_count_as_set(name: str):
    func = getattr(methods, name)
    cls = inspect.signature(func, eval_str=True).parameters["params"].annotation
    for model in request_models(cls):
        constants = constant_fields(model)
        assert "type" in constants, model.__name__
        assert constants <= model.model_construct().model_fields_set, model.__name__


def test_only_single_value_literals_with_a_default_are_constant():
    class Sample(GeneratedBaseModel):
        kind: Literal["a"] = "a"
        mode: Literal["x", "y"] = "x"
        tag: Literal["t"] | None = None
        name: Literal["n"]

    assert constant_fields(Sample) == {"kind"}
    assert Sample(name="n").model_dump(exclude_unset=True) == {"kind": "a", "name": "n"}


def test_load_model_variant_model_type_is_constant():
    assert constant_fields(LoadModelSrcRequestLlamacppEmbedding) == {
        "type",
        "model_type",
    }


async def test_reply_method_sends_type_and_only_set_fields():
    sent = await send(methods.embed, EmbedRequest(model_id="m", text="hello"))
    assert sent == {"type": "embed", "modelId": "m", "text": "hello"}


async def test_stream_method_sends_type_and_only_set_fields():
    request = TranscribeRequest(
        model_id="m", audio_chunk=TranscribeRequestAudioChunkFilePath(value="/a.wav")
    )
    sent = await send(methods.transcribe, request)
    assert sent == {
        "type": "transcribe",
        "modelId": "m",
        "audioChunk": {"type": "filePath", "value": "/a.wav"},
    }


async def test_duplex_method_sends_type_and_only_set_fields():
    sent = await send(methods.transcribe_stream, TranscribeStreamRequest(model_id="m"))
    assert sent == {"type": "transcribeStream", "modelId": "m"}


async def test_cancel_sends_variant_labels_and_only_set_fields():
    request = CancelRequest(root=CancelRequestBroad(model_id="m"))
    sent = await send(methods.cancel, request)
    assert sent == {"type": "cancel", "operation": "broad", "modelId": "m"}


async def test_rag_sends_variant_labels_and_only_set_fields():
    request = RagRequest(root=RagRequestSearch(model_id="m", query="q"))
    sent = await send(methods.rag, request)
    assert sent == {"type": "rag", "operation": "search", "modelId": "m", "query": "q"}


async def test_vector_index_sends_variant_labels_and_only_set_fields():
    request = VectorIndexRequest(root=VectorIndexRequestDispose(index_id="i"))
    sent = await send(methods.vector_index, request)
    assert sent == {"type": "vectorIndex", "operation": "dispose", "indexId": "i"}
