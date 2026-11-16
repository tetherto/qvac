"""Wire-transport interface the generated method stubs call through.

This package generates the typed request/response models and method stubs
from the SDK's contract; it does not implement the socket transport that
speaks the worker's `bare-rpc` protocol — that is a separate, still unbuilt
piece.

Asyncio-native, matching the JS SDK (Promises / async iterators for
streaming methods) rather than a blocking/generator-based shape.

Any object providing these three methods can back the generated stubs.
`tetherto.qvac_sdk.bare_rpc_transport.BareRpcTransport` is the production
implementation; tests may also back it with a fake for pure request/response
shaping.
"""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import Any, Protocol


def held_model_change(
    request: dict[str, Any], response: dict[str, Any]
) -> tuple[str, bool] | None:
    """The model a reply to `request` made its caller hold (True) or release
    (False), or None for any other reply. A `loadModel` reply names the model;
    an `unloadModel` reply that released the lease drops it. Both arrive on the
    unary call and, for a load with progress, as the last frame of the stream.
    `SessionTransport` and `BareRpcTransport` apply it to every reply, so a
    model loaded through a generated stub is tracked as well."""
    kind = request.get("type")
    if response.get("type") != kind or response.get("success") is False:
        return None
    if kind == "loadModel":
        model_id = response.get("modelId")
        return (model_id, True) if isinstance(model_id, str) else None
    if kind == "unloadModel" and response.get("released") is not False:
        model_id = request.get("modelId")
        return (model_id, False) if isinstance(model_id, str) else None
    return None


class Transport(Protocol):
    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Unary request/reply: send `payload`, return the single parsed response."""
        ...

    def call_stream(self, payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        """Server-stream: send `payload`, yield each parsed response chunk."""
        ...

    def call_duplex(
        self, payload: dict[str, Any], up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict[str, Any]]:
        """Duplex: send `payload` then stream `up` chunks, yield response chunks."""
        ...
