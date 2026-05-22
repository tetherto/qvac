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

> The `0.1.0` release ships an **empty** model catalog as a placeholder. The full catalog lands in the follow-up codegen task — track [QVAC-19194 workstream 2](https://app.asana.com/0/0/1215054644422021). Until then, pass model aliases (e.g. `'qwen3-600m'`) as strings.

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
