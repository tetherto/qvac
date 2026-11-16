"""How BareRpcTransport reports a worker that faults, exits or ignores
`terminate`, over bare-stow's host side and an in-memory fake worker.

Does not need a built worker, so it runs in the fast PR check.
"""

from __future__ import annotations

import asyncio
import functools

import pytest
from bare_stow_host import WorkerError
from conftest import FakeWorker, _HostEnd, answer_init_config

from tetherto.qvac_sdk import client as client_module
from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport
from tetherto.qvac_sdk.client import UnbundledWorker
from tetherto.qvac_sdk.errors import (
    SetConfigFailedError,
    WorkerCrashedError,
    WorkerShutdownError,
    WorkerStartupError,
)

pytestmark = [pytest.mark.asyncio]


class _Sidecar:
    """A `bare-sidecar` process for a fake worker, which exits once the worker
    is asked to terminate."""

    def __init__(self, worker: FakeWorker) -> None:
        self._worker = worker
        self._host = _HostEnd(worker)
        self.exit_code: int | None = 0
        self.signal_code: str | None = None

    async def read(self) -> bytes:
        return await self._host.read()

    async def write(self, data: bytes) -> None:
        await self._host.write(data)

    def kill(self) -> None:
        self._host.close()

    async def close(self) -> None:
        self._host.close()

    async def wait(self) -> None:
        await self._worker.terminated.wait()


async def test_a_worker_error_after_ready_reaches_the_caller(fake_worker) -> None:
    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        worker.control("error", message="worker blew up", stack="at x")
        worker.control("exit", code=1)

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        with pytest.raises(WorkerCrashedError) as raised:
            await asyncio.wait_for(transport.call({"type": "heartbeat"}), timeout=5)
        cause = raised.value.__cause__
        assert isinstance(cause, WorkerError)
        assert str(cause) == "worker blew up"
        assert cause.stack == "at x"
    finally:
        await transport.close()


async def test_a_crash_after_reconnecting_is_not_reported_as_a_shutdown(
    fake_worker,
) -> None:
    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        workers[-1].control("error", message="worker blew up")
        workers[-1].control("exit", code=1)

    workers: list[FakeWorker] = []

    async def start(timeout: float, *, grace: float = 5):
        workers.append(fake_worker(on_request))
        return await workers[-1].start(timeout, grace=grace)

    transport = BareRpcTransport(start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    await asyncio.wait_for(transport.close(), timeout=5)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        with pytest.raises(WorkerCrashedError):
            await asyncio.wait_for(transport.call({"type": "heartbeat"}), timeout=5)
    finally:
        await transport.close()


async def test_a_worker_that_ends_without_saying_why_reports_its_signal(
    fake_worker,
) -> None:
    ended = asyncio.Event()

    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        worker.to_host.end()
        ended.set()

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        call = asyncio.ensure_future(transport.call({"type": "heartbeat"}))
        await asyncio.wait_for(ended.wait(), timeout=5)
        assert transport.ipc is not None
        transport.ipc.exited(None, "SIGKILL")

        with pytest.raises(WorkerCrashedError) as raised:
            await asyncio.wait_for(call, timeout=5)
        assert raised.value.signal == "SIGKILL"
        cause = raised.value.__cause__
        assert isinstance(cause, WorkerError)
        assert cause.code == "WORKER_KILLED"
    finally:
        await transport.close()


async def test_a_duplex_call_ends_when_the_worker_destroys_its_request_stream(
    fake_worker,
) -> None:
    async def on_request(req) -> None:
        if req.data and await answer_init_config(req):
            return
        response = await req.create_response_stream()
        stream = req.request_stream
        await stream.read()
        stream.destroy()
        await response.write(b'{"type":"done"}\n')
        await response.end()

    async def up():
        await asyncio.Event().wait()
        yield b""

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        received = await asyncio.wait_for(
            _collect(transport.call_duplex({"type": "duplex"}, up())), timeout=5
        )
        assert received == [{"type": "done"}]
    finally:
        await transport.close()


async def test_a_duplex_upload_that_raises_ends_the_call_with_its_error(
    fake_worker,
) -> None:
    async def on_request(req) -> None:
        if req.data and await answer_init_config(req):
            return
        await req.create_response_stream()
        async for _ in req.request_stream:
            pass

    async def up():
        yield b"chunk"
        raise ValueError("upload failed")

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        with pytest.raises(ValueError, match="upload failed"):
            await asyncio.wait_for(
                _collect(transport.call_duplex({"type": "duplex"}, up())), timeout=5
            )
    finally:
        await transport.close()


async def _collect(values) -> list:
    return [value async for value in values]


async def test_a_call_in_flight_during_close_raises_shutdown(fake_worker) -> None:
    received = asyncio.Event()

    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        received.set()
        await asyncio.Event().wait()

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    call = asyncio.ensure_future(transport.call({"type": "heartbeat"}))
    await asyncio.wait_for(received.wait(), timeout=5)

    await asyncio.wait_for(transport.close(), timeout=5)

    with pytest.raises(WorkerShutdownError):
        await asyncio.wait_for(call, timeout=5)


async def test_a_call_after_close_raises_shutdown(fake_worker) -> None:
    worker = fake_worker(answer_init_config)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    await asyncio.wait_for(transport.close(), timeout=5)

    with pytest.raises(WorkerShutdownError):
        await asyncio.wait_for(transport.call({"type": "heartbeat"}), timeout=5)


async def test_a_worker_that_exits_on_its_own_fails_calls_as_crashed(
    fake_worker,
) -> None:
    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        worker.control("exit", code=3)
        worker.to_host.end()

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        with pytest.raises(WorkerCrashedError) as in_flight:
            await asyncio.wait_for(transport.call({"type": "heartbeat"}), timeout=5)
        assert in_flight.value.exit_code == 3

        with pytest.raises(WorkerCrashedError) as later:
            await asyncio.wait_for(transport.call({"type": "heartbeat"}), timeout=5)
        assert later.value.exit_code == 3
    finally:
        await transport.close()


async def test_close_terminates_the_worker(fake_worker) -> None:
    worker = fake_worker(answer_init_config)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)

    await asyncio.wait_for(transport.close(), timeout=5)

    assert worker.terminated.is_set()
    assert transport.ipc is not None
    assert transport.ipc.exit_code == 0


