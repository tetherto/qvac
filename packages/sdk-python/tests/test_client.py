"""Tests for `tetherto.qvac_sdk.Client` (QIP-1's `from tetherto.qvac_sdk import Client` entry point):
worker/bare-binary resolution precedence and error messaging run as plain
unit tests; the real connect/heartbeat/close cycle runs against a spawned
worker, same rigor as test_bare_rpc_transport.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _worker_env import (
    BARE_BIN,
    WORKER_AVAILABLE,
    WORKER_PATH,
    _bundled_worker_and_bare,
)

import tetherto.qvac_sdk as qvac_sdk_pkg
from tetherto.qvac_sdk._generated.sdk_version import SDK_VERSION
from tetherto.qvac_sdk.client import (
    Client,
    WorkerNotFoundError,
    _bare_executable_name,
    _bare_runtime_package_suffix,
    _resolve_command,
)
from tetherto.qvac_sdk.methods import heartbeat
from tetherto.qvac_sdk.schemas import HeartbeatRequest


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
        f"/sdk/node_modules/bare-runtime-{_bare_runtime_package_suffix()}/bin/"
        f"{_bare_executable_name()}"
    )


def test_resolve_command_derives_from_sdk_dir(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    bare, worker = _resolve_command(None, None, "/sdk")
    assert Path(worker) == Path("/sdk/dist/server/worker.js")
    assert Path(bare) == Path(
        f"/sdk/node_modules/bare-runtime-{_bare_runtime_package_suffix()}/bin/"
        f"{_bare_executable_name()}"
    )


def test_resolve_command_sdk_dir_env_var(monkeypatch) -> None:
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.setenv("QVAC_SDK_DIR", "/env-sdk")
    bare, worker = _resolve_command(None, None, None)
    assert Path(worker) == Path("/env-sdk/dist/server/worker.js")


def test_resolve_command_uses_bundled_wheel(monkeypatch, tmp_path) -> None:
    # The self-contained bundled wheel resolves ahead of sdk_dir / managed /
    # global, with no env or checkout: stage a fake _bundle next to a patched
    # client __file__ and assert it wins even when an sdk_dir is also passed.
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    bundled_worker = tmp_path / "_bundle" / "worker" / "dist" / "server" / "worker.js"
    bundled_bare = tmp_path / "_bundle" / "runtime" / _bare_executable_name()
    bundled_worker.parent.mkdir(parents=True)
    bundled_worker.write_text("")
    bundled_bare.parent.mkdir(parents=True)
    bundled_bare.write_text("")
    # _resolve_command derives the bundle from Path(__file__).parent of the
    # client module; point that at tmp_path so the staged _bundle is found.
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__", str(tmp_path / "client.py")
    )
    bare, worker = _resolve_command(None, None, "/sdk")
    assert Path(worker) == bundled_worker
    assert Path(bare) == bundled_bare


def test_resolve_command_uses_bundled_bare_exe_on_windows(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client._bare_executable_name", lambda: "bare.exe"
    )
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    bundled_worker = tmp_path / "_bundle" / "worker" / "dist" / "server" / "worker.js"
    bundled_bare = tmp_path / "_bundle" / "runtime" / "bare.exe"
    bundled_worker.parent.mkdir(parents=True)
    bundled_worker.write_text("")
    bundled_bare.parent.mkdir(parents=True)
    bundled_bare.write_text("")
    (tmp_path / "_bundle" / "runtime" / "bare").write_text("")
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__", str(tmp_path / "client.py")
    )
    bare, worker = _resolve_command(None, None, "/sdk")
    assert Path(worker) == bundled_worker
    assert Path(bare) == bundled_bare


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
        .endswith(
            f"bare-runtime-{_bare_runtime_package_suffix()}/bin/{_bare_executable_name()}"
        )
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


def test_client_transport_property_requires_connect() -> None:
    # __init__ only checks these paths exist, not that they're a real worker --
    # any real file will do for this not-yet-connected check.
    client = Client(worker_path=__file__, bare_path=__file__)
    with pytest.raises(RuntimeError, match="not connected"):
        client.transport


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
    _bundled_worker_and_bare() is None,
    reason="zero-config Client() requires an installed fat-wheel _bundle",
)
async def test_client_zero_config_uses_installed_bundle(monkeypatch) -> None:
    # Restores real client.__file__ past the autouse neutralization so the
    # installed wheel's `_bundle` is what `Client()` resolves.
    monkeypatch.setattr(
        "tetherto.qvac_sdk.client.__file__",
        str(Path(qvac_sdk_pkg.__file__).resolve().parent / "client.py"),
    )
    monkeypatch.delenv("QVAC_WORKER_PATH", raising=False)
    monkeypatch.delenv("QVAC_BARE_PATH", raising=False)
    monkeypatch.delenv("QVAC_SDK_DIR", raising=False)

    async with Client() as client:
        response = await heartbeat(client.transport, HeartbeatRequest(type="heartbeat"))
        assert response.type == "heartbeat"
        assert isinstance(response.number, float)
