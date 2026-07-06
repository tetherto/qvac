# Changelog

## [0.3.0]

Release Date: 2026-07-03

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.3.0

## Larger Agent Models in the Catalog

The friendly model catalog now includes larger models aimed at agentic and coding workloads, alongside the existing families:

- `gpt-oss-20b` → `GPT_OSS_20B_INST_Q4_K_M`
- `gemma4-31b` → `GEMMA4_31B_MULTIMODAL_Q4_K_M`
- `qwen3.6-27b` → `QWEN3_6_27B_MULTIMODAL_Q4_K_XL`
- `qwen3.6-35b-a3b` → `QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M`

These ids resolve to model constants already shipped in `@qvac/sdk` 0.14.x, so `qvac serve` can load them directly. Callers can now select these larger models by friendly id in both catalog UIs and generated serve configs.

## Managed Mode Supports CLI 0.8

`@qvac/ai-sdk-provider` now accepts the `@qvac/cli` `0.8.x` line as its optional managed-mode CLI peer, in addition to `0.6.x` and `0.7.x`. Installing the provider alongside CLI 0.8 resolves to the `@qvac/sdk` 0.14.x runtime, which is where the larger catalog models are available.

## Compatibility

External mode is unchanged and remains the default synchronous path. There are no breaking API changes in this release; the catalog additions are additive and existing model ids continue to resolve as before.

## [0.2.2]

Release Date: 2026-06-16

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.2

## Managed Mode Supports CLI 0.7

`@qvac/ai-sdk-provider` now accepts both the `@qvac/cli` `0.6.x` and `0.7.x` lines as its optional managed-mode CLI peer. This lets strict package managers install the provider alongside CLI 0.7, which resolves to the newer `@qvac/sdk` 0.13.x runtime.

No provider API changes are included in this patch release.

## [0.2.1]

Release Date: 2026-06-15

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.1

## Managed Mode Compatibility

`@qvac/ai-sdk-provider` now declares the published `@qvac/cli` `0.6.x` line as its optional managed-mode CLI peer. This keeps strict package managers from rejecting installs where applications use managed mode with the current QVAC CLI release.

No provider API changes are included in this patch release.

## [0.2.0]

Release Date: 2026-06-10

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.0

## Managed Mode

`@qvac/ai-sdk-provider` can now run `qvac serve` for local applications instead of requiring users to start a separate server first. Calling `createQvac({ mode: 'managed', models })` creates an ephemeral serve config, starts the QVAC CLI on a free local port, waits for the OpenAI-compatible endpoint to become healthy, and returns a normal AI SDK provider pointed at that serve.

Managed serves are shared by default. If another process requests the same model fleet and config, it attaches to the existing warm serve instead of spawning another process and loading the same model into memory again. A detached runner owns the serve and reaps it after the last consumer exits and the idle timeout expires.

## Lifecycle Improvements

The managed serve lifecycle is designed for coding agents and other local tools that may start, restart, or crash frequently:

- `close()` and `await using` detach the current consumer without killing a serve that another session is still using.
- `closeOnParentExit` lets plugin hosts clean up when their parent tool exits.
- Process-group shutdown ensures the serve and its inference worker are terminated together.
- Connection-refused recovery re-resolves a serve and retries once when the backing process has disappeared before a request starts.

## Friendly Model Catalog

The package now exposes a small public catalog that maps models.dev-style ids, such as `qwen3.5-9b`, to the SDK constants that `qvac serve` loads. This keeps model ids consistent across catalog UIs, provider configuration, and generated serve configs while preserving support for raw SDK constants.

The generated catalog was refreshed against the live QVAC registry for this release, adding 17 OpenAI-compatible model constants with no removals.

## Compatibility

External mode is unchanged and remains the default synchronous path. Managed mode is loaded only when `mode: 'managed'` is used and requires `@qvac/cli` as an optional peer dependency.

## [0.1.0]

Release Date: 2026-05-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.1.0

