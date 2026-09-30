"""Serve or discover RPC endpoints.

Serving requires @qvac/ggml-rpc-server and a worker rebuilt with
rpcServerProvider: "@qvac/sdk/ggml-rpc-server/provider" in qvac.config.json.

python examples/rpc_servers.py serve 10.0.0.2 my-private-rpc-group
python examples/rpc_servers.py discover my-private-rpc-group
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from tetherto.qvac_sdk import Client
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


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    serve = modes.add_parser("serve")
    serve.add_argument("host")
    serve.add_argument("topic")
    discover = modes.add_parser("discover")
    discover.add_argument("topic")
    args = parser.parse_args()
    try:
        async with Client() as client:
            transport = client.transport
            if args.mode == "serve":
                server = await start_rpc_server(
                    transport,
                    StartRpcServerRequest(
                        type="startRpcServer",
                        host=args.host,
                        allow_non_loopback_host=True,
                        discovery_topic=args.topic,
                    ),
                )
                try:
                    print(f"▸ Serving {server.url}", file=sys.stderr)
                    print(
                        "▸ Press Enter after clients unload their models.",
                        file=sys.stderr,
                    )
                    await asyncio.to_thread(input)
                finally:
                    await stop_rpc_server(
                        transport,
                        StopRpcServerRequest(
                            type="stopRpcServer", server_id=server.server_id
                        ),
                    )
            else:
                result = await discover_rpc_servers(
                    transport,
                    DiscoverRpcServersRequest(
                        type="discoverRpcServers", topic=args.topic, timeout_ms=5000
                    ),
                )
                alias = 0
                for server in sorted(result.servers, key=lambda item: item.url):
                    for device in server.devices:
                        print(f"RPC{alias}: {server.url}, device {device.index}")
                        alias += 1
                if not alias:
                    print("▸ No idle servers found", file=sys.stderr)
    except Exception as error:
        print(f"✖ {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
