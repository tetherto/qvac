# Environment Manifest — OpenAI serve provider compare

Fill this in on the benchmark host before the formal sweep. Do not put secrets here.

## Host

| Field | Value |
|---|---|
| Hostname | |
| macOS version | |
| Apple chip | |
| RAM | |
| Power state | AC connected |
| Unrelated inference processes stopped | yes / no |

## Client

| Field | Value |
|---|---|
| Python | |
| `openai` package | 1.99.9 (see `requirements.txt`) |
| PyYAML | 6.0.2 |

## Model parity

| Field | Value |
|---|---|
| Registry constant | `QWEN3_5_9B_MULTIMODAL_Q4_K_M` |
| GGUF filename | `Qwen3.5-9B-Q4_K_M.gguf` |
| Absolute GGUF path | |
| File size (bytes) | |
| SHA-256 | |

Record digest with:

```bash
python benchmark.py digest
```

## qvac serve

| Field | Value |
|---|---|
| Repo / branch | |
| Commit SHA (must include PR #3259 merge `7ee761b70271` or later) | |
| PR | https://github.com/tetherto/qvac/pull/3259 |
| `@qvac/cli` version | |
| `@qvac/sdk` version | |
| Listen URL | `http://127.0.0.1:11435/v1` |
| Serve alias / model id | |
| Context size | 8192 |
| Reasoning disabled via | _(e.g. load config `reasoning_budget: 0`)_ |
| Launch command | |

Example shape (adjust paths/aliases):

```bash
# From a checkout at the recorded commit — do not use port 11434.
qvac serve openai --config /path/to/qvac.serve.benchmark.json
```

Suggested serve config sketch:

```json
{
  "serve": {
    "host": "127.0.0.1",
    "port": 11435,
    "models": {
      "qwen35-9b-bench": {
        "src": "/ABSOLUTE/PATH/Qwen3.5-9B-Q4_K_M.gguf",
        "type": "llamacpp-completion",
        "preload": true,
        "config": {
          "ctx_size": 8192,
          "reasoning_budget": 0
        }
      }
    }
  }
}
```

Confirm the exact key that disables Qwen3.5 thinking for the CLI version under test, then record it above.

## Ollama

| Field | Value |
|---|---|
| Version | |
| Listen URL | `http://127.0.0.1:11434/v1` |
| Model name | |
| Context size | 8192 |
| Reasoning disabled via | _(e.g. Modelfile `PARAMETER think false` or current equivalent)_ |
| Launch / import commands | |

```bash
# Example Modelfile pointing at the same GGUF bytes
cat > /tmp/Qwen35Bench.Modelfile <<'EOF'
FROM /ABSOLUTE/PATH/Qwen3.5-9B-Q4_K_M.gguf
PARAMETER num_ctx 8192
PARAMETER temperature 0
PARAMETER think false
EOF
ollama create qwen35-9b-bench -f /tmp/Qwen35Bench.Modelfile
```

Verify the `think` / reasoning parameter name for the installed Ollama version and update this section if it differs.

## LM Studio

| Field | Value |
|---|---|
| Version | |
| Listen URL | `http://127.0.0.1:1234/v1` |
| Model id | |
| Context size | 8192 |
| Reasoning / thinking disabled via | |
| GPU / Metal | enabled |
| Launch notes | Load the same GGUF path; start local server on port 1234 |

## Shared generation settings

| Field | Value |
|---|---|
| `max_tokens` | 128 |
| `temperature` | 0 |
| `seed` | 42 (omit for all providers if any rejects it) |
| `stream` | true |
| `stream_options.include_usage` | true |

## Cool-down

| Field | Value |
|---|---|
| Between providers | 90 seconds (`benchmark.yaml` `cooldown_seconds`) |

## Runbook

```bash
cd packages/cli/benchmarks/serve-openai-providers
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 1) Edit benchmark.yaml model IDs + gguf_path
# 2) Fill this environment.md
# 3) Start one provider at a time; keep Mac on AC power

python benchmark.py digest
python -m pytest test_benchmark.py -q
python benchmark.py preflight
python benchmark.py calibrate --provider qvac
# Adjust prompts.json if measured prompt_tokens drift far from targets, then re-preflight all three.
python benchmark.py smoke
python benchmark.py full
```

CI: PR runs harness unit tests via `.github/workflows/benchmark-cli-serve-openai-providers.yml`.
Dispatch the same workflow with `mode=smoke` or `mode=full` on a configured `qvac-macos26-arm64-gpu` runner for live providers.

Smoke is a hard gate: all three providers must return streaming usage, non-empty content, and reasoning-off before `full`.

## Provider execution order

Record the order actually used by the session (also stored in `results/raw.json` → `provider_order`):

1.
2.
3.
