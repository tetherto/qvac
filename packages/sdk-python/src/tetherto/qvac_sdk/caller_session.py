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
The operations that change the runtime for every session (`suspend`,
`resume`, `delete_cache`, `start_rpc_server`, `stop_rpc_server`) and the
session management calls (`open_session`, `close_session`) raise
`OwnerOnlyError` on a session transport.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, AsyncIterator, Callable
from typing import Any

from ._api import generate_client_request_id
from ._transport import Transport, held_model_change
from .errors import (
    InvalidResponseError,
    ModelHandleInvalidatedError,
    OwnerOnlyError,
    SessionInvalidatedError,
)

# Operations reserved for the owner client: the ones that change the shared
# runtime for every session, and session management itself, since a session
# must not open or close sessions by naming their ids. The session transport
# refuses them before any wire traffic, like a call on an ended session; the
# worker refuses the runtime-wide ones from a session as well.
OWNER_ONLY_OPERATIONS = frozenset(
    {
        "suspend",
        "resume",
        "deleteCache",
        "startRpcServer",
        "stopRpcServer",
        "openSession",
        "closeSession",
    }
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
        kind = payload.get("type")
        if kind in OWNER_ONLY_OPERATIONS:
            raise OwnerOnlyError(kind, self.session_id)
        # The handle's id replaces any id the payload carries, so a caller
        # cannot send a request as another session. `Session.close` sends its
        # `closeSession` through the owner transport, not through here.
        return {**payload, "sessionId": self.session_id}

    def _track(self, request: dict[str, Any], response: dict[str, Any]) -> None:
        change = held_model_change(request, response)
        if change is None:
            return
        model_id, held = change
        if held:
            self.record_held_model(model_id)
        else:
            self.release_held_model(model_id)

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        stamped = self._stamp(payload)
        response = await self._inner.call(stamped)
        self._track(stamped, response)
        return response

    # The streams check the session when iteration starts, which is when the
    # transport sends the request: a stream created before the session ended
    # and read after it is refused locally too.
    async def call_stream(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        stamped = self._stamp(payload)
        async for frame in _closing(self._inner.call_stream(stamped)):
            self._track(stamped, frame)
            yield frame

    async def call_duplex(
        self, payload: dict[str, Any], up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict[str, Any]]:
        async for frame in _closing(self._inner.call_duplex(self._stamp(payload), up)):
            yield frame


async def _closing(
    frames: AsyncIterator[dict[str, Any]],
) -> AsyncIterator[dict[str, Any]]:
    """Yields `frames` and closes them when the reader stops early, so an
    abandoned session stream still releases the transport's stream."""
    try:
        async for frame in frames:
            yield frame
    finally:
        close = getattr(frames, "aclose", None)
        if close is not None:
            await close()


class Session:
    """A caller session. Pass `session.transport` wherever a `Transport` goes."""

    def __init__(
        self,
        owner: Transport,
        session_id: str,
        name: str | None,
        on_closed: Callable[[Session], None] | None = None,
    ) -> None:
        self._owner = owner
        self._on_closed = on_closed
        self.session_id = session_id
        self.name = name
        self._transport = SessionTransport(owner, session_id)

    @property
    def transport(self) -> SessionTransport:
        return self._transport

    def is_model_held(self, model_id: str) -> bool:
        return self._transport.is_model_held(model_id)

    async def close(self) -> None:
        """Cancels the session's requests, disposes the vector indexes it
        opened, releases its model leases and ends the handle. Later calls
        through `transport` raise `SessionInvalidatedError`.

        Cancelling the caller does not stop the `closeSession` round trip: the
        handle is already ended, so no retry could send it."""
        if self._transport.ended is not None:
            raise SessionInvalidatedError(self.session_id, self._transport.ended)
        self._transport.end("closed")
        if self._on_closed is not None:
            self._on_closed(self)
        response = await asyncio.shield(
            self._owner.call({"type": "closeSession", "sessionId": self.session_id})
        )
        if response.get("type") != "closeSession":
            raise InvalidResponseError("closeSession")

    async def __aenter__(self) -> Session:
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._transport.ended is None:
            await self.close()


async def open_session(
    owner: Transport,
    name: str | None = None,
    *,
    on_closed: Callable[[Session], None] | None = None,
) -> Session:
    """Registers a new session on the worker and returns its handle. `owner`
    is the client's own transport: a session's transport stamps its id over
    every call, so a session opened through another session would run as
    its parent. `on_closed` runs when the handle's own `close()` ends it."""
    if isinstance(owner, SessionTransport):
        raise ValueError(
            f'session "{owner.session_id}" cannot open a session; '
            "pass the owner client's transport"
        )
    session_id = generate_client_request_id()
    payload: dict[str, Any] = {"type": "openSession", "sessionId": session_id}
    if name is not None:
        payload["name"] = name
    session = Session(owner, session_id, name, on_closed)
    # The owner transport ends its sessions when it closes or loses its worker,
    # including ones opened here directly rather than through `Client`. The
    # handle is tracked before the open is sent, so a close or a lost worker
    # while the open is in flight ends it too.
    track = getattr(owner, "track_session", None)
    if track is not None:
        track(session.transport)
    # A caller cancelled after the worker received `openSession` gets no
    # handle to close, so the open finishes on its own and closes the session
    # it opened.
    opening = asyncio.ensure_future(owner.call(payload))
    try:
        response = await asyncio.shield(opening)
    except asyncio.CancelledError:
        opening.add_done_callback(
            lambda task: _close_abandoned_session(owner, session_id, task)
        )
        raise
    if response.get("type") != "openSession":
        raise InvalidResponseError("openSession")
    return session


# The event loop keeps only weak references to tasks.
_abandoned_closes: set[asyncio.Future[Any]] = set()


def _close_abandoned_session(
    owner: Transport, session_id: str, opening: asyncio.Future[Any]
) -> None:
    if opening.cancelled() or opening.exception() is not None:
        return
    closing = asyncio.ensure_future(
        owner.call({"type": "closeSession", "sessionId": session_id})
    )
    _abandoned_closes.add(closing)
    closing.add_done_callback(_forget_abandoned_close)


def _forget_abandoned_close(closing: asyncio.Future[Any]) -> None:
    _abandoned_closes.discard(closing)
    # Nobody waits for this close; a runtime that stopped meanwhile has
    # dropped the session already.
    if not closing.cancelled():
        closing.exception()


__all__ = ["Session", "SessionTransport", "open_session"]
