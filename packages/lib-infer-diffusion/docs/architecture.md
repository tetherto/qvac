# Architecture Documentation

**Package:** `@qvac/img-stable-diffusion-cpp` v0.1.0  
**Stack:** JavaScript, C++20, stable-diffusion.cpp, Bare Runtime, CMake, vcpkg  
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
- [Decision 1: stable-diffusion.cpp as Inference Backend](#decision-1-stable-diffusioncpp-as-inference-backend)
- [Decision 2: Bare Runtime over Node.js](#decision-2-bare-runtime-over-nodejs)
- [Decision 3: Disk-Local Model Files](#decision-3-disk-local-model-files)
- [Decision 4: Direct File Path Loading](#decision-4-direct-file-path-loading)
- [Decision 5: Generation Parameters Format](#decision-5-generation-parameters-format-json-serialization)
- [Decision 6: Exclusive Run Queue](#decision-6-exclusive-run-queue-indexjs)
- [Decision 7: TypeScript Definitions](#decision-7-typescript-definitions)

### Technical Debt
- [Limited Error Context](#1-limited-error-context)

---

# Overview

## Purpose

`@qvac/img-stable-diffusion-cpp` is a cross-platform npm package providing diffusion model inference for Bare runtime applications. It wraps stable-diffusion.cpp in a JavaScript-friendly API, enabling local image and video generation on desktop and mobile with CPU/GPU acceleration.

**Core value:**
- High-level JavaScript API for diffusion model inference
- Progress callback during generation steps
- Text-to-image and image-to-image generation via single `run()` API
- Disk-local model files (no download/streaming layer)

## Key Features

- **Cross-platform**: macOS, Linux, Windows, iOS, Android
- **Disk-local models**: Files must be present on disk at `diskPath`
- **Progress tracking**: Step-by-step generation progress callbacks
- **GPU acceleration**: Metal, Vulkan, CUDA, OpenCL
- **Quantized models**: GGUF, safetensors, checkpoint formats
- **Diffusion models**: SD1.x, SD2.x, SDXL, SD3, FLUX.2 [klein]
- **Generation modes**: txt2img, img2img (auto-detected via `init_image` parameter)

## Target Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan, CUDA |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan, CUDA |

**Dependencies:**
- qvac-lib-inference-addon-cpp (≥1.1.2): C++ addon framework (single-job runner, runJob/activate/cancel/destroyInstance)
- stable-diffusion.cpp: Diffusion inference engine
- Bare Runtime (≥1.24.0): JavaScript runtime
- Ubuntu-22 requires g++-13 installed

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
        IMG[img-stable-diffusion-cpp<br/>Image/Video Gen]
        LLM[llm-llamacpp<br/>LLMs]
        EMBED[embed-llamacpp<br/>Embeddings]
        WHISPER[whispercpp<br/>STT]
    end
    
    subgraph "core libs"
        BASE["@qvac/infer-base"]
    end
    
    subgraph "Native Framework"
        ADDON[addon-cpp]
    end
    
    subgraph "Backend"
        BARE[Bare Runtime]
        SDCPP[stable-diffusion.cpp]
    end
    
    APP --> IMG
    IMG --> BASE
    IMG --> ADDON
    ADDON --> BARE
    ADDON --> SDCPP
    
    style IMG fill:#e1f5ff,stroke:#0066cc,stroke-width:3px
```

<details>
<summary>📊 LLM-Friendly: Package Relationships</summary>

**Dependency Table:**

| Package | Type | Version | Purpose |
|---------|------|---------|---------|
| @qvac/infer-base | Framework | ^0.2.0 | Base classes (BaseInference, QvacResponse) |
| qvac-lib-inference-addon-cpp | Native | ≥1.1.1 | C++ addon framework (single-job runner) |
| stable-diffusion.cpp | Native | latest | Diffusion inference engine |
| Bare Runtime | Runtime | ≥1.24.0 | JavaScript execution |

**Integration Points:**

| From | To | Mechanism | Data Format |
|------|-----|-----------|-------------|
| JavaScript | ImgStableDiffusion | Constructor | args, config objects |
| ImgStableDiffusion | BaseInference | Inheritance | Template method pattern |
| ImgStableDiffusion | SdInterface | Composition | Method calls |
| SdInterface | C++ Addon | require.addon() | Native binding |

</details>

---

## Public API

### Main Class: ImgStableDiffusion

```mermaid
classDiagram
    class ImgStableDiffusion {
        +constructor(args, config)
        +load() Promise~void~
        +run(params: GenerationParams) Promise~QvacResponse~
        +cancel() Promise~void~
        +unload() Promise~void~
    }

    class BaseInference {
        <<abstract>>
        +load() Promise~void~
        +run() Promise~QvacResponse~
        +unload() Promise~void~
        #_runInternal() Promise~QvacResponse~
        #_withExclusiveRun(fn) Promise~any~
    }

    class QvacResponse {
        +onUpdate(callback) QvacResponse
        +await() Promise~void~
        +cancel() Promise~void~
    }

    ImgStableDiffusion --|> BaseInference
    ImgStableDiffusion ..> QvacResponse : creates
```

<details>
<summary>📊 LLM-Friendly: Class Responsibilities</summary>

**Component Roles:**

| Class | Responsibility | Lifecycle | Dependencies |
|-------|----------------|-----------|--------------|
| ImgStableDiffusion | Orchestrate model lifecycle, manage loading/inference | Created by user, persistent | SdInterface |
| BaseInference | Define standard inference API (template method pattern) | Abstract base class | None |
| QvacResponse | Handle generation progress and result | Created per `run()` call | None |

**Key Relationships:**

| From | To | Type | Purpose |
|------|-----|------|---------|
| ImgStableDiffusion | BaseInference | Inheritance | Standard QVAC inference API |
| ImgStableDiffusion | QvacResponse | Creates | Progress/result per generation |

</details>

---

## Internal Architecture

### Architectural Pattern

The package follows a **layered architecture** with clear separation of concerns:

```mermaid
graph TB
    subgraph "Layer 1: JavaScript API"
        APP["Application Code"]
        IMGCLASS["ImgStableDiffusion<br/>(index.js)"]
        BASEINF["BaseInference<br/>(@qvac/infer-base)"]
        RESPONSE["QvacResponse"]
    end
    
    subgraph "Layer 2: Bridge"
        SDIF["SdInterface<br/>(addon.js)"]
        BINDING["require.addon<br/>(binding.js)"]
    end
    
    subgraph "Layer 3: C++ Addon"
        JSINTERFACE["JsInterface<br/>(addon-cpp JsInterface)"]
        ADDONCPP["AddonCpp / AddonJs<br/>(addon-cpp + addon/AddonJs.hpp)"]
    end
    
    subgraph "Layer 4: Model"
        SDMODEL["SdModel<br/>(model-interface/SdModel.cpp)"]
        TXT2IMG["Txt2ImgContext<br/>(model-interface/Txt2ImgContext.cpp)"]
        IMG2IMG["Img2ImgContext<br/>(model-interface/Img2ImgContext.cpp)"]
        VIDGEN["VideoGenContext<br/>(model-interface/VideoGenContext.cpp)"]
    end
    
    subgraph "Layer 5: Backend"
        SDCPP["stable-diffusion.cpp"]
        GGML["GGML"]
        GPU["GPU Backends<br/>(Metal/Vulkan/CUDA/OpenCL)"]
    end
    
    APP --> IMGCLASS
    IMGCLASS --> BASEINF
    IMGCLASS --> SDIF
    IMGCLASS -.-> RESPONSE

    SDIF --> BINDING
    BINDING --> JSINTERFACE

    JSINTERFACE --> ADDONCPP
    ADDONCPP --> SDMODEL
    
    SDMODEL --> TXT2IMG
    SDMODEL --> IMG2IMG
    SDMODEL --> VIDGEN
    TXT2IMG --> SDCPP
    IMG2IMG --> SDCPP
    VIDGEN --> SDCPP
    
    SDCPP --> GGML
    GGML --> GPU
    
    style IMGCLASS fill:#e1f5ff
    style ADDONCPP fill:#ffe1e1
    style SDMODEL fill:#ffe1e1
    style SDCPP fill:#e1ffe1
```

<details>
<summary>📊 LLM-Friendly: Layer Responsibilities</summary>

**Layer Breakdown:**

| Layer | Components | Responsibility | Language | Why This Layer |
|-------|------------|----------------|----------|----------------|
| 1. JavaScript API | ImgStableDiffusion, BaseInference, QvacResponse | High-level API, error handling | JS | Ergonomic API for npm consumers |
| 2. Bridge | SdInterface, binding.js | JS↔C++ communication | JS wrapper | Lifecycle management, handle safety |
| 3. C++ Addon | JsInterface, AddonCpp/AddonJs | Single-job runner, threading, callbacks | C++ | Performance, native integration |
| 4. Model | SdModel, Contexts | Diffusion logic, sampling | C++ | Direct stable-diffusion.cpp integration |
| 5. Backend | stable-diffusion.cpp, GGML | Tensor ops, GPU kernels | C++ | Optimized inference |

**Data Flow Through Layers:**

| Direction | Path | Data Format | Transform |
|-----------|------|-------------|-----------|
| Input → | JS → Bridge → Addon | JSON params | Serialize generation params |
| Input → | Addon → Model | parsed params | Parse JSON, configure sampler |
| Input → | Model → SD.cpp | latent tensors | Encode prompt, prepare latents |
| Output ← | SD.cpp → Model | latent tensors | Denoise step |
| Output ← | Model → Addon | step progress | Report progress |
| Output ← | Addon → Bridge | progress/image | Queue output |
| Output ← | Bridge → JS | Uint8Array (PNG) | Emit via callback |

</details>

---

## Core Components

### JavaScript Components

#### **ImgStableDiffusion (index.js)**

**Responsibility:** Main API class, orchestrates model lifecycle and inference

**Why JavaScript:**
- High-level API ergonomics for npm consumers
- Promise/async-await integration
- Event loop integration for progress callbacks
- Configuration parsing

#### **SdInterface (addon.js)**

**Responsibility:** JavaScript wrapper around native addon, manages handle lifecycle

**Why JavaScript:**
- Clean JavaScript API over raw C++ bindings
- Native handle lifecycle management
- Type conversion between JS and native

### C++ Components

#### **SdModel (model-interface/SdModel.cpp)**

**Responsibility:** Core diffusion implementation wrapping stable-diffusion.cpp

**Why C++:**
- Direct integration with stable-diffusion.cpp C API
- Performance-critical diffusion loop
- Memory-efficient tensor processing
- Native GPU backend access

#### **AddonCpp / AddonJs (addon-cpp + addon/AddonJs.hpp)**

**Responsibility:** Addon-cpp framework integration; IMG addon provides createInstance and runJob over JsInterface

**Why C++:**
- Single-job runner (one job at a time, runJob returns boolean accepted)
- Dedicated processing thread via addon-cpp JobRunner
- Thread-safe job submission and cancellation (IModelCancel)
- Output dispatching via uv_async

**IMG specialization:** createInstance builds SdModel with config; runJob parses generation params (prompt, negative_prompt, cfg_scale, steps, etc.)

#### **BackendSelection (utils/BackendSelection.cpp)**

**Responsibility:** GPU backend selection at runtime

- Selects between CPU, Metal, Vulkan, CUDA, and OpenCL backends at runtime
- Metal compiled statically on macOS/iOS
- CUDA available on Linux/Windows with NVIDIA GPUs
- Vulkan as cross-platform fallback
- OpenCL for Adreno GPUs on Android

#### **SamplerManager (model-interface/SamplerManager.cpp)**

**Responsibility:** Manages diffusion sampling methods

- Supports multiple samplers: Euler, Euler A, Heun, DPM2, DPM++ 2M, DPM++ 2S a, LCM
- Configurable CFG scale, steps, seed
- Scheduler selection (Karras, linear, etc.)

#### **LoraManager (model-interface/LoraManager.cpp)**

**Responsibility:** LoRA weight loading and application

- Loads LoRA weights from safetensors/GGUF
- Applies LoRA to UNet and text encoder
- Supports multiple simultaneous LoRAs with configurable weights

---

## Bare Runtime Integration

### Communication Pattern

```mermaid
sequenceDiagram
    participant JS as JavaScript
    participant IF as SdInterface
    participant Bind as Native Binding
    participant Addon as AddonCpp/AddonJs
    participant Model as SdModel
    participant SD as stable-diffusion.cpp
    
    JS->>IF: run(params)
    IF->>Bind: runJob(handle, paramsJson)
    Bind->>Addon: runJob(params) [lock mutex]
    Addon->>Addon: Set job input
    Addon->>Addon: cv.notify_one()
    Bind-->>IF: accepted (boolean)
    IF-->>JS: QvacResponse
    
    Note over Addon: Processing Thread
    Addon->>Addon: Take job
    Addon->>Addon: uv_async_send (JobStarted)
    
    loop For each diffusion step
        Addon->>Model: process(params)
        Model->>SD: sd_txt2img_step()
        SD-->>Model: latents
        Model->>Addon: progressCallback(step, total)
        Addon->>Addon: Queue progress [lock]
        Addon->>Addon: uv_async_send()
    end
    
    Model->>SD: vae_decode()
    SD-->>Model: pixel_data
    Model->>Addon: outputCallback(image_data)
    
    Note over Addon: UV async callback
    Addon->>Bind: jsOutputCallback()
    Bind->>IF: outputCb('Output', jobId, image)
    IF->>JS: Response emits image
```

<details>
<summary>📊 LLM-Friendly: Thread Communication</summary>

**Thread Responsibilities:**

| Thread | Runs | Blocks On | Can Call |
|--------|------|-----------|----------|
| JavaScript | App code, callbacks | Nothing (event loop) | All JS, addon methods |
| Processing | Diffusion steps | model.process() | model.*, uv_async_send() |

**Synchronization Primitives:**

| Primitive | Purpose | Held Duration | Risk |
|-----------|---------|---------------|------|
| std::mutex | Protect single job state | <1ms | Low (brief) |
| std::condition_variable | Wake processing thread | N/A | None |
| uv_async_t | Wake JS thread | N/A | None |

**Thread Safety Rules:**

1. ✅ Call addon methods from any thread (runJob, cancel, activate, destroyInstance)
2. ✅ Processing thread calls model methods
3. ❌ Don't call JS functions from C++ thread (use uv_async_send)
4. ❌ Don't call model methods from JS thread

</details>

---

# Architecture Decisions

## Decision 1: stable-diffusion.cpp as Inference Backend

<details>
<summary>⚡ TL;DR</summary>

**Chose:** stable-diffusion.cpp over Python diffusers, ONNX Runtime, and alternatives  
**Why:** Pure C++ implementation, GGML-based (consistent with llama.cpp), broad model support, mature cross-platform GPU acceleration  
**Cost:** Large binary size, C++ build complexity, API instability

</details>

### Context

Need high-performance, cross-platform diffusion model inference for resource-constrained environments (laptops, mobile devices) with support for:
- Various model architectures (SD1.x, SD2.x, SDXL, SD3, FLUX, Wan, etc.)
- Quantization for reduced memory footprint
- GPU acceleration on diverse hardware
- Both image and video generation

### Decision

Use stable-diffusion.cpp as the core inference engine instead of Python diffusers, ONNX Runtime, or custom implementation.

### Rationale

**Performance:**
- Pure C/C++ implementation for maximum performance
- GGML-based tensor operations (same as llama.cpp, familiar ecosystem)
- Supports quantization reducing memory by 2-8x
- GPU acceleration via Metal (Apple), Vulkan (cross-platform), CUDA (NVIDIA), OpenCL

**Model Support:**
- Comprehensive support for diffusion models:
  - SD1.x, SD2.x, SD-Turbo
  - SDXL, SDXL-Turbo
  - SD3/SD3.5
  - FLUX.1-dev/schnell, FLUX.2-dev/klein
  - Wan2.1/Wan2.2 (video generation)
  - Qwen Image, Z-Image
- LoRA, ControlNet support
- GGUF, safetensors, checkpoint format support

**Development Velocity:**
- Active development with regular releases
- Community adding new model support rapidly
- Mirrors llama.cpp architecture (familiar patterns)

### Alternatives Considered

1. **Python Diffusers (Hugging Face)**
   - ✅ Comprehensive model support
   - ✅ Easy to use
   - ❌ Requires Python runtime
   - ❌ Heavy memory footprint
   - ❌ Poor mobile support
   - ❌ Complex deployment

2. **ONNX Runtime**
   - ✅ Cross-platform
   - ✅ Good mobile support
   - ❌ Requires model conversion
   - ❌ Limited quantization support
   - ❌ No native LoRA/ControlNet support
   - ❌ Complex pipeline orchestration

3. **TensorRT (NVIDIA)**
   - ✅ Excellent NVIDIA GPU performance
   - ❌ NVIDIA-only (no AMD, Apple, mobile)
   - ❌ Requires model compilation per GPU
   - ❌ Large binary size

4. **Core ML (Apple)**
   - ✅ Excellent Apple device performance
   - ❌ Apple-only
   - ❌ Limited model support
   - ❌ Requires model conversion

**Why stable-diffusion.cpp Won:**
- Broadest platform support (desktop + mobile, all major OSes)
- Pure C++ with no external runtime dependencies
- GGML integration (consistent with our llama.cpp stack)
- Active development and growing model support
- Multiple GPU backends in single codebase
- Quantization support for memory efficiency

---

## Decision 2: Bare Runtime over Node.js

See [qvac-lib-inference-addon-cpp Decision 4: Why Bare Runtime](https://github.com/tetherto/qvac-lib-inference-addon-cpp/blob/main/docs/architecture.md#decision-4-why-bare-runtime) for rationale.

**Summary:** Mobile support (iOS/Android), lightweight, modern addon API. Core business logic remains runtime-agnostic.

---

## Decision 3: Disk-Local Model Files

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Require model files to already exist on disk at `diskPath`
**Why:** Simplicity — the addon loads files directly from disk, no streaming/download layer needed
**Cost:** Caller must ensure files are present before calling `load()`

</details>

### Context

Diffusion models consist of multiple large files (diffusion model, text encoders, VAE). The addon needs these files to create the native `sd_ctx_t` context.

Unlike the LLM addon which historically used WeightsProvider for streaming weights, diffusion loads files directly from disk paths — no loader abstraction is involved.

### Decision

Require all model files to be present on disk at `diskPath` before `load()` is called. The addon constructs file paths by joining `diskPath` with each model filename and passes them directly to stable-diffusion.cpp.

### Rationale

**Simplicity:**
- No download/streaming abstraction layer needed
- No WeightsProvider, no progress tracking for downloads
- Direct file paths to stable-diffusion.cpp

**Split-model support:**
- Diffusion models may have multiple components (diffusion GGUF, CLIP-L, CLIP-G, T5-XXL, LLM encoder, VAE)
- All resolved as `path.join(diskPath, filename)` in `_load()`
- Split vs all-in-one layout detected via heuristic (`isSplitLayout = !!llmModel || !!t5XxlModel`)

### Trade-offs
- ✅ Simple, no abstraction overhead
- ✅ No streaming/buffering complexity
- ❌ Caller responsible for ensuring files exist on disk

---

## Decision 4: Direct File Path Loading

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Pass file paths directly to stable-diffusion.cpp via `sd_ctx_params_t`
**Why:** stable-diffusion.cpp natively loads from file paths; no need for buffer intermediary
**Cost:** Files must exist on disk (no streaming from P2P sources)

</details>

### Context

stable-diffusion.cpp accepts model files via file paths in its context parameters (`model_path`, `diffusion_model_path`, `clip_l_path`, `vae_path`, etc.). The addon constructs these paths from `diskPath` + filenames.

### Decision

Pass absolute file paths directly to stable-diffusion.cpp rather than using buffer-based loading. The `_load()` method constructs a `configurationParams` object with resolved paths and passes it to the native addon.

### Rationale

**Simplicity:**
- stable-diffusion.cpp handles file I/O internally
- No custom streambuf or buffer management needed
- No JavaScript reference lifecycle concerns

**Split-model routing:**
- All-in-one checkpoints (SD1.x, SD2.x, SDXL) → `model_path`
- Standalone diffusion GGUFs (FLUX.2, SD3 split) → `diffusion_model_path`
- Separate encoders → `clipLPath`, `clipGPath`, `t5XxlPath`, `llmPath`
- VAE → `vaePath`

### Trade-offs
- ✅ No buffer management complexity
- ✅ stable-diffusion.cpp handles memory-mapped I/O efficiently
- ❌ Cannot stream from P2P sources directly (files must be on disk first)

---

## Decision 5: Generation Parameters Format (JSON Serialization)

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Serialize generation parameters to JSON string before crossing JS/C++ boundary  
**Why:** Simple marshalling, familiar pattern, extensible for new parameters  
**Cost:** JSON parsing overhead per inference call

</details>

### Context

Need to pass complex generation parameters from JavaScript to C++:
- Prompt and negative prompt
- Image dimensions (width, height)
- Sampling parameters (steps, cfg_scale, sampler, seed)
- Optional inputs (init image for img2img, LoRA configs, ControlNet)

### Decision

Serialize generation parameters to JSON string before passing to C++.

### Rationale

**Simplicity:**
- Single string parameter instead of complex nested objects
- JSON parsing well-supported in both JavaScript and C++
- Consistent with llm-llamacpp pattern

**Extensibility:**
- Easy to add new parameters without changing C++ interface
- Optional parameters naturally handled (absent = default)
- LoRA configs, ControlNet settings as nested objects

### Trade-offs
- ✅ Portable and well-understood format
- ❌ Serialization overhead on every call
- ❌ No compile-time type checking across boundary

### Parameter Schema

```typescript
interface GenerationParams {
  prompt: string;
  negative_prompt?: string;
  width?: number;             // default: 512
  height?: number;            // default: 512
  steps?: number;             // default: 20
  cfg_scale?: number;         // CFG scale (SD1/SD2/SDXL/SD3)
  guidance?: number;          // Distilled guidance (FLUX.2)
  sampling_method?: string;   // 'euler' | 'euler_a' | 'dpm++_2m' | etc.
  scheduler?: string;         // 'default' | 'karras' | 'exponential' | etc.
  seed?: number;              // -1 for random
  batch_count?: number;       // default: 1
  vae_tiling?: boolean;       // Enable VAE tiling (for large images)
  cache_preset?: string;      // 'slow' | 'medium' | 'fast' | 'ultra'
  init_image?: Uint8Array;    // PNG/JPEG bytes — if provided, runs img2img
  strength?: number;          // img2img: 0.0 = keep source, 1.0 = full redraw
}
```

Mode is determined automatically: if `init_image` is provided, runs img2img; otherwise txt2img.

---

## Decision 6: Exclusive Run Queue (index.js)

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Promise-based exclusive run queue using `_withExclusiveRun()` wrapper  
**Why:** Ensure generation jobs complete without interruption (long-running operations)  
**Cost:** One generation at a time per model instance

</details>

### Context

Diffusion generation takes significant time (seconds to minutes). Without coordination, concurrent requests could interfere. The addon returns `false` (not accepted) if a job is already running.

### Decision

Implement JavaScript-level promise queue ensuring only one generation job runs at a time per model instance.

### Rationale

**Resource Management:**
- GPU memory fully utilized during generation
- No partial state from interrupted generations
- Predictable VRAM usage

**Progress Integrity:**
- Step progress callbacks correspond to single job
- No mixing of progress from concurrent requests

### Trade-offs
- ✅ Simple promise-based queue
- ✅ Predictable execution order
- ❌ One request at a time per instance
- ❌ Long generations block subsequent requests

**Mitigation:** For batch generation, use batch_count parameter; for parallel jobs, create multiple model instances

---

## Decision 7: TypeScript Definitions

<details>
<summary>⚡ TL;DR</summary>

**Chose:** Hand-written TypeScript definitions (index.d.ts)  
**Why:** Type safety, IDE support, API documentation  
**Cost:** Manual maintenance, must keep in sync with implementation

</details>

### Context

Developers expect TypeScript support for better IDE experience, autocomplete, and compile-time checking.

### Decision

Provide hand-written TypeScript definitions in `index.d.ts`.

### Rationale

**Developer Experience:**
- IDE autocomplete for methods and parameters
- Compile-time error checking
- Clear parameter types for generation options

**Documentation:**
- Types serve as living API documentation
- Clear contracts for all public methods

### Trade-offs
- ✅ Catch errors at compile time
- ❌ Maintenance burden (must keep .d.ts in sync)

---

# Technical Debt

### 1. Limited Error Context
**Status:** C++ exceptions lose stack traces crossing JS boundary  
**Issue:** Generic error messages make debugging difficult  
**Root Cause:** Bare's `js.h` doesn't support error stacks  
**Plan:** Implement structured error objects with error codes and context

---

**Last Updated:** 2026-03-11
