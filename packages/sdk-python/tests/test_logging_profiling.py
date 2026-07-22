"""Unit tests for tetherto.qvac_sdk.logging_streams (per-model log fan-in, all-logs
subscription, registry lifecycle, load/unload side-effects) and
tetherto.qvac_sdk.profiling (the __profiling wire envelope + profiled_call)."""

from __future__ import annotations

import asyncio
from typing import Any

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk.logging_streams import (
    SDK_ALL_LOG_ID,
    has_active_stream_for_model,
    start_logging_stream_for_model,
    stop_logging_stream_for_model,
    subscribe_server_logs,
)
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4
from tetherto.qvac_sdk.profiling import (
    PROFILING_KEY,
    extract_profiling_meta,
    inject_profiling_meta,
    profiled_call,
    strip_profiling_meta,
)


def _log(id: str, level: str, message: str, namespace: str = "llamacpp") -> dict:
    return {
        "type": "loggingStream",
        "id": id,
        "level": level,
        "namespace": namespace,
        "message": message,
        "timestamp": 1.0,
    }


class RecordingLogger:
    def __init__(self):
        self.records: list[tuple[str, str]] = []

    def _record(self, level, fmt, *args):
        self.records.append((level, fmt % args if args else fmt))

    def error(self, fmt, *args):
        self._record("error", fmt, *args)

    def warning(self, fmt, *args):
        self._record("warning", fmt, *args)

    def info(self, fmt, *args):
        self._record("info", fmt, *args)

    def debug(self, fmt, *args):
        self._record("debug", fmt, *args)


class FakeTransport:
    """call() returns `response`; call_stream() yields `stream_items` then
    blocks forever (a live log stream never ends on its own), so tests can
    assert the pump keeps running until explicitly stopped."""

    def __init__(self, response=None, stream_items=None, hang: bool = True):
        self.response = response
        self.stream_items = stream_items or []
        self.hang = hang
        self.sent: Any = None
        self.stream_sent: Any = None

    async def call(self, payload):
        self.sent = payload
        return self.response

    async def call_stream(self, payload):
        self.stream_sent = payload
        for item in self.stream_items:
            yield item
        if self.hang:
            await asyncio.Event().wait()

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


async def _drain() -> None:
    # Let the pump task consume everything queued so far.
    for _ in range(10):
        await asyncio.sleep(0)


# ---- logging streams ---------------------------------------------------------


async def test_model_log_pump_dispatches_levels_and_stops():
    logs = [
        _log("m-1", "error", "boom"),
        _log("m-1", "warn", "careful"),
        _log("m-1", "info", "hello"),
        _log("m-1", "debug", "details"),
        _log("m-1", "off", "fallback to info"),
    ]
    transport = FakeTransport(stream_items=logs)
    logger = RecordingLogger()

    start_logging_stream_for_model(transport, "m-1", logger)
    assert has_active_stream_for_model("m-1")
    await _drain()

    assert logger.records == [
        ("error", "[llamacpp] boom"),
        ("warning", "[llamacpp] careful"),
        ("info", "[llamacpp] hello"),
        ("debug", "[llamacpp] details"),
        ("info", "[llamacpp] fallback to info"),
    ]
    assert transport.stream_sent == {"type": "loggingStream", "id": "m-1"}

    stop_logging_stream_for_model("m-1")
    await _drain()
    assert not has_active_stream_for_model("m-1")


async def test_duplicate_start_is_a_noop():
    transport = FakeTransport(stream_items=[])
    logger = RecordingLogger()
    start_logging_stream_for_model(transport, "m-2", logger)
    second = FakeTransport(stream_items=[])
    start_logging_stream_for_model(second, "m-2", logger)
    await _drain()
    # The second transport was never subscribed.
    assert second.stream_sent is None
    stop_logging_stream_for_model("m-2")
    await _drain()


async def test_subscribe_server_logs_uses_all_stream_and_unsubscribes():
    logs = [_log(SDK_ALL_LOG_ID, "info", "one"), _log("m-3", "info", "two")]
    transport = FakeTransport(stream_items=logs)
    seen: list[str] = []
    unsubscribe = subscribe_server_logs(transport, lambda log: seen.append(log.message))
    await _drain()
    assert seen == ["one", "two"]
    assert transport.stream_sent == {"type": "loggingStream", "id": SDK_ALL_LOG_ID}
    unsubscribe()
    await _drain()


async def test_load_model_logger_side_effect_and_unload_cleanup():
    transport = FakeTransport(
        response={"type": "loadModel", "success": True, "modelId": "m-4"},
        stream_items=[_log("m-4", "info", "model ready")],
    )
    logger = RecordingLogger()
    model_id = await api.load_model(
        transport, model_src=QWEN3_600M_INST_Q4, logger=logger
    )
    assert model_id == "m-4"
    assert has_active_stream_for_model("m-4")
    await _drain()
    assert ("info", "[llamacpp] model ready") in logger.records

    transport.response = {"type": "unloadModel", "success": True}
    await api.unload_model(transport, "m-4")
    await _drain()
    assert not has_active_stream_for_model("m-4")


# ---- profiling envelope --------------------------------------------------------


def test_envelope_inject_extract_strip_round_trip():
    payload = {"type": "heartbeat"}
    injected = inject_profiling_meta(payload, {"enabled": True, "id": "p-1"})
    assert injected[PROFILING_KEY] == {"enabled": True, "id": "p-1"}
    assert payload == {"type": "heartbeat"}  # original untouched

    assert extract_profiling_meta(injected) == {"enabled": True, "id": "p-1"}
    assert extract_profiling_meta({"type": "x"}) is None
    assert extract_profiling_meta("not a dict") is None

    assert strip_profiling_meta(injected) == {"type": "heartbeat"}
    assert strip_profiling_meta({"type": "x"}) == {"type": "x"}


async def test_profiled_call_times_and_splits_server_breakdown():
    transport = FakeTransport(
        response={
            "type": "heartbeat",
            "number": 1,
            PROFILING_KEY: {
                "id": "server-side-id",
                "server": {"totalMs": 3.2},
                "operation": {"name": "heartbeat"},
            },
        }
    )
    response, report = await profiled_call(transport, {"type": "heartbeat"})
    # Request carried the enabled meta with a fresh uuid.
    meta = transport.sent[PROFILING_KEY]
    assert meta["enabled"] is True and meta["includeServer"] is True
    assert meta["id"] == report.profile_id
    # Response meta was split out of the returned payload.
    assert PROFILING_KEY not in response
    assert response["number"] == 1
    assert report.server == {"totalMs": 3.2}
    assert report.operation == {"name": "heartbeat"}
    assert report.request_type == "heartbeat"
    assert report.total_ms >= 0
