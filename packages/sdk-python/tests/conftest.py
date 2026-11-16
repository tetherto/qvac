from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable

import bare_rpc
import pytest
from bare_stow_host import IPC, wrap
from bare_stow_host.protocol import (
    CONTROL,
    USER,
    FrameDecoder,
    encode_control,
    encode_frame,
)


class _Pipe:
    """One direction of an in-memory byte transport."""

    def __init__(self) -> None:
        self._chunks: asyncio.Queue[bytes] = asyncio.Queue()

    def push(self, data: bytes) -> None:
        self._chunks.put_nowait(data)

    def end(self) -> None:
        self._chunks.put_nowait(b"")

    async def read(self) -> bytes:
        return await self._chunks.get()


class _HostEnd:
    """The host's end of a fake worker's transport: read, write and close."""

    def __init__(self, worker: FakeWorker) -> None:
        self._worker = worker

    async def read(self) -> bytes:
        return await self._worker.to_host.read()

    async def write(self, data: bytes) -> None:
        self._worker.from_host(data)

    def close(self) -> None:
        self._worker.closed = True
        self._worker.to_host.end()


class _WorkerUserData:
    """The worker's side of the user data channel, which its bare-rpc runs on."""

    def __init__(self, worker: FakeWorker) -> None:
        self._worker = worker
        self.incoming = _Pipe()

    async def read(self) -> bytes:
        return await self.incoming.read()

    async def write(self, data: bytes) -> None:
        self._worker.to_host.push(encode_frame(USER, data))

    def close(self) -> None:
        pass


class FakeWorker:
    """A worker speaking bare-stow's protocol and bare-rpc in memory, in place
    of a Bare process. `on_request` answers the host's requests."""

    def __init__(self, on_request: Callable[..., Awaitable[None]]) -> None:
        self.to_host = _Pipe()
        self.user = _WorkerUserData(self)
        self._decoder = FrameDecoder()
        self._on_request = on_request
        self.closed = False
        self.terminated = asyncio.Event()
        self.answer_terminate = True
        self.rpc: bare_rpc.RPC | None = None

    def control(self, type: str, **payload: object) -> None:
        self.to_host.push(encode_control(type, **payload))

    def from_host(self, data: bytes) -> None:
        for tag, payload in self._decoder.feed(data):
            if tag == USER:
                self.user.incoming.push(payload)
            elif tag == CONTROL and json.loads(payload).get("type") == "terminate":
                self.terminated.set()
                if self.answer_terminate:
                    self.control("exit", code=0)
                    self.to_host.end()

    async def start(self, timeout: float, *, grace: float = 5) -> IPC:
        self.rpc = bare_rpc.RPC(self.user, on_request=self._on_request)
        ipc = wrap(_HostEnd(self), timeout=timeout, grace=grace)
        self.control("ready")
        await ipc.ready
        return ipc


async def answer_init_config(req) -> bool:
    """Answers `__init_config`; False for any other request."""
    if json.loads(req.data).get("type") != "__init_config":
        return False
    await req.reply(b'{"success":true}')
    return True


@pytest.fixture
def fake_worker() -> Callable[..., FakeWorker]:
    return FakeWorker
