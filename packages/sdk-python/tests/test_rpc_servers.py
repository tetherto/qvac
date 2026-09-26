"""Generated RPC server methods preserve the worker wire contract."""

import pytest
from pydantic import ValidationError
from test_api import FakeTransport

from tetherto.qvac_sdk import cancel
from tetherto.qvac_sdk.errors import InferenceCancelledError, reconstruct_error
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
            request_id="start-rpc-request",
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
        "requestId": "start-rpc-request",
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
        type="discoverRpcServers",
        topic="private-group",
        timeout_ms=100,
        request_id="discover-rpc-request",
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
        "requestId": "discover-rpc-request",
    }
    transport.response = {"type": "discoverRpcServers", "servers": []}
    assert (await discover_rpc_servers(transport, request)).servers == []


def test_rpc_server_input_bounds():
    with pytest.raises(ValidationError):
        StartRpcServerRequest(port=0)
    with pytest.raises(ValidationError):
        DiscoverRpcServersRequest(topic="private-group", timeout_ms=30001)
    with pytest.raises(ValidationError):
        StartRpcServerRequest(request_id="")
    with pytest.raises(ValidationError):
        DiscoverRpcServersRequest(topic="private-group", request_id="")


async def test_rpc_cancel_uses_the_same_request_id():
    transport = FakeTransport({"type": "discoverRpcServers", "servers": []})
    request = DiscoverRpcServersRequest(topic="private-group", request_id="rpc-search")
    await discover_rpc_servers(transport, request)
    assert transport.sent is not None
    assert transport.sent["requestId"] == request.request_id
    transport.response = {"type": "cancel", "success": True, "cancelled": 1}
    await cancel(transport, request_id=request.request_id)
    assert transport.sent == {
        "type": "cancel",
        "operation": "request",
        "requestId": "rpc-search",
    }


def test_rpc_cancellation_reconstructs_with_request_id():
    error = reconstruct_error(
        {
            "type": "error",
            "name": "INFERENCE_CANCELLED",
            "code": 52419,
            "message": "Inference cancelled",
            "typedFields": {"requestId": "rpc-search"},
        }
    )
    assert isinstance(error, InferenceCancelledError)
    assert error.request_id == "rpc-search"
