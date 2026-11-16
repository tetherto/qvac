"""Tests for `tetherto.qvac_sdk.Client` (QIP-1's `from tetherto.qvac_sdk import Client` entry point):
worker resolution precedence and error messaging run as plain unit tests; the
real connect/heartbeat/close cycle runs against a started worker, same rigor
as test_bare_rpc_transport.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from _worker_env import WORKER_AVAILABLE, WORKER_PATH, _bundled_harness

import tetherto.qvac_sdk as qvac_sdk_pkg
from tetherto.qvac_sdk._generated.sdk_version import SDK_VERSION
from tetherto.qvac_sdk.client import (
    BundledWorker,
    Client,
    UnbundledWorker,
    WorkerNotFoundError,
    _resolve_worker,
)
from tetherto.qvac_sdk.methods import heartbeat
from tetherto.qvac_sdk.schemas import HeartbeatRequest


def _touch(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def _write_sdk(root: Path) -> Path:
    _touch(
        root / "package.json", json.dumps({"name": "@qvac/sdk", "version": SDK_VERSION})
    )
    _touch(root / "dist" / "src" / "worker" / "index.js")
    _touch(root / "dist" / "src" / "worker" / "unbundled-shim.js")
    return root


def _shim(sdk: Path) -> Path:
    return sdk / "dist" / "src" / "worker" / "unbundled-shim.js"


def _default_worker(sdk: Path) -> Path:
    return sdk / "dist" / "src" / "worker" / "index.js"


@pytest.fixture(autouse=True)
def _neutralize_ambient_bundle(monkeypatch, tmp_path):
    """Make the resolver-tier tests deterministic regardless of how the package
    under test was installed. `_resolve_worker` finds a self-contained wheel's
    `_worker` relative to the client module's __file__; an installed fat wheel
    carries one, which would win the bundle tier and break the tests that assert
    the sdk_dir / managed / global tiers (or that no worker is found). Point
    __file__ at a bundle-less dir so those tiers are exercised. The bundle-tier
    test stages its own `_worker` under this same tmp_path, so it is unaffected."""
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__", str(tmp_path / "client.py")
    )
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)


def test_explicit_paths_win_over_env_vars(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    worker = _resolve_worker("/explicit/worker.js", "/explicit/bare", "/sdk")
    assert worker == UnbundledWorker(
        _shim(Path("/sdk").resolve()),
        Path("/explicit/worker.js").resolve(),
        "/explicit/bare",
    )


def test_env_vars_fill_in_missing_arguments(monkeypatch) -> None:
    monkeypatch.setenv("QVAC_WORKER_PATH", "/env/worker.js")
    monkeypatch.setenv("QVAC_BARE_PATH", "/env/bare")
    monkeypatch.setenv("QVAC_SDK_DIR", "/env-sdk")
    worker = _resolve_worker(None, None, None)
    assert worker == UnbundledWorker(
        _shim(Path("/env-sdk").resolve()), Path("/env/worker.js").resolve(), "/env/bare"
    )


def test_sdk_dir_runs_its_default_worker() -> None:
    sdk = Path("/sdk").resolve()
    worker = _resolve_worker(None, None, "/sdk")
    assert worker == UnbundledWorker(_shim(sdk), _default_worker(sdk))


def test_a_worker_entry_runs_on_the_sdk_it_belongs_to(tmp_path) -> None:
    # A project's generated entry: the SDK is the one the project installed.
    project = tmp_path / "app"
    sdk = _write_sdk(project / "node_modules" / "@qvac" / "sdk")
    entry = _touch(project / "qvac" / "worker.entry.mjs")
    worker = _resolve_worker(str(entry), None, None)
    assert worker == UnbundledWorker(_shim(sdk), entry)


def test_a_worker_entry_without_an_sdk_is_rejected(tmp_path) -> None:
    entry = _touch(tmp_path / "worker.entry.mjs")
    with pytest.raises(WorkerNotFoundError, match="no @qvac/sdk found"):
        _resolve_worker(str(entry), None, None)


def test_a_bundled_worker_folder_starts_through_its_harness(tmp_path) -> None:
    # `qvac bundle sdk --language python` writes the package inside its folder.
    folder = tmp_path / "qvac" / "worker"
    harness = _touch(folder / "worker" / "__init__.py")
    worker = _resolve_worker(str(folder), "/explicit/bare", None)
    assert worker == BundledWorker(harness, "/explicit/bare")


def test_a_folder_without_a_harness_is_rejected(tmp_path) -> None:
    folder = tmp_path / "qvac" / "worker"
    folder.mkdir(parents=True)
    with pytest.raises(WorkerNotFoundError, match="no bare-stow Python harness"):
        _resolve_worker(str(folder), None, None)


def test_the_bundled_wheel_wins_over_sdk_dir(tmp_path) -> None:
    # The self-contained bundled wheel resolves ahead of sdk_dir / managed /
    # global: stage a fake _worker next to the patched client __file__.
    harness = _touch(tmp_path / "_worker" / "__init__.py")
    assert _resolve_worker(None, None, "/sdk") == BundledWorker(harness)


def test_no_worker_found_without_inputs(monkeypatch, tmp_path) -> None:
    # Isolate from any real managed-cache / global npm worker on this machine.
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path / "empty-cache"))
    monkeypatch.setattr("tetherto.qvac_sdk.client._npm_global_sdk_root", lambda: None)
    with pytest.raises(WorkerNotFoundError, match="no worker found"):
        _resolve_worker(None, None, None)


def test_the_managed_worker_cache_runs_its_default_worker(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path))
    root = _write_sdk(tmp_path / SDK_VERSION / "node_modules" / "@qvac" / "sdk")
    assert _resolve_worker(None, None, None) == UnbundledWorker(
        _shim(root), _default_worker(root)
    )


def test_a_global_npm_install_runs_its_default_worker(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("QVAC_WORKER_HOME", str(tmp_path / "empty-cache"))
    global_root = _write_sdk(tmp_path / "global" / "@qvac" / "sdk")
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client._npm_global_sdk_root", lambda: global_root
    )
    assert _resolve_worker(None, None, None) == UnbundledWorker(
        _shim(global_root), _default_worker(global_root)
    )


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


def test_client_raises_when_the_shim_does_not_exist() -> None:
    with pytest.raises(WorkerNotFoundError, match="no worker shim found"):
        Client(sdk_dir="/no/such/sdk")


def test_client_raises_when_the_bare_runtime_does_not_exist(tmp_path) -> None:
    sdk = _write_sdk(tmp_path / "sdk")
    with pytest.raises(WorkerNotFoundError, match="no Bare binary found"):
        Client(sdk_dir=str(sdk), bare_path="/no/such/bare")


def test_client_transport_property_requires_connect(tmp_path) -> None:
    # __init__ only checks these paths exist, not that they're a real worker --
    # any real files will do for this not-yet-connected check.
    sdk = _write_sdk(tmp_path / "sdk")
    client = Client(sdk_dir=str(sdk))
    with pytest.raises(RuntimeError, match="not connected"):
        client.transport


@pytest.mark.skipif(
    not WORKER_AVAILABLE,
    reason=f"no built SDK worker (worker={WORKER_PATH!r})",
)
async def test_client_connects_and_round_trips_a_heartbeat() -> None:
    async with Client(worker_path=WORKER_PATH) as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)


@pytest.mark.skipif(
    _bundled_harness() is None,
    reason="zero-config Client() requires an installed fat-wheel _worker",
)
async def test_client_zero_config_uses_installed_bundle(monkeypatch) -> None:
    # Restores real client.__file__ past the autouse neutralization so the
    # installed wheel's `_worker` is what `Client()` resolves.
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__",
        str(Path(qvac_sdk_pkg.__file__).resolve().parent / "client.py"),
    )

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)
