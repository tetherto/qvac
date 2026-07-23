# OpenAI serve provider compare (`qvac serve` vs LM Studio vs Ollama)

Client-side benchmark that hits each server's `POST /v1/chat/completions` with one
shared OpenAI TypeScript SDK client, the same local GGUF, and a fixed prompt set.
It measures TTFT, total latency, `client_output_tps`, and an end-to-end prefill
proxy. `client_output_tps` is completion tokens divided by complete request
latency, so it includes HTTP, queueing, prompt processing, and first-token time;
it is not native decode throughput.

Design details: [`design.md`](./design.md). Host/launch checklist: [`environment.md`](./environment.md).

The full sweep verifies the configured GGUF SHA-256 before contacting providers.
It then starts one provider at a time, runs parity and measurements in the same
provider session, and always attempts bounded stop cleanup after a start attempt.
Reports include valid, unavailable, failed, and attempted counts for every
aggregate.

## CI

| Trigger                                           | Job               | What runs                                                                        |
| ------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| PR touching this folder / workflow / CLI lockfile | `harness-unit`    | `tsx` unit tests (no models, no live servers) on the PR merge SHA                |
| CLI `test:unit` (SDK Pod Checks)                  | same harness      | via `npm run test:bench-serve-openai-providers`                                  |
| `workflow_dispatch` (any mode)                    | `validate-target` | validates the full SHA, checks it out, and typechecks + tests it (GitHub-hosted) |
| `workflow_dispatch` `mode=smoke` / `full`         | `live`            | live providers on the self-hosted GPU runner, gated by `benchmark-live`          |

Dispatch is **immutable**: the required `target_sha` input must be a full
40-character commit SHA (`^[0-9a-fA-F]{40}$`); branch names and tags are
rejected. `validate-target` runs on GitHub-hosted infra and pins the exact
commit before any self-hosted code runs. The `live` job then requires manual
approval of the protected `benchmark-live` environment (see
[`environment.md`](./environment.md)) before it installs or executes anything on
the self-hosted runner. Approval attests to the selected commit's benchmark
harness code and dependency install scripts as well as the protected external
configuration.

The full three-provider sweep is **not** part of SDK Pod Checks. It needs local
LM Studio / Ollama / `qvac serve` and the shared GGUF on a `qvac-macos*-gpu`
runner, with the runtime config and environment manifest supplied by protected
`benchmark-live` environment variables (never from the checked-out tree).
The protected job validates the immutable target before dispatch and rejects
runtime files that are missing, relative, inside the checkout, or reachable
through a symlink into it.

## Local

The committed `benchmark.yaml` is a non-runnable template. Supply a populated
external file with `--config`; do not run benchmarks against the committed copy.

```bash
cd packages/cli
npm install
npm run test:bench-serve-openai-providers

# Keep the filled config outside the repository and fill a local copy of
# benchmarks/serve-openai-providers/environment.md.
export BENCHMARK_CONFIG_PATH=/absolute/path/to/benchmark.yaml
npx tsx benchmarks/serve-openai-providers/benchmark.ts digest --config "$BENCHMARK_CONFIG_PATH"
npx tsx benchmarks/serve-openai-providers/benchmark.ts preflight --config "$BENCHMARK_CONFIG_PATH"
npx tsx benchmarks/serve-openai-providers/benchmark.ts smoke --config "$BENCHMARK_CONFIG_PATH"
npx tsx benchmarks/serve-openai-providers/benchmark.ts full --config "$BENCHMARK_CONFIG_PATH"
```

For local runs, `benchmarks/serve-openai-providers/environment.md` is the source
manifest. Protected full CI copies the runner-local filled manifest to
`results/environment.md`, which is the version included in the results artifact.
