"""Tests for `tetherto.qvac_sdk.Client` (QIP-1's `from tetherto.qvac_sdk import Client` entry point):
worker/bare-binary resolution precedence and error messaging run as plain
unit tests; the real connect/heartbeat/close cycle runs against a spawned
worker, same rigor as test_bare_rpc_transport.py.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from _worker_env import BARE_BIN, WORKER_AVAILABLE

from tetherto.qvac_sdk._generated.sdk_version import SDK_VERSION
from tetherto.qvac_sdk.bare_rpc_transport import BARE_RPC_AVAILABLE
from tetherto.qvac_sdk.client import (
    Client,
    WorkerNotFoundError,
    _bare_runtime_package_suffix,
    _resolve_command,
)

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)
WORKER_PATH = f"{SDK_DIR}/dist/server/worker.js"


def test_resolve_command_prefers_explicit_paths(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    bare, worker = _resolve_command("/explicit/worker.js", "/explicit/bare", None)
    assert (bare, worker) == ("/explicit/bare", "/explicit/worker.js")


def test_resolve_command_falls_back_to_env_vars(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    bare, worker = _resolve_command(None, None, None)
    assert (bare, worker) == ("/env/bare", "/env/worker.js")


def test_resolve_command_env_vars_beat_a_co_present_sdk_dir(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    bare, worker = _resolve_command(None, None, "/sdk")
    assert (bare, worker) == ("/env/bare", "/env/worker.js")


def test_resolve_command_resolves_worker_and_bare_independently(monkeypatch) -> None:
    # An explicit worker_path with no bare_path still derives the Bare binary
    # from sdk_dir, rather than requiring both from the same tier.
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    bare, worker = _resolve_command("/explicit/worker.js", None, "/sdk")
    assert worker == "/explicit/worker.js"
    # Derived paths are OS-native (pathlib), so compare via Path, not a POSIX
    # string literal -- on Windows the join yields backslashes.
    assert Path(bare) == Path(
        f"/sdk/node_modules/bare-runtime-{_bare_runtime_package_suffix()}/bin/bare"
    )


def test_resolve_command_derives_from_sdk_dir(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    bare, worker = _resolve_command(None, None, "/sdk")
    assert Path(worker) == Path("/sdk/dist/server/worker.js")
    assert Path(bare) == Path(
        f"/sdk/node_modules/bare-runtime-{_bare_runtime_package_suffix()}/bin/bare"
    )


def test_resolve_command_sdk_dir_env_var(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.setenv("QVAC_SDK_DIR", "/env-sdk")
    bare, worker = _resolve_command(None, None, None)
    assert Path(worker) == Path("/env-sdk/dist/server/worker.js")


def test_resolve_command_raises_with_no_inputs(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)
    # Isolate from any real managed-cache / global npm worker on this machine.
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path / "empty-cache"))
    monkeypatch.setattr("tetherto.qvac_sdk.client._npm_global_sdk_root", lambda: None)
    with pytest.raises(WorkerNotFoundError, match="no worker found"):
        _resolve_command(None, None, None)


def test_resolve_command_uses_managed_worker_cache(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path))
    root = tmp_path / SDK_VERSION / "node_modules" / "@qvac" / "sdk"
    (root / "dist" / "server").mkdir(parents=True)
    (root / "dist" / "server" / "worker.js").write_text("")
    bare, worker = _resolve_command(None, None, None)
    assert worker == str(root / "dist" / "server" / "worker.js")
    # as_posix() so the tail check is separator-agnostic (backslashes on Windows).
    assert (
        Path(bare)
        .as_posix()
        .endswith(f"bare-runtime-{_bare_runtime_package_suffix()}/bin/bare")
    )


def test_resolve_command_uses_global_npm_when_present(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path / "empty-cache"))
    global_root = tmp_path / "global" / "@qvac" / "sdk"
    (global_root / "dist" / "server").mkdir(parents=True)
    (global_root / "dist" / "server" / "worker.js").write_text("")
    (global_root / "package.json").write_text(f'{{"version": "{SDK_VERSION}"}}')
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client._npm_global_sdk_root", lambda: global_root
    )
    _, worker = _resolve_command(None, None, None)
    assert worker == str(global_root / "dist" / "server" / "worker.js")


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


def test_client_raises_when_resolved_paths_do_not_exist(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    with pytest.raises(WorkerNotFoundError, match="no Bare binary found"):
        Client(sdk_dir="/no/such/sdk")


@pytest.mark.skipif(
    not BARE_RPC_AVAILABLE,
    reason="Client() constructs a BareRpcTransport -- needs the 'bare-rpc' extra",
)
def test_client_transport_property_requires_connect() -> None:
    # __init__ only checks these paths exist, not that they're a real worker --
    # any real file will do for this not-yet-connected check.
    client = Client(worker_path=__file__, bare_path=__file__)
    with pytest.raises(RuntimeError, match="not connected"):
        client.transport


@pytest.mark.skipif(
    not BARE_RPC_AVAILABLE,
    reason="bare_rpc not installed -- install the 'bare-rpc' extra "
    "(`pip install -e '.[bare-rpc]'`) to run these tests",
)
@pytest.mark.skipif(
    not WORKER_AVAILABLE,
    reason=f"no built SDK worker + Bare runtime (worker={WORKER_PATH!r}, bare={BARE_BIN!r})",
)
async def test_client_connects_and_round_trips_a_heartbeat() -> None:
    from tetherto.qvac_sdk.methods import heartbeat
    from tetherto.qvac_sdk.schemas import HeartbeatRequest

    async with Client(worker_path=WORKER_PATH, bare_path=BARE_BIN) as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)
