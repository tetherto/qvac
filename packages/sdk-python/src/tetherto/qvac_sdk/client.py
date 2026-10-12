"""Ergonomic entry point for the QVAC Python SDK:

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))

Asyncio-native, matching the rest of this package.

`Client()` starts the worker as `bare <tcp-shim> <worker entry> <port>`: the
Bare runtime that `bare-sidecar` ships, the SDK's `dist/src/worker/tcp-shim.js`,
and a worker entry, by default the SDK's `dist/src/worker/index.js`.

`worker_path` / `bare_path` (or the `QVAC_WORKER_PATH` / `QVAC_BARE_PATH` env
vars, the names the JS SDK uses) override the entry and the runtime. The SDK
that provides the shim, and the runtime when none is given, is the first of:
  1. A self-contained bundled wheel: the built SDK and its production
     dependencies staged under `_bundle/worker/` by scripts/build_wheel.py.
  2. `sdk_dir` argument or `QVAC_SDK_DIR` env var, an installed `@qvac/sdk`
     package directory.
  3. The `@qvac/sdk` an explicit worker entry belongs to: the package it sits
     in, or the one its project installed.
  4. A thin wheel's fetched worker: `python -m tetherto.qvac_sdk install-worker` puts the
     version-matched `@qvac/sdk` under a per-user cache dir, else a global
     `npm install -g @qvac/sdk` (version-checked; warns on mismatch).

The runtime is `bare-sidecar/prebuilds/<platform>-<arch>/bare` in the SDK's
`node_modules`, or in an ancestor's where the install hoisted it.
"""

from __future__ import annotations

import json
import os
import platform
import stat
import subprocess
import warnings
from dataclasses import dataclass
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


@dataclass(frozen=True)
class WorkerCommand:
    """The process `Client()` starts; `BareRpcTransport` appends the port."""

    bare: str
    shim: str
    worker: str

    def argv(self) -> list[str]:
        return [self.bare, self.shim, self.worker]


def _host() -> str:
    """`<platform>-<arch>`, the name of bare-sidecar's prebuild folder for this machine."""
    system = platform.system()
    machine = platform.machine()
    if system not in _PLATFORM_MAP:
        raise WorkerNotFoundError(
            f"unsupported platform {system!r} -- bare-sidecar ships no Bare runtime for it"
        )
    if machine not in _ARCH_MAP:
        raise WorkerNotFoundError(
            f"unsupported architecture {machine!r} -- bare-sidecar ships no Bare runtime for it"
        )
    return f"{_PLATFORM_MAP[system]}-{_ARCH_MAP[machine]}"


def _bare_executable_name() -> str:
    return "bare.exe" if os.name == "nt" else "bare"


def _sidecar_bare(sdk_root: Path) -> Path:
    """bare-sidecar's Bare runtime for this host, from the SDK's node_modules or
    the nearest ancestor's; the SDK's own path when there is none, so the
    missing-binary error names where it was expected."""
    relative = Path(
        "node_modules", "bare-sidecar", "prebuilds", _host(), _bare_executable_name()
    )
    for directory in [sdk_root, *sdk_root.parents]:
        if (directory / relative).exists():
            return directory / relative
    return sdk_root / relative


def _is_sdk_root(directory: Path) -> bool:
    try:
        manifest = json.loads((directory / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(manifest, dict) and manifest.get("name") == "@qvac/sdk"


def _sdk_root_near(path: Path) -> Path | None:
    """The `@qvac/sdk` a worker entry belongs to: the package it sits in, or
    the one its project installed."""
    for directory in [path, *path.parents]:
        if _is_sdk_root(directory):
            return directory
        installed = directory / "node_modules" / "@qvac" / "sdk"
        if _is_sdk_root(installed):
            return installed
    return None


def _command_for_sdk(
    sdk_root: Path, worker_path: str | None, bare_path: str | None
) -> WorkerCommand:
    worker_dir = sdk_root / "dist" / "src" / "worker"
    return WorkerCommand(
        bare=bare_path or str(_sidecar_bare(sdk_root)),
        shim=str(worker_dir / "tcp-shim.js"),
        worker=worker_path or str(worker_dir / "index.js"),
    )


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
) -> WorkerCommand:
    worker_path = worker_path or os.environ.get("QVAC_WORKER_PATH")
    bare_path = bare_path or os.environ.get("QVAC_BARE_PATH")
    return _command_for_sdk(
        _resolve_sdk_root(worker_path, sdk_dir), worker_path, bare_path
    )


def _resolve_sdk_root(worker_path: str | None, sdk_dir: str | None) -> Path:
    # Self-contained wheel: scripts/build_wheel.py stages the built SDK and its
    # production dependencies, bare-sidecar's runtime among them, under
    # _bundle/worker/, so an installed bundled wheel needs no configuration.
    bundled = Path(__file__).parent / "_bundle" / "worker"
    if (bundled / "dist" / "src" / "worker" / "index.js").exists():
        return bundled

    sdk_dir = sdk_dir or os.environ.get("QVAC_SDK_DIR")
    if sdk_dir:
        return Path(sdk_dir).resolve()

    if worker_path:
        near = _sdk_root_near(Path(worker_path).resolve().parent)
        if near is not None:
            return near

    # Thin wheel: resolve a worker fetched by `python -m tetherto.qvac_sdk install-worker`
    # (version-scoped, so it always matches this client), then a global
    # `npm install -g @qvac/sdk` (version-checked, warns on mismatch).
    managed = _managed_sdk_root()
    if (managed / "dist" / "src" / "worker" / "index.js").exists():
        return managed

    global_root = _npm_global_sdk_root()
    if (
        global_root is not None
        and (global_root / "dist" / "src" / "worker" / "index.js").exists()
    ):
        _warn_on_version_mismatch(global_root)
        return global_root

    raise WorkerNotFoundError(
        f"no worker found -- run `python -m tetherto.qvac_sdk install-worker` to fetch "
        f"@qvac/sdk@{SDK_VERSION} via npm, or pass worker_path/bare_path (or "
        f"sdk_dir) to Client(), or set QVAC_WORKER_PATH/QVAC_BARE_PATH (or "
        f"QVAC_SDK_DIR) in the environment"
    )


def _ensure_executable(path: str) -> None:
    """npm and bun do not reliably keep the exec bit on bare-sidecar's runtime;
    bare-sidecar sets it when Node loads it, which never happens here."""
    if os.name == "nt" or os.access(path, os.X_OK):
        return
    mode = os.stat(path).st_mode
    os.chmod(path, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


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
        explicit_bare = bare_path or os.environ.get("QVAC_BARE_PATH")
        command = _resolve_command(worker_path, bare_path, sdk_dir)
        if not os.path.exists(command.bare):
            raise WorkerNotFoundError(f"no Bare binary found at {command.bare!r}")
        if not os.path.exists(command.shim):
            raise WorkerNotFoundError(f"no worker shim found at {command.shim!r}")
        if not os.path.exists(command.worker):
            raise WorkerNotFoundError(f"no worker entry found at {command.worker!r}")
        if os.path.isdir(command.worker):
            raise WorkerNotFoundError(
                f"{command.worker!r} is a folder; this client takes a worker entry "
                "file, such as qvac/worker.entry.mjs"
            )
        if explicit_bare is None:
            _ensure_executable(command.bare)
        self._transport = BareRpcTransport(
            command.argv(), home_dir=home_dir, config=config
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
