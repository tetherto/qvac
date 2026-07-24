"""Unit coverage for BareRpcTransport.connect() cleanup on spawn failure.

Does not need a built worker — only the bare_rpc extra — so it runs in the
fast PR check once that extra is installed, and locally with `pip install -e
'.[bare-rpc]'`.
"""

from __future__ import annotations

import asyncio
import importlib.util

import pytest

from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport

BARE_RPC_AVAILABLE = importlib.util.find_spec("bare_rpc") is not None

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not BARE_RPC_AVAILABLE,
        reason="bare_rpc not installed -- install the 'bare-rpc' extra "
        "(`pip install -e '.[bare-rpc]'`) to run these tests",
    ),
]


async def test_connect_closes_loopback_server_when_spawn_fails(monkeypatch) -> None:
    async def boom(*_args, **_kwargs):
        raise FileNotFoundError("fake missing bare binary")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)

    transport = BareRpcTransport(["/no/such/bare", "/no/such/worker.js"])
    with pytest.raises(FileNotFoundError, match="fake missing bare binary"):
        await transport.connect()

    assert transport._server is not None
    assert not transport._server.is_serving()
