"""Tests for `tetherto.qvac_sdk.Client` (QIP-1's `from tetherto.qvac_sdk import Client` entry point):
worker/bare-binary resolution precedence and error messaging run as plain
unit tests; the real connect/heartbeat/close cycle runs against a spawned
worker, same rigor as test_bare_rpc_transport.py.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from _worker_env import (
    BARE_BIN,
    WORKER_AVAILABLE,
    WORKER_PATH,
    _bundled_sdk,
)

import tetherto.qvac_sdk as qvac_sdk_pkg
from tetherto.qvac_sdk._generated.sdk_version import SDK_VERSION
from tetherto.qvac_sdk.client import (
    Client,
    WorkerNotFoundError,
    _bare_executable_name,
    _host,
    _resolve_command,
)
from tetherto.qvac_sdk.methods import heartbeat
from tetherto.qvac_sdk.schemas import HeartbeatRequest


def _sidecar_bare(root: Path) -> Path:
    return (
        root
        / "node_modules"
        / "bare-sidecar"
        / "prebuilds"
        / _host()
        / _bare_executable_name()
    )


def _touch(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def _write_sdk(root: Path) -> Path:
    _touch(
        root / "package.json", json.dumps({"name": "@qvac/sdk", "version": SDK_VERSION})
    )
    _touch(root / "dist" / "src" / "worker" / "index.js")
    _touch(root / "dist" / "src" / "worker" / "tcp-shim.js")
    return root


@pytest.fixture(autouse=True)
def _neutralize_ambient_bundle(monkeypatch, tmp_path):
    """Make the resolver-tier tests deterministic regardless of how the package
    under test was installed. `_resolve_command` finds a self-contained wheel's
    `_bundle` relative to the client module's __file__; an installed fat wheel
    carries one, which would win the bundle tier and break the tests that assert
    the sdk_dir / managed / global tiers (or that no worker is found). Point
    __file__ at a bundle-less dir so those tiers are exercised. The bundle-tier
    test stages its own `_bundle` under this same tmp_path, so it is unaffected."""
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__", str(tmp_path / "client.py")
    )
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)


def test_resolve_command_prefers_explicit_paths(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    command = _resolve_command("/explicit/worker.js", "/explicit/bare", "/sdk")
    assert (command.bare, command.worker) == ("/explicit/bare", "/explicit/worker.js")
    assert Path(command.shim) == Path("/sdk").resolve() / "dist/src/worker/tcp-shim.js"


def test_resolve_command_falls_back_to_env_vars(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    monkeypatch.setenv("QVAC_SDK_DIR", "/env-sdk")
    command = _resolve_command(None, None, None)
    assert (command.bare, command.worker) == ("/env/bare", "/env/worker.js")
    assert (
        Path(command.shim) == Path("/env-sdk").resolve() / "dist/src/worker/tcp-shim.js"
    )


def test_resolve_command_derives_from_sdk_dir() -> None:
    command = _resolve_command(None, None, "/sdk")
    # Derived paths are OS-native (pathlib), so compare via Path, not a POSIX
    # string literal -- on Windows the join yields backslashes.
    sdk = Path("/sdk").resolve()
    assert Path(command.worker) == sdk / "dist/src/worker/index.js"
    assert Path(command.shim) == sdk / "dist/src/worker/tcp-shim.js"
    assert Path(command.bare) == _sidecar_bare(sdk)


def test_resolve_command_resolves_worker_and_bare_independently() -> None:
    # An explicit worker_path with no bare_path still derives the Bare binary
    # from sdk_dir, rather than requiring both from the same tier.
    command = _resolve_command("/explicit/worker.js", None, "/sdk")
    assert command.worker == "/explicit/worker.js"
    assert Path(command.bare) == _sidecar_bare(Path("/sdk").resolve())


def test_resolve_command_sdk_dir_env_var(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_SDK_DIR", "/env-sdk")
    command = _resolve_command(None, None, None)
    assert (
        Path(command.worker) == Path("/env-sdk").resolve() / "dist/src/worker/index.js"
    )


def test_resolve_command_walks_up_from_a_relative_sdk_dir(
    monkeypatch, tmp_path
) -> None:
    workspace = tmp_path / "workspace"
    sdk = _write_sdk(workspace / "packages" / "sdk")
    bare = _touch(_sidecar_bare(workspace))
    monkeypatch.chdir(workspace / "packages")
    command = _resolve_command(None, None, "sdk")
    assert Path(command.worker) == sdk.resolve() / "dist/src/worker/index.js"
    assert Path(command.bare) == bare.resolve()


def test_resolve_command_finds_the_sdk_a_worker_entry_belongs_to(tmp_path) -> None:
    # A project's generated entry: the SDK is the one the project installed,
    # and the runtime is the bare-sidecar the install hoisted above it.
    project = tmp_path / "app"
    sdk = _write_sdk(project / "node_modules" / "@qvac" / "sdk")
    bare = _touch(_sidecar_bare(project))
    entry = _touch(project / "qvac" / "worker.entry.mjs")
    command = _resolve_command(str(entry), None, None)
    assert command.worker == str(entry)
    assert Path(command.shim) == sdk / "dist" / "src" / "worker" / "tcp-shim.js"
    assert Path(command.bare) == bare


def test_resolve_command_uses_bundled_wheel(monkeypatch, tmp_path) -> None:
    # The self-contained bundled wheel resolves ahead of sdk_dir / managed /
    # global, with no env or checkout: stage a fake _bundle next to the patched
    # client __file__ and assert it wins even when an sdk_dir is also passed.
    bundled = _write_sdk(tmp_path / "_bundle" / "worker")
    bundled_bare = _touch(_sidecar_bare(bundled))
    command = _resolve_command(None, None, "/sdk")
    assert Path(command.worker) == bundled / "dist" / "src" / "worker" / "index.js"
    assert Path(command.bare) == bundled_bare


def test_resolve_command_uses_bundled_bare_exe_on_windows(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client._bare_executable_name", lambda: "bare.exe"
    )
    bundled = _write_sdk(tmp_path / "_bundle" / "worker")
    prebuilds = bundled / "node_modules" / "bare-sidecar" / "prebuilds" / _host()
    bundled_bare = _touch(prebuilds / "bare.exe")
    _touch(prebuilds / "bare")
    command = _resolve_command(None, None, "/sdk")
    assert Path(command.bare) == bundled_bare


def test_resolve_command_raises_with_no_inputs(monkeypatch, tmp_path) -> None:
    # Isolate from any real managed-cache / global npm worker on this machine.
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path / "empty-cache"))
    monkeypatch.setattr("tetherto.qvac_sdk.client._npm_global_sdk_root", lambda: None)
    with pytest.raises(WorkerNotFoundError, match="no worker found"):
        _resolve_command(None, None, None)


def test_resolve_command_uses_managed_worker_cache(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path))
    prefix = tmp_path / SDK_VERSION
    root = _write_sdk(prefix / "node_modules" / "@qvac" / "sdk")
    hoisted_bare = _touch(_sidecar_bare(prefix))
    command = _resolve_command(None, None, None)
    assert command.worker == str(root / "dist" / "src" / "worker" / "index.js")
    assert Path(command.bare) == hoisted_bare


def test_resolve_command_uses_global_npm_when_present(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path / "empty-cache"))
    global_root = _write_sdk(tmp_path / "global" / "@qvac" / "sdk")
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client._npm_global_sdk_root", lambda: global_root
    )
    command = _resolve_command(None, None, None)
    assert command.worker == str(global_root / "dist" / "src" / "worker" / "index.js")


def test_install_worker_runs_npm_with_pinned_spec(monkeypatch, tmp_path) -> None:
    import tetherto.qvac_sdk.__main__ as cli

    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path))
    recorded: dict = {}

    class _Result:
        returncode = 0

    def fake_run(args, **kwargs):
        recorded["args"] = args
        return _Result()

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    assert cli.main(["install-worker"]) == 0
    assert "install" in recorded["args"]
    assert f"@qvac/sdk@{SDK_VERSION}" in recorded["args"]


def test_install_worker_usage_on_bad_args() -> None:
    import tetherto.qvac_sdk.__main__ as cli

    assert cli.main([]) == 2


def test_client_raises_when_resolved_paths_do_not_exist() -> None:
    with pytest.raises(WorkerNotFoundError, match="no Bare binary found"):
        Client(sdk_dir="/no/such/sdk")


def test_client_rejects_a_worker_folder(tmp_path) -> None:
    sdk = _write_sdk(tmp_path / "sdk")
    folder = tmp_path / "qvac" / "worker"
    folder.mkdir(parents=True)
    with pytest.raises(WorkerNotFoundError, match="is a folder"):
        Client(worker_path=str(folder), bare_path=__file__, sdk_dir=str(sdk))


def test_client_transport_property_requires_connect(tmp_path) -> None:
    # __init__ only checks these paths exist, not that they're a real worker --
    # any real files will do for this not-yet-connected check.
    sdk = _write_sdk(tmp_path / "sdk")
    client = Client(worker_path=__file__, bare_path=__file__, sdk_dir=str(sdk))
    with pytest.raises(RuntimeError, match="not connected"):
        client.transport


@pytest.mark.skipif(os.name == "nt", reason="Windows has no executable bit")
def test_client_makes_only_the_sidecar_runtime_executable(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    sdk = _write_sdk(tmp_path / "sdk")
    sidecar = _touch(_sidecar_bare(sdk))
    Client(sdk_dir=str(sdk))
    assert os.access(sidecar, os.X_OK)

    explicit = _touch(tmp_path / "bare")
    Client(bare_path=str(explicit), sdk_dir=str(sdk))
    assert not os.access(explicit, os.X_OK)


@pytest.mark.skipif(
    not WORKER_AVAILABLE,
    reason=f"no built SDK worker + Bare runtime (worker={WORKER_PATH!r}, bare={BARE_BIN!r})",
)
async def test_client_connects_and_round_trips_a_heartbeat() -> None:
    async with Client(worker_path=WORKER_PATH, bare_path=BARE_BIN) as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)


@pytest.mark.skipif(
    _bundled_sdk() is None,
    reason="zero-config Client() requires an installed fat-wheel _bundle",
)
async def test_client_zero_config_uses_installed_bundle(monkeypatch) -> None:
    # Restores real client.__file__ past the autouse neutralization so the
    # installed wheel's `_bundle` is what `Client()` resolves.
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__",
        str(Path(qvac_sdk_pkg.__file__).resolve().parent / "client.py"),
    )

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)
