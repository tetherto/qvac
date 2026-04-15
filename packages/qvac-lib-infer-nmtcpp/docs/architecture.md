# Architecture Documentation

**Package:** `@qvac/translation-nmtcpp` v0.3.7  
**Stack:** JavaScript, C++20, GGML, Bergamot, Bare Runtime, CMake, vcpkg  
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
- [Decision 1: GGML as Inference Backend](#decision-1-ggml-as-inference-backend-for-indictrans2)
- [Decision 2: Bare Runtime over Node.js](#decision-2-bare-runtime-over-nodejs)
- [Decision 3: Multiple NMT Backends](#decision-3-multiple-nmt-backends-ggml--bergamot)
- [Decision 4: SentencePiece Tokenization](#decision-4-sentencepiece-tokenization)
- [Decision 5: Queue-Based Inference via Addon Framework](#decision-5-queue-based-inference-via-addon-framework)

### Technical Debt
- [Legacy "Marian" Naming](#1-legacy-marian-naming)
- [Whisper.cpp as Indirect GGML Provider](#2-whispercpp-as-indirect-ggml-provider)
- [Overlay Ports Instead of Registry](#3-overlay-ports-instead-of-registry)

---

# Overview

## Purpose

Offline neural machine translation for QVAC-powered applications (mobile and desktop). Translates text between language pairs using multiple NMT backends, each optimized for different language families and performance profiles.

**Core value:**
- High-level JavaScript API for NMT inference
- Model distribution via registry or local files
- Multi-backend architecture (IndicTrans2, Bergamot)
- Batch translation support
- Pluggable model weight loaders

## Key Features

- **Multi-backend architecture:** GGML-based custom NMT (IndicTrans2) and Mozilla Bergamot
- **Cross-platform support:** macOS, iOS, Linux, Android, Windows
- **GPU acceleration:** via GGML backends (Metal on Apple, Vulkan on others)
- **Beam search decoding** with configurable beam size, length penalty, and repetition control
- **SentencePiece tokenization** for subword segmentation
- **Batch translation** (Bergamot backend) for high-throughput scenarios
- **Model distribution** via registry or local files
- **Queue-based inference** with pause/cancel/resume support

## Target Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan |

**Dependencies:**
- qvac-lib-inference-addon-cpp (≥0.12.2): C++ addon framework
- ggml (vcpkg): Tensor computation and GPU backends
- sentencepiece (vcpkg): Subword tokenization
- bergamot-translator (vcpkg, optional): Mozilla Bergamot translation engine
- Bare Runtime (≥1.19.0): JavaScript runtime

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
        NMT["translation-nmtcpp<br/>NMT"]
        LLM["llm-llamacpp<br/>LLMs"]
        EMBED["embed-llamacpp<br/>Embeddings"]
        WHISPER["whispercpp<br/>STT"]
    end

    subgraph "core libs"
        BASE["@qvac/infer-base"]
        DL["@qvac/registry-client"]
    end

    subgraph "Native Framework"
        ADDON["addon-cpp"]
    end

    subgraph "Backend"
        BARE["Bare Runtime"]
        GGML_LIB["ggml"]
        BERGAMOT_LIB["bergamot-translator"]
    end

    APP --> NMT
    NMT --> BASE
    NMT --> DL
    NMT --> ADDON
    ADDON --> BARE
    ADDON --> GGML_LIB
    ADDON --> BERGAMOT_LIB

    style NMT fill:#f9f,stroke:#333,stroke-width:3px
```

<details>
<summary>📊 LLM-Friendly: Package Relationships</summary>

**Dependency Table:**

| Package | Type | Version | Purpose |
|---------|------|---------|---------|
| @qvac/infer-base | Framework | ^0.2.0 | Base classes, WeightsProvider, QvacResponse |
| @qvac/registry-client | Framework | ^0.1.0 | Model distribution |
| qvac-lib-inference-addon-cpp | Native | ≥0.12.2 | C++ addon framework (threading, job queue, JS interop) |
| ggml | Native | (vcpkg) | Tensor computation and GPU backends |
| sentencepiece | Native | (vcpkg) | Subword tokenization |
| protobuf | Native | (vcpkg) | SentencePiece model serialization |
| bergamot-translator | Native | (vcpkg, optional) | Mozilla Bergamot translation engine |
| Bare Runtime | Runtime | ≥1.19.0 | JavaScript execution |

**Integration Points:**

| From | To | Mechanism | Data Format |
|------|----|-----------|-------------|
| JavaScript | TranslationNmtcpp | Constructor | args, config objects |
| TranslationNmtcpp | BaseInference | Inheritance | Template method pattern |
| TranslationNmtcpp | TranslationInterface | Composition | Method calls |
| TranslationInterface | C++ Addon | require.addon() | Native binding |
| WeightsProvider | Data Loader | Interface | Stream protocol |

</details>

---

## Public API

### Main Class: TranslationNmtcpp

```mermaid
classDiagram
    class TranslationNmtcpp {
        +ModelTypes$ : Object
        +constructor(args, config)
        +load(close?, reportProgressCallback?) Promise~void~
        +run(input: string) Promise~QvacResponse~
        +runBatch(texts: string[]) Promise~string[]~
        +unload() Promise~void~
    }

    class ModelTypes {
        +IndicTrans : "IndicTrans"
        +Bergamot : "Bergamot"
    }

    class TranslationInterface {
        -_handle : native
        +activate() Promise~void~
        +append(data) Promise~number~
        +pause() Promise~void~
        +cancel(jobId) Promise~void~
        +stop() Promise~void~
        +unload() Promise~void~
        +processBatch(texts) Promise~string[]~
        +destroy() Promise~void~
    }

    class BaseInference {
        <<abstract>>
        +load()
        +run()
        +unload()
    }

    class QvacResponse {
        +onUpdate(callback)
        +onFinish(callback)
        +onCancel(callback)
        +onError(callback)
        +iterate()
    }

    class WeightsProvider {
        +downloadFiles(files, path, opts) Promise~void~
    }

    TranslationNmtcpp --|> BaseInference
    TranslationNmtcpp *-- WeightsProvider
    TranslationNmtcpp --> TranslationInterface : creates
    TranslationNmtcpp --> ModelTypes
    TranslationNmtcpp ..> QvacResponse : creates
```

<details>
<summary>📊 LLM-Friendly: Class Responsibilities</summary>

**Component Roles:**

| Class | Responsibility | Lifecycle | Dependencies |
|-------|---------------|-----------|--------------|
| TranslationNmtcpp | Orchestrate model lifecycle, manage loading/inference | Created by user, persistent | WeightsProvider, TranslationInterface |
| BaseInference | Define standard inference API | Abstract base class | None |
| QvacResponse | Stream inference output | Created per run() call, short-lived | None |
| WeightsProvider | Abstract model weight loading | Created by TranslationNmtcpp | DataLoader |

**Key Relationships:**

| From | To | Type | Purpose |
|------|----|------|---------|
| TranslationNmtcpp | BaseInference | Inheritance | Standard QVAC inference API |
| TranslationNmtcpp | WeightsProvider | Composition | Model weight acquisition |
| TranslationNmtcpp | TranslationInterface | Composition | Native addon operations |
| TranslationNmtcpp | QvacResponse | Creates | Streaming output per inference |

</details>

---

## Internal Architecture

### Architectural Pattern

The package follows a **layered architecture** with clear separation of concerns:

```mermaid
graph TB
    subgraph "Layer 1: JavaScript API"
        APP["Application Code"]
        NMTCPP["TranslationNmtcpp<br/>(index.js)"]
        BASEINF["BaseInference<br/>(@qvac/infer-base)"]
        WEIGHTSPR["WeightsProvider<br/>(@qvac/infer-base)"]
        RESPONSE["QvacResponse / QvacIndicTransResponse"]
    end

    subgraph "Layer 2: Bridge"
        TRANS_IF["TranslationInterface<br/>(marian.js)"]
        BINDING_JS["require.addon<br/>(binding.js)"]
    end

    subgraph "Layer 3: C++ Addon"
        BINDING_CPP["JsInterface<br/>(binding.cpp)"]
        ADDON["Addon&lt;TranslationModel&gt;<br/>(Addon.cpp)"]
    end

    subgraph "Layer 4: Model"
        TMODEL["TranslationModel<br/>(TranslationModel.cpp)"]
    end

    subgraph "Layer 5a: GGML Backend"
        NMT["nmt pipeline<br/>(nmt.cpp)"]
        LOADER["nmt_loader"]
        ENCODER["nmt_graph_encoder"]
        DECODER["nmt_graph_decoder"]
        BEAM["nmt_beam_search"]
        TOKENIZE["nmt_tokenization"]
        STATE["nmt_state_backend"]
    end

    subgraph "Layer 5b: Bergamot Backend"
        BERG["bergamot wrapper<br/>(bergamot.cpp)"]
    end

    subgraph "Layer 6: Native Libraries"
        GGML["ggml"]
        SPM["sentencepiece"]
        BERG_LIB["bergamot-translator"]
    end

    APP --> NMTCPP
    NMTCPP --> BASEINF
    NMTCPP --> WEIGHTSPR
    NMTCPP --> TRANS_IF
    NMTCPP -.-> RESPONSE

    TRANS_IF --> BINDING_JS
    BINDING_JS --> BINDING_CPP

    BINDING_CPP --> ADDON
    ADDON --> TMODEL

    TMODEL --> NMT
    TMODEL --> BERG
    NMT --> LOADER
    NMT --> ENCODER
    NMT --> DECODER
    NMT --> BEAM
    NMT --> TOKENIZE
    NMT --> STATE

    ENCODER --> GGML
    DECODER --> GGML
    STATE --> GGML
    TOKENIZE --> SPM
    BERG --> BERG_LIB

    style NMTCPP fill:#e1f5ff
    style ADDON fill:#ffe1e1
    style TMODEL fill:#ffe1e1
    style GGML fill:#e1ffe1
```

<details>
<summary>📊 LLM-Friendly: Layer Responsibilities</summary>

**Layer Breakdown:**

| Layer | Components | Responsibility | Language | Why This Layer |
|-------|-----------|---------------|----------|----------------|
| 1. JavaScript API | TranslationNmtcpp, BaseInference | High-level API, error handling | JS | Ergonomic API for npm consumers |
| 2. Bridge | TranslationInterface, binding.js | JS↔C++ communication | JS wrapper | Lifecycle management, handle safety |
| 3. C++ Addon | JsInterface, Addon\<T\> | Job queue, threading, callbacks | C++ | Performance, native integration |
| 4. Model | TranslationModel | Backend detection and dispatch | C++ | Multi-backend routing |
| 5a. GGML Backend | nmt_* modules | Custom encoder-decoder with beam search | C++ | IndicTrans2 inference |
| 5b. Bergamot Backend | bergamot wrapper | Bergamot translator integration | C++ | Batch-optimized translation |
| 6. Native Libraries | ggml, sentencepiece, bergamot | Tensor ops, tokenization, translation | C++ | Optimized inference |

**Data Flow Through Layers:**

| Direction | Path | Data Format | Transform |
|-----------|------|-------------|-----------|
| Input → | JS → Bridge → Addon | string | Pass input text |
| Input → | Addon → Model | std::string | Route to backend |
| Input → | Model → nmt_* | tokens | SentencePiece tokenize |
| Output ← | nmt_* → Model | token IDs | Beam search → detokenize |
| Output ← | Model → Addon | UTF-8 string | Queue output |
| Output ← | Addon → Bridge → JS | string | Emit via callback |

</details>

---

## Core Components

### JavaScript Components

#### **TranslationNmtcpp (index.js)**

**Responsibility:** Main API class, orchestrates model lifecycle, manages data loaders, routes to correct backend

**Why JavaScript:**
- High-level API ergonomics for npm consumers
- Promise/async-await integration
- IndicTrans pre/post-processing via third-party JS module
- Configuration parsing

#### **TranslationInterface (marian.js)**

**Responsibility:** JavaScript wrapper around native addon, manages handle lifecycle

**Why JavaScript:**
- Clean JavaScript API over raw C++ bindings
- Native handle lifecycle management
- Logger bridge (C++ → JS)
- Type conversion between JS and native

#### **QvacIndicTransResponse (index.js)**

**Responsibility:** IndicTrans-specific response with pre/post-processing via `IndicProcessor`

**Why JavaScript:**
- Script normalization/denormalization is text processing, not performance-critical
- Leverages existing third-party IndicProcessor JS module

### C++ Components

#### **TranslationModel (model-interface/TranslationModel.cpp)**

**Responsibility:** High-level model: backend detection (GGML vs Bergamot), config management, dispatch

**Why C++:**
- Direct integration with both GGML and Bergamot C/C++ APIs
- Backend auto-detection from model file format
- Unified process() interface over heterogeneous backends

#### **Addon\<TranslationModel\> (addon/Addon.cpp)**

**Responsibility:** Template specialization of addon framework

**Why C++:**
- Provides job queue and priority scheduling
- Dedicated processing thread
- Thread-safe state machine
- Output dispatching via uv_async
- Batch processing helper functions

#### **nmt_context / nmt_* (model-interface/nmt*.cpp)**

**Responsibility:** GGML-based NMT: encode, decode, full translation pipeline

**Why C++:**
- Performance-critical inference loop (encoder/decoder graphs)
- Direct GGML tensor operations
- Beam search with KV cache management
- SentencePiece integration for tokenization

**Key structures:** `nmt_context`, `nmt_model`, `nmt_state`, `nmt_vocab`, `nmt_config`, `nmt_kv_cache`

#### **bergamot_context (model-interface/bergamot.cpp)**

**Responsibility:** Bergamot wrapper: init, translate, batch translate, runtime stats

**Why C++:**
- Wraps Mozilla bergamot-translator C++ library
- Exposes single and batch translation
- Manages BlockingService and TranslationModel lifecycle

#### **WeightsProvider (@qvac/infer-base)**

**Responsibility:** Abstracts model weight acquisition

**Why JavaScript:**
- Integrates with data loaders (registry, filesystem)
- Progress tracking and reporting
- Handles multi-file downloads (model + vocabularies)

---

## Bare Runtime Integration

### Communication Pattern

```mermaid
sequenceDiagram
    participant JS as JavaScript
    participant IF as TranslationInterface
    participant Bind as Native Binding
    participant Addon as Addon<TranslationModel>
    participant Model as TranslationModel
    participant Backend as GGML / Bergamot

    JS->>IF: run(input)
    IF->>Bind: append({type:'text', input})
    Bind->>Addon: append() [lock mutex]
    Addon->>Addon: Enqueue job
    Addon->>Addon: cv.notify_one()
    Bind-->>IF: jobId
    IF-->>JS: QvacResponse

    Note over Addon: Processing Thread
    Addon->>Addon: Dequeue job
    Addon->>Addon: uv_async_send (JobStarted)

    Addon->>Model: process(input)
    Model->>Backend: encode → decode → beam search
    Backend-->>Model: translated text
    Model->>Addon: outputCallback(translation)
    Addon->>Addon: Queue output [lock]
    Addon->>Addon: uv_async_send()

    Note over Addon: UV async callback
    Addon->>Bind: jsOutputCallback()
    Bind->>IF: outputCb('Output', jobId, translation)
    IF->>JS: Response emits translation
```

<details>
<summary>📊 LLM-Friendly: Thread Communication</summary>

**Thread Responsibilities:**

| Thread | Runs | Blocks On | Can Call |
|--------|------|-----------|---------|
| JavaScript | App code, callbacks | Nothing (event loop) | All JS, addon methods |
| Processing | Inference | model.process() | model.*, uv_async_send() |

**Synchronization Primitives:**

| Primitive | Purpose | Held Duration | Risk |
|-----------|---------|--------------|------|
| std::mutex | Protect job queue | <1ms | Low (brief) |
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

## Decision 1: GGML as Inference Backend for IndicTrans2

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Custom encoder-decoder on GGML for lightweight cross-platform inference  
**Why:** Cross-platform portability, quantization support, no heavy dependencies  
**Cost:** Custom encoder/decoder graphs require maintenance

</details>

### Context

Needed to run NMT models on mobile devices (iOS, Android) and desktop without heavy ML framework dependencies.

### Decision

Implemented a custom encoder-decoder inference engine on top of GGML tensors, with hand-built computation graphs for self-attention, cross-attention, FFN, and beam search.

### Rationale

**Portability:**
- GGML provides cross-platform tensor operations with minimal dependencies
- Supports multiple GPU backends (Metal, Vulkan) through a unified API
- No dependency on Python, CUDA, or heavy ML frameworks

**Efficiency:**
- Enables model quantization for reduced memory footprint on mobile
- Single dependency (ggml) for all tensor computation

### Trade-offs
- ✅ Runs on all target platforms including iOS and Android
- ✅ Quantization support reduces model size significantly
- ✅ Single dependency (ggml) for all tensor computation
- ❌ Custom encoder/decoder graphs require maintenance when model architectures evolve
- ❌ Performance tuning must be done manually per-platform

---

## Decision 2: Bare Runtime over Node.js

See [qvac-lib-inference-addon-cpp Decision 4: Why Bare Runtime](https://github.com/tetherto/qvac-lib-inference-addon-cpp/blob/main/docs/architecture.md#decision-4-why-bare-runtime) for rationale.

**Summary:** Mobile support (iOS/Android), lightweight, modern addon API. Core business logic remains runtime-agnostic.

---

## Decision 3: Multiple NMT Backends (GGML + Bergamot)

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Two backends behind a unified API  
**Why:** Different language families need different model architectures and optimizations  
**Cost:** Two backends to build, test, and maintain

</details>

### Context

Different language families require different model architectures. Indic languages are served by IndicTrans2, and some use cases benefit from Mozilla's Bergamot for batch throughput.

### Decision

Support two model types behind a unified `TranslationNmtcpp` API, with backend auto-detection based on model file format.

### Rationale

**Language Coverage:**
- IndicTrans2: purpose-built for Indic languages with specialized pre/post-processing
- Bergamot: mature, production-tested engine with batch translation support

**Unified API:**
- Consumers use the same `load()` / `run()` / `runBatch()` regardless of backend
- Backend selection is transparent via `ModelTypes` enum

### Trade-offs
- ✅ Best-in-class translation for each language family
- ✅ Unified API hides backend complexity from consumers
- ❌ Two backends to build, test, and maintain
- ❌ Different model formats and loading paths increase code complexity

---

## Decision 4: SentencePiece Tokenization

<details>
<summary>⚡ TL;DR</summary>

**Chose:** SentencePiece library for tokenization  
**Why:** Standard tokenizer used by IndicTrans2 model authors  
**Cost:** Additional native dependency (protobuf required)

</details>

### Context

NMT models require subword tokenization. IndicTrans2 models ship with SentencePiece vocabulary files.

### Decision

Use the SentencePiece library for tokenization and detokenization, loading vocabulary from model files or separate `.spm` files.

### Rationale

**Compatibility:**
- Standard tokenizer used by IndicTrans2 model authors
- Handles both source and target vocabularies with a unified API
- Integrates cleanly with GGML model loading

### Trade-offs
- ✅ Direct compatibility with upstream model vocabularies
- ✅ Battle-tested library with broad language support
- ❌ Requires protobuf as transitive dependency
- ❌ Bergamot bundles its own SentencePiece, requiring careful linking

---

## Decision 5: Queue-Based Inference via Addon Framework

<details>
<summary>⚡ TL;DR</summary>

**Chose:** `qvac-lib-inference-addon-cpp`'s `Addon<T>` template  
**Why:** Proven pattern used by all QVAC inference addons, handles threading and lifecycle  
**Cost:** Template complexity, indirect control over processing thread

</details>

### Context

Translation requests arrive from the JavaScript thread but inference must run on a separate C++ thread to avoid blocking the event loop.

### Decision

Use `qvac-lib-inference-addon-cpp`'s `Addon<T>` template, which provides a job queue, worker thread, and callback mechanism for communicating results back to JavaScript.

### Rationale

**Proven Pattern:**
- Used by all QVAC inference addons (LLM, embeddings, STT)
- Handles thread synchronization, lifecycle management, and error propagation
- Supports pause/cancel/resume out of the box

**Consistency:**
- Same addon patterns across all inference packages
- Shared C++ framework reduces code duplication

### Trade-offs
- ✅ Battle-tested threading and lifecycle management
- ✅ Consistent patterns across QVAC inference addons
- ❌ One request at a time per model instance (exclusive run queue)
- ❌ Template metaprogramming adds build complexity

---

# Technical Debt

### 1. Legacy "Marian" Naming
**Status:** Present throughout codebase  
**Issue:** `marian.js`, `QvacErrorAddonMarian`, namespace `qvac_lib_inference_addon_mlc_marian` predate multi-backend architecture  
**Root Cause:** Renaming requires coordinated changes across JS, C++, and consumer packages  
**Plan:** Rename in a dedicated refactoring PR — `marian.js` → `translationInterface.js`, `QvacErrorAddonMarian` → `QvacErrorTranslation`, namespace → `qvac_lib_infer_nmtcpp`

### 2. Whisper.cpp as Indirect GGML Provider
**Status:** Active dependency — `whisper-cpp` is declared in `vcpkg.json` and built via a custom overlay port with multiple patches  
**Issue:** The package depends on `whisper-cpp` solely to obtain the `ggml` library it bundles as a submodule. No whisper.cpp APIs are used anywhere in the codebase. This adds unnecessary build complexity, overlay maintenance (build patches, cross-compile fixes), and a confusing dependency chain for contributors  
**Root Cause:** The package originally used MLC-LLM (as a git submodule) for its translation backend. In July 2025, MLC-LLM was removed and `whisper-cpp` was added to `vcpkg.json` as the vehicle to obtain a vcpkg-installable `ggml`.
**Plan:** Migrate to a standalone `ggml` vcpkg port, remove the `whisper-cpp` overlay port and its associated patches (`0001-fix-vcpkg-build.patch`, `0002-fix-apple-silicon-cross-compile.patch`), and update `vcpkg.json` to depend on `ggml` directly

### 3. Overlay Ports Instead of Registry
**Status:** 7 local overlay ports in `vcpkg-overlays/` — `whisper-cpp`, `bergamot-translator`, `marian-dev`, `ssplit`, `intgemm`, `ruy`, `simd-utils`  
**Issue:** Dependencies are maintained as local overlay ports with custom portfiles and patches instead of being published to `qvac-registry-vcpkg`. This duplicates port maintenance into the package itself, makes dependency updates error-prone, and diverges from the pattern already adopted by other inference packages (e.g. `qvac-lib-infer-whispercpp` migrated to the registry in `94bcdfc` — July 2025)  
**Root Cause:** The Bergamot backend was originally built from deeply nested git submodules (`bergamot-translator` → `marian-dev` → `intgemm`, `ruy`, `simd-utils`, `ssplit`). When the package migrated to vcpkg, these submodule trees were converted to local overlay ports to unblock the build, but were never promoted to the shared registry  
**Plan:** Publish all overlay ports to `qvac-registry-vcpkg`, remove the `vcpkg-overlays/` directory, and update `vcpkg-configuration.json` to resolve all dependencies from the registry. This can be done incrementally — `whisper-cpp` removal is covered by item #2, and the Bergamot chain (`bergamot-translator`, `marian-dev`, `ssplit`, `intgemm`, `ruy`, `simd-utils`) can be migrated as a group

---

**Related Document:**
- [data-flows-detailed.md](data-flows-detailed.md) - Detailed data flow diagrams and sequences

**Last Updated:** 2026-02-12
