# Changelog

## [Unreleased]

---

## [0.2.2]

Release Date: 2026-06-16

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.2

### Fixed

- Allow managed-mode installs with either the `@qvac/cli` `0.6.x` or `0.7.x` line as the optional CLI peer, so strict package managers can resolve the provider while CLI 0.7 brings in the newer SDK runtime.

---

## [0.2.1]

Release Date: 2026-06-15

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.1

### Fixed

- Require the published `@qvac/cli` `0.6.x` line as the optional managed-mode CLI peer, so consumers can install `@qvac/ai-sdk-provider` alongside the current CLI release without strict peer-resolution failures.

---

## [0.2.0]

Release Date: 2026-06-10

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.0

### Added

- **Managed mode (`mode: 'managed'`).** `createQvac({ mode: 'managed', models, ... })` returns a `Promise<ManagedQvacProvider>` that synthesizes an ephemeral `qvac.config.json` from a model list and brings up `qvac serve openai` for you — no hand-authored config or separate CLI step. Serves are **shared** across processes via a *fleet key* (model set + per-model config + host + binary + pinned port), owned by a **detached runner** that idle-reaps the serve once no consumer process remains for `serveIdleTimeout` (default 5 min). `close()` / `await using` detaches the calling process; a serve still in use by another consumer keeps running. Includes crash-recovery (`fetch` re-resolves and retries once on `ECONNREFUSED`) and a self-healing registry under `~/.qvac/managed-serves/`. New options: `models`, `servePort`, `serveHost`, `serveStartTimeout`, `serveBinPath`, `reuse`, `serveIdleTimeout`. New exports: `ManagedQvacProvider`, `QvacManagedOptions`, `QvacManagedModel`, `QvacExternalOptions`, and the managed error classes (`QvacManagedModeError` + subclasses) with the `QvacManagedErrorCode` union. Requires the optional `@qvac/cli` peer dependency. **External mode is unchanged**; the managed subsystem is dynamically imported only when `mode: 'managed'` is set.
- **Refreshed model catalog.** Updated the generated provider catalog against the live QVAC registry for the 0.2.0 release, adding 17 OpenAI-compatible model constants with no removals.

---

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

The provider exposes the same surface as any AI SDK provider — `qvac('alias')` for the default chat model, plus explicit `qvac.chatModel(...)`, `qvac.completionModel(...)`, `qvac.textEmbeddingModel(...)`, and `qvac.imageModel(...)` accessors. A pre-built default instance (`qvac`) is also exported for quick scripts; explicit `createQvac({ baseURL })` is recommended until the default `baseURL` is finalized (see *Known limitations* below).

---

## Typed Model Catalog (`@qvac/ai-sdk-provider/models`)

Every model in the QVAC P2P registry that has an OpenAI-shaped endpoint is exported as a strongly-typed constant. The catalog is code-generated from the live production registry at build time and committed to the package, so consumers can introspect models with zero HTTP traffic:

```ts
import { models, allModels } from '@qvac/ai-sdk-provider'

models.QWEN3_4B_INST_Q4_K_M.endpointCategory  // 'chat'      (compile-time known)
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
