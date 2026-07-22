#!/usr/bin/env python3
"""OpenAI-compatible server performance benchmark harness (qvac serve vs peers)."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import statistics
import sys
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import yaml

THINK_MARKERS = ("<think>", "</think>")
PLACEHOLDER_PREFIXES = ("REPLACE_WITH_",)


@dataclass
class StreamTimings:
    request_start_s: float
    first_content_s: float | None = None
    last_content_s: float | None = None
    stream_end_s: float | None = None


@dataclass
class StreamParseResult:
    content: str
    reasoning_content: str
    prompt_tokens: int | None
    completion_tokens: int | None
    response_model: str | None
    timings: StreamTimings
    error: str | None = None


@dataclass
class RunMetrics:
    ttft_ms: float | None
    total_ms: float | None
    decode_window_ms: float | None
    prompt_tokens: int | None
    completion_tokens: int | None
    decode_tps: float | None
    effective_prefill_tps: float | None
    decode_tps_unavailable_reason: str | None = None


@dataclass
class ValidationResult:
    ok: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class AggregateStats:
    median: float | None
    p25: float | None
    p75: float | None
    iqr: float | None
    n_valid: int
    n_failed: int


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"config must be a mapping: {path}")
    return data


def load_prompts(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if "parity" not in data or "prompts" not in data:
        raise ValueError("prompts.json must contain parity and prompts")
    return data


def prompt_by_id(prompts_doc: Mapping[str, Any], prompt_id: str) -> dict[str, Any]:
    if prompt_id == prompts_doc["parity"]["id"]:
        return dict(prompts_doc["parity"])
    for prompt in prompts_doc["prompts"]:
        if prompt["id"] == prompt_id:
            return dict(prompt)
    raise KeyError(f"unknown prompt id: {prompt_id}")


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def build_messages(content: str, run_id: str | None) -> list[dict[str, str]]:
    if run_id:
        body = f"[run:{run_id}] {content}"
    else:
        body = content
    return [{"role": "user", "content": body}]


def build_completion_kwargs(
    *,
    model: str,
    messages: Sequence[Mapping[str, str]],
    generation: Mapping[str, Any],
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": list(messages),
        "stream": True,
        "temperature": generation.get("temperature", 0),
        "max_tokens": generation.get("max_tokens", 128),
        "stream_options": dict(generation.get("stream_options") or {"include_usage": True}),
    }
    if "seed" in generation and generation["seed"] is not None:
        kwargs["seed"] = generation["seed"]
    return kwargs


def _delta_field(delta: Any, name: str) -> str:
    value = getattr(delta, name, None)
    if value is None and isinstance(delta, Mapping):
        value = delta.get(name)
    return value if isinstance(value, str) else ""


def parse_stream(
    chunks: Iterable[Any],
    timings: StreamTimings,
    *,
    now: Any = time.perf_counter,
) -> StreamParseResult:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    response_model: str | None = None
    error: str | None = None

    try:
        for chunk in chunks:
            response_model = getattr(chunk, "model", None) or response_model
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                pt = getattr(usage, "prompt_tokens", None)
                ct = getattr(usage, "completion_tokens", None)
                if pt is not None:
                    prompt_tokens = int(pt)
                if ct is not None:
                    completion_tokens = int(ct)

            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            choice0 = choices[0]
            delta = getattr(choice0, "delta", None)
            if delta is None:
                continue

            reasoning = _delta_field(delta, "reasoning_content")
            if reasoning:
                reasoning_parts.append(reasoning)

            text = _delta_field(delta, "content")
            if text:
                ts = now()
                if timings.first_content_s is None:
                    timings.first_content_s = ts
                timings.last_content_s = ts
                content_parts.append(text)
    except Exception as exc:  # noqa: BLE001 - surface stream failures as parse errors
        error = f"{type(exc).__name__}: {exc}"

    timings.stream_end_s = now()
    return StreamParseResult(
        content="".join(content_parts),
        reasoning_content="".join(reasoning_parts),
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        response_model=response_model,
        timings=timings,
        error=error,
    )


def compute_metrics(parsed: StreamParseResult) -> RunMetrics:
    t = parsed.timings
    ttft_ms = None
    total_ms = None
    decode_window_ms = None

    if t.first_content_s is not None:
        ttft_ms = (t.first_content_s - t.request_start_s) * 1000.0
    if t.stream_end_s is not None:
        total_ms = (t.stream_end_s - t.request_start_s) * 1000.0
    if t.first_content_s is not None and t.last_content_s is not None:
        decode_window_ms = (t.last_content_s - t.first_content_s) * 1000.0

    decode_tps = None
    decode_reason = None
    if parsed.completion_tokens is None:
        decode_reason = "missing_completion_tokens"
    elif parsed.completion_tokens < 2:
        decode_reason = "completion_tokens_lt_2"
    elif decode_window_ms is None or decode_window_ms <= 0:
        decode_reason = "decode_window_zero_or_missing"
    else:
        decode_tps = (parsed.completion_tokens - 1) / (decode_window_ms / 1000.0)

    effective_prefill_tps = None
    if (
        parsed.prompt_tokens is not None
        and parsed.prompt_tokens > 0
        and ttft_ms is not None
        and ttft_ms > 0
    ):
        effective_prefill_tps = parsed.prompt_tokens / (ttft_ms / 1000.0)

    return RunMetrics(
        ttft_ms=ttft_ms,
        total_ms=total_ms,
        decode_window_ms=decode_window_ms,
        prompt_tokens=parsed.prompt_tokens,
        completion_tokens=parsed.completion_tokens,
        decode_tps=decode_tps,
        effective_prefill_tps=effective_prefill_tps,
        decode_tps_unavailable_reason=decode_reason,
    )


def validate_run(
    *,
    parsed: StreamParseResult,
    metrics: RunMetrics,
    require_content: bool = True,
    check_reasoning_off: bool = True,
) -> ValidationResult:
    reasons: list[str] = []
    if parsed.error:
        reasons.append(f"stream_error:{parsed.error}")
    if require_content and not parsed.content.strip():
        reasons.append("empty_content")
    if parsed.prompt_tokens is None or parsed.completion_tokens is None:
        reasons.append("missing_usage")
    else:
        if parsed.prompt_tokens <= 0:
            reasons.append("prompt_tokens_zero")
        if parsed.completion_tokens <= 0:
            reasons.append("completion_tokens_zero")
    if metrics.ttft_ms is None:
        reasons.append("missing_ttft")
    if metrics.total_ms is None:
        reasons.append("missing_total")
    # Do not require response `model` to equal the request model string.
    # LM Studio / Ollama often echo a different visible id than the request alias.
    if check_reasoning_off:
        lowered = parsed.content.lower()
        for marker in THINK_MARKERS:
            if marker in lowered:
                reasons.append(f"think_marker_in_content:{marker}")
                break
        if parsed.reasoning_content.strip():
            reasons.append("reasoning_content_non_empty")
    return ValidationResult(ok=len(reasons) == 0, reasons=reasons)


def quantiles_inclusive(values: Sequence[float]) -> tuple[float, float, float]:
    if not values:
        raise ValueError("values must be non-empty")
    if len(values) == 1:
        v = float(values[0])
        return v, v, v
    q = statistics.quantiles(list(values), n=4, method="inclusive")
    # q[0]=Q1, q[1]=Q2/median, q[2]=Q3 for n=4
    return float(q[0]), float(q[1]), float(q[2])


def aggregate_metric(values: Sequence[float | None], n_failed: int) -> AggregateStats:
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return AggregateStats(
            median=None, p25=None, p75=None, iqr=None, n_valid=0, n_failed=n_failed
        )
    p25, median, p75 = quantiles_inclusive(sorted(clean))
    return AggregateStats(
        median=median,
        p25=p25,
        p75=p75,
        iqr=p75 - p25,
        n_valid=len(clean),
        n_failed=n_failed,
    )


def rotate_ids(ids: Sequence[str], offset: int) -> list[str]:
    if not ids:
        return []
    o = offset % len(ids)
    return list(ids[o:]) + list(ids[:o])


def create_session_dir(base: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session = base / f"session-{stamp}-{uuid.uuid4().hex[:8]}"
    session.mkdir(parents=True, exist_ok=False)
    return session


def new_raw_document(config: Mapping[str, Any], session_id: str) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "config_snapshot": {
            "generation": config.get("generation"),
            "cooldown_seconds": config.get("cooldown_seconds"),
            "warmup_runs": config.get("warmup_runs"),
            "measured_runs": config.get("measured_runs"),
            "prompt_ids": config.get("prompt_ids"),
            "providers": [
                {"id": p["id"], "base_url": p["base_url"], "model": p["model"]}
                for p in config.get("providers", [])
            ],
            "model_parity": config.get("model_parity"),
        },
        "provider_order": [],
        "parity": {},
        "runs": [],
    }


def append_run(raw_path: Path, raw: dict[str, Any], run: Mapping[str, Any]) -> None:
    raw["runs"].append(dict(run))
    atomic_write_json(raw_path, raw)


class FakeDelta:
    def __init__(self, content: str | None = None, reasoning_content: str | None = None):
        self.content = content
        self.reasoning_content = reasoning_content


class FakeChoice:
    def __init__(self, delta: FakeDelta):
        self.delta = delta


class FakeUsage:
    def __init__(self, prompt_tokens: int, completion_tokens: int):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens


class FakeChunk:
    def __init__(
        self,
        *,
        content: str | None = None,
        reasoning_content: str | None = None,
        role: str | None = None,
        usage: FakeUsage | None = None,
        model: str | None = None,
        empty_choices: bool = False,
    ):
        self.model = model
        self.usage = usage
        if empty_choices:
            self.choices = []
            return
        delta = FakeDelta(content=content, reasoning_content=reasoning_content)
        if role is not None:
            setattr(delta, "role", role)
        self.choices = [FakeChoice(delta)]


def make_client(base_url: str, api_key: str) -> Any:
    from openai import OpenAI

    return OpenAI(base_url=base_url, api_key=api_key)


def run_streaming_completion(
    client: Any,
    *,
    model: str,
    messages: Sequence[Mapping[str, str]],
    generation: Mapping[str, Any],
) -> tuple[StreamParseResult, RunMetrics, ValidationResult]:
    kwargs = build_completion_kwargs(model=model, messages=messages, generation=generation)
    timings = StreamTimings(request_start_s=time.perf_counter())
    try:
        stream = client.chat.completions.create(**kwargs)
        parsed = parse_stream(stream, timings)
    except Exception as exc:  # noqa: BLE001
        timings.stream_end_s = time.perf_counter()
        parsed = StreamParseResult(
            content="",
            reasoning_content="",
            prompt_tokens=None,
            completion_tokens=None,
            response_model=None,
            timings=timings,
            error=f"{type(exc).__name__}: {exc}",
        )
    metrics = compute_metrics(parsed)
    validation = validate_run(parsed=parsed, metrics=metrics)
    return parsed, metrics, validation


def config_placeholders(config: Mapping[str, Any]) -> list[str]:
    bad: list[str] = []
    for provider in config.get("providers", []):
        for key in ("model", "base_url"):
            value = str(provider.get(key, ""))
            if any(value.startswith(p) for p in PLACEHOLDER_PREFIXES):
                bad.append(f"providers.{provider.get('id')}.{key}")
    gguf = str(config.get("model_parity", {}).get("gguf_path", ""))
    if any(gguf.startswith(p) for p in PLACEHOLDER_PREFIXES) or not gguf:
        bad.append("model_parity.gguf_path")
    return bad


def cmd_digest(config: Mapping[str, Any]) -> int:
    path = Path(config["model_parity"]["gguf_path"]).expanduser()
    if not path.is_file():
        print(f"GGUF not found: {path}", file=sys.stderr)
        return 1
    digest = sha256_file(path)
    size = path.stat().st_size
    print(json.dumps({"path": str(path), "bytes": size, "sha256": digest}, indent=2))
    return 0


def cmd_preflight(
    config: Mapping[str, Any],
    prompts_doc: Mapping[str, Any],
    *,
    session_dir: Path | None = None,
) -> int:
    bad = config_placeholders(config)
    if bad:
        print("Replace placeholders before preflight:", file=sys.stderr)
        for item in bad:
            print(f"  - {item}", file=sys.stderr)
        return 1

    parity = prompt_by_id(prompts_doc, config.get("parity_prompt_id", "parity"))
    generation = config["generation"]
    api_key = config.get("api_key", "local-benchmark-key")
    results: dict[str, Any] = {}
    prompt_token_counts: dict[str, int] = {}

    for provider in config["providers"]:
        client = make_client(provider["base_url"], api_key)
        messages = build_messages(parity["content"], run_id=None)
        parsed, metrics, validation = run_streaming_completion(
            client,
            model=provider["model"],
            messages=messages,
            generation=generation,
        )
        entry = {
            "ok": validation.ok,
            "reasons": validation.reasons,
            "prompt_tokens": parsed.prompt_tokens,
            "completion_tokens": parsed.completion_tokens,
            "response_model": parsed.response_model,
            "content": parsed.content,
            "metrics": asdict(metrics),
        }
        results[provider["id"]] = entry
        if parsed.prompt_tokens is not None:
            prompt_token_counts[provider["id"]] = parsed.prompt_tokens
        status = "OK" if validation.ok else "FAIL"
        print(f"[{status}] {provider['id']}: reasons={validation.reasons} usage=({parsed.prompt_tokens},{parsed.completion_tokens})")

    unique = set(prompt_token_counts.values())
    parity_ok = len(unique) == 1 and len(prompt_token_counts) == len(config["providers"])
    if not parity_ok:
        print(
            f"FAIL prompt_tokens parity across providers: {prompt_token_counts}",
            file=sys.stderr,
        )
    else:
        print(f"OK prompt_tokens parity: {next(iter(unique))}")

    if session_dir is not None:
        raw_path = session_dir / "raw.json"
        raw = new_raw_document(config, session_dir.name)
        raw["parity"] = {"results": results, "prompt_tokens_equal": parity_ok}
        atomic_write_json(raw_path, raw)

    all_ok = parity_ok and all(v["ok"] for v in results.values())
    return 0 if all_ok else 1


def _run_one(
    *,
    client: Any,
    provider: Mapping[str, Any],
    prompt: Mapping[str, Any],
    generation: Mapping[str, Any],
    phase: str,
    run_index: int,
) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:10]
    messages = build_messages(prompt["content"], run_id=run_id)
    started = datetime.now(timezone.utc).isoformat()
    parsed, metrics, validation = run_streaming_completion(
        client,
        model=provider["model"],
        messages=messages,
        generation=generation,
    )
    ended = datetime.now(timezone.utc).isoformat()
    return {
        "provider": provider["id"],
        "prompt_id": prompt["id"],
        "phase": phase,
        "run_index": run_index,
        "run_id": run_id,
        "started_at": started,
        "ended_at": ended,
        "ok": validation.ok,
        "validation_reasons": validation.reasons,
        "response_model": parsed.response_model,
        "content_preview": parsed.content[:240],
        "reasoning_preview": parsed.reasoning_content[:240],
        "error": parsed.error,
        "metrics": asdict(metrics),
    }


def cmd_smoke(config: Mapping[str, Any], prompts_doc: Mapping[str, Any]) -> int:
    pre = cmd_preflight(config, prompts_doc)
    if pre != 0:
        return pre

    shortest = config["prompt_ids"][0]
    prompt = prompt_by_id(prompts_doc, shortest)
    generation = config["generation"]
    api_key = config.get("api_key", "local-benchmark-key")
    failed = False
    for provider in config["providers"]:
        client = make_client(provider["base_url"], api_key)
        result = _run_one(
            client=client,
            provider=provider,
            prompt=prompt,
            generation=generation,
            phase="smoke",
            run_index=0,
        )
        status = "OK" if result["ok"] else "FAIL"
        print(
            f"[{status}] smoke {provider['id']} {shortest}: "
            f"ttft_ms={result['metrics']['ttft_ms']} "
            f"decode_tps={result['metrics']['decode_tps']} "
            f"reasons={result['validation_reasons']}"
        )
        if not result["ok"]:
            failed = True
    return 1 if failed else 0


def cmd_calibrate(
    config: Mapping[str, Any],
    prompts_doc: Mapping[str, Any],
    *,
    provider_id: str,
) -> int:
    provider = next((p for p in config["providers"] if p["id"] == provider_id), None)
    if provider is None:
        print(f"unknown provider: {provider_id}", file=sys.stderr)
        return 1
    if any(str(provider.get("model", "")).startswith(p) for p in PLACEHOLDER_PREFIXES):
        print(f"set providers.{provider_id}.model first", file=sys.stderr)
        return 1

    client = make_client(provider["base_url"], config.get("api_key", "local-benchmark-key"))
    generation = dict(config["generation"])
    # Calibration only needs usage + short output.
    generation["max_tokens"] = min(int(generation.get("max_tokens", 128)), 16)

    rows = []
    for prompt_id in config["prompt_ids"]:
        prompt = prompt_by_id(prompts_doc, prompt_id)
        parsed, _metrics, validation = run_streaming_completion(
            client,
            model=provider["model"],
            messages=build_messages(prompt["content"], run_id="calibrate"),
            generation=generation,
        )
        rows.append(
            {
                "prompt_id": prompt_id,
                "target_prompt_tokens": prompt.get("target_prompt_tokens"),
                "measured_prompt_tokens": parsed.prompt_tokens,
                "ok": validation.ok,
                "reasons": validation.reasons,
            }
        )
        print(json.dumps(rows[-1]))
    return 0 if all(r["ok"] and r["measured_prompt_tokens"] for r in rows) else 1


def cmd_full(
    config: Mapping[str, Any],
    prompts_doc: Mapping[str, Any],
    *,
    root: Path,
) -> int:
    session_base = root / str(config.get("session_dir", "results"))
    session_dir = create_session_dir(session_base)
    raw_path = session_dir / "raw.json"
    raw = new_raw_document(config, session_dir.name)
    atomic_write_json(raw_path, raw)

    print(f"session: {session_dir}")
    if cmd_preflight(config, prompts_doc, session_dir=session_dir) != 0:
        print("preflight failed; aborting full sweep", file=sys.stderr)
        return 1

    # Reload raw written by preflight.
    raw = json.loads(raw_path.read_text(encoding="utf-8"))

    generation = config["generation"]
    api_key = config.get("api_key", "local-benchmark-key")
    warmup_runs = int(config.get("warmup_runs", 1))
    measured_runs = int(config.get("measured_runs", 5))
    cooldown_seconds = int(config.get("cooldown_seconds", 90))
    base_prompt_ids = list(config["prompt_ids"])

    for provider_index, provider in enumerate(config["providers"]):
        raw["provider_order"].append(provider["id"])
        atomic_write_json(raw_path, raw)
        print(f"\n=== provider {provider['id']} ===")
        client = make_client(provider["base_url"], api_key)
        order = rotate_ids(base_prompt_ids, provider_index)
        print(f"prompt order: {order}")

        for prompt_id in order:
            prompt = prompt_by_id(prompts_doc, prompt_id)
            for i in range(warmup_runs):
                run = _run_one(
                    client=client,
                    provider=provider,
                    prompt=prompt,
                    generation=generation,
                    phase="warmup",
                    run_index=i,
                )
                append_run(raw_path, raw, run)
                print(f"warmup {provider['id']} {prompt_id}#{i} ok={run['ok']}")
            for i in range(measured_runs):
                run = _run_one(
                    client=client,
                    provider=provider,
                    prompt=prompt,
                    generation=generation,
                    phase="measured",
                    run_index=i,
                )
                append_run(raw_path, raw, run)
                m = run["metrics"]
                print(
                    f"measured {provider['id']} {prompt_id}#{i} ok={run['ok']} "
                    f"ttft_ms={m['ttft_ms']} decode_tps={m['decode_tps']}"
                )

        if provider_index < len(config["providers"]) - 1 and cooldown_seconds > 0:
            print(f"cooldown {cooldown_seconds}s before next provider")
            time.sleep(cooldown_seconds)

    report_path = session_dir / "report.md"
    write_report(raw, report_path)
    # Convenience copies under results/
    atomic_write_json(session_base / "raw.json", raw)
    report_path_copy = session_base / "report.md"
    report_path_copy.write_text(report_path.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"wrote {report_path}")
    print(f"copied {session_base / 'raw.json'} and {report_path_copy}")

    measured_failures = [
        r for r in raw.get("runs", []) if r.get("phase") == "measured" and not r.get("ok")
    ]
    if measured_failures:
        print(
            f"FAIL: {len(measured_failures)} measured run(s) failed; see {raw_path}",
            file=sys.stderr,
        )
        return 1
    return 0


def _fmt(value: float | None, digits: int = 2) -> str:
    if value is None:
        return "—"
    return f"{value:.{digits}f}"


def write_report(raw: Mapping[str, Any], path: Path) -> None:
    providers = [p["id"] for p in raw.get("config_snapshot", {}).get("providers", [])]
    prompt_ids = list(raw.get("config_snapshot", {}).get("prompt_ids", []))
    measured = [
        r
        for r in raw.get("runs", [])
        if r.get("phase") == "measured"
    ]

    lines: list[str] = []
    lines.append("# OpenAI Server Performance Benchmark Report")
    lines.append("")
    lines.append(f"Session: `{raw.get('session_id')}`")
    lines.append(f"Created: `{raw.get('created_at')}`")
    lines.append("")
    lines.append("## Executive summary")
    lines.append("")
    lines.append(
        "Client-side comparison of OpenAI-compatible `/v1/chat/completions` "
        "across qvac serve, Ollama, and LM Studio using one shared GGUF and one shared SDK path."
    )
    lines.append("")
    lines.append("## Environment and exact revisions")
    lines.append("")
    lines.append("See `environment.md` in the harness directory for host, package, and launch details.")
    lines.append("")
    parity = raw.get("parity", {})
    lines.append("## Model parity evidence")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(raw.get("config_snapshot", {}).get("model_parity", {}), indent=2))
    lines.append("```")
    lines.append("")
    lines.append("Preflight parity:")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(parity, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Methodology and metric definitions")
    lines.append("")
    lines.append("- TTFT: request start → first non-empty `delta.content`")
    lines.append("- Total: request start → stream completion")
    lines.append("- Decode TPS: `(completion_tokens - 1) / decode_window_s`")
    lines.append(
        "- Effective prefill TPS (proxy): `prompt_tokens / ttft_s` "
        "(includes HTTP, queueing, template, prefill, first token; not native ppTPS)"
    )
    lines.append(f"- Provider order: {raw.get('provider_order')}")
    lines.append(
        f"- Cool-down between providers: {raw.get('config_snapshot', {}).get('cooldown_seconds')}s"
    )
    lines.append("")

    metric_keys = [
        ("ttft_ms", "TTFT (ms)"),
        ("total_ms", "Total latency (ms)"),
        ("decode_tps", "Decode TPS"),
    ]
    lines.append("## Median and IQR tables by prompt size")
    lines.append("")
    for metric_key, title in metric_keys:
        lines.append(f"### {title}")
        lines.append("")
        header = "| Prompt | " + " | ".join(providers) + " |"
        sep = "|---| " + " | ".join(["---"] * len(providers)) + " |"
        lines.append(header)
        lines.append(sep)
        for prompt_id in prompt_ids:
            cells = [prompt_id]
            for provider in providers:
                values = [
                    r.get("metrics", {}).get(metric_key)
                    for r in measured
                    if r.get("provider") == provider
                    and r.get("prompt_id") == prompt_id
                    and r.get("ok")
                ]
                n_failed = sum(
                    1
                    for r in measured
                    if r.get("provider") == provider
                    and r.get("prompt_id") == prompt_id
                    and not r.get("ok")
                )
                stats = aggregate_metric(values, n_failed)
                cells.append(
                    f"{_fmt(stats.median)} (IQR {_fmt(stats.iqr)}; n={stats.n_valid}/{stats.n_valid + stats.n_failed})"
                )
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")

    lines.append("## Effective prefill TPS (proxy)")
    lines.append("")
    lines.append(
        "End-to-end proxy only. Do not interpret as native llama.cpp prefill throughput."
    )
    lines.append("")
    header = "| Prompt | " + " | ".join(providers) + " |"
    sep = "|---| " + " | ".join(["---"] * len(providers)) + " |"
    lines.append(header)
    lines.append(sep)
    for prompt_id in prompt_ids:
        cells = [prompt_id]
        for provider in providers:
            values = [
                r.get("metrics", {}).get("effective_prefill_tps")
                for r in measured
                if r.get("provider") == provider
                and r.get("prompt_id") == prompt_id
                and r.get("ok")
            ]
            n_failed = sum(
                1
                for r in measured
                if r.get("provider") == provider
                and r.get("prompt_id") == prompt_id
                and not r.get("ok")
            )
            stats = aggregate_metric(values, n_failed)
            cells.append(f"{_fmt(stats.median)} (IQR {_fmt(stats.iqr)})")
        lines.append("| " + " | ".join(cells) + " |")
    lines.append("")

    lines.append("## Run variability and failures")
    lines.append("")
    failures = [r for r in measured if not r.get("ok")]
    lines.append(f"Measured failures: {len(failures)}")
    lines.append("")
    for fail in failures:
        lines.append(
            f"- `{fail.get('provider')}` `{fail.get('prompt_id')}` "
            f"#{fail.get('run_index')}: {fail.get('validation_reasons')} error={fail.get('error')}"
        )
    if not failures:
        lines.append("- None")
    lines.append("")
    lines.append("## Interpretation")
    lines.append("")
    lines.append("_Fill in after reviewing medians, IQRs, and any failures._")
    lines.append("")
    lines.append("## Limitations")
    lines.append("")
    lines.append("- Single-host, single-model, sequential requests only.")
    lines.append("- Provider blocks are ordered; cool-down reduces but does not erase thermal carryover.")
    lines.append("- Effective prefill TPS is an end-to-end proxy, not native ppTPS.")
    lines.append("- Prompt size labels are nominal; run-id prefixes slightly change prompt_tokens per run.")
    lines.append("- llama.cpp / runtime build differences across servers are part of the measured stack.")
    lines.append("")
    lines.append("## Reproduction commands")
    lines.append("")
    lines.append("```bash")
    lines.append("python -m venv .venv && source .venv/bin/activate")
    lines.append("pip install -r requirements.txt")
    lines.append("python benchmark.py digest")
    lines.append("python benchmark.py preflight")
    lines.append("python benchmark.py smoke")
    lines.append("python benchmark.py full")
    lines.append("```")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def cmd_report(raw_path: Path, report_path: Path) -> int:
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    write_report(raw, report_path)
    print(f"wrote {report_path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("benchmark.yaml"),
        help="Path to benchmark.yaml",
    )
    parser.add_argument(
        "--prompts",
        type=Path,
        default=Path("prompts.json"),
        help="Path to prompts.json",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("digest", help="SHA-256 the configured GGUF")
    sub.add_parser("preflight", help="Parity + reasoning-off + usage checks")
    sub.add_parser("smoke", help="Preflight plus one short measured request per provider")
    cal = sub.add_parser("calibrate", help="Measure prompt_tokens for each prompt size")
    cal.add_argument("--provider", default="qvac", help="Provider id to calibrate against")
    sub.add_parser("full", help="Full warmup + measured sweep")
    rep = sub.add_parser("report", help="Rebuild report.md from a raw.json")
    rep.add_argument("--raw", type=Path, required=True)
    rep.add_argument("--out", type=Path, default=Path("results/report.md"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path.cwd()
    config = load_yaml(args.config if args.config.is_absolute() else root / args.config)
    prompts_doc = load_prompts(args.prompts if args.prompts.is_absolute() else root / args.prompts)

    if args.command == "digest":
        return cmd_digest(config)
    if args.command == "preflight":
        return cmd_preflight(config, prompts_doc)
    if args.command == "smoke":
        return cmd_smoke(config, prompts_doc)
    if args.command == "calibrate":
        return cmd_calibrate(config, prompts_doc, provider_id=args.provider)
    if args.command == "full":
        return cmd_full(config, prompts_doc, root=root)
    if args.command == "report":
        return cmd_report(args.raw, args.out)
    parser.error(f"unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
