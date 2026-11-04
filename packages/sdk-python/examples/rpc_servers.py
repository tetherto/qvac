"""Serve or discover RPC endpoints.

Serving requires @qvac/ggml-rpc-server and a worker rebuilt with
rpcServerProvider: "@qvac/sdk/ggml-rpc-server/provider" in qvac.config.json.

python examples/rpc_servers.py serve my-private-rpc-group
python examples/rpc_servers.py serve 10.0.0.2 my-private-rpc-group
python examples/rpc_servers.py discover my-private-rpc-group
python examples/rpc_servers.py serve my-private-rpc-group --lan-address 10.0.0.2
python examples/rpc_servers.py discover my-private-rpc-group --lan-address 10.0.0.2
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from contextlib import aclosing

from tetherto.qvac_sdk import Client
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


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    serve = modes.add_parser("serve")
    serve.add_argument("host", nargs="?")
    serve.add_argument("topic")
    discover = modes.add_parser("discover")
    discover.add_argument("topic")
    for mode in (serve, discover):
        mode.add_argument(
            "--lan-address",
            action="append",
            help="Opt in to a local private IPv4 address, including renamed adapters. Repeat to select several.",
        )
    args = parser.parse_args()
    selection = {"lan_addresses": args.lan_address} if args.lan_address else {}
    try:
        async with Client() as client:
            transport = client.transport
            if args.mode == "serve":
                options = StartRpcServerRequest(
                    type="startRpcServer",
                    allow_non_loopback_host=True,
                    discovery_topic=args.topic,
                    **selection,
                )
                if args.host is not None:
                    options.host = args.host
                while True:
                    server = await start_rpc_server(transport, options)

                    async def watch_advertisement() -> None:
                        stream = rpc_server_status_stream(
                            transport,
                            RpcServerStatusStreamRequest(
                                type="rpcServerStatusStream", server_id=server.server_id
                            ),
                        )
                        async with aclosing(stream):
                            async for status in stream:
                                print(
                                    f"{status.server_id}: {status.advertisement.value}, "
                                    f"{status.reason}",
                                    file=sys.stderr,
                                )
                                if status.error is not None:
                                    print(
                                        status.error.model_dump_json(by_alias=True),
                                        file=sys.stderr,
                                    )
                                if status.recovery.value == "restart":
                                    print(
                                        "Restore the network, then enter r to stop and restart. "
                                        "Clients must rediscover the new endpoint.",
                                        file=sys.stderr,
                                    )

                    watcher = asyncio.create_task(watch_advertisement())
                    try:
                        print(f"Serving {server.url}", file=sys.stderr)
                        print(
                            "After clients unload models, enter r to restart or Enter to stop.",
                            file=sys.stderr,
                        )
                        action = await asyncio.to_thread(input)
                    finally:
                        watcher.cancel()
                        outcome = (
                            await asyncio.gather(watcher, return_exceptions=True)
                        )[0]
                        if isinstance(outcome, Exception):
                            print(
                                f"Advertisement monitor failed: {outcome}",
                                file=sys.stderr,
                            )
                        await stop_rpc_server(
                            transport,
                            StopRpcServerRequest(
                                type="stopRpcServer", server_id=server.server_id
                            ),
                        )
                    if action.strip().lower() != "r":
                        break
            else:
                result = await discover_rpc_servers(
                    transport,
                    DiscoverRpcServersRequest(
                        type="discoverRpcServers",
                        topic=args.topic,
                        timeout_ms=5000,
                        **selection,
                    ),
                )
                alias = 0
                # Prefer server RDMA offers before assigning aliases. Transport still needs negotiation.
                for server in sorted(
                    result.servers, key=lambda item: (not item.rdma_available, item.url)
                ):
                    print(
                        f"{server.url}; server RDMA available: {server.rdma_available}",
                        file=sys.stderr,
                    )
                    for device in server.devices:
                        print(f"RPC{alias}: {server.url}, device {device.index}")
                        alias += 1
                if not alias:
                    print("No idle servers found", file=sys.stderr)
    except Exception as error:
        print(f"{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
