# @qvac/ai-sdk-provider

[Vercel AI SDK](https://ai-sdk.dev) provider for the [QVAC](https://qvac.com) local AI runtime.

QVAC is an open-source, cross-platform ecosystem for **local-first, peer-to-peer AI** — LLMs, embeddings, transcription, translation, speech, OCR, and image generation, all running on the user's own hardware. This package is a thin, branded wrapper around [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible) that points at a running `qvac serve openai` HTTP server and re-exports QVAC's model metadata so callers can introspect typed model constants without an HTTP round-trip.

> **Status — v1 (`0.1.0`).** External mode only: the package wraps a `qvac serve openai` HTTP endpoint that you run yourself. A future `0.2.0` will add `mode: 'managed'` for auto-spawn / supervise of the serve process. See the [QVAC-19194 epic](https://app.asana.com/1/45238840754660/task/1214968611313049).

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

## Using with coding agents

QVAC's primary v1 use case is wiring local AI into coding agents (OpenCode, Cline, Aider, Continue, Roo). The OpenAI-compatible bridge works end-to-end, but a few `qvac serve` behaviours need explicit configuration before an agent harness will feel right.

### 1. Concurrent requests collide on a single model instance

The underlying llama.cpp addon serializes inference per native model context and **rejects** concurrent requests rather than queuing them. The server log shows `Cannot set new job: a job is already set or being processed`; clients see `500 An internal error occurred`.

Coding agents routinely fire concurrent requests — typically a main chat completion plus a "title generation" call for the conversation panel. To get parallel inference today you need **two different model files** loaded under two aliases. Same-file aliases collapse to one native context because the SDK deduplicates `loadModel` by `modelSrc`, so two aliases pointing at the same `QWEN3_4B_INST_Q4_K_M` get the same `sdkModelId` and share the same job lock.

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
      },
      "qwen3-1_7b-title": {
        "model": "QWEN3_1_7B_INST_Q4",
        "preload": true,
        "config": {
          "ctx_size": 4096,
          "reasoning_budget": 0
        }
      }
    }
  }
}
```

Then map the two aliases to your harness's chat vs. utility model slots — for OpenCode:

```json
// opencode.json
{
  "model":       "qvac/qwen3-8b-chat",
  "small_model": "qvac/qwen3-1_7b-title"
}
```

A proper per-`sdkModelId` request queue inside `qvac serve` would obsolete this workaround; tracked as a follow-up on the CLI side.

### 2. `ctx_size` defaults to 1024 — too small for agents

The default LLM `ctx_size` is 1024 tokens, which is fine for short chats and unusable for coding agents: a typical OpenCode message ships 10–15 tool definitions plus a system prompt, easily 2–4k tokens before the user's first message lands. Set `ctx_size` explicitly per model (`16384` is a sensible default for chat, `4096` is plenty for title gen) or you'll see context fills and truncated responses well before the model misbehaves.

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

The catalog is **codegen'd from the live QVAC P2P registry** at build time and committed to the package — `0.1.0` ships 729 OpenAI-surface model constants covering chat (`llamacpp-completion`), embeddings (`llamacpp-embedding`), transcription (`whispercpp-transcription`, `parakeet-transcription`), translation (`nmtcpp-translation`), speech (`onnx-tts`, `tts-ggml`), OCR (`onnx-ocr`), and image generation (`sdcpp-generation`). Regenerate against the live registry with:

```bash
npm run update-models     # writes src/models/constants.ts + models/history/<sha>.txt
npm run check-models      # CI drift check; fails if regen would change anything
```

Registry entries for engines without an OpenAI-shaped surface (VAD, classification, VLA, …) are filtered out at codegen time. `check-models` runs in CI so the committed catalog cannot drift from the registry without a deliberate regen commit.

---

## API

### `createQvac(options?: QvacOptions): QvacProvider`

Factory returning a branded Vercel AI SDK provider. Wraps `createOpenAICompatible` with QVAC defaults.

```ts
interface QvacOptions {
  baseURL?: string                       // default: see Default base URL
  apiKey?: string                        // default: 'qvac'
  headers?: Record<string, string>       // default: {}
  fetch?: typeof fetch                   // default: globalThis.fetch
}
```

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

You get the QVAC branded export, the typed model metadata, the future `mode: 'managed'` auto-spawn surface, and a discoverable handle for the [`models.dev`](https://models.dev) catalog (so QVAC shows up in `/connect` for OpenCode and other catalog consumers).

---

## License

Apache-2.0 © [Tether Data, S.A. de C.V.](https://tether.io)
