"""Caller sessions on a shared runtime.

    async with Client() as client:
        session = await client.open_session(name="harness")
        model_id = await load_model(session.transport, model_src=...)
        await cancel(session.transport, request_id=run.request_id)
        await session.close()

`Session.transport` satisfies `Transport`, so every wrapper and generated stub
works through it unchanged. Each payload it sends carries the session id, so
`cancel` reaches only this session's requests, `load_model` takes a lease the
session's `unload_model` releases, and `close()` ends the session without
shutting the runtime down. Only `Client.close()`, the owner's call, does that.
"""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import Any

from ._api import generate_client_request_id
from ._transport import Transport
from .errors import (
    InvalidResponseError,
    ModelHandleInvalidatedError,
    SessionInvalidatedError,
)


class SessionTransport:
    """Stamps every payload with the session id. Refuses calls once the
    session ended, locally, before any wire traffic."""

    def __init__(self, inner: Transport, session_id: str) -> None:
        self._inner = inner
        self.session_id = session_id
        self._ended: str | None = None
        self._held_models: set[str] = set()

    @property
    def ended(self) -> str | None:
        return self._ended

    def end(self, reason: str) -> None:
        if self._ended is None:
            self._ended = reason

    def record_held_model(self, model_id: str) -> None:
        self._held_models.add(model_id)

    def release_held_model(self, model_id: str) -> None:
        self._held_models.discard(model_id)

    def is_model_held(self, model_id: str) -> bool:
        return model_id in self._held_models

    def _stamp(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._ended is not None:
            model_id = payload.get("modelId")
            if isinstance(model_id, str) and model_id in self._held_models:
                raise ModelHandleInvalidatedError(model_id, self.session_id)
            raise SessionInvalidatedError(self.session_id, self._ended)
        # The handle's id replaces any id the payload carries, so a caller
        # cannot send a request as another session. Only the session methods
        # themselves name the session they act on.
        if payload.get("type") in ("openSession", "closeSession"):
            return payload
        return {**payload, "sessionId": self.session_id}

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._inner.call(self._stamp(payload))

    def call_stream(self, payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        return self._inner.call_stream(self._stamp(payload))

    def call_duplex(
        self, payload: dict[str, Any], up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict[str, Any]]:
        return self._inner.call_duplex(self._stamp(payload), up)


class Session:
    """A caller session. Pass `session.transport` wherever a `Transport` goes."""

    def __init__(self, owner: Transport, session_id: str, name: str | None) -> None:
        self._owner = owner
        self.session_id = session_id
        self.name = name
        self._transport = SessionTransport(owner, session_id)

    @property
    def transport(self) -> SessionTransport:
        return self._transport

    def is_model_held(self, model_id: str) -> bool:
        return self._transport.is_model_held(model_id)

    async def close(self) -> None:
        """Cancels the session's requests, releases its model leases and ends
        the handle. Later calls through `transport` raise
        `SessionInvalidatedError`."""
        if self._transport.ended is not None:
            raise SessionInvalidatedError(self.session_id, self._transport.ended)
        self._transport.end("closed")
        response = await self._owner.call(
            {"type": "closeSession", "sessionId": self.session_id}
        )
        if response.get("type") != "closeSession":
            raise InvalidResponseError("closeSession")

    async def __aenter__(self) -> Session:
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._transport.ended is None:
            await self.close()


async def open_session(owner: Transport, name: str | None = None) -> Session:
    """Registers a new session on the worker and returns its handle. `owner`
    is the client's own transport: a session's transport stamps its id over
    every call, so a session opened through another session would run as
    its parent."""
    if isinstance(owner, SessionTransport):
        raise ValueError(
            f'session "{owner.session_id}" cannot open a session; '
            "pass the owner client's transport"
        )
    session_id = generate_client_request_id()
    payload: dict[str, Any] = {"type": "openSession", "sessionId": session_id}
    if name is not None:
        payload["name"] = name
    response = await owner.call(payload)
    if response.get("type") != "openSession":
        raise InvalidResponseError("openSession")
    return Session(owner, session_id, name)


__all__ = ["Session", "SessionTransport", "open_session"]
