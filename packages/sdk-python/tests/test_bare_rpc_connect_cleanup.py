"""Unit coverage for BareRpcTransport.connect() cleanup on spawn failure.

Does not need a built worker — only bare_rpc — so it runs in the fast PR check.
"""

from __future__ import annotations

import asyncio

import pytest

from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport

pytestmark = [pytest.mark.asyncio]


async def test_connect_closes_loopback_server_when_spawn_fails(monkeypatch) -> None:
    async def boom(*_args, **_kwargs):
        raise FileNotFoundError("fake missing bare binary")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)

    transport = BareRpcTransport(["/no/such/bare", "/no/such/worker.js"])
    with pytest.raises(FileNotFoundError, match="fake missing bare binary"):
        await transport.connect()

    assert transport._server is not None
    assert not transport._server.is_serving()
