# QVAC SDK Architecture

Author(s): [Yuri Samarin](https://github.com/yuranich) - QVAC Team

Last Update: Aug 21, 2026

Related Documents & Links

- [C4 Model Reference](https://c4model.com/)
- [Agent Integrations](./AGENT-INTEGRATIONS.md) - AI SDK provider, OpenCode plugin, CLI serve, models.dev, layer ownership, and release workflow

---

# Product Executive Summary

QVAC SDK is a local-first, peer-to-peer AI platform for JavaScript, Bare, and Python applications. The architecture is split by responsibility:

- **`@qvac/inference`** is the engine: dispatch, plugins, models, P2P, RAG, schemas, and request lifecycle. Direct Bare apps import this package and call it in process.
- **`@qvac/sdk`** is the TypeScript host for Node.js, Bun, Electron, Expo/React Native, and Pear. It owns the client, worker shell, RPC, bundling, and the default all-plugin distribution. The worker runs `@qvac/inference` inside Bare and re-exports the engine public API.
- **`tetherto-qvac-sdk`** is the generated Python client. It uses the same worker RPC contract as TypeScript.

`@qvac/bare-sdk` is deprecated. Bare consumers use `@qvac/inference`.

The core execution model is the same across packages:

- Plugins implement `QvacPlugin`, provide Zod schemas, create model instances, and expose unary, server-streaming, or duplex handlers.
- Host clients either call the engine in process or send the same request envelope to a Bare worker over the platform transport.
- Model distribution uses HTTP, the QVAC Model Registry, Hyperdrive, or local filesystem paths.

---

# System Context Diagram

![System Context Diagram](puml/images/01-system-context.png)

[PlantUML source](puml/01-system-context.puml)

*Key - Blue: system in scope; grey: external systems; arrows: intent [transport]. Registry catalog and model bytes use Holepunch (Hyperswarm plus a Hypercore blob store). HTTP/CDN is a separate HTTPS path.*

The family is one software system at this zoom. Package choice is in the [executive summary](#product-executive-summary). Runtime boxes are on the [container diagram](#container-diagram).

---

# Container Diagram

![Container Diagram](puml/images/02-container.png)

[PlantUML source](puml/02-container.puml)

*Key - Blue: runtime boxes; grey: external systems; cylinder: data store; arrows: intent [transport]. External I/O leaves `@qvac/inference`. Holepunch includes the QVAC Model Registry. Host RPC transports are in the [deployment table](#deployment-diagram).*

Host, worker, and `@qvac/inference` are the runtime path for `@qvac/sdk` and Python. Direct Bare skips this diagram's host and worker; it is the right-hand [deployment](#deployment-diagram) topology.

---

# Component Overview

![Component Overview](puml/images/03-component-overview.png)

[PlantUML source](puml/03-component-overview.puml)

*Key - Host process above, `@qvac/inference` below. Host to engine is `bare-rpc` (or in-process on direct Bare). Internal engine arrows are in-process. Python uses the same public API, generated from the wire contract.*

Physical process placement is covered in the [Deployment Diagram](#deployment-diagram).

---

# Plugin Architecture

Each AI capability is an independent plugin. A `QvacPlugin` defines its canonical `modelType`, addon metadata, load-config schema, model factory, optional artifact resolution, and handler set. Handlers declare Zod request/response schemas and whether they are unary, server-streaming, or duplex.

The plugin registry provides uniform dispatch for built-in and custom plugins. Distribution-specific registration rules live in [Worker Generation & Bundle System](#worker-generation--bundle-system).

**Built-in plugins:**

| Plugin | Model Type | Wraps |
|--------|------------|-------|
| LLM Completion | `llamacpp-completion` | `@qvac/llm-llamacpp` |
| Embeddings | `llamacpp-embedding` | `@qvac/embed-llamacpp` |
| Whisper | `whispercpp-transcription` | `@qvac/asr-ggml` |
| BCI Whisper | `bci-whispercpp-transcription` | `@qvac/bci-whispercpp` |
| Parakeet | `parakeet-transcription` | `@qvac/asr-ggml` |
| NMT | `nmtcpp-translation` | `@qvac/translation-nmtcpp` |
| TTS | `tts-ggml` | `@qvac/tts-ggml` |
| OCR | `ggml-ocr` | `@qvac/ocr-ggml` |
| Diffusion / Video / Upscale | `sdcpp-generation` | `@qvac/diffusion-cpp` |
| Audio Generation | `audiogen-ggml` | `@qvac/audiogen-ggml` |
| Vision-Language-Action | `ggml-vla` | `@qvac/vla-ggml` |
| Classification | `ggml-classification` | `@qvac/classification-ggml` |

Model types follow an `engine-usecase` naming convention. Backward-compatible aliases (`llm`, `whisper`, `bci`, `embeddings`, `nmt`, `parakeet`, `tts`, `ocr`, `diffusion`, `audiogen`, `vla`, `classification`) are supported and normalized to canonical types.

**Custom plugins** ship as npm packages whose plugin manifest is imported through a `/plugin` subpath.

**Plugin Invocation Flow:**

![Plugin Invocation Flow](puml/images/04-plugin-invocation-flow.png)

[PlantUML source](puml/04-plugin-invocation-flow.puml)

Streaming uses `invokePluginStream` (async generator, newline-delimited JSON). Transport is the same as the [RPC flow](#rpc-communication-flow).

---

# Worker Generation & Bundle System

Plugin registration is determined by the package and runtime path:

- `@qvac/inference` registers no plugins by default. Consumers assemble the engine explicitly with `plugins([...])` or `registerPlugin(...)`.
- `@qvac/sdk` ships a default worker that runs `@qvac/inference` with every built-in plugin registered.
- `qvac bundle sdk` generates an optimized worker entry for the plugin list in `qvac.config.{json,js,ts}`.

The bundle command emits:

- `qvac/worker.entry.mjs` - standalone worker entry with RPC and lifecycle, used by desktop/Electron packaging.
- `qvac/worker.pear.entry.mjs` - Pear worker entry (same process), generated by the Pear pre-hook.
- `qvac/worker.bundle.js` - mobile bundle for Expo/React Native BareKit.
- `qvac/addons.manifest.json` - native addon manifest derived from the bundle.

**TypeScript desktop worker resolution:**

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `QVAC_WORKER_PATH` env var | Explicit path override |
| 2 | Packaged Electron worker | `resources/.../qvac/worker.entry.mjs` |
| 3 | `qvac/worker.entry.mjs` in project root | Output of `npx qvac bundle sdk` |
| 4 | Default SDK worker | Fallback that runs `@qvac/inference` with all built-in plugins |

---

# Deployment Diagram

![Deployment Diagram](puml/images/05-deployment.png)

[PlantUML source](puml/05-deployment.puml)

*Key - Nested boxes: deployment environment; blue: runtime instances; cylinder: persistent storage; arrows: intent [transport]. Left is host plus worker: subprocess on Node/Python/Electron, same process on Pear (in-process) and Expo (BareKit). Right is direct Bare: the app imports `@qvac/inference` and there is no SDK worker.*

| Platform | Host | Worker placement | Transport |
|---|---|---|---|
| Node.js / Bun / Electron | `@qvac/sdk` | Bare subprocess | Unix socket or named pipe |
| Python | `tetherto-qvac-sdk` | Bare subprocess | Loopback TCP |
| Pear | `@qvac/sdk` | Same process | In-process |
| Expo / React Native | `@qvac/sdk` | BareKit worklet | Native bridge |
| Direct Bare | `@qvac/inference` | None | In-process |

Native addon packaging follows the deployment target: Node/Bun use installed prebuilds, Electron and Expo/RN package native addons with the app, and Bare/Pear builds include the addons selected by the authored or generated worker entry.

---

# Domain Model Diagram

![Domain Model Diagram](puml/images/06-domain-model.png)

[PlantUML source](puml/06-domain-model.puml)

---

# RPC Communication Flow

![RPC Communication Flow](puml/images/07-rpc-communication-flow.png)

[PlantUML source](puml/07-rpc-communication-flow.puml)

Worker-backed clients use the same JSON request/response envelopes over different transports:

- TypeScript Node/Bun/Electron clients use `bare-rpc` over a Unix socket or Windows named pipe.
- Expo clients use `bare-rpc` over the BareKit worklet IPC bridge.
- Python clients use `bare-rpc-python` over loopback TCP (`127.0.0.1:0`) because asyncio has no cross-platform Unix-socket/named-pipe server.

In-process Bare (`@qvac/inference`) bypasses sockets and calls the dispatch layer directly.

---

# Model Loading Flow

![Model Loading Flow](puml/images/08-model-loading-flow.png)

[PlantUML source](puml/08-model-loading-flow.puml)

**Model Constants:** Model constants are rich objects (not plain strings) containing metadata such as `name`, `src`, `modelId`, `blobCoreKey`, `expectedSize`, `sha256Checksum`, and `addon`. APIs accept string URIs, local paths, descriptor objects, and model constants via the `ModelSrcInput` union type. Python receives the same constants from `packages/sdk/contract/models.json`.

---

# Delegated Inference Component Diagram

![Delegated Inference Components](puml/images/09-delegated-inference.png)

[PlantUML source](puml/09-delegated-inference.puml)

*Key - Consumer above, provider below. Wire path is delegated inference [Noise / Hyperswarm]. The provider invokes a local model in process.*

**Delegation Workflow:**

1. **Provider** loads model locally, calls `startQVACProvider({ firewall? })`
2. Provider waits for DHT bootstrap, binds its swarm keypair with `swarm.listen()`, and returns its `publicKey`
3. **Consumer** calls `loadModel({ modelSrc, delegate: { providerPublicKey, timeout?, healthCheckTimeout?, fallbackToLocal?, forceNewConnection? } })`
4. Consumer dials the provider directly with `dht.connect(providerPublicKey)`
5. All inference calls proxy through encrypted P2P stream
6. Provider executes inference locally, streams results back

**Firewall Configuration:** `mode: "allow"|"deny"` with `publicKeys` array

---

# RAG Component Diagram

![RAG Components](puml/images/10-rag-components.png)

[PlantUML source](puml/10-rag-components.puml)

*Key - Host API calls engine handlers. Operations: chunk, ingest, search, delete, reindex, plus workspace create/open/close.*

**Workspace Isolation:** Each workspace is bound to a specific embedding model at creation. Documents from different workspaces cannot be mixed.

---

# Model Registry (Online Catalog)

The SDK includes a client for the QVAC Model Registry (`@qvac/registry-client`), providing catalog-based model discovery. Client APIs: `modelRegistryList`, `modelRegistrySearch`, `modelRegistryGetModel`. Models discovered through the registry can be loaded via `loadModel()` or pre-downloaded via `downloadAsset()`.

---

# Language Contract & Python Client

The language-neutral SDK contract lives under `packages/sdk/contract/**`:

- `schema.json` contains JSON Schema for every request/response wire type and registered public constants.
- `manifest.json` lists every RPC method and call shape (`request-reply`, `server-stream`, `duplex`).
- `models.json` contains the generated model constants catalog.

`packages/sdk` owns contract generation via `bun run contract:export` and drift detection via `bun run contract:check`. `packages/sdk-python` consumes the contract to generate Pydantic models, typed method stubs, model type maps, error-code registries, model constants, and the pinned SDK version.

The Python package provides:

- A flat public API under `tetherto.qvac_sdk`, plus `tetherto.qvac_sdk.models` for model constants.
- Ergonomic wrappers for common calls, generated stubs for the full RPC surface, typed errors, logging/profiling helpers, VLA helpers, and a notebook `SyncClient` facade.
- Thin PyPI installs that resolve a worker from explicit paths, `QVAC_*` env vars, a local `@qvac/sdk`, a managed `install-worker` cache, or global npm.
- Self-contained release wheels that bundle the worker and Bare runtime for supported platforms.

---

# Security Model

| Boundary | Mechanism |
|----------|-----------|
| P2P Transport | Noise protocol encryption (Hyperswarm default) |
| Delegated Inference | Firewall allow/deny lists by public key |
| Model Integrity | SHA256 checksum verification (model constants include checksums; optional for custom URLs) |
| Path Security | Path traversal protection for model file resolution |
| Local Worker RPC | Local IPC/loopback only; trusted local process model |
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
| Worker crash during an in-flight request | Client life-signal race rejects pending calls instead of hanging |
| Plugin not enabled | Fast-fail with a plugin registration / no-handler error and guidance to configure or register the plugin |
| `@qvac/inference` call before plugin assembly | Fast-fail with guidance to call `plugins([...])` or `registerPlugin(...)` |

**Cancellation:** `cancel({ requestId })` is the preferred targeted path for migrated long-running operations, including completion/batch completion, embeddings, transcription, translation, fine-tuning, model loading, asset downloads, RAG, and audio generation. Broad cancellation by `modelId` remains available for shutdown, unload, and admin sweeps.

---

# Native Addons Architecture

- [Addon C++ Framework](../../packages/inference-addon-cpp/docs/architecture.md)
- [LLM Completion - llama.cpp](../../packages/llm-llamacpp/docs/architecture.md)
- [Embeddings - llama.cpp](../../packages/embed-llamacpp/docs/architecture.md)
- [Speech-to-text - ASR GGML](../../packages/asr-ggml/docs/architecture.md)
- [Translation - nmt.cpp](../../packages/translation-nmtcpp/docs/architecture.md)
- [Diffusion - stable-diffusion.cpp](../../packages/diffusion-cpp/docs/architecture.md)
- [Classification - GGML](../../packages/classification-ggml/docs/architecture.md)

---

# Cross-Cutting Concerns

**Logging:** Logs span host client, worker core, and native addons. Addon logs are forwarded to JS via registered callbacks (plugins can configure this via `logging.module` and `logging.namespace`). A streaming mechanism (`loggingStream` / `subscribeServerLogs`) allows real-time log forwarding from subprocess to client for debugging UIs. Log level and console output are configurable via `qvac.config` and Python `Client(config=...)`.

**Error Handling:** All SDK errors expose a numeric `code` property for programmatic handling, with original errors preserved via `cause` chain. Errors are structured classes extending `QvacErrorBase`. Client (50,001-52,000) and server (52,001-54,000) error codes are strictly separated.

**Worker Lifecycle:** The SDK worker shell frames RPC, acquires the process lock, and calls `@qvac/inference` `send` / `stream` / `duplex`. Startup registers SIGTERM/SIGINT handlers, registers built-in plugins on the engine, then `ensureRPCSetup()` creates the IPC client (desktop) or BareKit RPC server (mobile). Direct Bare imports `@qvac/inference` and skips the worker. On termination, the engine clears registries, unloads models, destroys the swarm, closes RAG instances, cancels downloads, closes the registry client, and releases the worker lock where the runtime owns process exit.

**Request Lifecycle:** Long-running operations run through request lifecycle primitives (`RequestRegistry`, `RequestContext`, `DisposableScope`) that provide request IDs, cancellation, structured cleanup, concurrency policy, and per-request logging. Client-side `completion`, `loadModel`, and `downloadAsset` expose request IDs synchronously so callers can cancel in-flight work.

---

# Repositories

Most packages live in this monorepo under `packages/`. Integration plugins live under `plugins/`, and the documentation site lives under `docs/website`.

**SDK & CLI**

| Directory | Package | Purpose |
|-----------|---------|---------|
| `sdk` | `@qvac/sdk` | TypeScript host: public API, worker shell, RPC transports, bundling; re-exports `@qvac/inference` |
| `bare-sdk` | `@qvac/bare-sdk` | Deprecated slim Bare distribution; Bare consumers use `@qvac/inference` |
| `inference` | `@qvac/inference` | Engine: dispatch, plugins, models, P2P, RAG, schemas; Bare in-process, no worker/RPC |
| `sdk-python` | `tetherto-qvac-sdk` | Generated Python client for the SDK worker contract |
| `cli` | `@qvac/cli` | CLI tooling (`qvac bundle sdk`, verification, release helpers) |
| `ai-sdk-provider` | `@qvac/ai-sdk-provider` | Vercel AI SDK provider integration |
| `test-suite` | `@qvac/test-suite` | Distributed MQTT test-orchestration framework (`qvac-test` CLI) driving the SDK e2e suites across desktop, Electron, Snap, Android, and iOS |
| `plugins/opencode` | `@qvac/opencode-plugin` | OpenCode integration |
| `plugins/openclaw` | `@qvac/openclaw-plugin` | OpenClaw integration |
| `docs/website` | - | Documentation site (Next.js / Fumadocs) |

**Inference Addons**

| Directory | Package | Purpose |
|-----------|---------|---------|
| `llm-llamacpp` | `@qvac/llm-llamacpp` | LLM completion (llama.cpp) |
| `embed-llamacpp` | `@qvac/embed-llamacpp` | Text embeddings (llama.cpp) |
| `asr-ggml` | `@qvac/asr-ggml` | Whisper and Parakeet speech-to-text (GGML) |
| `bci-whispercpp` | `@qvac/bci-whispercpp` | BCI neural-signal transcription |
| `translation-nmtcpp` | `@qvac/translation-nmtcpp` | Translation (nmt.cpp) |
| `tts-ggml` | `@qvac/tts-ggml` | Text-to-speech (GGML) |
| `ocr-ggml` | `@qvac/ocr-ggml` | OCR (GGML) |
| `diffusion-cpp` | `@qvac/diffusion-cpp` | Image/video generation and upscaling |
| `audiogen-ggml` | `@qvac/audiogen-ggml` | Text-conditioned audio generation |
| `vla-ggml` | `@qvac/vla-ggml` | Vision-language-action inference |
| `classification-ggml` | `@qvac/classification-ggml` | Image classification |

**Support Libraries**

| Directory | Package | Purpose |
|-----------|---------|---------|
| `rag` | `@qvac/rag` | RAG with HyperDB |
| `decoder-audio` | `@qvac/decoder-audio` | Audio decoding |
| `logging` | `@qvac/logging` | Logging utilities |
| `error` | `@qvac/error` | Base error types |
| `langdetect-text` | `@qvac/langdetect-text` | Language detection |
| `registry-server` | process package plus `@qvac/registry-client` / shared packages | Distributed model registry service and client/shared contracts |


