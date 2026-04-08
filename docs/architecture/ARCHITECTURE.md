# QVAC SDK Architecture

Author(s): [Yuri Samarin](https://github.com/yuranich) — QVAC Team

Last Update: Mar 4, 2026

Related Documents & Links

- [C4 Model Reference](https://c4model.com/)

---

# Product Executive Summary

QVAC SDK is a TypeScript SDK providing local-first, peer-to-peer AI capabilities across desktop and mobile platforms. The core abstraction is a **plugin-based client-server RPC architecture** where:

- **Client** runs in any JS environment (Node.js, Bun, Expo/React Native, Bare)
- **Server (Worker)** runs on [Bare Runtime](https://bare.pears.com) with native C++ inference addons, composed of registered **plugins**

The SDK is modular: each AI capability ships as a **plugin** that can be included or excluded at build time. Users select plugins in their config and run a build step to produce a tree-shaken worker bundle. Out-of-the-box, a default worker with all built-in plugins is provided.

Built-in plugins cover:
- **LLM Completion** (llama.cpp) — Text generation with streaming, tools, multimodal
- **Transcription** (whisper.cpp) — Speech-to-text with VAD support
- **Transcription** (Parakeet) — Speech-to-text (NVIDIA NeMo ONNX)
- **Embeddings** (llama.cpp) — Text embeddings for RAG
- **Translation** (nmtcpp) — Neural machine translation (Marian, IndicTrans2, Bergamot)
- **Text-to-Speech** (ONNX/Piper, Chatterbox, Supertonic) — Speech synthesis
- **OCR** (ONNX) — Optical character recognition

Custom plugins can be authored as npm packages with the same contract as built-in plugins.

Model distribution uses the Holepunch stack (Hyperdrive, Hyperswarm) for P2P delivery, HTTP as an alternative, the QVAC Model Registry for catalog-based downloads, or local filesystem paths for development and pre-staged deployments.

---

# System Context Diagram

![System Context Diagram](puml/images/01-system-context.png)

[PlantUML source](puml/01-system-context.puml)

*Key — Blue: system in scope · Grey: external systems · Arrows: dependency direction*

---

# Container Diagram

![Container Diagram](puml/images/02-container.png)

[PlantUML source](puml/02-container.puml)

*Key — Blue: internal containers · Grey: external systems · Cylinder: data store*

---

# Component Overview

![Component Overview](puml/images/03-component-overview.png)

[PlantUML source](puml/03-component-overview.puml)

*Key — Left boundary: Client process · Right boundary: Worker process · Arrows: runtime dependencies*

The SDK runs as a single logical unit. On desktop (Node.js/Bun), Client components run in the application process, Worker components run in a spawned Bare subprocess. On mobile (Expo), all components run in-process via BareKit. On Pear Desktop, a pre-hook generates the worker entry and Pear manages the lifecycle. See [Deployment Diagram](#deployment-diagram) for process topology.

---

# Plugin Architecture

The SDK uses a **plugin architecture** where each AI capability is an independent, self-contained plugin. Plugins implement the `QvacPlugin` interface — defining a `modelType`, a model factory (`createModel`), and a set of handlers with Zod-validated request/response schemas. Plugins are registered with the worker at startup via `registerPlugin()`.

This enables modular bundles (include only what you need), custom third-party plugins (same contract as built-in), and uniform dispatch (all operations route through the plugin registry).

**Built-in plugins:**

| Plugin | Model Type | Wraps |
|--------|------------|-------|
| LLM Completion | `llamacpp-completion` | `@qvac/llm-llamacpp` |
| Embeddings | `llamacpp-embedding` | `@qvac/embed-llamacpp` |
| Whisper | `whispercpp-transcription` | `@qvac/transcription-whispercpp` |
| Parakeet | `parakeet-transcription` | `@qvac/transcription-parakeet` |
| NMT | `nmtcpp-translation` | `@qvac/translation-nmtcpp` |
| TTS | `onnx-tts` | `@qvac/tts-onnx` |
| OCR | `onnx-ocr` | `@qvac/ocr-onnx` |

Model types follow an `engine-usecase` naming convention. Backward-compatible aliases (`llm`, `whisper`, `embeddings`, `nmt`, `tts`, `ocr`, `parakeet`) are supported and normalized to canonical types.

**Custom plugins** ship as npm packages with two subpath exports: default (`.`) for client wrappers (Metro-safe, cross-platform) and `./plugin` for the Bare-only plugin definition. The build step statically imports selected plugins into the worker.

**Plugin Invocation Flow:**

![Plugin Invocation Flow](puml/images/04-plugin-invocation-flow.png)

[PlantUML source](puml/04-plugin-invocation-flow.puml)

---

# Worker Generation & Bundle System

The `plugins` array in `qvac.config.{json,js,ts}` declares which plugins to include. Running `npx qvac bundle sdk` generates a worker entry with static imports for the selected plugins, then bundles it via `bare-pack` — tree-shaking unused addons. Output is `qvac/worker.entry.mjs` (desktop) and `qvac/worker.bundle.js` (mobile).

**Worker resolution at runtime:**

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `QVAC_WORKER_PATH` env var | Explicit path override |
| 2 | Packaged Electron worker | `resources/.../qvac/worker.entry.mjs` |
| 3 | `qvac/worker.entry.mjs` in project root | Output of `npx qvac bundle sdk` |
| 4 | Default SDK worker (`dist/server/worker.js`) | Fallback with all built-in plugins |

**Out-of-the-box**, the SDK ships a default worker with all built-in plugins — no build step required. Running the bundle command produces an optimized worker with only the selected plugins.

---

# Deployment Diagram

![Deployment Diagram](puml/images/05-deployment.png)

[PlantUML source](puml/05-deployment.puml)

*Key — Nested boxes: deployment environment · Blue: container instances · Cylinder: persistent storage*

**Platform binaries:** Node.js/Bun ships prebuilt native addons for darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64. Electron and Expo/RN bundle addons with the app binary. Pear Desktop and Bare Direct use the host runtime's native modules.

---

# Domain Model Diagram

![Domain Model Diagram](puml/images/06-domain-model.png)

[PlantUML source](puml/06-domain-model.puml)

---

# RPC Communication Flow

![RPC Communication Flow](puml/images/07-rpc-communication-flow.png)

[PlantUML source](puml/07-rpc-communication-flow.puml)


---

# Model Loading Flow

![Model Loading Flow](puml/images/08-model-loading-flow.png)

[PlantUML source](puml/08-model-loading-flow.puml)

**Model Constants:** Model constants are rich objects (not plain strings) containing all metadata — `name`, `src`, `modelId`, `hyperdriveKey`, `expectedSize`, `sha256Checksum`, `addon`. APIs accept both string URIs and object constants via a `ModelSrcInput` union type.

---

# Delegated Inference Component Diagram

![Delegated Inference Components](puml/images/09-delegated-inference.png)

[PlantUML source](puml/09-delegated-inference.puml)

*Key — Left boundary: provider-side · Right boundary: consumer-side · Bidirectional arrows: P2P connections*

**Delegation Workflow:**

1. **Provider** loads model locally, calls `startQVACProvider({ topic, firewall? })`
2. Provider announces on the specified Hyperswarm topic
3. **Consumer** calls `loadModel({ modelSrc, delegate: { providerPublicKey, topic, timeout?, fallbackToLocal?, forceNewConnection? } })`
4. Consumer joins swarm, connects to provider
5. All inference calls proxy through encrypted P2P stream
6. Provider executes inference locally, streams results back

**Firewall Configuration:** `mode: "allow"|"deny"` with `publicKeys` array

---

# RAG Component Diagram

![RAG Components](puml/images/10-rag-components.png)

[PlantUML source](puml/10-rag-components.puml)

**Workspace Isolation:** Each workspace is bound to a specific embedding model at creation. Documents from different workspaces cannot be mixed.

---

# Model Registry (Online Catalog)

The SDK includes a client for the QVAC Model Registry (`@qvac/registry-client`), providing catalog-based model discovery. Client APIs: `modelRegistryList`, `modelRegistrySearch`, `modelRegistryGetModel`. Models discovered through the registry can be loaded via `loadModel()` or pre-downloaded via `downloadAsset()`.

---

# Security Model

| Boundary | Mechanism |
|----------|-----------|
| P2P Transport | Noise protocol encryption (Hyperswarm default) |
| Delegated Inference | Firewall allow/deny lists by public key |
| Model Integrity | SHA256 checksum verification (model constants include checksums; optional for custom URLs) |
| Path Security | Path traversal protection for model file resolution |
| Local Storage | No encryption at rest; relies on OS-level file permissions |

**Not in scope:** Authentication/authorization for local API calls (SDK runs as trusted local process).

---

# Failure Modes

| Failure | Behavior |
|---------|----------|
| P2P peer disconnects mid-inference | Consumer receives error; `fallbackToLocal` option triggers local model load if configured |
| Download interrupted | Partial file cached; resume on retry (HTTP range requests, Hyperdrive sparse sync) |
| Model load fails (corrupt/incompatible) | Error with cause chain; model not registered |
| Native addon crash | Server process may terminate; client receives RPC error |
| Server process OOM | OS kills subprocess; client receives RPC connection error and must restart SDK |
| Plugin not enabled | Fast-fail with message: "plugin not enabled, add to qvac.config and rebuild" |

**Cancellation:** `cancel({ requestId })` supported for `inference`, `downloadAsset`, and `rag` operations.

---

# Native Addons Architecture

- [C++ Addon Framework](../packages/qvac-lib-inference-addon-cpp/docs/architecture.md)
- [LLM Completion — llama.cpp](../packages/qvac-lib-infer-llamacpp-llm/docs/architecture.md)
- [Embeddings — llama.cpp](../packages/qvac-lib-infer-llamacpp-embed/docs/architecture.md)
- [Transcription — whisper.cpp](../packages/qvac-lib-infer-whispercpp/docs/architecture.md)
- [Translation — nmt.cpp](../packages/qvac-lib-infer-nmtcpp/docs/architecture.md)
- [TTS — ONNX](../packages/qvac-lib-infer-onnx-tts/docs/architecture.md)
- [OCR — ONNX](../packages/ocr-onnx/docs/architecture.md)

---

# Cross-Cutting Concerns

**Logging:** Logs span three boundaries—client process, server (Bare subprocess), and native addons. Addon logs are forwarded to JS via registered callbacks (plugins can configure this via `logging.module` and `logging.namespace`). A streaming mechanism (`loggingStream`) allows real-time log forwarding from subprocess to client for debugging UIs. Log level and console output are configurable via `qvac.config`.

**Error Handling:** All SDK errors expose a numeric `code` property for programmatic handling, with original errors preserved via `cause` chain. Errors are structured classes extending `QvacErrorBase`. Client (50,001–52,000) and server (52,001–54,000) error codes are strictly separated.

**Worker Lifecycle:** Startup has two phases: `initializeWorkerCore()` parses environment, starts log buffering, and registers SIGTERM/SIGINT handlers; then plugins are registered; finally `ensureRPCSetup()` creates the IPC client (desktop) or BareKit RPC server (mobile) and begins accepting requests. On termination signal, the registered shutdown handler runs graceful cleanup: clear registries, unload models, destroy swarm, close RAG instances, cancel downloads, close registry client.

---

# Repositories

All packages live in this monorepo under `packages/`:

**SDK & CLI**

| Directory | Package | Purpose |
|-----------|---------|---------|
| `qvac-sdk` | `@qvac/sdk` | Core SDK: client API, RPC, plugins, worker |
| `qvac-cli` | `@qvac/cli` | CLI tooling (`qvac bundle sdk`) |
| `docs` | `docs` | Documentation site (Next.js / Fumadocs) |

**Inference Addons**

| Directory | Package | Purpose |
|-----------|---------|---------|
| `qvac-lib-infer-llamacpp-llm` | `@qvac/llm-llamacpp` | LLM completion (llama.cpp) |
| `qvac-lib-infer-llamacpp-embed` | `@qvac/embed-llamacpp` | Text embeddings (llama.cpp) |
| `qvac-lib-infer-whispercpp` | `@qvac/transcription-whispercpp` | Speech-to-text (whisper.cpp) |
| `qvac-lib-infer-parakeet` | `@qvac/transcription-parakeet` | Speech-to-text (Parakeet) |
| `qvac-lib-infer-nmtcpp` | `@qvac/translation-nmtcpp` | Translation (nmt.cpp) |
| `qvac-lib-infer-onnx-tts` | `@qvac/tts-onnx` | Text-to-speech (ONNX) |
| `ocr-onnx` | `@qvac/ocr-onnx` | OCR (ONNX) |

**Support Libraries**

| Directory | Package | Purpose |
|-----------|---------|---------|
| `qvac-lib-rag` | `@qvac/rag` | RAG with HyperDB |
| `dl-base` | `@qvac/dl-base` | Base data loader |
| `qvac-lib-dl-hyperdrive` | `@qvac/dl-hyperdrive` | Hyperdrive data loader |
| `dl-filesystem` | `@qvac/dl-filesystem` | Filesystem data loader |
| `qvac-lib-infer-base` | `@qvac/infer-base` | Base inference client |
| `qvac-lib-decoder-audio` | `@qvac/decoder-audio` | Audio decoding |
| `qvac-lib-logging` | `@qvac/logging` | Logging utilities |
| `qvac-lib-error-base` | `@qvac/error` | Base error types |
| `qvac-lib-langdetect-text` | `@qvac/langdetect-text` | Language detection |
| `qvac-lib-registry-server` | `@qvac/registry-server` | Model registry server |


