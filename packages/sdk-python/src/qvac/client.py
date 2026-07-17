"""Ergonomic entry point for the QVAC Python SDK (QIP-1, phase 1):

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))

Asyncio-native, matching the rest of this package (the QIP's own sample
code is illustrative pseudocode, not a literal sync API).

Locating an installed worker remains phase 1's explicit contract ("thin
client... phase 3 bundles it into the wheel") -- this class resolves an
already-installed `@qvac/sdk` on disk and starts/connects to it; it does
not bundle, download, or discover a worker without one of the inputs
below being supplied.

`worker_path` and `bare_path` resolve independently, each falling through
its own three tiers (constructor argument, then env var, then derived
from `sdk_dir`) -- so, for example, an explicit `worker_path` with no
`bare_path` still derives the Bare binary from `sdk_dir`/`QVAC_SDK_DIR`
rather than requiring both to come from the same tier:
  1. `worker_path` / `bare_path` constructor arguments.
  2. `QVAC_WORKER_PATH` / `QVAC_BARE_PATH` env vars -- same names the JS
     SDK itself uses for the worker override (see `client/rpc/node-rpc-client.ts`).
  3. `sdk_dir` argument or `QVAC_SDK_DIR` env var, pointing at an installed
     `@qvac/sdk` package directory, from which the missing path(s) are
     derived (`<sdk_dir>/dist/server/worker.js` and
     `<sdk_dir>/node_modules/bare-runtime-<platform>-<arch>/bin/bare`,
     mirroring how the JS SDK itself locates its bundled Bare binary).
"""

from __future__ import annotations

import os
import platform
from pathlib import Path

from .bare_rpc_transport import BareRpcTransport

_PLATFORM_MAP = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}
_ARCH_MAP = {"x86_64": "x64", "AMD64": "x64", "arm64": "arm64", "aarch64": "arm64"}


class WorkerNotFoundError(Exception):
    """Raised when no worker entry point / Bare binary can be resolved.

    Fixable by either passing `worker_path`/`bare_path` (or `sdk_dir`)
    directly to `Client()`, or setting `QVAC_WORKER_PATH`/`QVAC_BARE_PATH`
    (or `QVAC_SDK_DIR`) in the environment.
    """


def _bare_runtime_package_suffix() -> str:
    system = platform.system()
    machine = platform.machine()
    if system not in _PLATFORM_MAP:
        raise WorkerNotFoundError(
            f"unsupported platform {system!r} -- no bare-runtime-* package exists for it"
        )
    if machine not in _ARCH_MAP:
        raise WorkerNotFoundError(
            f"unsupported architecture {machine!r} -- no bare-runtime-* package exists for it"
        )
    return f"{_PLATFORM_MAP[system]}-{_ARCH_MAP[machine]}"


def _resolve_command(
    worker_path: str | None, bare_path: str | None, sdk_dir: str | None
) -> tuple[str, str]:
    worker_path = worker_path or os.environ.get("QVAC_WORKER_PATH")
    bare_path = bare_path or os.environ.get("QVAC_BARE_PATH")
    if worker_path and bare_path:
        return bare_path, worker_path

    # Self-contained wheel: scripts/build_wheel.py stages the Bare runtime
    # and the built worker under qvac/_bundle/, so an installed bundled
    # wheel needs no explicit paths, env, or sdk checkout at all.
    bundle = Path(__file__).parent / "_bundle"
    bundled_worker = bundle / "worker" / "dist" / "server" / "worker.js"
    bundled_bare = bundle / "runtime" / "bare"
    if bundled_worker.exists() and bundled_bare.exists():
        return (
            bare_path or str(bundled_bare),
            worker_path or str(bundled_worker),
        )

    sdk_dir = sdk_dir or os.environ.get("QVAC_SDK_DIR")
    if not sdk_dir:
        raise WorkerNotFoundError(
            "no worker found -- pass worker_path/bare_path (or sdk_dir) to Client(), "
            "or set QVAC_WORKER_PATH/QVAC_BARE_PATH (or QVAC_SDK_DIR) in the environment"
        )
    sdk_root = Path(sdk_dir)
    worker_path = worker_path or str(sdk_root / "dist" / "server" / "worker.js")
    bare_path = bare_path or str(
        sdk_root
        / "node_modules"
        / f"bare-runtime-{_bare_runtime_package_suffix()}"
        / "bin"
        / "bare"
    )
    return bare_path, worker_path


class Client:
    """Starts (or connects to) a QVAC SDK worker and owns its transport.

    `client.transport` satisfies `qvac._transport.Transport` and can be
    passed directly to any generated stub in `qvac.methods` or wrapper in
    `qvac.api`.
    """

    def __init__(
        self,
        *,
        worker_path: str | None = None,
        bare_path: str | None = None,
        sdk_dir: str | None = None,
        home_dir: str | None = None,
    ) -> None:
        bare, worker = _resolve_command(worker_path, bare_path, sdk_dir)
        if not os.path.exists(bare):
            raise WorkerNotFoundError(f"no Bare binary found at {bare!r}")
        if not os.path.exists(worker):
            raise WorkerNotFoundError(f"no worker entry found at {worker!r}")
        self._transport = BareRpcTransport([bare, worker], home_dir=home_dir)
        self._connected = False

    @property
    def transport(self) -> BareRpcTransport:
        if not self._connected:
            raise RuntimeError(
                "Client is not connected -- use it as an async context manager"
            )
        return self._transport

    async def connect(self, *, timeout: float = 30) -> Client:
        if not self._connected:
            await self._transport.connect(timeout=timeout)
            self._connected = True
        return self

    async def close(self) -> None:
        if self._connected:
            await self._transport.close()
            self._connected = False

    async def __aenter__(self) -> Client:
        return await self.connect()

    async def __aexit__(self, *exc: object) -> None:
        await self.close()
