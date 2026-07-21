"""Ergonomic entry point for the QVAC Python SDK:

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))

Asyncio-native, matching the rest of this package.

`Client()` locates a worker by trying these tiers in order (`worker_path`
and `bare_path` resolve independently, so an explicit `worker_path` with no
`bare_path` still derives the Bare binary from a later tier):
  1. `worker_path` / `bare_path` constructor arguments.
  2. `QVAC_WORKER_PATH` / `QVAC_BARE_PATH` env vars -- same names the JS
     SDK uses for its worker override (see `client/rpc/node-rpc-client.ts`).
  3. A self-contained bundled wheel: the Bare runtime + built worker staged
     under `qvac/_bundle/` by scripts/build_wheel.py -- zero configuration.
  4. `sdk_dir` argument or `QVAC_SDK_DIR` env var, an installed `@qvac/sdk`
     package directory (`<sdk_dir>/dist/server/worker.js` +
     `<sdk_dir>/node_modules/bare-runtime-<platform>-<arch>/bin/bare`).
  5. A thin wheel's fetched worker: `python -m tetherto.qvac_sdk install-worker` puts the
     version-matched `@qvac/sdk` under a per-user cache dir, else a global
     `npm install -g @qvac/sdk` (version-checked; warns on mismatch).
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import warnings
from pathlib import Path
from typing import Any

from ._generated.sdk_version import SDK_VERSION
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


def _derive_from_sdk_root(
    sdk_root: Path, worker_path: str | None, bare_path: str | None
) -> tuple[str, str]:
    """(bare, worker) paths for an installed `@qvac/sdk` package directory:
    `<root>/dist/server/worker.js` and the platform Bare binary under its
    node_modules -- the same layout the JS SDK locates its own worker in."""
    resolved_worker = worker_path or str(sdk_root / "dist" / "server" / "worker.js")
    resolved_bare = bare_path or str(
        sdk_root
        / "node_modules"
        / f"bare-runtime-{_bare_runtime_package_suffix()}"
        / "bin"
        / "bare"
    )
    return resolved_bare, resolved_worker


def managed_worker_prefix() -> Path:
    """npm --prefix dir `python -m tetherto.qvac_sdk install-worker` installs into, scoped by
    the pinned SDK version so each version resolves to its own matching worker.
    Defaults to `~/.cache/qvac/worker`; override the base with QVAC_WORKER_HOME."""
    base = os.environ.get("QVAC_WORKER_HOME") or str(
        Path.home() / ".cache" / "qvac" / "worker"
    )
    return Path(base) / SDK_VERSION


def _managed_sdk_root() -> Path:
    return managed_worker_prefix() / "node_modules" / "@qvac" / "sdk"


def _npm_global_sdk_root() -> Path | None:
    try:
        result = subprocess.run(
            ["npm", "root", "-g"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    root = result.stdout.strip()
    if result.returncode != 0 or not root:
        return None
    return Path(root) / "@qvac" / "sdk"


def _warn_on_version_mismatch(sdk_root: Path) -> None:
    try:
        version = json.loads(
            (sdk_root / "package.json").read_text(encoding="utf-8")
        ).get("version")
    except (OSError, ValueError):
        return
    if version and version != SDK_VERSION:
        warnings.warn(
            f"resolved @qvac/sdk {version} but this client was generated for "
            f"{SDK_VERSION}; the wire contract may not match. Run "
            f"`python -m tetherto.qvac_sdk install-worker` for the matching version.",
            RuntimeWarning,
            stacklevel=4,
        )


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
    if sdk_dir:
        return _derive_from_sdk_root(Path(sdk_dir), worker_path, bare_path)

    # Thin wheel: resolve a worker fetched by `python -m tetherto.qvac_sdk install-worker`
    # (version-scoped, so it always matches this client), then a global
    # `npm install -g @qvac/sdk` (version-checked, warns on mismatch).
    managed = _managed_sdk_root()
    if (managed / "dist" / "server" / "worker.js").exists():
        return _derive_from_sdk_root(managed, worker_path, bare_path)

    global_root = _npm_global_sdk_root()
    if (
        global_root is not None
        and (global_root / "dist" / "server" / "worker.js").exists()
    ):
        _warn_on_version_mismatch(global_root)
        return _derive_from_sdk_root(global_root, worker_path, bare_path)

    raise WorkerNotFoundError(
        f"no worker found -- run `python -m tetherto.qvac_sdk install-worker` to fetch "
        f"@qvac/sdk@{SDK_VERSION} via npm, or pass worker_path/bare_path (or "
        f"sdk_dir) to Client(), or set QVAC_WORKER_PATH/QVAC_BARE_PATH (or "
        f"QVAC_SDK_DIR) in the environment"
    )


class Client:
    """Starts (or connects to) a QVAC SDK worker and owns its transport.

    `client.transport` satisfies `tetherto.qvac_sdk._transport.Transport` and can be
    passed directly to any generated stub or ergonomic wrapper re-exported
    from `qvac` (or in `tetherto.qvac_sdk.methods`).
    """

    def __init__(
        self,
        *,
        worker_path: str | None = None,
        bare_path: str | None = None,
        sdk_dir: str | None = None,
        home_dir: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        bare, worker = _resolve_command(worker_path, bare_path, sdk_dir)
        if not os.path.exists(bare):
            raise WorkerNotFoundError(f"no Bare binary found at {bare!r}")
        if not os.path.exists(worker):
            raise WorkerNotFoundError(f"no worker entry found at {worker!r}")
        self._transport = BareRpcTransport(
            [bare, worker], home_dir=home_dir, config=config
        )
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