async def test_close_kills_a_worker_that_ignores_terminate(fake_worker) -> None:
    worker = fake_worker(answer_init_config)
    worker.answer_terminate = False
    transport = BareRpcTransport(functools.partial(worker.start, grace=0.2))
    await asyncio.wait_for(transport.connect(), timeout=5)

    await asyncio.wait_for(transport.close(), timeout=5)

    assert worker.terminated.is_set()
    assert worker.closed


async def test_cancelling_connect_terminates_a_worker_that_is_not_ready(
    fake_worker, monkeypatch, tmp_path
) -> None:
    worker = fake_worker(answer_init_config)

    async def spawn(*args: object, **kwargs: object) -> _Sidecar:
        return _Sidecar(worker)

    monkeypatch.setattr(client_module, "spawn", spawn)
    start = UnbundledWorker(tmp_path / "shim.js", tmp_path / "worker.js").start
    transport = BareRpcTransport(start)

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(transport.connect(), timeout=0.2)

    # bare-stow-host closes a cancelled start in a background task.
    await asyncio.wait_for(worker.terminated.wait(), timeout=2)


async def test_close_during_start_stops_the_worker_and_fails_connect_as_shutdown(
    fake_worker, monkeypatch, tmp_path
) -> None:
    worker = fake_worker(answer_init_config)
    spawned = asyncio.Event()

    async def spawn(*args: object, **kwargs: object) -> _Sidecar:
        spawned.set()
        return _Sidecar(worker)

    monkeypatch.setattr(client_module, "spawn", spawn)
    start = UnbundledWorker(tmp_path / "shim.js", tmp_path / "worker.js").start
    transport = BareRpcTransport(start)
    connecting = asyncio.ensure_future(transport.connect(timeout=30))
    await asyncio.wait_for(spawned.wait(), timeout=2)

    await asyncio.wait_for(transport.close(), timeout=2)

    with pytest.raises(WorkerShutdownError):
        await asyncio.wait_for(connecting, timeout=2)
    # bare-stow-host closes a cancelled start in a background task.
    await asyncio.wait_for(worker.terminated.wait(), timeout=2)


async def test_connect_terminates_the_worker_when_init_config_fails(
    fake_worker,
) -> None:
    async def on_request(req) -> None:
        await req.reply(b'{"success":false,"error":"bad config"}')

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)

    with pytest.raises(SetConfigFailedError, match="bad config"):
        await asyncio.wait_for(transport.connect(), timeout=5)

    assert worker.terminated.is_set()


@pytest.mark.parametrize(
    ("timeout_ms", "expected"),
    [(2000, 2.0), (1500.5, 1.5005), (True, 60.0), ("2000", 60.0)],
)
async def test_connect_starts_the_worker_with_the_configured_init_timeout(
    fake_worker, timeout_ms: object, expected: float
) -> None:
    worker = fake_worker(answer_init_config)
    timeouts: list[float] = []

    async def start(timeout: float):
        timeouts.append(timeout)
        return await worker.start(timeout)

    transport = BareRpcTransport(start, config={"rpcInitTimeoutMs": timeout_ms})
    await asyncio.wait_for(transport.connect(), timeout=5)
    await transport.close()

    assert timeouts == [expected]


async def test_connect_fails_when_the_worker_does_not_apply_its_config_in_time(
    fake_worker,
) -> None:
    async def on_request(req) -> None:
        await asyncio.Event().wait()

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)

    with pytest.raises(WorkerStartupError) as raised:
        await asyncio.wait_for(transport.connect(timeout=0.3), timeout=5)

    assert raised.value.timed_out
    assert worker.terminated.is_set()
