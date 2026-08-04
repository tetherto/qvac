# OpenAI serve provider compare (`qvac serve` vs LM Studio vs Ollama)

Client-side benchmark that hits each server's `POST /v1/chat/completions` with one
shared OpenAI TypeScript SDK client, the same local GGUF, and a fixed prompt set.
It measures TTFT, total latency, `client_output_tps`, and an end-to-end prefill
proxy. `client_output_tps` is completion tokens divided by complete request
latency, so it includes HTTP, queueing, prompt processing, and first-token time;
it is not native decode throughput.

Full runs also capture static QVAC route coverage against the OpenAI
specification. The report highlights consumer-primary and broader primary-AI
coverage, exact gaps, QVAC extensions, and the specification SHA-256. This is a
capability-surface metric only: route presence does not prove behavioral
compatibility. A live specification fetch is attempted once before provider
execution with a 15-second timeout and falls back to the last validated QVAC
offline cache. New live bytes are parsed successfully before atomically
replacing that cache. An HTTP 304 is accepted only when the cached bytes match
their recorded SHA-256; otherwise the specification is fetched again without
the ETag. Offline mode rejects a cache that disagrees with an existing hash
sidecar while remaining compatible with parse-valid caches created before the
sidecar existed. If neither source is available, performance measurements
continue and the coverage section is marked unavailable.

Design details: [`design.md`](./design.md). Host/launch checklist: [`environment.md`](./environment.md).

The full sweep verifies the configured GGUF SHA-256 before contacting providers.
It then starts one provider at a time, runs parity and measurements in the same
provider session, and always attempts bounded stop cleanup after a start attempt.
Reports include valid, unavailable, failed, and attempted counts for every
aggregate. `results/raw.json` preserves the OpenAI coverage snapshot used by
`results/report.md`, so rebuilding a report never refetches or changes its
coverage denominator.

## CI

| Trigger                                         | Job               | What runs                                                                        |
| ----------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| PR touching this folder / workflow / CLI config | `harness-unit`    | `tsx` unit tests (no models, no live servers) on the PR merge SHA                |
| CLI `test:unit` (SDK Pod Checks)                | same harness      | via `npm run test:bench-serve-openai-providers`                                  |
| `workflow_dispatch` (any mode)                  | `validate-target` | validates the full SHA, checks it out, and typechecks + tests it (GitHub-hosted) |
| `workflow_dispatch` `mode=coverage-report`      | `coverage-report` | provider-free coverage JSON + Markdown preview artifact on GitHub-hosted infra   |
| `workflow_dispatch` `mode=smoke` / `full`       | `live`            | live providers on the self-hosted GPU runner, gated by `benchmark-live`          |

Dispatch is **immutable**: the required `target_sha` input must be a full
40-character commit SHA (`^[0-9a-fA-F]{40}$`); branch names and tags are
rejected. `validate-target` runs on GitHub-hosted infra and pins the exact
commit before any self-hosted code runs. The `live` job then uses the protected
`benchmark-live` environment (see [`environment.md`](./environment.md)) before
it installs or executes anything on the self-hosted runner. The environment
requires review from `tether-devops` and prevents self-review; repository
administrators can use GitHub's configured admin bypass. Approval attests to the
selected commit's benchmark harness code and dependency install scripts as well
as the protected external configuration. The hosted preview job audits runner
egress, and both hosted and live checkouts do not persist GitHub credentials.
Network monitoring for the self-hosted bare-metal live runner must be
provisioned as a runner-level service rather than a workflow action.

The `coverage-report` mode does not use models, provider servers, protected
configuration, environments, or self-hosted runners. It fetches the OpenAI
specification, compares it with the checked-out QVAC router, and uploads
`coverage.json` plus `report.md` as `openai-coverage-report-<run-id>`.
The target SHA pins repository source. npm dependencies still resolve from the
version ranges in `packages/cli/package.json`, because this monorepo intentionally
does not commit package-level npm lockfiles; runner egress is audited.

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
npx tsx benchmarks/serve-openai-providers/coverage-preview.ts

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
