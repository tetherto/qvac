"""Tests for `qvac.Client` (QIP-1's `from qvac import Client` entry point):
worker/bare-binary resolution precedence and error messaging run as plain
unit tests; the real connect/heartbeat/close cycle runs against a spawned
worker, same rigor as test_bare_rpc_transport.py.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from qvac.bare_rpc_transport import BARE_RPC_AVAILABLE
from qvac.client import (
    Client,
    WorkerNotFoundError,
    _bare_runtime_package_suffix,
    _resolve_command,
)

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)
BARE_BIN = f"{SDK_DIR}/node_modules/bare-runtime-darwin-arm64/bin/bare"
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
    assert (
        bare
        == f"/sdk/node_modules/bare-runtime-{_bare_runtime_package_suffix()}/bin/bare"
    )


def test_resolve_command_derives_from_sdk_dir(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    bare, worker = _resolve_command(None, None, "/sdk")
    assert worker == "/sdk/dist/server/worker.js"
    assert (
        bare
        == f"/sdk/node_modules/bare-runtime-{_bare_runtime_package_suffix()}/bin/bare"
    )


def test_resolve_command_sdk_dir_env_var(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.setenv("QVAC_SDK_DIR", "/env-sdk")
    bare, worker = _resolve_command(None, None, None)
    assert worker == "/env-sdk/dist/server/worker.js"


def test_resolve_command_raises_with_no_inputs(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)
    with pytest.raises(WorkerNotFoundError, match="no worker found"):
        _resolve_command(None, None, None)


def test_client_raises_when_resolved_paths_do_not_exist(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    with pytest.raises(WorkerNotFoundError, match="no Bare binary found"):
        Client(sdk_dir="/no/such/sdk")


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
    not os.path.exists(WORKER_PATH),
    reason=f"no built SDK worker found at {WORKER_PATH!r} -- run `bun run build` in packages/sdk, or set QVAC_POC_SDK_DIR",
)
async def test_client_connects_and_round_trips_a_heartbeat() -> None:
    from qvac.methods import heartbeat
    from qvac.schemas import HeartbeatRequest

    async with Client(worker_path=WORKER_PATH, bare_path=BARE_BIN) as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)
