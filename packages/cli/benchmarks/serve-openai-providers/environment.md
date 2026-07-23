# Environment Manifest — OpenAI serve provider compare

Fill this in on the benchmark host before the formal sweep. Do not put secrets here.

## Host

| Field                                 | Value        |
| ------------------------------------- | ------------ |
| Hostname                              |              |
| macOS version                         |              |
| Apple chip                            |              |
| RAM                                   |              |
| Power state                           | AC connected |
| Unrelated inference processes stopped | yes / no     |

## Client

| Field                             | Value              |
| --------------------------------- | ------------------ |
| Node.js                           |                    |
| `openai` (npm, CLI devDependency) |                    |
| `js-yaml`                         | (from `@qvac/cli`) |

## Model parity

| Field              | Value                          |
| ------------------ | ------------------------------ |
| Registry constant  | `QWEN3_5_9B_MULTIMODAL_Q4_K_M` |
| GGUF filename      | `Qwen3.5-9B-Q4_K_M.gguf`       |
| Absolute GGUF path |                                |
| File size (bytes)  |                                |
| SHA-256            |                                |

Record digest with:

```bash
npx tsx benchmark.ts digest
```

The configured `model_parity.sha256` must match this digest. `preflight`,
`smoke`, and `full` enforce the digest before issuing any provider request.

## qvac serve

