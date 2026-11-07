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
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class HeldModelTracker(Protocol):
    """A transport that records the models loaded through it, so a model loaded
    through a session can be told apart from an unknown id once the session
    ended. `SessionTransport` implements it; the plain worker transport does
    not."""

    def record_held_model(self, model_id: str) -> None:
        """A load through this transport resolved to `model_id`."""

    def release_held_model(self, model_id: str) -> None:
        """An unload through this transport released `model_id`."""


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
