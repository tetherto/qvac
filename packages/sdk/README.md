# QVAC SDK

**QVAC SDK** is the canonical entry point to develop AI applications with QVAC.

> _Part of **QVAC** ecosystem_
> <br>
> <sup>
> <a href="https://qvac.tether.io/" >Home</a> &nbsp;•&nbsp;
> <a href="https://docs.qvac.tether.io/" >Docs</a> &nbsp;•&nbsp;
> <a href="https://discord.com/channels/1425125849346216029/1445400675189264516" >Support</a> &nbsp;•&nbsp;
> <a href="https://discord.com/invite/tetherdev" >Discord</a>

**QVAC SDK** is the main entry point for developing applications with QVAC. It is type-safe and exposes all QVAC capabilities through a unified interface. It runs on Node.js and [Expo](https://expo.dev).

See [https://docs.qvac.tether.io/sdk/getting-started](https://docs.qvac.tether.io/sdk/getting-started) for the comprehensive QVAC documentation.

For AI/LLM tools, use [https://docs.qvac.tether.io/llms-full.txt](https://docs.qvac.tether.io/llms-full.txt) as the consolidated plaintext documentation export.

> **In-process Bare:** use [`@qvac/inference`](../inference/README.md). `@qvac/bare-sdk` is deprecated; last release is 0.18.2.

## Supported environments and installation

See https://docs.qvac.tether.io/sdk/getting-started/installation

## Quickstart

1. Create the examples workspace:

```bash
mkdir qvac-examples
cd qvac-examples
npm init -y && npm pkg set type=module
```

2. Install the SDK:

```bash
npm install @qvac/sdk
```

3. Create the quickstart script:

```js
import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } from '@qvac/sdk'
try {
  // Load a model into memory
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress) => {
      console.log(progress)
    }
  })
  // You can use the loaded model multiple times
  const history = [
    {
      role: 'user',
      content: 'Explain quantum computing in one sentence'
    }
  ]
  const result = completion({ modelId, history, stream: true })
  for await (const token of result.tokenStream) {
    process.stdout.write(token)
  }
  // Unload model to free up system resources
  await unloadModel({ modelId })
} catch (error) {
  console.error('❌ Error:', error)
  process.exit(1)
}
```

4. Run the quickstart script:

```bash
node quickstart.js
```

## System resource diagnostics

Use `getSystemResources` to inspect locally observed CPU, system-memory, GPU, and
driver capabilities. Pass `sample: true` only when you also need a fresh usage
sample:

```ts
import { getSystemResources } from '@qvac/sdk'

const resources = await getSystemResources({ sample: true })

if (resources.capabilities.memory.totalBytes.status === 'supported') {
  console.log('System memory:', resources.capabilities.memory.totalBytes.value)
}

if (resources.sample?.cpu.status === 'supported') {
  console.log('CPU utilization:', resources.sample.cpu.value)
}
```

See the [system resources support matrix](./docs/system-resources-support-matrix.md)
for metric-level evidence and platform limitations.

Every metric reports `supported`, `unavailable`, `unverified`, or `failed`.
Supported values include provenance with a source and optional scope. These
values are diagnostics; they do not reserve memory or guarantee that a model
can be loaded.

GPU capabilities expose observed driver names, versions, and graphics APIs.
These observations do not prove that an inference backend is compatible.

Profiled inference operation events may include `event.backend` with the
selected backend and device, graphics API, driver, fallback reason, and probe
result. Addons attach backend metadata with `attachBackendDiagnostics`; the SDK
validates it before recording the operation event. `gpuId`, when present,
identifies a GPU from the current worker resource collector and is stable only
for that collector's lifetime. The SDK does not infer compatibility from driver
inventory or log text.

### Profiler resource gauges

Resource gauges are disabled by default. Enable them explicitly to attach one
worker resource sample to each profiled operation:

```ts
import { profiler } from '@qvac/sdk'

profiler.enable({ mode: 'verbose', includeResourceGauges: true })

// Run SDK operations, then inspect recentEvents[].resources.
const profile = profiler.exportJSON()
```

The sample uses the same status, provenance, and scope semantics as
`getSystemResources({ sample: true })`. Its `sampledAt` uses the same monotonic
clock as the profiling event's `ts`, so the two timestamps are comparable.
`resources.origin` records that the sample was taken on the `local` worker.
Samples are delivered to `profiler.onRecord`; they
are retained in `exportJSON().recentEvents` only in `verbose` mode. Enabling
gauges in `summary` mode still incurs the sampling cost without retaining them.
Disabling profiling or omitting `includeResourceGauges` performs no resource
sampling. Enabling gauges adds one CPU query and one query per GPU to each
profiled operation's response path. If the worker resource collector is not
initialized, the event omits the resource block.

## Pre-download model fit assessment

Use `assessModelFit` to check, before downloading anything, whether models are
likely to fit in this device's memory. It reads generated catalog metadata plus a
fresh memory sample — no weights, no load, no native probe:

```ts
import { assessModelFit, QWEN3_8B_INST_Q4_K_M } from '@qvac/sdk'

const result = await assessModelFit({
  models: [{ model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } }],
  execution: 'sequential',
  policy: 'interactive-v1'
})

console.log(result.verdict) // 'likely-fits' | 'likely-too-large' | 'unknown'
```

The result is advisory: it does not block `loadModel`, reserve memory, or make a
performance claim. `unknown` is a real answer meaning the evidence does not
support a call either way — show it as "can't say", not as "no".

See [pre-download model fit assessment](./docs/assess-model-fit.md) for the
budget arithmetic, why estimates are ranges, the supported engine and workload
matrix, and the current calibration status.

## Streaming transcription statistics

Whisper and Parakeet duplex transcription sessions expose terminal engine
statistics after their event iterator completes:

```ts
const session = await transcribeStream({ modelId })

for await (const text of session) {
  process.stdout.write(text)
}

const stats = await session.stats
console.log(stats?.audioDuration, stats?.realTimeFactor)
```

`session.stats` resolves to `undefined` when the engine does not report
statistics.

## Examples

In the `./examples` subdirectory, you will find scripts demonstrating how to use all SDK functionalities. To try any of them:

1. Build the SDK from source (see [Build](#build) section).
2. Run using Bare, Node.js, or Bun as the runtime:

```bash
# With Bare
bun run bare:example dist/examples/path/to/example.js

# With Node
node dist/examples/path/to/example.js

# With bun, straight from source
bun run examples/path/to/example.ts
```

`examples/abot-world.ts` has a companion guide covering the hardware
requirements, scene-pack lifecycle, cancellation semantics and concurrency rules
of an interactive world session: see
[ABot-World interactive world sessions](./docs/abot-world.md).

## Build

Use the [Bun](https://bun.sh/) package manager:

```bash
bun i
```

`@qvac/inference` resolves to its published release by default. To build and test against the in-repo engine at the same commit, link it first:

```bash
bun run sdk-source:workspace
```

```bash
bun run build  # or `watch` for hotreload
```

```bash
bun run build:pack
```

This outputs a tarball under `dist/sdk-{version}.tgz` that you can install in your project, e.g.:

```bash
npm i path/to/sdk-0.3.0.tgz
```

## Testing

The SDK test suite is organized into two buckets by runtime:

| Bucket            | Runtime    | Location | Command                                |
| ----------------- | ---------- | -------- | -------------------------------------- |
| Unit              | Bun / Node | `test/`  | `bun run test:unit`                    |
| Client (consumer) | Node / RN  | `e2e/`   | See [`e2e/README.md`](./e2e/README.md) |

See [`TESTING.md`](./TESTING.md) for the full decision tree on where new tests should land.

## Contributing

### Commit Message and PR Title Format

This repository enforces structured commit messages and PR titles to maintain consistency and generate changelogs automatically.

#### Format

**Commit messages:**

```
prefix[tags]?: subject
```

**PR titles:**

```
TICKET prefix[tags]: subject
```

#### Allowed Prefixes

- `feat` - New features or capabilities
- `fix` - Bug fixes
- `doc` - Documentation changes
- `test` - Test additions or modifications
- `mod` - Model-related changes
- `chore` - Maintenance tasks
- `infra` - CI/CD, tooling, infrastructure

#### Allowed Tags

Tags are optional:

- `[api]` - API changes (non-breaking)
- `[bc]` - Breaking changes (including breaking API changes)

#### Examples

**Valid commit messages:**

```bash
feat: add RAG support for LanceDB
fix[api]: fix completion stream error handling
doc: update installation instructions
feat[bc]: redesign loadModel signature
chore: update dependencies
```

**Valid PR titles:**

```bash
QVAC-123 feat: add RAG support for LanceDB
QVAC-456 fix[api]: fix completion stream error handling
QVAC-789 doc: update installation instructions
QVAC-101 feat[bc]: redesign loadModel signature
```

#### Code Examples Requirements

When creating PRs with specific tags, you must include code examples in the PR description:

**`[bc]` tag requirements:**

Must include BEFORE/AFTER code examples showing the migration path:

````markdown
## BC Changes

**BEFORE:**

```typescript
const model = await loadModel('model-path')
```

**AFTER:**

```typescript
const modelId = await loadModel('model-path', { modelType: 'llm' })
```
````

Or using inline comments:

````markdown
```typescript
// old
const model = await loadModel('model-path')

// new
const modelId = await loadModel('model-path', { modelType: 'llm' })
```
````

**`[api]` tag requirements (non-breaking):**

Must include at least one fenced code block showing the new API usage:

````markdown
## New API

```typescript
// New completion API with streaming support
for await (const token of completion({
  modelId,
  history: [{ role: 'user', content: 'Hello!' }]
}).tokenStream) {
  process.stdout.write(token)
}
```
````

#### Validation

- **Commit messages** are validated automatically via Husky commit-msg hook
- **PR titles and descriptions** are validated via GitHub Actions on PR creation/update
- Invalid commits or PRs will be rejected with helpful error messages
- **Auto-skipped commits:** The following Git-generated commits bypass validation:
  - Merge commits (e.g., `Merge pull request #123`)
  - Version bumps (e.g., `1.0.0`, `v1.0.0`)
  - Revert commits (e.g., `Revert "feat: add feature"`)
  - Squash commits (e.g., `squash! fix: bug fix`)

#### Generating Changelogs

Once your PRs are merged into `dev`, you can generate a changelog:

```bash
npm run changelog:generate
```

This will:

1. Compare versions between `dev` and `main` branches
2. Collect all merged PRs
3. Parse and classify each PR by prefix
4. Generate `changelog/<version>/CHANGELOG.md`
5. Generate `changelog/<version>/breaking.md` for BC changes (with code examples)
6. Generate `changelog/<version>/api.md` for API changes (with code examples)