| Field                                                            | Value                                      |
| ---------------------------------------------------------------- | ------------------------------------------ |
| Repo / branch                                                    |                                            |
| Commit SHA (must include PR #3259 merge `7ee761b70271` or later) |                                            |
| PR                                                               | https://github.com/tetherto/qvac/pull/3259 |
| `@qvac/cli` version                                              |                                            |
| `@qvac/sdk` version                                              |                                            |
| Listen URL                                                       | `http://127.0.0.1:11435/v1`                |
| Serve alias / model id                                           |                                            |
| Context size                                                     | 8192                                       |
| Reasoning disabled via                                           | _(e.g. load config `reasoning_budget: 0`)_ |
| Launch command                                                   |                                            |

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

| Field                    | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| Version                  |                                                                  |
| Listen URL               | `http://127.0.0.1:11434/v1`                                      |
| Model name               |                                                                  |
| Context size             | 8192                                                             |
| Reasoning disabled via   | _(e.g. Modelfile `PARAMETER think false` or current equivalent)_ |
| Launch / import commands |                                                                  |

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

| Field                             | Value                                                    |
| --------------------------------- | -------------------------------------------------------- |
| Version                           |                                                          |
| Listen URL                        | `http://127.0.0.1:1234/v1`                               |
| Model id                          |                                                          |
| Context size                      | 8192                                                     |
| Reasoning / thinking disabled via |                                                          |
| GPU / Metal                       | enabled                                                  |
| Launch notes                      | Load the same GGUF path; start local server on port 1234 |

## Shared generation settings

| Field                          | Value                                         |
| ------------------------------ | --------------------------------------------- |
| `max_tokens`                   | 128                                           |
| `temperature`                  | 0                                             |
| `seed`                         | 42 (omit for all providers if any rejects it) |
| `stream`                       | true                                          |
| `stream_options.include_usage` | true                                          |

## Cool-down

| Field             | Value                                            |
| ----------------- | ------------------------------------------------ |
| Between providers | 90 seconds (`benchmark.yaml` `cooldown_seconds`) |

## Runbook

```bash
cd packages/cli
npm install
npm run test:bench-serve-openai-providers

cd benchmarks/serve-openai-providers
# 1) Create a runner-local benchmark.yaml outside the repository.
# 2) Fill a runner-local copy of environment.md outside the repository.
# 3) Keep the Mac on AC power; lifecycle commands start one provider at a time.

export BENCHMARK_CONFIG_PATH=/absolute/path/to/benchmark.yaml
npx tsx benchmark.ts digest --config "$BENCHMARK_CONFIG_PATH"
npx tsx benchmark.ts preflight --config "$BENCHMARK_CONFIG_PATH"
npx tsx benchmark.ts calibrate --config "$BENCHMARK_CONFIG_PATH" --provider qvac
# Adjust prompts.json if measured prompt_tokens drift far from targets, then re-preflight all three.
npx tsx benchmark.ts smoke --config "$BENCHMARK_CONFIG_PATH"
npx tsx benchmark.ts full --config "$BENCHMARK_CONFIG_PATH"
```

CI: PR / CLI `test:unit` runs harness unit tests. Dispatch
`.github/workflows/benchmark-cli-serve-openai-providers.yml` with `mode=smoke` or
`mode=full` for live providers. See "CI dispatch" below for the immutable-SHA and
`benchmark-live` requirements.

Smoke is a hard gate: all three providers must return streaming usage, non-empty content, and reasoning-off before `full`.

## CI dispatch (`benchmark-live`)

The live sweep runs on the self-hosted `qvac-macos26-arm64-gpu` runner and is
protected end to end. Configure the following **before** dispatching, or the run
will fail closed.

### Immutable target SHA

The workflow's only ref input is `target_sha`, which must be a full
40-character commit SHA (`^[0-9a-fA-F]{40}$`). Branch names, tags, and short
SHAs are rejected. A GitHub-hosted `validate-target` job checks the format,
resolves it to a commit, requires the resolved commit to equal the supplied SHA,
checks out that exact commit, and runs the harness typecheck + tests before the
self-hosted job is allowed to start. Resolve the SHA yourself, e.g.:

```bash
git rev-parse HEAD        # or the reviewed commit you intend to benchmark
```

### `benchmark-live` environment (one-time setup)

Create a repository **environment** named `benchmark-live` (Settings →
Environments) and configure:

- **Required reviewers** — at least one trusted maintainer. The `live` job pauses
  for manual approval before it checks out, installs, or runs anything on the
  self-hosted runner. Approval attests to the selected target commit's benchmark
  harness code and dependency install scripts, not only to the protected
  external config. This replaces the former label gate.
- **Deployment branch rule** — restrict the environment to the branches that are
  allowed to dispatch it (e.g. `main`, `release-*`). Dispatches from other
  branches cannot access the environment's variables and are blocked.
- **Environment variables** (not secrets — plain environment variables):

  | Variable                     | Value                                                                               |
  | ---------------------------- | ----------------------------------------------------------------------------------- |
  | `BENCHMARK_CONFIG_PATH`      | Absolute path to the runner-local `benchmark.yaml` (filled model IDs + `gguf_path`) |
  | `BENCHMARK_ENVIRONMENT_PATH` | Absolute path to the runner-local, filled-in copy of this `environment.md`          |

Both paths must be **absolute** and must point **outside** `GITHUB_WORKSPACE`.
The `live` job rejects unset, relative, workspace-contained, missing, or
unreadable paths. It resolves the workspace and both files to their canonical
paths first, so symlinks into the workspace are also rejected. Resolution
failures stop the job. Keeping the real config off the checked-out tree means
the benchmarked commit cannot smuggle in its own model paths or lifecycle
commands.

### Runner-local files

On the runner, maintain a filled-in benchmark config and environment manifest at
the paths above:

- The config is the same shape as the committed `benchmark.yaml`, but with real
  provider `model` IDs, the absolute `gguf_path`, and its `sha256` populated.
- This checked-in `environment.md` is the local source-manifest template. The
  runner-local filled copy is copied into `results/environment.md` **after** the
  sweep completes; that copied file is the environment manifest uploaded in the
  results artifact (`full` mode only).

### Lifecycle script contracts

Each provider in the runtime config may declare an optional `lifecycle` block.
`start_command` and `stop_command` are **argv arrays** (no shell):
`start_command` runs before parity, and parity plus all measurements run in that
same provider session. `stop_command` is attempted after every start attempt,
including start timeout and provider failure. An optional `timeout_seconds`
applies independently to each command; timed-out children are killed and
settled before cleanup continues. If both the provider operation and stop
cleanup fail, both errors are retained.
Because the config lives on the runner (outside the repo), these commands are
controlled by the runner operator, not by the dispatched commit. Example:

```yaml
lifecycle:
  start_command: [/absolute/path/to/start-provider.sh]
  stop_command: [/absolute/path/to/stop-provider.sh]
  timeout_seconds: 30
```

## Provider execution order

Record the order actually used by the session (also stored in `results/raw.json` → `provider_order`):

1.
2.
3.
