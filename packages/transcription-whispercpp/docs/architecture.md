# Architecture Documentation

**Package:** `@qvac/transcription-whispercpp` v0.6.7
**Stack:** JavaScript, C++20, whisper.cpp, Bare Runtime, CMake, vcpkg  
**License:** Apache-2.0

---

## Table of Contents

### Overview
- [Purpose](#purpose)
- [Key Features](#key-features)
- [Target Platforms](#target-platforms)

### Core Architecture
- [Package Context](#package-context)
- [Public API](#public-api)
- [Internal Architecture](#internal-architecture)
- [Core Components](#core-components)
- [Bare Runtime Integration](#bare-runtime-integration)

### Architecture Decisions
- [Decision 1: whisper.cpp as Inference Backend](#decision-1-whispercpp-as-inference-backend)
- [Decision 2: Bare Runtime over Node.js](#decision-2-bare-runtime-over-nodejs)
- [Decision 3: Shared Addon Framework](#decision-3-shared-addon-framework-inference-addon-cpp)
- [Decision 4: Variant-Based Configuration Pipeline](#decision-4-variant-based-configuration-pipeline)
- [Decision 5: Silero VAD via whisper.cpp Built-in Support](#decision-5-silero-vad-via-whispercpp-built-in-support)

### Technical Debt
- [Streaming Session Lifecycle](#1-streaming-session-lifecycle)

---

# Overview

## Purpose

`@qvac/transcription-whispercpp` is a cross-platform npm package providing speech-to-text transcription for Bare runtime applications. It wraps [whisper.cpp](https://github.com/ggerganov/whisper.cpp) in a JavaScript-friendly API, enabling local audio transcription on desktop and mobile with CPU/GPU acceleration.

**Core value:**
- High-level JavaScript API for speech-to-text inference
- Streaming transcription with real-time segment delivery
- Silero VAD integration for production-quality accuracy
- Unified interface shared with other QVAC inference backends
- Hot-reload of configuration without destroying the instance

## Key Features

- **Cross-platform**: macOS, Linux, Windows, iOS, Android
- **Streaming transcription**: Audio chunks appended in real-time; segments emitted as decoded
- **GPU acceleration**: Metal (Apple), Vulkan (Linux/Android/Windows) with automatic CPU fallback
- **Silero VAD**: Voice Activity Detection via explicit `files.vadModel`; required for `runStreaming()`
- **Hot-reload**: Change language, VAD params, etc. at runtime; only context-level changes trigger full model reload
- **Runtime statistics**: Wall time, real-time factor, tokens/second, whisper.cpp internal timings

## Target Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan (CPU fallback) |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan (CPU fallback) |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan (CPU fallback) |

**Dependencies:**
- whisper.cpp (=1.8.4.1): Inference engine (GGML-based)
- inference-addon-cpp (≥1.1.6): C++ addon framework (`AddonJs`, `runJob`, streaming exports, cancellation)
- @qvac/infer-base (^0.4.0): `createJobHandler`, `exclusiveRunQueue`, QvacResponse
- @qvac/decoder-audio (^0.3.3): Audio decoding and sample rate conversion
- @qvac/error (^0.1.0): Shared error code infrastructure
- @qvac/logging (^0.1.0): Structured logging
- Bare Runtime (≥1.24.0): JavaScript runtime

---

# Core Architecture

## Package Context

### Ecosystem Position

```mermaid
graph TB
    subgraph "Application Layer"
        APP[QVAC Applications]
    end

    subgraph "Inference Addons"
        WHISPER[whispercpp<br/>STT]
        LLM[llm-llamacpp<br/>LLMs]
        EMBED[embed-llamacpp<br/>Embeddings]
        NMT[nmtcpp<br/>Translation]
    end

    subgraph "Core Libs"
        BASE["@qvac/infer-base"]
        DECODER["@qvac/decoder-audio"]
    end

    subgraph "Native Framework"
        ADDON[addon-cpp]
    end

    subgraph "Backend"
        BARE[Bare Runtime]
        WCPP[whisper.cpp]
    end

    APP --> WHISPER
    WHISPER --> BASE
    WHISPER --> DECODER
    WHISPER --> ADDON
    ADDON --> BARE
    ADDON --> WCPP

    style WHISPER fill:#e1f5ff,stroke:#0066cc,stroke-width:3px
```

<details>
<summary>📊 LLM-Friendly: Package Relationships</summary>

**Dependency Table:**

| Package | Type | Version | Purpose |
|---------|------|---------|---------|
| @qvac/infer-base | Framework | ^0.4.0 | `createJobHandler`, `exclusiveRunQueue`, QvacResponse |
| @qvac/decoder-audio | Runtime | ^0.3.3 | Audio decoding and resampling |
| inference-addon-cpp | Native | ≥1.1.6 | C++ addon framework |
| whisper.cpp | Native | =1.8.4.1 | Inference engine |
| Bare Runtime | Runtime | ≥1.24.0 | JavaScript execution |

**Integration Points:**

| From | To | Mechanism | Data Format |
|------|-----|-----------|-------------|
| JavaScript | TranscriptionWhispercpp | Constructor | args, config objects |
| TranscriptionWhispercpp | createJobHandler / exclusiveRunQueue | Composition | Job lifecycle + single-job serialization |
| TranscriptionWhispercpp | WhisperInterface | Composition | Method calls |
| WhisperInterface | C++ Addon | require.addon() | Native binding |
| TranscriptionWhispercpp | files.model / files.vadModel | Constructor paths | Local model files; no package-owned download |

</details>

---

## Public API

### Main Class: TranscriptionWhispercpp

```mermaid
classDiagram
    class TranscriptionWhispercpp {
        +constructor(args, config)
        +load() Promise~void~
        +run(audioStream) Promise~QvacResponse~
        +runStreaming(options) Promise~QvacResponse~
        +reload(newConfig) Promise~void~
        +unload() Promise~void~
        +validateModelFiles()
    }

    class JobHandler {
        <<createJobHandler>>
        +start() QvacResponse
        +output(data)
        +end(stats)
        +fail(error)
    }

    class QvacResponse {
        +iterate() AsyncIterator~string~
        +onUpdate(callback) QvacResponse
        +onFinish(callback) QvacResponse
        +await() Promise~void~
        +cancel() Promise~void~
        +stats object
    }

    class RunQueue {
        <<exclusiveRunQueue>>
        +(fn) Promise
    }

    TranscriptionWhispercpp *-- JobHandler
    TranscriptionWhispercpp *-- RunQueue
    TranscriptionWhispercpp ..> QvacResponse : creates
```

<details>
<summary>📊 LLM-Friendly: Class Responsibilities</summary>

**Component Roles:**

| Class | Responsibility | Lifecycle | Dependencies |
|-------|----------------|-----------|--------------|
| TranscriptionWhispercpp | Orchestrate model lifecycle, manage batch and streaming transcription | Created by user, persistent | WhisperInterface, createJobHandler, exclusiveRunQueue |
| QvacResponse | Stream inference output | Created per run() call, short-lived | None |
| WhisperInterface | JS wrapper around native batch and streaming exports | Created by TranscriptionWhispercpp | Native binding |

**Key Relationships:**

| From | To | Type | Purpose |
|------|-----|------|---------|
| TranscriptionWhispercpp | createJobHandler | Composition | Response lifecycle |
| TranscriptionWhispercpp | exclusiveRunQueue | Composition | Serialize batch calls |
| TranscriptionWhispercpp | QvacResponse | Creates | Streaming output per inference |

</details>

---

## Internal Architecture

### Architectural Pattern

The package follows a **layered architecture** with clear separation of concerns:

```mermaid
graph TB
    subgraph "Layer 1: JavaScript API"
        APP["Application Code"]
        TWCLASS["TranscriptionWhispercpp<br/>(index.js)"]
        JOBH["createJobHandler<br/>(@qvac/infer-base)"]
        RUNQ["exclusiveRunQueue<br/>(@qvac/infer-base)"]
        RESPONSE["QvacResponse<br/>(@qvac/infer-base)"]
    end

    subgraph "Layer 2: Bridge"
        WHISPERIF["WhisperInterface<br/>(whisper.js)"]
        CONFIGCHK["configChecker.js"]
        BINDING["require.addon<br/>(binding.js)"]
    end

    subgraph "Layer 3: C++ Addon"
        JSINTERFACE["JsInterface<br/>(js-interface/binding.cpp)"]
        JSADAPTER["JSAdapter<br/>(js-interface/JSAdapter.cpp)"]
        ADDON["AddonJs<br/>(addon/src/addon/AddonJs.hpp)"]
        STREAMING["StreamingProcessor<br/>(model-interface/StreamingProcessor.cpp)"]
    end

    subgraph "Layer 4: Model"
        WHISPERMODEL["WhisperModel<br/>(model-interface/WhisperModel.cpp)"]
        WHISPERCONFIG["WhisperConfig / WhisperHandlers<br/>(model-interface/WhisperConfig.cpp)"]
    end

    subgraph "Layer 5: Backend"
        WCPP["whisper.cpp"]
        GGML["GGML"]
        GPU["GPU Backends"]
    end

    APP --> TWCLASS
    TWCLASS --> JOBH
    TWCLASS --> RUNQ
    TWCLASS --> WHISPERIF
    TWCLASS -.-> RESPONSE

    WHISPERIF --> CONFIGCHK
    WHISPERIF --> BINDING
    BINDING --> JSINTERFACE
    JSINTERFACE --> JSADAPTER

    JSINTERFACE --> ADDON
    ADDON --> STREAMING
    ADDON --> WHISPERMODEL

    WHISPERMODEL --> WHISPERCONFIG
    WHISPERMODEL --> WCPP

    WCPP --> GGML
    GGML --> GPU

    style TWCLASS fill:#e1f5ff
    style ADDON fill:#ffe1e1
    style WHISPERMODEL fill:#ffe1e1
    style WCPP fill:#e1ffe1
```

<details>
<summary>📊 LLM-Friendly: Layer Responsibilities</summary>

**Layer Breakdown:**

| Layer | Components | Responsibility | Language | Why This Layer |
|-------|------------|----------------|----------|----------------|
| 1. JavaScript API | TranscriptionWhispercpp, createJobHandler, exclusiveRunQueue | High-level API, config normalization, response lifecycle | JS | Ergonomic API for npm consumers |
| 2. Bridge | WhisperInterface, configChecker, binding.js | JS↔C++ communication, validation | JS wrapper | Lifecycle management, handle safety |
| 3. C++ Addon | JsInterface, JSAdapter, AddonJs, StreamingProcessor | Batch jobs, streaming sessions, config conversion | C++ | Performance, native integration |
| 4. Model | WhisperModel, WhisperConfig | Inference logic, parameter mapping | C++ | Direct whisper.cpp integration |
| 5. Backend | whisper.cpp, GGML | Audio processing, GPU kernels | C++ | Optimized inference |

**Data Flow Through Layers:**

| Direction | Path | Data Format | Transform |
|-----------|------|-------------|-----------|
| Input → | JS → Bridge → Addon | Uint8Array (PCM) | Pass audio bytes |
| Input → | Addon → Model | std::vector\<float\> | preprocessAudioData (s16le/f32le → float) |
| Input → | Model → whisper.cpp | float* + count | whisper_full() |
| Output ← | whisper.cpp → Model | segments | onNewSegment callback |
| Output ← | Model → Addon | Transcript struct | Queue output |
| Output ← | Addon → Bridge | JS array of objects | uv_async_send → jsOutputCallback |
| Output ← | Bridge → JS | {text, start, end, id} | Emit via response callback |

</details>

---

## Core Components

### JavaScript Components

#### **TranscriptionWhispercpp (index.js)**

**Responsibility:** Main API class, orchestrates model lifecycle, manages batch audio jobs and streaming sessions.

**Why JavaScript:**
- High-level API ergonomics for npm consumers
- Promise/async-await integration for streaming
- Configuration normalization and default-filling
- Local model path validation (`files.model`, optional `files.vadModel`)
- Response lifecycle via `createJobHandler`; batch calls serialized with `exclusiveRunQueue`

#### **WhisperInterface (whisper.js)**

**Responsibility:** JavaScript wrapper around native addon, manages handle lifecycle

**Why JavaScript:**
- Clean JavaScript API over raw C++ bindings
- Native handle lifecycle management (createInstance → destroyInstance)
- Error wrapping with `QvacErrorAddonWhisper` (codes 6001–6009)

#### **configChecker (configChecker.js)**

**Responsibility:** Whitelist-based parameter validation before crossing JS/C++ boundary

- Validates `whisperConfig`, `contextParams`, `miscConfig` sections exist
- Rejects unknown parameter keys against explicit whitelists
- Catches invalid configuration before any C++ allocation

### C++ Components

#### **WhisperModel (model-interface/WhisperModel.cpp)**

**Responsibility:** Core inference implementation wrapping whisper.cpp

**Why C++:**
- Direct integration with whisper.cpp C API
- Audio preprocessing (PCM conversion) at native speed
- Segment callback integration with whisper_full()
- Runtime statistics collection (timings, tokens, segments)

#### **AddonJs + streaming exports (addon/src/addon/AddonJs.hpp, binding.cpp)**

**Responsibility:** Native addon integration for batch transcription plus explicit streaming session functions.

**Why C++:**
- Provides `runJob`, `reload`, `cancel`, `destroyInstance`
- Exposes `startStreaming`, `appendStreamingAudio`, `endStreaming`, and streaming cancellation
- Manages streaming sessions via `StreamingProcessor` and session maps guarded by mutexes
- Output dispatching via uv_async

**Specialization:** Constructor takes `WhisperConfig`; callbacks marshal transcript segments and runtime stats to JS.

#### **JSAdapter (js-interface/JSAdapter.cpp)**

**Responsibility:** Converts JavaScript objects to C++ `WhisperConfig` struct

- Traverses JS object properties via `js.h` API
- Populates four variant maps: `whisperMainCfg`, `vadCfg`, `whisperContextCfg`, `miscConfig`
- Type conversion: JS boolean/number/string → `std::variant<monostate, int, double, string, bool>`

#### **WhisperConfig / WhisperHandlers (model-interface/WhisperConfig.cpp)**

**Responsibility:** Maps variant-based config to whisper.cpp parameter structs

- `toWhisperFullParams()`: variant maps → `whisper_full_params` with VAD
- `toWhisperContextParams()`: variant maps → `whisper_context_params` (model path, GPU settings)
- `toMiscConfig()`: variant maps → `MiscConfig` (caption mode, seed)
- Declarative handler maps enable adding new parameters without structural changes

---

## Bare Runtime Integration

### Communication Pattern

```mermaid
sequenceDiagram
    participant JS as JavaScript
    participant IF as WhisperInterface
    participant Bind as Native Binding
    participant Addon as AddonJs / StreamingProcessor
    participant Model as WhisperModel
    participant Whisper as whisper.cpp

    JS->>IF: run(audioStream)
    IF->>Bind: runJob({type:'audio', input:Uint8Array}) or appendStreamingAudio(session, chunk)
    Bind->>Bind: preprocessAudioData()
    Bind->>Addon: runJob(...) or stream append
    Addon->>Addon: Accept single job / update streaming session
    Bind-->>IF: accepted / session state
    IF-->>JS: QvacResponse

    Note over Addon: Processing Thread
    Addon->>Addon: Dequeue job
    Addon->>Addon: uv_async_send (JobStarted)

    loop For each audio chunk
        JS-->>IF: append({type:'audio', input:chunk})
        Bind->>Addon: appendStreamingAudio
        Addon->>Model: process(input)
        Model->>Whisper: whisper_full()
        Whisper-->>Model: onNewSegment callback
        Model->>Addon: outputCallback(segments)
        Addon->>Addon: Queue output [lock]
        Addon->>Addon: uv_async_send()
    end

    Note over Addon: UV async callback
    Addon->>Bind: jsOutputCallback()
    Bind->>IF: outputCb('output', jobId, segments)
    IF->>JS: Response emits segments
```

<details>
<summary>📊 LLM-Friendly: Thread Communication</summary>

**Thread Responsibilities:**

| Thread | Runs | Blocks On | Can Call |
|--------|------|-----------|----------|
| JavaScript | App code, callbacks | Nothing (event loop) | All JS, addon methods |
| Processing | Inference | model.process() | model.*, uv_async_send() |

**Synchronization Primitives:**

| Primitive | Purpose | Held Duration | Risk |
|-----------|---------|---------------|------|
| std::mutex | Protect job queue + output queue | <1ms | Low (brief) |
| std::condition_variable | Wake processing thread | N/A | None |
| uv_async_t | Wake JS thread | N/A | None |

**Thread Safety Rules:**

1. ✅ Call addon methods from any thread
2. ✅ Processing thread calls model methods
3. ❌ Don't call JS functions from C++ thread (use uv_async_send)
4. ❌ Don't call model methods from JS thread

</details>

---

# Architecture Decisions

## Decision 1: whisper.cpp as Inference Backend

<details>
<summary>⚡ TL;DR</summary>

**Chose:** whisper.cpp (GGML) for on-device speech-to-text  
**Why:** Optimized C++ Whisper implementation, broad hardware support, built-in VAD  
**Cost:** Pinned to specific version, tied to whisper.cpp release cadence

</details>

### Context

Need a performant, cross-platform speech-to-text engine that runs on-device without cloud dependencies, supporting:
- Multiple languages and Whisper model sizes
- GPU acceleration on diverse hardware
- Voice Activity Detection for production quality

### Decision

Use whisper.cpp (via vcpkg, pinned to v1.8.4.1) as the sole inference backend.

### Rationale

**Performance:**
- Highly optimized C/C++ implementation of OpenAI's Whisper model
- GGML format enables quantized models for reduced memory and faster inference on edge devices
- GPU acceleration via Metal (Apple) and Vulkan (cross-platform)

**Features:**
- Built-in Silero VAD integration (v1.7.x+) eliminates need for separate VAD pipeline
- Supports all Whisper model sizes (tiny through large-v3)
- Active open-source community with frequent releases

### Trade-offs
- ✅ Runs fully on-device — no network dependency at inference time
- ✅ Quantized models enable deployment on resource-constrained devices
- ❌ Tied to whisper.cpp release cadence for model and feature updates
- ❌ Pinned to v1.8.4.1 via vcpkg override — upgrading requires compatibility verification

---

## Decision 2: Bare Runtime over Node.js

See [inference-addon-cpp Decision 4: Why Bare Runtime](https://github.com/tetherto/qvac/blob/main/packages/inference-addon-cpp/docs/architecture.md#decision-4-why-bare-runtime) for rationale.

**Summary:** Mobile support (iOS/Android), lightweight, modern addon API via `js.h`. Core business logic remains runtime-agnostic.

---

## Decision 3: Shared Addon Framework (`inference-addon-cpp`)

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Shared C++ addon framework (`AddonJs` plus package-specific binding exports)
**Why:** Eliminate duplication of threading, job queues, state machines across inference packages  
**Cost:** Template specialization complexity, coordinated framework upgrades

</details>

### Context

Multiple inference packages (whisper, llama.cpp, NMT, embeddings) need the same C++ addon patterns: threading, job queues, state machines, output callbacks.

### Decision

Use the shared addon-cpp framework for lifecycle, callbacks, logging, cancellation, and model integration. Whisper adds package-specific binding exports for streaming sessions in addition to the standard `runJob` path.

### Rationale

**Code Reuse:**
- Eliminates duplication of threading, state management, and JS-bridge code
- Each package only implements its model and package-specific bridge/streaming logic.
- Bug fixes in the framework benefit all packages simultaneously

**Consistency:**
- Consistent addon lifecycle and output-event protocol across backends
- Same output event protocol (JobStarted, Output, JobEnded, Error)
- Same `uv_async_t` communication pattern to JS

### Trade-offs
- ✅ Consistent behavior and lifecycle across all inference backends
- ✅ Framework improvements benefit all packages
- ❌ Package-specific streaming exports still need focused integration tests

---

## Decision 4: Variant-Based Configuration Pipeline

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Multi-stage pipeline: JS Object → JSAdapter → WhisperConfig (variant maps) → WhisperHandlers → whisper.cpp structs  
**Why:** Decouple JS types from whisper.cpp types, declarative parameter mapping  
**Cost:** Indirection through variant maps, parameter names must stay in sync

</details>

### Context

whisper.cpp has numerous parameters across multiple C structs (`whisper_full_params`, `whisper_context_params`, `whisper_vad_params`). These must be configurable from JavaScript while keeping the C++ layer decoupled from JS types.

### Decision

Use a multi-stage configuration pipeline with variant-based intermediate representation and declarative handler maps.

### Rationale

**Extensibility:**
- Adding new whisper.cpp parameters requires only a new handler entry — no structural changes
- Four separate variant maps (`whisperMainCfg`, `vadCfg`, `whisperContextCfg`, `miscConfig`) mirror whisper.cpp's struct groupings
- `configChecker.js` provides early JS-side whitelist validation before crossing the bridge

**Decoupling:**
- `WhisperConfig` uses `std::map<string, variant>` — no dependency on `js.h` types
- `JSAdapter` handles all JS↔C++ type conversion in one place
- `WhisperHandlers` declaratively map variant keys to struct fields with validation

### Trade-offs
- ✅ New parameters exposed by adding a single handler entry + whitelist entry
- ✅ JS-side validation catches invalid parameters before any C++ allocation
- ❌ Indirection through variant maps adds complexity vs. direct struct population
- ❌ Parameter names must be kept in sync across `configChecker.js`, `JSAdapter`, and `WhisperHandlers`

---

## Decision 5: Silero VAD via whisper.cpp Built-in Support

<details>
<summary>⚡ TL;DR</summary>

**Chose:** whisper.cpp's built-in Silero VAD with an explicit caller-supplied VAD model path
**Why:** Single inference call, no IPC overhead, native integration  
**Cost:** Silero-only (not pluggable), requires separate VAD model file

</details>

### Context

Raw audio often contains silence, noise, or non-speech segments that degrade transcription quality and waste compute. Voice Activity Detection is needed to filter non-speech.

### Decision

Use whisper.cpp's built-in Silero VAD integration rather than a separate external VAD pipeline.

### Rationale

**Simplicity:**
- whisper.cpp v1.8.x integrates Silero VAD natively — no separate pre-processing pipeline needed
- VAD parameters are passed alongside transcription parameters in `whisper_full_params`
- Single model load path for both VAD and transcription

**Quality:**
- Significantly improves transcription accuracy
- Effectively required for production use

### Trade-offs
- ✅ Single inference call handles both VAD and transcription
- ✅ No inter-process communication overhead between VAD and STT
- ❌ Silero is the only supported VAD; not pluggable for alternative VAD models
- ❌ Requires a separate Silero VAD model file alongside the Whisper model

---

# Technical Debt

### 1. Streaming Session Lifecycle
**Status:** Active  
**Issue:** Streaming introduces session maps and mutex-protected state outside the simple batch `runJob` path.
**Root Cause:** Real-time transcription needs append/end/cancel operations that do not fit a single synchronous job payload.
**Plan:** Keep session cleanup and cancellation covered by integration tests, especially `startStreaming` / `appendStreamingAudio` / `endStreaming` / cancel flows.

---

**Related Document:**
- [data-flows-detailed.md](data-flows-detailed.md) - Detailed data flow diagrams and sequences

**Last Updated:** 2026-05-07
