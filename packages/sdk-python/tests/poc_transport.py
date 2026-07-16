"""Adapts the hand-written PoC's `QvacWorker` (poc_heartbeat.py) to the
`qvac._transport.Transport` protocol, so the generated stubs in
`qvac.methods` (and the request/response types in `qvac.schemas`) can be
smoke-tested against a real running worker ahead of the production
`bare-rpc-python` transport (not yet built).
"""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Import-time only (see `from __future__ import annotations` above) --
    # poc_heartbeat.py imports this module's PocTransport for its own demos,
    # so a real top-level import here would be circular.
    from poc_heartbeat import QvacWorker


class PocTransport:
    def __init__(self, worker: QvacWorker) -> None:
        self._worker = worker

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._worker.call(payload)

    async def call_stream(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        async for chunk in self._worker.call_stream(payload):
            yield chunk

    async def call_duplex(
        self, payload: dict[str, Any], up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict[str, Any]]:
        async for chunk in self._worker._duplex_call(payload, up):
            yield chunk
