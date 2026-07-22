# OpenAI serve provider compare (`qvac serve` vs LM Studio vs Ollama)

Client-side benchmark that hits each server's `POST /v1/chat/completions` with one
shared OpenAI TypeScript SDK client, the same local GGUF, and a fixed prompt set.
It measures TTFT, total latency, decode TPS, and an end-to-end prefill proxy.

Design details: [`design.md`](./design.md). Host/launch checklist: [`environment.md`](./environment.md).

## CI

| Trigger                                           | Job                          | What runs                                            |
| ------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| PR touching this folder / workflow / CLI lockfile | `harness-unit`               | `tsx` unit tests (no models, no live servers)        |
| CLI `test:unit` (SDK Pod Checks)                  | same harness tests           | via `npm run test:bench-serve-openai-providers`      |
| `workflow_dispatch` `mode=smoke` / `full`         | self-hosted macOS GPU runner | live providers (must be preconfigured on the runner) |

The full three-provider sweep is **not** part of SDK Pod Checks. It needs local
LM Studio / Ollama / `qvac serve` and the shared GGUF on a `qvac-macos*-gpu` runner.

## Local

```bash
cd packages/cli
npm install
npm run test:bench-serve-openai-providers

# Edit benchmarks/serve-openai-providers/benchmark.yaml, fill environment.md, start servers.
cd benchmarks/serve-openai-providers
npx tsx benchmark.ts digest
npx tsx benchmark.ts preflight
npx tsx benchmark.ts smoke
npx tsx benchmark.ts full
```
