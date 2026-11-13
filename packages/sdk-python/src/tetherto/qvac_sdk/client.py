"""Ergonomic entry point for the QVAC Python SDK:

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))

Asyncio-native, matching the rest of this package.

`Client()` starts the worker with the Bare runtime that the `bare-sidecar`
wheel ships, and talks to it over bare-stow's IPC. The worker is the first of:
  1. `worker_path` argument or `QVAC_WORKER_PATH` env var (the name the JS SDK
     uses): a folder written by `qvac bundle sdk --language python`, which is
     started through the bare-stow harness in it, or a worker entry file, such
     as `qvac/worker.entry.mjs`, which is run without a bundle.
  2. A self-contained bundled wheel: the worker with every built-in plugin,
     bundled by bare-stow under `_worker/` by scripts/build_wheel.py.
  3. The default worker of an installed `@qvac/sdk`, run without a bundle.

A worker entry, or the default worker, runs on the SDK's
`dist/src/worker/unbundled-shim.js`. For an entry, that SDK is `sdk_dir` (or
`QVAC_SDK_DIR`), else the `@qvac/sdk` the entry belongs to (the package it sits
in, or the one its project installed). For the default worker, it is the first
of: `sdk_dir` (or `QVAC_SDK_DIR`); the version-matched `@qvac/sdk` that
`python -m tetherto.qvac_sdk install-worker` puts under a per-user cache dir; a
global `npm install -g @qvac/sdk` (version-checked; warns on mismatch).

`bare_path` (or `QVAC_BARE_PATH`) replaces the Bare runtime with another build
of `bare-sidecar`'s Bare, which passes the worker its IPC channel.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import subprocess
import warnings
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from bare_sidecar import Sidecar, spawn
from bare_stow_host import IPC, wrap

from ._generated.sdk_version import SDK_VERSION
from .bare_rpc_transport import BareRpcTransport
from .caller_session import Session, open_session

SHUTDOWN_GRACE = 10.0
"""Seconds a stopping worker gets to unload its engines before it is killed."""


class WorkerNotFoundError(Exception):
    """Raised when no worker can be resolved.

    Fixable by either passing `worker_path` (or `sdk_dir`) directly to
    `Client()`, or setting `QVAC_WORKER_PATH` (or `QVAC_SDK_DIR`) in the
    environment.
    """


@dataclass(frozen=True)
class BundledWorker:
    """A bundled worker, started by the bare-stow harness at `harness`."""

    harness: Path
    bare: str | None = None

    async def start(self, timeout: float) -> IPC:
        started = await _load_harness(self.harness).start(
            timeout=timeout, grace=SHUTDOWN_GRACE, bare=self.bare
        )
        return started.ipc


_watching: set[asyncio.Future[None]] = set()


@dataclass(frozen=True)
class UnbundledWorker:
    """A worker entry run without a bundle on the SDK's unbundled shim, through
    `bare-sidecar` and `bare-stow-host`."""

    shim: Path
    entry: Path
    bare: str | None = None

    async def start(self, timeout: float) -> IPC:
        sidecar = await spawn(self.shim, self.entry, bare=self.bare)
        ipc = wrap(sidecar, kill=sidecar.kill, timeout=timeout, grace=SHUTDOWN_GRACE)
        watching = asyncio.ensure_future(_watch(sidecar, ipc))
        _watching.add(watching)
        watching.add_done_callback(_watching.discard)
        await ipc.ready
        return ipc


async def _watch(sidecar: Sidecar, ipc: IPC) -> None:
    await sidecar.wait()
    ipc.exited(sidecar.exit_code, sidecar.signal_code)
    await sidecar.close()


def _load_harness(harness: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        f"_qvac_worker_{abs(hash(str(harness)))}", harness
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _harness_in(folder: Path) -> Path | None:
    """The `__init__.py` of the bare-stow Python package in `folder`: the folder
    itself, or the package bare-stow writes inside its output folder."""
    for package in (folder, folder / folder.name.replace("-", "_")):
        if (package / "__init__.py").is_file():
            return package / "__init__.py"
    return None


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


def _default_worker(sdk_root: Path) -> Path:
    return sdk_root / "dist" / "src" / "worker" / "index.js"


def _shim(sdk_root: Path) -> Path:
    return sdk_root / "dist" / "src" / "worker" / "unbundled-shim.js"


def _resolve_worker(
    worker_path: str | None, bare_path: str | None, sdk_dir: str | None
) -> BundledWorker | UnbundledWorker:
    worker_path = worker_path or os.environ.get("QVAC_WORKER_PATH")
    bare = bare_path or os.environ.get("QVAC_BARE_PATH")
    sdk_dir = sdk_dir or os.environ.get("QVAC_SDK_DIR")

    if worker_path:
        worker = Path(worker_path).resolve()
        if worker.is_dir():
            harness = _harness_in(worker)
            if harness is None:
                raise WorkerNotFoundError(
                    f"{worker_path!r} is a folder with no bare-stow Python harness; "
                    "write one with `qvac bundle sdk --language python`"
                )
            return BundledWorker(harness, bare)
        sdk_root = Path(sdk_dir).resolve() if sdk_dir else _sdk_root_near(worker.parent)
        if sdk_root is None:
            raise WorkerNotFoundError(
                f"no @qvac/sdk found for the worker entry {worker_path!r}; set "
                "sdk_dir or QVAC_SDK_DIR to the @qvac/sdk that runs it"
            )
        return UnbundledWorker(_shim(sdk_root), worker, bare)

    # Self-contained wheel: scripts/build_wheel.py bundles the worker with
    # bare-stow under _worker/, so an installed bundled wheel needs no
    # configuration.
    bundled = _harness_in(Path(__file__).parent / "_worker")
    if bundled is not None:
        return BundledWorker(bundled, bare)

    if sdk_dir:
        sdk_root = Path(sdk_dir).resolve()
        return UnbundledWorker(_shim(sdk_root), _default_worker(sdk_root), bare)

    # Thin wheel: resolve a worker fetched by `python -m tetherto.qvac_sdk install-worker`
    # (version-scoped, so it always matches this client), then a global
    # `npm install -g @qvac/sdk` (version-checked, warns on mismatch).
    managed = _managed_sdk_root()
    if _default_worker(managed).exists():
        return UnbundledWorker(_shim(managed), _default_worker(managed), bare)

    global_root = _npm_global_sdk_root()
    if global_root is not None and _default_worker(global_root).exists():
        _warn_on_version_mismatch(global_root)
        return UnbundledWorker(_shim(global_root), _default_worker(global_root), bare)

    raise WorkerNotFoundError(
        f"no worker found -- run `python -m tetherto.qvac_sdk install-worker` to fetch "
        f"@qvac/sdk@{SDK_VERSION} via npm, or pass worker_path (or sdk_dir) to "
        f"Client(), or set QVAC_WORKER_PATH (or QVAC_SDK_DIR) in the environment"
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
        worker = _resolve_worker(worker_path, bare_path, sdk_dir)
        if worker.bare is not None and not os.path.exists(worker.bare):
            raise WorkerNotFoundError(f"no Bare binary found at {worker.bare!r}")
        if isinstance(worker, UnbundledWorker):
            if not worker.shim.exists():
                raise WorkerNotFoundError(
                    f"no worker shim found at {str(worker.shim)!r}"
                )
            if not worker.entry.exists():
                raise WorkerNotFoundError(
                    f"no worker entry found at {str(worker.entry)!r}"
                )
        self.worker = worker
        self._transport = BareRpcTransport(
            worker.start, home_dir=home_dir, config=config
        )
        self._transport.on_worker_lost(lambda: self._end_sessions("crashed"))
        self._connected = False
        self._sessions: list[Session] = []

    @property
    def transport(self) -> BareRpcTransport:
        if not self._connected:
            raise RuntimeError(
                "Client is not connected -- use it as an async context manager"
            )
        return self._transport

    async def connect(self, *, timeout: float | None = None) -> Client:
        if not self._connected:
            await self._transport.connect(timeout=timeout)
            self._connected = True
        return self

    async def open_session(self, name: str | None = None) -> Session:
        """Opens a caller session on this runtime. Pass `session.transport` to
        any wrapper or stub; its calls carry the session id."""
        session = await open_session(
            self.transport, name, on_closed=self._sessions.remove
        )
        self._sessions.append(session)
        return session

    def _end_sessions(self, reason: str) -> None:
        for session in self._sessions:
            session.transport.end(reason)
        self._sessions.clear()

    async def close(self) -> None:
        """Owner shutdown. Every session opened on this client ends with it."""
        self._end_sessions("shutdown")
        if self._connected:
            await self._transport.close()
            self._connected = False

    async def __aenter__(self) -> Client:
        return await self.connect()

    async def __aexit__(self, *exc: object) -> None:
        await self.close()
