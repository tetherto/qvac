from __future__ import annotations

import json
from pathlib import Path

import benchmark as harness


def test_role_and_reasoning_chunks_do_not_count_as_first_content() -> None:
    timings = harness.StreamTimings(request_start_s=100.0)
    clock = iter([100.5, 100.8, 101.0])

    def now() -> float:
        return next(clock)

    chunks = [
        harness.FakeChunk(role="assistant", content=None),
        harness.FakeChunk(reasoning_content="thinking..."),
        harness.FakeChunk(content="Hello"),
        harness.FakeChunk(content=" world"),
        harness.FakeChunk(
            empty_choices=True,
            usage=harness.FakeUsage(prompt_tokens=12, completion_tokens=4),
            model="m",
        ),
    ]
    parsed = harness.parse_stream(chunks, timings, now=now)
    assert parsed.content == "Hello world"
    assert parsed.reasoning_content == "thinking..."
    assert timings.first_content_s == 100.5
    assert timings.last_content_s == 100.8
    assert parsed.prompt_tokens == 12
    assert parsed.completion_tokens == 4


def test_final_usage_required_and_extracted() -> None:
    timings = harness.StreamTimings(request_start_s=0.0)
    chunks = [
        harness.FakeChunk(content="x"),
        harness.FakeChunk(
            empty_choices=True,
            usage=harness.FakeUsage(prompt_tokens=100, completion_tokens=8),
        ),
    ]
    parsed = harness.parse_stream(chunks, timings, now=lambda: 1.0)
    metrics = harness.compute_metrics(parsed)
    validation = harness.validate_run(parsed=parsed, metrics=metrics)
    assert validation.ok
    assert metrics.prompt_tokens == 100
    assert metrics.completion_tokens == 8


def test_decode_and_prefill_formulas() -> None:
    timings = harness.StreamTimings(
        request_start_s=0.0,
        first_content_s=0.5,
        last_content_s=1.5,
        stream_end_s=1.6,
    )
    parsed = harness.StreamParseResult(
        content="abcd",
        reasoning_content="",
        prompt_tokens=200,
        completion_tokens=11,
        response_model="m",
        timings=timings,
    )
    metrics = harness.compute_metrics(parsed)
    assert metrics.ttft_ms == 500.0
    assert metrics.total_ms == 1600.0
    assert metrics.decode_window_ms == 1000.0
    assert metrics.decode_tps == 10.0
    assert metrics.effective_prefill_tps == 400.0


def test_decode_tps_unavailable_for_lt_two_completion_tokens() -> None:
    timings = harness.StreamTimings(
        request_start_s=0.0,
        first_content_s=0.1,
        last_content_s=0.2,
        stream_end_s=0.3,
    )
    parsed = harness.StreamParseResult(
        content="x",
        reasoning_content="",
        prompt_tokens=10,
        completion_tokens=1,
        response_model="m",
        timings=timings,
    )
    metrics = harness.compute_metrics(parsed)
    assert metrics.decode_tps is None
    assert metrics.decode_tps_unavailable_reason == "completion_tokens_lt_2"


def test_median_quartiles_iqr_for_five_values() -> None:
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    stats = harness.aggregate_metric(values, n_failed=0)
    assert stats.n_valid == 5
    assert stats.median == 30.0
    assert stats.p25 == 20.0
    assert stats.p75 == 40.0
    assert stats.iqr == 20.0


def test_failed_runs_excluded_from_aggregates() -> None:
    values = [10.0, None, 30.0]
    stats = harness.aggregate_metric(values, n_failed=1)
    assert stats.n_valid == 2
    assert stats.n_failed == 1
    assert stats.median == 20.0


def test_atomic_result_persistence(tmp_path: Path) -> None:
    path = tmp_path / "raw.json"
    payload = {"runs": [{"id": 1}]}
    harness.atomic_write_json(path, payload)
    payload["runs"].append({"id": 2})
    harness.atomic_write_json(path, payload)
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert loaded["runs"] == [{"id": 1}, {"id": 2}]


def test_missing_usage_and_empty_output_fail_validation() -> None:
    timings = harness.StreamTimings(request_start_s=0.0, stream_end_s=1.0)
    parsed = harness.StreamParseResult(
        content="",
        reasoning_content="",
        prompt_tokens=None,
        completion_tokens=None,
        response_model="m",
        timings=timings,
    )
    metrics = harness.compute_metrics(parsed)
    validation = harness.validate_run(parsed=parsed, metrics=metrics)
    assert not validation.ok
    assert "empty_content" in validation.reasons
    assert "missing_usage" in validation.reasons


def test_think_markers_in_content_fail_validation() -> None:
    timings = harness.StreamTimings(
        request_start_s=0.0,
        first_content_s=0.1,
        last_content_s=0.2,
        stream_end_s=0.3,
    )
    parsed = harness.StreamParseResult(
        content="<think>secret</think>answer",
        reasoning_content="",
        prompt_tokens=5,
        completion_tokens=5,
        response_model="m",
        timings=timings,
    )
    metrics = harness.compute_metrics(parsed)
    validation = harness.validate_run(parsed=parsed, metrics=metrics)
    assert not validation.ok
    assert any(r.startswith("think_marker_in_content") for r in validation.reasons)


def test_reasoning_content_non_empty_fails_validation() -> None:
    timings = harness.StreamTimings(
        request_start_s=0.0,
        first_content_s=0.1,
        last_content_s=0.2,
        stream_end_s=0.3,
    )
    parsed = harness.StreamParseResult(
        content="answer",
        reasoning_content="chain",
        prompt_tokens=5,
        completion_tokens=5,
        response_model="m",
        timings=timings,
    )
    metrics = harness.compute_metrics(parsed)
    validation = harness.validate_run(parsed=parsed, metrics=metrics)
    assert not validation.ok
    assert "reasoning_content_non_empty" in validation.reasons


def test_rotate_ids() -> None:
    assert harness.rotate_ids(["a", "b", "c"], 1) == ["b", "c", "a"]


def test_build_messages_inserts_run_id() -> None:
    messages = harness.build_messages("hello", run_id="abc")
    assert messages == [{"role": "user", "content": "[run:abc] hello"}]


def test_response_model_mismatch_does_not_fail_validation() -> None:
    timings = harness.StreamTimings(
        request_start_s=0.0,
        first_content_s=0.1,
        last_content_s=0.2,
        stream_end_s=0.3,
    )
    parsed = harness.StreamParseResult(
        content="answer",
        reasoning_content="",
        prompt_tokens=5,
        completion_tokens=5,
        response_model="some-other-visible-id",
        timings=timings,
    )
    metrics = harness.compute_metrics(parsed)
    validation = harness.validate_run(parsed=parsed, metrics=metrics)
    assert validation.ok
    assert not any(r.startswith("model_mismatch") for r in validation.reasons)


def test_measured_failure_counts_for_fail_closed_full() -> None:
    runs = [
        {"phase": "warmup", "ok": False},
        {"phase": "measured", "ok": True},
        {"phase": "measured", "ok": False},
    ]
    measured_failures = [r for r in runs if r.get("phase") == "measured" and not r.get("ok")]
    assert len(measured_failures) == 1
    exit_code = 1 if measured_failures else 0
    assert exit_code == 1
