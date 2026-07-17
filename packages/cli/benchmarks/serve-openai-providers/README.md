# OpenAI serve provider compare (`qvac serve` vs LM Studio vs Ollama)

One-off / dispatchable client-side benchmark for QVAC-22258. Hits each server's
`POST /v1/chat/completions` with one OpenAI Python SDK client, the same Qwen3.5-9B
Q4_K_M GGUF, and a fixed prompt set.

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
