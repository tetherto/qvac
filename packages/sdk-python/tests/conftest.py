from __future__ import annotations

import asyncio

import pytest

from tetherto.qvac_sdk import bare_rpc_transport


class _FakeProc:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self._exited = asyncio.Event()

    def exit(self, code: int = 0) -> None:
        self.returncode = code
        self._exited.set()

    def terminate(self) -> None:
        self.exit()

    kill = terminate

    async def wait(self) -> int:
        await self._exited.wait()
        assert self.returncode is not None
        return self.returncode


class _Spawn:
    def __init__(self) -> None:
        self.argv: tuple = ()
        self.env: dict = {}
        self.proc: _FakeProc | None = None
        self.ready = asyncio.Event()

    @property
    def port(self) -> int:
        return int(self.argv[-1])

    @property
    def token(self) -> bytes:
        return self.env["QVAC_IPC_AUTH_TOKEN"].encode("ascii")


@pytest.fixture
def spawn(monkeypatch) -> _Spawn:
    captured = _Spawn()
    monkeypatch.setattr(bare_rpc_transport, "_HANDSHAKE_TIMEOUT", 0.5)

    async def fake_exec(*argv, env=None, **_kwargs):
        captured.argv = argv
        captured.env = env or {}
        captured.proc = _FakeProc()
        captured.ready.set()
        return captured.proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return captured
