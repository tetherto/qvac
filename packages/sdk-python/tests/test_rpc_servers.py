"""Generated RPC server methods preserve the worker wire contract."""

import pytest
from pydantic import ValidationError
from test_api import FakeTransport

from tetherto.qvac_sdk import cancel
from tetherto.qvac_sdk.errors import InferenceCancelledError, reconstruct_error
from tetherto.qvac_sdk.methods import (
    discover_rpc_servers,
    rpc_server_status_stream,
    start_rpc_server,
    stop_rpc_server,
)
from tetherto.qvac_sdk.schemas import (
    DiscoverRpcServersRequest,
    RpcServerStatusStreamRequest,
    StartRpcServerRequest,
    StopRpcServerRequest,
)


@pytest.mark.parametrize("rdma_capable", [False, True])
async def test_managed_rpc_server_wire_contract(rdma_capable):
    transport = FakeTransport(
        {
            "type": "startRpcServer",
            "serverId": "owned",
            "url": "10.0.0.2:50052",
            "rdmaCapable": rdma_capable,
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
    assert server.rdma_capable is rdma_capable
    assert "runtime" not in server.model_dump(by_alias=True)
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


async def test_discovery_preserves_rdma_availability_candidate_order_and_empty_results():
    transport = FakeTransport(
        {
            "type": "discoverRpcServers",
            "servers": [
                {
                    "url": "10.0.0.3:50052",
                    "rdmaAvailable": False,
                    "devices": [
                        {"index": 0, "freeMemory": 1024, "totalMemory": 2048},
                        {"index": 1, "freeMemory": 512, "totalMemory": 2048},
                    ],
                },
                {
                    "url": "10.0.0.2:50052",
                    "rdmaAvailable": True,
                    "devices": [{"index": 0, "freeMemory": 4096, "totalMemory": 8192}],
                },
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
    assert [server.rdma_available for server in result.servers] == [False, True]
    assert [
        server.model_dump(by_alias=True)["rdmaAvailable"] for server in result.servers
    ] == [
        False,
        True,
    ]
    assert [device.index for device in result.servers[0].devices] == [0, 1]
    assert result.servers[1].devices[0].total_memory == 8192
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


async def test_rpc_status_stream_preserves_ownership_recovery_and_structured_cause():
    cause = {
        "name": "Error",
        "message": "send failed",
        "cause": {"message": "link lost"},
    }
    common = {
        "type": "rpcServerStatusStream",
        "serverId": "owned",
        "url": "10.0.0.2:50052",
        "nativeState": "owned",
    }
    transport = FakeTransport(
        [
            {
                **common,
                "advertisement": "advertising",
                "reason": "ready",
                "recovery": "none",
            },
            {
                **common,
                "advertisement": "suspended",
                "reason": "runtime suspended",
                "recovery": "resume",
            },
            {
                **common,
                "advertisement": "failed",
                "reason": "send failed",
                "recovery": "restart",
                "error": {
                    "type": "error",
                    "name": "RPC_SERVER_OPERATION_FAILED",
                    "message": "Advertising failed",
                    "cause": cause,
                    "typedFields": {"operation": "advertise", "details": "send failed"},
                },
            },
        ]
    )
    events = [
        event
        async for event in rpc_server_status_stream(
            transport,
            RpcServerStatusStreamRequest(
                type="rpcServerStatusStream", server_id="owned"
            ),
        )
    ]
    assert transport.sent == {"type": "rpcServerStatusStream", "serverId": "owned"}
    assert [event.advertisement.value for event in events] == [
        "advertising",
        "suspended",
        "failed",
    ]
    assert [event.recovery.value for event in events] == ["none", "resume", "restart"]
    assert all(
        event.native_state.value == "owned" and event.server_id == "owned"
        for event in events
    )
    failure = events[-1].error
    assert failure is not None
    assert failure.cause == cause
    assert failure.typed_fields is not None
    assert failure.typed_fields.root["operation"] == "advertise"
    assert failure.model_dump(by_alias=True)["cause"]["cause"]["message"] == "link lost"


def test_rpc_status_stream_rejects_invalid_states_and_identity():
    from tetherto.qvac_sdk.schemas import RpcServerStatusStreamResponse

    valid = {
        "serverId": "owned",
        "url": "10.0.0.2:50052",
        "nativeState": "owned",
        "advertisement": "advertising",
        "reason": "ready",
        "recovery": "none",
    }
    for field, value in [
        ("serverId", ""),
        ("advertisement", "unknown"),
        ("recovery", "retry"),
    ]:
        with pytest.raises(ValidationError):
            RpcServerStatusStreamResponse.model_validate({**valid, field: value})


async def test_explicit_lan_addresses_reach_serving_and_discovery_in_order():
    addresses = ["10.0.1.2", "10.0.0.2"]
    transport = FakeTransport(
        {
            "type": "startRpcServer",
            "serverId": "selected-interface",
            "url": "10.0.0.2:50052",
            "rdmaCapable": False,
        }
    )
    await start_rpc_server(
        transport,
        StartRpcServerRequest(
            type="startRpcServer",
            host="10.0.0.2",
            allow_non_loopback_host=True,
            discovery_topic="renamed-adapter",
            lan_addresses=addresses,
        ),
    )
    assert transport.sent is not None
    assert transport.sent["host"] == "10.0.0.2"
    assert transport.sent["lanAddresses"] == addresses
    transport.response = {"type": "discoverRpcServers", "servers": []}
    await discover_rpc_servers(
        transport,
        DiscoverRpcServersRequest(
            type="discoverRpcServers", topic="renamed-adapter", lan_addresses=addresses
        ),
    )
    assert transport.sent == {
        "type": "discoverRpcServers",
        "topic": "renamed-adapter",
        "lanAddresses": addresses,
    }


@pytest.mark.parametrize(
    "addresses", [[], ["10.0.0.2"] * 9, ["192.0.2.1"], ["10.0.0.999"], [""]]
)
@pytest.mark.parametrize(
    ("request_type", "fields"),
    [(StartRpcServerRequest, {}), (DiscoverRpcServersRequest, {"topic": "selected"})],
)
def test_explicit_lan_address_bounds(request_type, fields, addresses):
    with pytest.raises(ValidationError):
        request_type.model_validate({**fields, "lanAddresses": addresses})
