"""Per-call deadlines the runtime enforces.

    bounded = with_deadline(client.transport, queue_ms=10_000, idle_ms=90_000)
    run = completion(bounded, model_id=model_id, history=history)

`with_deadline` returns a transport, so every wrapper and generated stub works
through it unchanged. Each request it sends carries the deadline, and the
worker fails the call with `DeadlineExceededError` when one passes. A value
can shorten the one the runtime configuration sets for the same field and
never lengthens it.
"""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import Any

from ._transport import Transport

# The request types that register no work on the worker. Their schemas take no
# `deadline`, and several refuse unknown fields.
UNTRACKED_REQUEST_TYPES = frozenset(
    {
        "assessModelFit",
        "calcTokens",
        "cancel",
        "closeSession",
        "deleteCache",
        "getLoadedModelInfo",
        "getModelInfo",
        "getRuntimeCapabilities",
        "getSystemResources",
        "heartbeat",
        "loggingStream",
        "openSession",
        "resume",
        "state",
        "stopRpcServer",
        "suspend",
        "unloadModel",
    }
)


class DeadlineTransport:
    """Adds a deadline to every request that registers work. A request that
    already carries a `deadline` keeps its own."""

    def __init__(self, inner: Transport, deadline: dict[str, int]) -> None:
        self._inner = inner
        self._deadline = deadline

    def __getattr__(self, name: str) -> Any:
        # Session and worker transports expose more than the three call
        # methods; the wrappers that read those attributes get the inner ones.
        return getattr(self._inner, name)

    def _stamp(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("type") in UNTRACKED_REQUEST_TYPES or "deadline" in payload:
            return payload
        return {**payload, "deadline": self._deadline}

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._inner.call(self._stamp(payload))

    def call_stream(self, payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        return self._inner.call_stream(self._stamp(payload))

    def call_duplex(
        self, payload: dict[str, Any], up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict[str, Any]]:
        return self._inner.call_duplex(self._stamp(payload), up)


def with_deadline(
    transport: Transport,
    *,
    queue_ms: int | None = None,
    idle_ms: int | None = None,
    run_ms: int | None = None,
    load_ms: int | None = None,
) -> DeadlineTransport:
    """Returns a transport whose requests carry these deadlines.

    - `queue_ms`: longest wait for an admission slot on the model.
    - `idle_ms`: longest gap between two progress events of a streaming call.
    - `run_ms`: longest run, from admission to the end of the request.
    - `load_ms`: longest model load, from the end of the download. Read only
      by `load_model`.
    """
    fields = {
        "queueMs": queue_ms,
        "idleMs": idle_ms,
        "runMs": run_ms,
        "loadMs": load_ms,
    }
    deadline = {key: value for key, value in fields.items() if value is not None}
    for key, value in deadline.items():
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{key} must be a positive integer of milliseconds")
    return DeadlineTransport(transport, deadline)


__all__ = ["DeadlineTransport", "with_deadline"]
