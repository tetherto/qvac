[![QVAC logo](docs/branding/logo.avif)](https://docs.qvac.tether.io)

---

> <a href="https://qvac.tether.io" >Website</a> &nbsp;•&nbsp;
> <a href="https://docs.qvac.tether.io" >Docs</a> &nbsp;•&nbsp;
> <a href="https://discord.com/channels/1425125849346216029/1445400675189264516" >Support</a> &nbsp;•&nbsp;
> <a href="https://discord.com/invite/tetherdev" >Discord</a>

**QVAC** is an open-source, cross-platform ecosystem for building local-first, peer-to-peer **AI** applications and systems. With QVAC, you can run AI tasks like LLMs, speech, RAG, and more locally across Linux, macOS, Windows, Android, and iOS — or delegate inference to peers using its built-in P2P capabilities.

### Key features

- **Local-first:** load AI models and perform inference on your own machine. No third-party APIs, SaaS, or cloud involved.
- **P2P:** build unstoppable internet systems — like BitTorrent, IPFS, and blockchain networks, but for AI.
- **Cross-platform:** consistent developer experience across hardware, operating systems, and JS runtime environments — write code once, run it everywhere.
- **OpenAI-compatible API:** integrate with the broader AI ecosystem.
- **Open source:** 100% free to use and modify — build on top, contribute back, be part of our community.

## Usage

QVAC is composed of JavaScript libraries and tools that converge in the JS SDK. _The SDK is the main entry point for using QVAC_. It is type-safe and exposes all QVAC capabilities through a unified interface. It runs on Node.js, [Bare runtime](https://bare.pears.com), and [Expo](https://expo.dev).

Additionally, QVAC provides a CLI with tools and an HTTP server that exposes an [**OpenAI-compatible API**](https://platform.openai.com/docs/api-reference). *By implementing the OpenAI API format, QVAC can integrate with the broader AI ecosystem.*

Install the `@qvac/sdk` npm package in your project. Then load models and run AI inference locally, or delegate inference to peers using the built-in P2P features.

### Quickstart

1. Create the examples workspace:

```bash
mkdir qvac-examples
cd qvac-examples
npm init -y && npm pkg set type=module
```

2. Install the SDK:

```bash
npm install @qvac/sdk
```

3. Create the quickstart script:

```js
import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel, } from "@qvac/sdk";
try {
    // Load a model into memory
    const modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: "llm",
        onProgress: (progress) => {
            console.log(progress);
        },
    });
    // You can use the loaded model multiple times
    const history = [
        {
            role: "user",
            content: "Explain quantum computing in one sentence",
        },
    ];
    const result = completion({ modelId, history, stream: true });
    for await (const token of result.tokenStream) {
        process.stdout.write(token);
    }
    // Unload model to free up system resources
    await unloadModel({ modelId });
}
catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
}
```

4. Run the quickstart script:

```bash
node quickstart.js
```

### Functionalities

#### AI capabilities

* **Completion:** LLM inference for text generation and chat via [`qvac-fabric-llm.cpp`](https://github.com/tetherto/qvac-fabric-llm.cpp).
* **Text embeddings:** vector embedding generation for semantic search, clustering, and retrieval, via `qvac-fabric-llm.cpp`.
* **Translation:** text-to-text neural machine translation (NMT), via `qvac-fabric-llm.cpp` and [Bergamot](https://browser.mt).
* **Transcription:** automatic speech recognition (ASR) for speech-to-text via [`qvac-ext-lib-whisper.cpp`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp) or [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), plus speaker diarization via NVIDIA Sortformer.
* **Text-to-Speech:** speech synthesis for text-to-speech (TTS) using the Chatterbox and Supertonic neural TTS models.
* **OCR:** optical character recognition (OCR) for extracting text from images, via the ONNX Runtime or GGML backends.
* **Image generation:** text-to-image generation via [`qvac-ext-stable-diffusion.cpp`](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp).
* **Fine-tuning:** adapting LLMs to domain-specific tasks via LoRA.
* **Multimodal:** LLM inference over text, images, and other media within a single conversation context.
* **RAG:** out-of-the-box retrieval-augmented generation workflow.

#### P2P capabilities

* **Delegated inference:** delegate inference to peers via the [Holepunch stack](https://holepunch.to), enabling resource sharing.
* **Fetch models:** download AI models from peers via the distributed model registry.
* **Blind relays:** connect peers across NATs/firewalls by routing traffic through relay nodes.

#### Utilities

* **Plugin system**: build lean apps by including only required AI capabilities, and extend the SDK by plugging in custom capabilities.
* **Logging:** visibility into what's happening  during loading, inference, and other operations.
* **Download Lifecycle:** pause and resume model downloads.
* **Sharded models:** download a model that is sharded into multiple parts.

### Complete user docs

> [!TIP]
> For comprehensive QVAC documentation, see [https://docs.qvac.tether.io](https://docs.qvac.tether.io).
> There, you'll find [the compatibility matrix, installation instructions per environment/platform](https://docs.qvac.tether.io/sdk/getting-started/installation/), [reference with code examples for using each functionality](https://docs.qvac.tether.io/sdk/getting-started/), and much more.

## Contributing

### Repository layout

Monorepo structure overview. All QVAC components live under `/packages`, including the SDK, libraries, and tooling. Not every component is published to npm.

Legend:
* **Core:** foundational building blocks shared across the ecosystem.
* **Addon:** capability packages — each QVAC capability is implemented by one or more addons.
* **SDK:** primary entry point for consumers.
* **Tool:** user-facing tools and services that support the ecosystem.

| Package | Description | Category |
| :--- | :--- | :--- |
| sdk | Main entry point to develop AI applications with QVAC | SDK |
| bare-sdk | Bare-targeted slim assembly of the SDK; consumers install only the addons they need and register plugins explicitly | SDK |
| ai-sdk-provider | Vercel AI SDK provider exposing the QVAC runtime (chat, embeddings, transcription, translation, speech, OCR, image) | SDK |
| bci-whispercpp | Brain-Computer Interface (BCI) neural-signal transcription addon powered by whisper.cpp | Addon |
| classification-ggml | Image classification addon (MobileNetV3-Small) on the GGML backend | Addon |
| decoder-audio | Audio decoder library leveraging FFmpeg as a preprocessing step for other addons | Addon |
| diffusion-cpp | Native C++ addon for image/video generation via `qvac-ext-stable-diffusion.cpp` | Addon |
| embed-llamacpp | Native C++ addon for text embedding generation via `qvac-fabric-llm.cpp` | Addon |
| langdetect-text | Language detection library providing an interface for detecting the language of given text | Addon |
| langdetect-text-cld2 | Language detection using CLD2 with the same API as `@qvac/langdetect-text` | Addon |
| llm-llamacpp | Native C++ addon for running Large Language Models (LLMs) via `qvac-fabric-llm.cpp` | Addon |
| ocr-ggml | Optical Character Recognition (OCR) addon (EasyOCR pipeline) on the GGML backend | Addon |
| ocr-onnx | Optical Character Recognition (OCR) addon using ONNX Runtime | Addon |
| onnx | Bare addon for ONNX Runtime session management | Addon |
| rag | JavaScript library for Retrieval-Augmented Generation (RAG) with document ingestion, vector search, and LLM integration | Addon |
| transcription-parakeet | Speech-to-text (ASR) and Sortformer speaker-diarization addon using NVIDIA Parakeet models | Addon |
| transcription-whispercpp | Whisper-based audio transcription addon via `qvac-ext-lib-whisper.cpp` | Addon |
| translation-nmtcpp | Native C++ addon for translation using either `qvac-fabric-llm.cpp` or [Bergamot](https://browser.mt) | Addon |
| tts-ggml | Text-to-Speech (TTS) addon wrapping the Chatterbox and Supertonic engines on the GGML backend | Addon |
| vla-ggml | Vision-Language-Action (VLA) inference addon on the GGML backend | Addon |
| dl-base | Base class for QVAC dataloader libraries providing a common interface for loading data from various sources | Core |
| dl-filesystem | Data loading library for model weights and resources from the local filesystem | Core |
| dl-hyperdrive | Data loading library for model weights and resources from the Hyperdrive distributed file system | Core |
| error | Standardized error-handling capabilities for all QVAC libraries | Core |
| fabric | Shared Bare addon hosting the qvac-fabric (forked llama.cpp + ggml) runtime for QVAC inference addons | Core |
| infer-base | Base class for inference addon clients defining the common lifecycle and generic model-interaction methods | Core |
| inference-addon-cpp | Header-only C++ library providing common abstractions and infrastructure for building inference addons | Core |
| logging | Logger wrapper that normalizes the logging interface across QVAC libraries | Core |
| cli | Command-line interface for the QVAC ecosystem with tooling for building, bundling, and managing QVAC-powered applications | Tool |
| diagnostics | Diagnostic report generation library for QVAC | Tool |
| ggml-coload-smoke | Multi-addon co-load smoke harness that loads several GGML addons into one Bare process to catch cross-addon symbol/dlopen clashes | Tool |
| lint-cpp | Configuration files for formatting and linting C++ source files with pre-commit hooks | Tool |
| qvac-ci | CI utilities for the QVAC monorepo | Tool |
| registry-server | Distributed model registry server for downloading AI models and contributing new ones | Tool |

### Development

- For the standard development workflow used in this monorepo, see [`/docs/gitflow.md`](./docs/gitflow.md).
- For development specifics of each QVAC component, refer to the documentation in the respective subdirectory under `/packages`.
- For the QVAC architecture as a whole, see `/docs/architecture`.

## Banners and badges

Built something with QVAC? Add a badge or banner to your README, website, or app. It is a simple way to highlight your project, help others discover QVAC, and strengthen our community.

By using these badges and banners, you help foster the QVAC ecosystem!

Choose a banner or badge below and copy its Markdown snippet, or copy its image URL and use the hosted SVG asset directly.

### Banners

Large format badges (240x60) for prominent placement in your README header.

**Dark with monochrome glow**</br>
![Dark with monochrome glow](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-banner-dark-glow.svg)

**Dark with colorful flow**</br>
![Dark with colorful flow](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-banner-dark-flow.svg)

**Dark with stars pattern**</br>
![Dark with stars pattern](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-banner-dark-stars.svg)

**Light with colorful flow**</br>
![Light with colorful flow](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-banner-light-flow.svg)

**Banner usage**
```
[![Built with QVAC](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-banner-dark-glow.svg)](https://github.com/tetherto/qvac)
```

### Badges

Compact badges for use alongside other shields/badges in your README.

**Compact**

| Variant | Dark bg | Light bg |
|---------|---------|----------|
| Green logo | ![Green on dark](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-green-dark.svg) | ![Green on light](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-green-light.svg) |
| Monochrome | ![Mono on dark](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-mono-dark.svg) | ![Mono on light](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-mono-light.svg) |

**Inline**

| Variant | Dark bg | Light bg |
|---------|---------|----------|
| Green logo | ![Green on dark](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-inline-green-dark.svg) | ![Green on light](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-inline-green-light.svg) |
| Monochrome | ![Mono on dark](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-inline-mono-dark.svg) | ![Mono on light](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-inline-mono-light.svg) |

**Badge usage**
```
[![Built with QVAC](https://raw.githubusercontent.com/tetherto/qvac/refs/heads/main/docs/branding/qvac-badge-green-dark.svg)](https://github.com/tetherto/qvac)
```
