# QVAC-22258 OpenAI Server Performance Benchmark Design

## Goal

Produce a reproducible, one-off comparison of `qvac serve`, LM Studio, and Ollama when serving the same Qwen3.5-9B Q4_K_M GGUF through `POST /v1/chat/completions` on the same macOS host.

The comparison measures the complete OpenAI-compatible server stack. Differences in each server's llama.cpp build and HTTP implementation are intentionally part of the result.

## Scope

The benchmark covers:

- `qvac serve` built from the exact merge commit of PR [#3259](https://github.com/tetherto/qvac/pull/3259) (`7ee761b70271`) or a later `main` commit that includes that change — record the SHA used in `environment.md`
- LM Studio
- Ollama
- One local Qwen3.5-9B Q4_K_M GGUF loaded by all three servers (registry constant `QWEN3_5_9B_MULTIMODAL_Q4_K_M` → `Qwen3.5-9B-Q4_K_M.gguf`)
- Cache-neutral, single-turn chat completions
- Four fixed prompt sizes of approximately 512, 2,000, 4,000, and 7,000 tokens (labels are nominal; calibrate against measured Qwen3.5 `prompt_tokens` after the shared chat template is applied)
- One warmup and five measured runs per provider and prompt size
- Client-measured TTFT and total latency
- Usage-based decode throughput and an end-to-end prefill proxy

It does not cover:

- Multi-turn or repeated-prompt KV-cache performance
- Concurrent request throughput
- Provider-native API endpoints
- Native telemetry in comparative tables
- Automated installation or lifecycle management of LM Studio and Ollama
- Running the full three-provider sweep on every pull request (harness unit tests only)

## CI

- **PR / `harness-unit`**: `pytest` for the harness (no models, no live servers) via
  `.github/workflows/benchmark-cli-serve-openai-providers.yml`
- **`workflow_dispatch` `smoke` / `full`**: optional live run on a self-hosted
  `qvac-macos*-gpu` runner when providers and the shared GGUF are already configured

## Artifacts

Self-contained package under `packages/cli/benchmarks/serve-openai-providers/`:

- `benchmark.py`: provider-neutral OpenAI Python SDK streaming runner
- `benchmark.yaml`: provider endpoints, model IDs, and shared generation settings
- `prompts.json`: the four fixed prompt bodies
- `requirements.txt`: exact Python dependency versions used for the run
- `test_benchmark.py`: focused harness and metric tests
- `environment.md`: hardware, software, model, and launch-command manifest
- `results/raw.json`: environment metadata and every warmup or measured run
- `results/report.md`: aggregate results, methodology, limitations, and conclusions

Credentials must not appear in configuration or result artifacts. Local endpoints should use a fixed non-secret placeholder API key where a client requires one.

## Server and Model Parity

Use the same GGUF bytes for all providers:

1. Resolve the Qwen3.5-9B Q4_K_M registry model to its local GGUF path.
2. Compute and record its SHA-256 digest.
3. Configure `qvac serve` to load that local model (commit SHA recorded in `environment.md`).
4. Load that file directly in LM Studio.
5. Import that file into Ollama with a `Modelfile` whose `FROM` points to the same path.
6. Record each provider's visible model identifier and confirm a preflight completion succeeds.

Match these settings wherever each provider exposes them:

- Context size: 8,192 tokens
- Output limit: 128 tokens
- Temperature: 0
- One fixed seed accepted by all three OpenAI-compatible endpoints
- Reasoning disabled (see below)
- Streaming enabled
- Usage included in the final stream chunk via `stream_options.include_usage` (three-provider smoke prerequisite)
- Metal/GPU acceleration enabled
- One resident model and no concurrent requests

Use the GGUF's embedded chat template without provider-specific system prompts or template overrides. Run the same short parity fixture through all three providers before benchmarking and require identical `prompt_tokens` counts. A mismatch blocks the sweep because it indicates that the servers are not evaluating equivalent serialized prompts.

### Reasoning disabled

Keep `reasoning_budget` and other provider-specific fields out of the shared request body. Disable thinking via server/load configuration so the request shape stays identical:

| Provider | Disable mechanism (record exact launch/config in `environment.md`) |
|---|---|
| `qvac serve` | Model/load config or server default equivalent to `reasoning_budget: 0` / thinking off for Qwen3.5 |
| Ollama | Modelfile / server setting that disables thinking (e.g. `PARAMETER think false` or current Ollama equivalent) |
| LM Studio | Load/runtime setting that disables reasoning / thinking for the GGUF |

Preflight must assert for every provider on the parity fixture:

- Final stream includes valid usage
- Non-empty `content` is produced
- No `<think>` / `</think>` markers appear in content
- No non-empty `reasoning_content` (or provider-equivalent reasoning field) is streamed

If any provider cannot fully disable reasoning, stop the formal comparison rather than mixing different TTFT semantics.

Reasoning mode and context size may require provider-specific server configuration rather than provider-specific request fields. The request body must contain only fields accepted by all three endpoints. If any provider rejects the proposed seed, omit `seed` from every provider rather than sending different request shapes.

The environment manifest records:

- macOS version, Apple chip, RAM, and power state
- Python and OpenAI SDK versions
- qvac PR URL, branch, and exact commit SHA (minimum: PR #3259 merge `7ee761b70271`)
- qvac CLI and SDK package versions
- LM Studio and Ollama versions
- Model path, file size, SHA-256, and registry constant name
- Context and generation settings
- Provider launch commands and ports
- Exact reasoning-disable settings used per provider

`qvac serve` must not use port `11434`, because that is Ollama's default. Use distinct endpoints such as qvac `11435`, Ollama `11434`, and LM Studio `1234`.

## Workload

Use fixed prompt bodies adapted from the existing calibrated prompt set in `packages/llm-llamacpp/benchmarks/performance/test-prompts.json`. Store the exact text in `prompts.json`; do not generate prompts during a timed run. Calibrate sizes with `python benchmark.py calibrate` against one provider so measured `prompt_tokens` land near the nominal targets for Qwen3.5's chat template; re-check parity across all three before the sweep.

Each request is a single user message. Insert a short run identifier near the start of the user content so a provider cannot reuse the full measured prompt prefix across runs. The run identifier is excluded from scenario naming but retained in raw request metadata. Size labels remain nominal because the run-id prefix makes `prompt_tokens` vary slightly across the five measured runs of a size; raw results keep per-run usage.

For each provider:

1. Run preflight validation.
2. Execute prompt sizes in a recorded rotated order.
3. Run one untimed warmup for each prompt size.
4. Run five measured requests sequentially for each prompt size.
5. Write each completed or failed run to `results/raw.json` immediately.
6. Cool the machine for **90 seconds** (recorded; override via `benchmark.yaml` `cooldown_seconds`) before switching providers.

Run only one provider benchmark block at a time. Stop unrelated inference processes and keep the Mac connected to AC power. The report must list provider execution order because provider blocks cannot be fully randomized without repeatedly unloading models.

## Streaming and Metric Definitions

All providers are called with the official OpenAI Python SDK through `chat.completions.create(..., stream=True, stream_options={"include_usage": true})`. The same request builder and stream parser handle every provider.

The benchmark timestamps:

- Request start, immediately before invoking the SDK
- First non-empty `choices[].delta.content`
- Last non-empty `choices[].delta.content`
- Stream completion

Reasoning-only, role-only, usage-only, and other metadata chunks do not stop the TTFT timer.

Per-run metrics:

- `ttft_ms`: request start to first non-empty content
- `total_ms`: request start to stream completion
- `decode_window_ms`: first non-empty content to last non-empty content
- `prompt_tokens`: final usage value
- `completion_tokens`: final usage value
- `decode_tps`: `(completion_tokens - 1) / (decode_window_ms / 1000)`
- `effective_prefill_tps`: `prompt_tokens / (ttft_ms / 1000)`

`effective_prefill_tps` is an end-to-end proxy. It includes HTTP, queueing, chat-template processing, prefill, and first-token generation, so the report must not call it native `ppTPS`.

If `completion_tokens` is less than two or the decode window is zero, `decode_tps` is unavailable for that run and the validation result records the reason.

Aggregate each metric by provider and prompt size using:

- Median
- 25th percentile
- 75th percentile
- Interquartile range
- Valid and failed run counts

Do not aggregate warmups or failed runs.

Calculate quartiles with inclusive linear interpolation over sorted values, matching Python's `statistics.quantiles(values, n=4, method="inclusive")`. This fixes the aggregation definition for the five-run sample.

## Validation and Failure Handling

Preflight must stop the formal sweep for a provider when any of these conditions occurs:

- The endpoint or configured model is unavailable
- The stream does not terminate normally
- No non-empty content is emitted
- Final prompt or completion usage is absent
- Prompt or completion usage is zero
- Required generation parameters are rejected
- The response model identity conflicts with the configured model
- The shared parity fixture produces different prompt-token counts across providers
- Reasoning artifacts appear despite the disable configuration (`<think>` in content or non-empty reasoning channel)
- Streaming usage is missing when `stream_options.include_usage` is set

A measured failure is persisted with provider, scenario, run index, elapsed time, error type, and error message. It is not retried automatically and is excluded from aggregates. After investigating the cause, the operator may restart the entire provider block; partial replacement runs are not mixed into the original block.

The harness writes results atomically after each run so an interruption preserves completed observations. Resuming creates a new run session rather than appending measurements to an earlier session.

## Harness Tests

`test_benchmark.py` uses synthetic stream chunks and controlled timestamps to verify:

- Role-only and reasoning-only chunks do not count as first content
- First and last content timestamps are captured correctly
- Final usage is required and extracted correctly
- Decode TPS and effective prefill TPS formulas
- Decode TPS is unavailable for fewer than two completion tokens
- Median, quartiles, and IQR for five values
- Failed runs are excluded from aggregates
- Atomic result persistence retains completed runs
- Missing usage, malformed chunks, and empty output fail validation
- Reasoning markers in content fail validation

After unit tests pass, run one measured request per provider at the shortest prompt size (`python benchmark.py smoke`). The full sweep starts only if all three smoke runs produce valid usage and metrics, including streaming usage.

## Report

`results/report.md` contains:

1. Executive summary
2. Environment and exact revisions
3. Model parity evidence
4. Methodology and metric definitions
5. Median and IQR tables by prompt size
6. Run variability and failures
7. Interpretation
8. Limitations
9. Reproduction commands

The primary comparison uses TTFT, total latency, and decode TPS. Effective prefill TPS appears in a separate table with its proxy caveat.

An optional qvac SDK-direct spot check may compare one short and one long request with native stats. It is validation context only and must not appear as a fourth comparative provider or alter HTTP metrics.

## Acceptance Criteria

The task is complete when:

- All three providers use the exact same GGUF digest.
- All benchmark requests use one OpenAI Python SDK client and one shared request path.
- Four prompt sizes each have one warmup and five attempted measured runs per provider.
- Raw results preserve every successful and failed attempt.
- Comparative metrics use identical definitions and measurement sources.
- The report presents medians and IQR, environment details, model parity evidence, limitations, and reproduction steps.
- Unit tests and the three-provider smoke run pass.
- Any missing or invalid usage blocks the affected provider instead of producing estimated token throughput.
- Reasoning is confirmed off on all three providers before the formal sweep.