The first public release of `@qvac/ai-sdk-provider` — the [Vercel AI SDK](https://ai-sdk.dev) provider for the QVAC local AI runtime. Point it at a running `qvac serve openai` HTTP server and you get the full AI SDK surface (`streamText`, `generateText`, `embed`, `transcribe`, `generateImage`, …) backed by on-device chat, embeddings, transcription, translation, speech, OCR, and image-generation models. The package ships a typed catalog of every model in the QVAC P2P registry that has an OpenAI-shaped endpoint, so callers can introspect models without an HTTP round-trip to `/v1/models`.

---

## Introducing `@qvac/ai-sdk-provider`

`@qvac/ai-sdk-provider` is a thin, branded wrapper around [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible) configured for the QVAC OpenAI-compatible endpoint. The provider gives QVAC a first-class identity in the AI SDK ecosystem — a dedicated `createQvac()` factory, a default `qvac` instance, typed model metadata, and a discoverable handle for the [`models.dev`](https://models.dev) catalog so QVAC shows up in `/connect` for OpenCode and other catalog consumers.

`ai@^6.0` and `@ai-sdk/openai-compatible@^2.0` are **peer dependencies** — install them alongside:

```bash
bun add @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible
# or: npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible
```

Run `qvac serve openai` ([`@qvac/cli`](https://www.npmjs.com/package/@qvac/cli)) with at least one preloaded chat model, then wire the provider in:

```ts
import { createQvac } from '@qvac/ai-sdk-provider'
import { streamText } from 'ai'

const qvac = createQvac({
  baseURL: 'http://127.0.0.1:11434/v1', // match your `qvac serve` port
  apiKey: 'qvac' // anything non-empty; serve does not validate
})

const { textStream } = streamText({
  model: qvac('qwen3-600m'),
  prompt: 'Write a haiku about local-first AI.'
})

for await (const chunk of textStream) {
  process.stdout.write(chunk)
}
```

The provider exposes the same surface as any AI SDK provider — `qvac('alias')` for the default chat model, plus explicit `qvac.chatModel(...)`, `qvac.completionModel(...)`, `qvac.textEmbeddingModel(...)`, and `qvac.imageModel(...)` accessors. A pre-built default instance (`qvac`) is also exported for quick scripts; explicit `createQvac({ baseURL })` is recommended until the default `baseURL` is finalized (see _Known limitations_ below).

---

## Typed Model Catalog (`@qvac/ai-sdk-provider/models`)

Every model in the QVAC P2P registry that has an OpenAI-shaped endpoint is exported as a strongly-typed constant. The catalog is code-generated from the live production registry at build time and committed to the package, so consumers can introspect models with zero HTTP traffic:

```ts
import { models, allModels } from '@qvac/ai-sdk-provider'

models.QWEN3_4B_INST_Q4_K_M.endpointCategory // 'chat'      (compile-time known)
models.WHISPER_EN_TINY_Q8_0.endpointCategory // 'transcription'

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

Catalog scope is intentionally narrower than the underlying QVAC registry: codegen filters to engines / addons that have an OpenAI-shaped surface today (`llamacpp-completion`, `llamacpp-embedding`, `whispercpp-transcription`, `parakeet-transcription`, `nmtcpp-translation`, `onnx-tts`, `tts-ggml`, `onnx-ocr`, `sdcpp-generation`). Registry entries for VAD, classification, VLA, and other engines without a matching OpenAI endpoint are dropped at codegen time — they would have no usable surface in an AI SDK provider.

Regenerate the catalog against the live registry with:

```bash
npm run update-models     # writes src/models/constants.ts + models/history/<sha>.txt
npm run check-models      # CI-friendly drift check; fails if regen would change anything
```

`check-models` runs as part of the package's CI pipeline so the committed catalog cannot drift from the registry without a deliberate regen commit.

---

## Logo Asset

The package ships a single `assets/logo.svg` (drawn in `currentColor` so it themes against light, dark, and brand backgrounds without a re-export per theme). It's available to consumers via the subpath export:

```ts
// docs / catalog usage
import logo from '@qvac/ai-sdk-provider/assets/logo.svg'
```

Used by `models.dev` and downstream docs / connector catalogs to render the QVAC entry.

---

## Known Limitations

This is a `v1` release; two surfaces are deliberately scoped down and will move in follow-up minors:

- **Default `baseURL` is a placeholder.** `qvac serve` today defaults to port `11434`, which collides with Ollama. The CLI will move to a non-conflicting port in a future release and this package's default will move with it. **Set `baseURL` explicitly** to your `qvac serve` port — the default is `http://127.0.0.1:11435/v1` as a placeholder and will fail to connect to the unmodified CLI until the port-change ticket lands.
- **External mode only.** The provider wraps a `qvac serve openai` endpoint that you run yourself. A future `0.2.0` will add `mode: 'managed'` for auto-spawn / supervise of the serve process from inside the provider, removing the manual CLI step for the common single-machine case.

Beyond these, the provider is the canonical entry point for using QVAC from any application that already speaks the Vercel AI SDK.
