# @qvac/ai-sdk-provider

[Vercel AI SDK](https://ai-sdk.dev) provider for the [QVAC](https://qvac.tether.io) local AI runtime.

QVAC is an open-source, cross-platform ecosystem for **local-first, peer-to-peer AI** — LLMs, embeddings, transcription, translation, speech, OCR, and image generation, all running on the user's own hardware. This package is a thin, branded wrapper around [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible) that points at a running `qvac serve openai` HTTP server and re-exports QVAC's model metadata so callers can introspect typed model constants without an HTTP round-trip.

> **Status — `0.2.0`.** Two modes:
> - **External** (default): the package wraps a `qvac serve openai` HTTP endpoint that you run yourself.
> - **Managed** (`mode: 'managed'`): the provider synthesizes an ephemeral config from a model list, then spawns (or reuses) a shared `qvac serve` on a free port and keeps it alive for as long as anything is using it, reaping it automatically once everyone is done. See [Managed mode](#managed-mode) below. Requires the optional [`@qvac/cli`](https://www.npmjs.com/package/@qvac/cli) peer dependency.
>
> See the [QVAC-19194 epic](https://app.asana.com/1/45238840754660/task/1214968611313049).

---

## Install

```bash
bun add @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible
# or: npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible
```

`ai` and `@ai-sdk/openai-compatible` are **peer dependencies** — install them alongside.

---

## Quickstart

### 1. Run `qvac serve openai`

You need [`@qvac/cli`](https://www.npmjs.com/package/@qvac/cli) installed and a minimal config that preloads at least one chat model:

```bash
npm i -g @qvac/cli

cat > qvac.config.json <<'EOF'
{
  "serve": {
    "models": {
      "qwen3-600m": { "model": "QWEN3_600M_INST_Q4", "preload": true }
    }
  }
}
EOF

qvac serve openai
```

By default, `qvac serve` listens on `http://127.0.0.1:11434/v1` (the port may change in a future CLI release — see the **Default base URL** note below).

### 2. Use the provider

```ts
import { createQvac } from '@qvac/ai-sdk-provider'
import { streamText } from 'ai'

const qvac = createQvac({
  baseURL: 'http://127.0.0.1:11434/v1', // match your `qvac serve` port
  apiKey: 'qvac'                         // anything non-empty; serve does not validate
})

const { textStream } = streamText({
  model: qvac('qwen3-600m'),
  prompt: 'Write a haiku about local-first AI.'
})

for await (const chunk of textStream) {
  process.stdout.write(chunk)
}
```

The provider exposes the same surface as any AI SDK provider:

```ts
qvac('qwen3-600m')                     // language model (chat)
qvac.chatModel('qwen3-600m')           // explicit chat model
qvac.completionModel('qwen3-600m')     // legacy completion
qvac.textEmbeddingModel('embed-gemma') // text embeddings
qvac.imageModel('flux-schnell')        // image generation
```

---

## Managed mode

External mode (above) assumes you've already authored a `qvac.config.json` and have `qvac serve openai` running in another terminal. **Managed mode removes both steps**: pass `mode: 'managed'` and a list of model constants, and the provider will synthesize an ephemeral config, spawn `qvac serve` on a free port, wait until it's healthy, and reap it automatically once nothing is using it.

The serve is **shared and self-cleaning**: a second session (or a separate tool) asking for the same models attaches to the already-warm serve instead of paying another cold start, and the serve is torn down by a detached supervisor a few minutes after the last user goes away. You never have to babysit a process — see [Shared serves & lifecycle](#shared-serves--lifecycle).

```bash
# Managed mode needs the QVAC CLI available (optional peer dependency):
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli
```

```ts
import { createQvac } from '@qvac/ai-sdk-provider'
import { generateText } from 'ai'

// `createQvac` is async in managed mode — it resolves once the serve is healthy.
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_600M_INST_Q4'] // SDK model constant names; first is the default
})

try {
  const { text } = await generateText({
    model: qvac('QWEN3_600M_INST_Q4'), // each constant becomes a same-named alias
    prompt: 'Write a haiku about local-first AI.'
  })
  console.log(text)
} finally {
  await qvac.close() // detaches this session; a shared serve keeps running for others
}
```

The returned provider is an `AsyncDisposable`, so `await using` handles teardown for you:

```ts
await using qvac = await createQvac({ mode: 'managed', models: ['QWEN3_600M_INST_Q4'] })
const { text } = await generateText({ model: qvac('QWEN3_600M_INST_Q4'), prompt: '…' })
// this session detaches at the end of the scope; the serve is reaped once idle
```

### Managed options

```ts
interface QvacManagedOptions {
  mode: 'managed'
  // SDK model constant names, or per-model spec objects (see below). The first
  // entry is the default alias unless one sets `default: true`.
  models: (string | QvacManagedModel)[]
  servePort?: number             // default: auto-allocate a free port
  serveHost?: string             // default: '127.0.0.1' (loopback only)
  serveStartTimeout?: number     // ms to wait for health; default: 180000
  serveBinPath?: string          // override the `qvac` binary; default: resolve @qvac/cli
  reuse?: boolean                // share/reuse a matching serve; default: true (false if servePort is pinned)
  serveIdleTimeout?: number      // ms to keep a shared serve after its last user exits; default: 300000
  apiKey?: string                // default: 'qvac'
  headers?: Record<string, string>
  fetch?: typeof fetch
}

interface QvacManagedModel {
  name: string                       // SDK model constant name
  config?: Record<string, unknown>   // per-model serve config (ctx_size, reasoning_budget, …)
  preload?: boolean                  // load at startup; default: true
  default?: boolean                  // make this the default alias (at most one model)
}
```

The resolved provider also exposes `provider.port`, `provider.pid`, and `provider.baseURL` for diagnostics.

### Per-model configuration

A bare string keeps the serve defaults. To set serve options per model — most importantly `ctx_size` and `reasoning_budget`, which coding agents need (see [Using with coding agents](#using-with-coding-agents)) — pass a spec object instead. The `config` block is written verbatim into the synthesized `qvac.config.json` for that model:

```ts
const qvac = await createQvac({
  mode: 'managed',
  models: [
    // Agent-capable chat model with a large context window and no reasoning budget.
    { name: 'GPT_OSS_20B_INST_Q4_K_M', config: { ctx_size: 32768, reasoning_budget: 0 }, default: true },
    // A smaller utility model, loaded lazily, for titles/summaries.
    { name: 'QWEN3_1_7B_INST_Q4', config: { ctx_size: 8192 }, preload: false }
  ]
})
```

Without this, every model uses `qvac serve`'s defaults — and the default `ctx_size` of 1024 is too small for an agent's tool-laden prompts.

### Shared serves & lifecycle

Managed mode runs `qvac serve` as a **shared, self-cleaning daemon** so that opening multiple sessions — or several tools at once — doesn't spawn a serve (and reload models into memory) for each one.

- **Fleet key & reuse.** Each managed provider derives a *fleet key* from its exact serve config (model set + per-model `config` + bind host + `serveBinPath`). `createQvac` reuses any healthy serve with a matching key and only spawns a new one when none exists. Two sessions that request the same models share one process; two that request different models (or different `ctx_size`, host, or `qvac` binary) each get their own.
- **Detached supervisor.** The serve is owned by a small detached runner — not by your process — so it survives your script exiting and can be shared. The runner reaps the serve once **no consumer process has been alive for `serveIdleTimeout`** (default 5 min). A *consumer* is a process that called `createQvac` and hasn't `close()`d or exited — liveness is tracked by those processes, **not** by request traffic. This means a tool that connects straight to `baseURL` (OpenCode, Cline, Aider) does **not** by itself keep the serve alive; the process that resolved the `baseURL` must stay alive for the duration (see [Using with coding agents](#using-with-coding-agents)).
- **`close()` detaches, it doesn't kill.** Calling `provider.close()` (or leaving an `await using` scope) deregisters *your* session. A serve still in use by another session keeps running; an unused one is reaped after the idle timeout. An abrupt exit (Ctrl-C, crash) is handled too — the runner prunes dead consumers automatically.
- **Crash recovery.** If the underlying serve is gone when a request goes out (connection refused), the provider's `fetch` transparently re-resolves — reattaching to a healthy serve or spawning a fresh one — and retries that request once. Only connection-refused is retried, so a completion that the serve had already begun processing is never blindly replayed.
- **Private serves.** Pass `reuse: false` (or pin `servePort`) to force a dedicated serve that is **not** shared and is reaped as soon as your process exits.
- **Self-healing registry.** Records live under `~/.qvac/managed-serves/`. Every `createQvac` first sweeps the registry, dropping dead records and terminating any serve whose runner has died — so a hard crash can never strand a process or wedge reuse.

### Behaviour notes

- **Startup is gated on model preload.** `qvac serve` does not open its port until every preloaded model is ready, and a cold P2P download can take minutes — hence the generous default `serveStartTimeout`. Raise it for large models.
- **External mode pays nothing.** The managed subsystem (and its `node:child_process` / `@qvac/cli` resolution) is dynamically imported only when `mode: 'managed'` is set.
- **Node 20+ and Bun.** The managed subsystem uses only portable `node:` APIs — no Bun-specific calls.
- **Typed errors.** Managed setup throws structured errors you can `instanceof`-check: `UnknownManagedModelError`, `DuplicateManagedModelError`, `MultipleDefaultManagedModelsError`, `CliNotFoundError`, `ServeStartTimeoutError`, `ServeSpawnFailedError`, `ServeExitedError`, and `PortAllocationFailedError` (all extending `QvacManagedModeError`, with a `.code` from `QvacManagedErrorCode`). They're exported from the package root.

---

## Using with coding agents

QVAC's primary v1 use case is wiring local AI into coding agents (OpenCode, Cline, Aider, Continue, Roo). The OpenAI-compatible bridge works end-to-end, but a few `qvac serve` behaviours need explicit configuration before an agent harness will feel right.

### 1. Same-model requests queue instead of failing

Coding agents routinely fire concurrent requests — typically a main chat completion plus a title, summary, or compaction call. `qvac serve` now queues same-model completion requests per loaded model context, so an agent can point both chat and utility calls at one serve alias and the utility call will wait its turn instead of failing with a native job-lock collision.

```json
// qvac.config.json — agent-friendly setup
{
  "serve": {
    "models": {
      "qwen3-8b-chat": {
        "model": "QWEN3_8B_INST_Q4_K_M",
        "preload": true,
        "config": {
          "ctx_size": 16384,
          "reasoning_budget": 0
        }
      }
    }
  }
}
```

Then point your harness at the alias. For OpenCode, `model` and `small_model` can use the same local model:

```json
// opencode.json
{
  "model":       "qvac/qwen3-8b-chat",
  "small_model": "qvac/qwen3-8b-chat"
}
```

You can still configure a separate, lighter `small_model` if you want title, summary, and compaction calls to avoid waiting behind the main chat decode, but it is no longer required for correctness.

**Managed-mode equivalent.** Instead of hand-authoring `qvac.config.json` and running `qvac serve` yourself, let [managed mode](#per-model-configuration) synthesize the same agent-friendly config and spawn the serve on a free port. Point OpenCode at the resolved `baseURL`:

OpenCode fires the main `build` completion and the `title`/summary completion concurrently against the one alias; the per-model queue (section 1) serializes them instead of failing on a job-lock collision.

> **Keep the resolving process alive while the agent runs.** Liveness is tracked by *consumer processes* — the ones that called `createQvac` — not by HTTP traffic. OpenCode connects straight to `baseURL`, so it is invisible to the idle reaper. If your setup script writes `opencode.json` and then **exits**, it deregisters the only consumer and the serve is reaped after `serveIdleTimeout`, even mid-session. Run the agent as a child of the process that holds the provider open, and let `await using` detach on exit:

```ts
import { spawn } from 'node:child_process'

await using qvac = await createQvac({
  mode: 'managed',
  models: [{ name: 'QWEN3_8B_INST_Q4_K_M', config: { ctx_size: 32768, reasoning_budget: 0 } }]
})
// Write opencode.json against the managed serve once:
//   provider.qvac.options.baseURL = qvac.baseURL  (e.g. http://127.0.0.1:5xxxx/v1)
//   model = small_model = "qvac/QWEN3_8B_INST_Q4_K_M"

// Run OpenCode as a child; this process stays alive (= a live consumer) until it exits.
const agent = spawn('opencode', { stdio: 'inherit' })
await new Promise<void>((resolve) => agent.on('exit', () => resolve()))
// Leaving the `await using` scope detaches; the shared serve is idle-reaped a few minutes later.
```

If you genuinely need the serve to outlive every QVAC-aware process (several independent tools attaching over time), keep a dedicated long-lived holder process open, or pin a `servePort` and run `qvac serve` yourself in [external mode](#external-mode).

### 2. `ctx_size` defaults to 1024 — too small for agents

The default LLM `ctx_size` is 1024 tokens, which is fine for short chats and unusable for coding agents: a typical OpenCode message ships 10–15 tool definitions plus a system prompt, easily 2–4k tokens before the user's first message lands. Set `ctx_size` explicitly per model (`16384` is a sensible default for chat; use 8192+ for a separate utility model that handles summaries or compaction) or you'll see context fills and truncated responses well before the model misbehaves.

### 3. `reasoning_budget: 0` to suppress `<think>` blocks

Reasoning-tuned models (Qwen3, DeepSeek-R1, etc.) emit `<think>…</think>` blocks before their final answer. Hosts that lack a reasoning channel render them verbatim in the chat UI, which looks broken and burns latency on tokens the user never sees. Set `reasoning_budget: 0` per model to disable reasoning at the addon level — cleaner output, meaningfully faster responses.

Requires `@qvac/sdk >= 0.11.0` (and `@qvac/cli >= 0.5.0` which pins it). Older SDKs reject the key on startup with `"Unrecognized keys: reasoning_budget"`.

### 4. Local-model capability is the real ceiling

The integration is plumbing — your local-model choice decides whether an agent actually works. Empirical findings from `qvac serve` + OpenCode testing:

- **Q4-quantized 4B/8B Qwen3-Instruct** can hold a conversation but won't reliably *invoke* tools. The model will say "let me search the docs" without emitting a tool call, then fabricate an answer.
- **Cloud Qwen3.5-9B** (full precision, e.g. via OpenRouter) calls tools aggressively but still hallucinates content from tool results.
- Reliable local tool use generally needs **≥14B parameters and coder/agent post-training** (e.g. `GPT_OSS_20B_INST_Q4_K_M` from the catalog, future Qwen3-Coder variants). Plain Instruct tunes at 4–8B sizes are not reliable agent backends.

This is an industry-wide reality for local AI, not specific to QVAC. Calibrate user expectations accordingly when documenting QVAC integrations for downstream harnesses.

---

## Default base URL

```ts
const qvac = createQvac() // uses DEFAULT_BASE_URL
```

> ⚠️ **The default `baseURL` is a placeholder pending the CLI port-change ticket.** `qvac serve` today defaults to `11434` (which collides with Ollama). The CLI will move to a non-conflicting port in a future release, and this package's default will move with it. **Set `baseURL` explicitly to your `qvac serve` port** until the default is finalized — otherwise the provider will fail to connect.

The default `apiKey` is the literal string `'qvac'`. `qvac serve` does not validate the key; the value matters only because some OpenAI-shaped HTTP clients refuse to issue a request without an `Authorization` header.

---

## Model metadata

QVAC ships a typed catalog of every model registered in its P2P registry. The metadata is codegen'd from the registry at build time and committed to the package, so you can introspect models **without** an HTTP call to `/v1/models`:

```ts
import { models, allModels } from '@qvac/ai-sdk-provider'

models.QWEN3_4B_INST_Q4_K_M.endpointCategory  // 'chat' (compile-time known)
models.WHISPER_EN_TINY_Q8_0.endpointCategory  // 'transcription'

for (const m of allModels) {
  console.log(`${m.name} (${m.endpointCategory}, ${m.expectedSize} bytes)`)
}
```

Each constant satisfies `ModelConstant<TEndpoint>` where `TEndpoint` is one of:

```ts
type EndpointCategory =
  | 'chat'
  | 'embedding'
  | 'transcription'
  | 'audio-translation'
  | 'translation'
  | 'speech'
  | 'ocr'
  | 'image'
```

The catalog is **codegen'd from the live QVAC P2P registry** at build time and committed to the package, covering chat (`llamacpp-completion`), embeddings (`llamacpp-embedding`), transcription (`whispercpp-transcription`, `parakeet-transcription`), translation (`nmtcpp-translation`), speech (`onnx-tts`, `tts-ggml`), OCR (`onnx-ocr`), and image generation (`sdcpp-generation`). Regenerate against the live registry with:

```bash
npm run update-models     # writes src/models/constants.ts + models/history/<sha>.txt
npm run check-models      # CI drift check; fails if regen would change anything
```

Registry entries for engines without an OpenAI-shaped surface (VAD, classification, VLA, …) are filtered out at codegen time. `check-models` runs in CI so the committed catalog cannot drift from the registry without a deliberate regen commit.

---

## API

### `createQvac(options?): QvacProvider | Promise<ManagedQvacProvider>`

Factory returning a branded Vercel AI SDK provider. The return type depends on `mode`:

- **External** (default): returns a `QvacProvider` **synchronously**. Wraps `createOpenAICompatible` with QVAC defaults.
- **Managed** (`mode: 'managed'`): returns a `Promise<ManagedQvacProvider>` that resolves once the spawned `qvac serve` is healthy. See [Managed mode](#managed-mode).

```ts
interface QvacExternalOptions {
  mode?: 'external'                      // default
  baseURL?: string                       // default: see Default base URL
  apiKey?: string                        // default: 'qvac'
  headers?: Record<string, string>       // default: {}
  fetch?: typeof fetch                   // default: globalThis.fetch
}
```

For `QvacManagedOptions` and the `ManagedQvacProvider` shape, see [Managed options](#managed-options).

### `qvac`

A default `createQvac()` instance with all defaults. Convenient for quick scripts; **explicit `createQvac({ baseURL })` is recommended** until the default `baseURL` is finalized.

### `models`, `allModels`, `ModelConstant`, `EndpointCategory`

Re-exported model metadata. See [Model metadata](#model-metadata) above.

---

## Compared to plain `@ai-sdk/openai-compatible`

This package is a thin wrapper. Mechanically `createQvac({ baseURL })` is equivalent to:

```ts
createOpenAICompatible({
  name: 'qvac',
  baseURL,
  apiKey: 'qvac'
})
```

You get the QVAC branded export, the typed model metadata, the [`mode: 'managed'`](#managed-mode) auto-spawn / supervise surface, and a discoverable handle for the [`models.dev`](https://models.dev) catalog (so QVAC shows up in `/connect` for OpenCode and other catalog consumers).

---

## License

Apache-2.0 © [Tether Data, S.A. de C.V.](https://tether.io)
