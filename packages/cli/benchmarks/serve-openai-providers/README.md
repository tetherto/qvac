# OpenAI serve provider compare (`qvac serve` vs LM Studio vs Ollama)

Client-side benchmark that hits each server's `POST /v1/chat/completions` with one
shared OpenAI Python SDK client, the same local GGUF, and a fixed prompt set.
It measures TTFT, total latency, decode TPS, and an end-to-end prefill proxy.

Python (not the CLI TypeScript stack) on purpose: this is a dispatchable compare
harness, same pattern as other addon quality/perf evals that use the official
OpenAI Python client as a provider-neutral HTTP client. It is not product code.

Design details: [`design.md`](./design.md). Host/launch checklist: [`environment.md`](./environment.md).

## CI

| Trigger | Job | What runs |
|---|---|---|
| PR touching this folder or the workflow | `harness-unit` | `pytest` (no models, no network servers) |
| `workflow_dispatch` `mode=harness-unit` | same | same |
| `workflow_dispatch` `mode=smoke` / `full` | self-hosted macOS GPU runner | live providers (must be preconfigured on the runner) |

The full three-provider sweep is **not** part of SDK Pod Checks. It needs local
LM Studio / Ollama / `qvac serve` and the shared GGUF on a `qvac-macos*-gpu` runner.

## Local

```bash
cd packages/cli/benchmarks/serve-openai-providers
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m pytest test_benchmark.py -q

# Edit benchmark.yaml (model IDs + gguf_path), fill environment.md, start servers.
python benchmark.py digest
python benchmark.py preflight
python benchmark.py smoke
python benchmark.py full
```
