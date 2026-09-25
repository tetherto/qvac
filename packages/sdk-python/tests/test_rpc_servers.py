"""Generated RPC server methods preserve the worker wire contract."""

import pytest
from pydantic import ValidationError
from test_api import FakeTransport

from tetherto.qvac_sdk.methods import (
    discover_rpc_servers,
    start_rpc_server,
    stop_rpc_server,
)
from tetherto.qvac_sdk.schemas import (
    DiscoverRpcServersRequest,
    StartRpcServerRequest,
    StopRpcServerRequest,
)


async def test_managed_rpc_server_wire_contract():
    transport = FakeTransport(
        {
            "type": "startRpcServer",
            "serverId": "owned",
            "url": "10.0.0.2:50052",
            "runtime": "in-process",
            "rdmaCapable": False,
        }
    )
    server = await start_rpc_server(
        transport,
        StartRpcServerRequest(
            type="startRpcServer",
            host="10.0.0.2",
            port=50052,
            allow_non_loopback_host=True,
            discovery_topic="private-group",
        ),
    )
    assert server.server_id == "owned"
    assert server.rdma_capable is False
    assert transport.sent == {
        "type": "startRpcServer",
        "host": "10.0.0.2",
        "port": 50052,
        "allowNonLoopbackHost": True,
        "discoveryTopic": "private-group",
    }
    transport.response = {"type": "stopRpcServer"}
    await stop_rpc_server(
        transport,
        StopRpcServerRequest(type="stopRpcServer", server_id=server.server_id),
    )
    assert transport.sent == {"type": "stopRpcServer", "serverId": "owned"}


async def test_discovery_preserves_candidate_order_and_empty_results():
    transport = FakeTransport(
        {
            "type": "discoverRpcServers",
            "servers": [
                {"url": "10.0.0.3:50052"},
                {"url": "10.0.0.2:50052"},
            ],
        }
    )
    request = DiscoverRpcServersRequest(
        type="discoverRpcServers", topic="private-group", timeout_ms=100
    )
    result = await discover_rpc_servers(transport, request)
    assert [server.url for server in result.servers] == [
        "10.0.0.3:50052",
        "10.0.0.2:50052",
    ]
    assert transport.sent == {
        "type": "discoverRpcServers",
        "topic": "private-group",
        "timeoutMs": 100,
    }
    transport.response = {"type": "discoverRpcServers", "servers": []}
    assert (await discover_rpc_servers(transport, request)).servers == []


def test_rpc_server_input_bounds():
    with pytest.raises(ValidationError):
        StartRpcServerRequest(port=0)
    with pytest.raises(ValidationError):
        DiscoverRpcServersRequest(topic="private-group", timeout_ms=30001)
