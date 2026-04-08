[![QVAC logo](docs/logo.avif)](https://docs.qvac.tether.io)

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

* [**Completion:**](/sdk/examples/ai-tasks/completion) LLM inference for text generation and chat via [`qvac-fabric-llm.cpp`](https://github.com/tetherto/qvac-fabric-llm.cpp).
* [**Text embeddings:**](/sdk/examples/ai-tasks/text-embeddings) vector embedding generation for semantic search, clustering, and retrieval, via `qvac-fabric-llm.cpp`.
* [**Translation:**](/sdk/examples/ai-tasks/translation) text-to-text neural machine translation (NMT), via `qvac-fabric-llm.cpp` and [Bergamot](https://browser.mt).
* [**Transcription:**](/sdk/examples/ai-tasks/transcription) automatic speech recognition (ASR) for speech-to-text via [`qvac-ext-lib-whisper.cpp`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp) or [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2).
* [**Text-to-Speech:**](/sdk/examples/ai-tasks/text-to-speech) speech synthesis for text-to-speech (TTS) via [ONNX Runtime](https://onnxruntime.ai).
* [**OCR:**](/sdk/examples/ai-tasks/ocr) optical character recognition (OCR) for extracting text from images via ONNX runtime.
* [**Multimodal:**](/sdk/examples/ai-tasks/multimodal) LLM inference over text, images, and other media within a single conversation context.
* [**RAG:**](/sdk/examples/ai-tasks/rag) out-of-the-box retrieval-augmented generation workflow.

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
| lib-decoder-audio | Audio decoder library leveraging FFmpeg for efficient audio decoding as preprocessing step for other addons | Addon |
| lib-infer-llamacpp-embed | Native C++ addon for running text embedding models to generate high-quality contextual embeddings via `qvac-fabric-llm.cpp` | Addon |
| lib-infer-llamacpp-llm | Native C++ addon for running Large Language Models (LLMs) via `qvac-fabric-llm.cpp` | Addon |
| lib-infer-diffusion | Native C++ addon for text-to-image generation via `qvac-ext-stable-diffusion.cpp` | Addon |
| lib-infer-nmtcpp | Native C++ addon for translation using either `qvac-fabric-llm.cpp` or [Bergamot](https://browser.mt) | Addon |
| lib-infer-onnx | Bare addon for ONNX Runtime session management | Addon |
| lib-infer-onnx-tts | Text-to-Speech (TTS) library using Chatterbox and Supertonic neural TTS model via ONNX Runtime | Addon |
| lib-infer-parakeet | High-performance speech-to-text inference addon using via NVIDIA/Parakeet | Addon |
| lib-infer-whispercpp | Library for running Whisper transcription model for audio transcription via `qvac-ext-lib-whisper.cpp` | Addon |
| lib-inference-addon-cpp | Header-only C++ library providing common abstractions and infrastructure for building high-performance inference addons | Addon |
| lib-langdetect-text | Language detection library providing interface for detecting language of given text | Addon |
| lib-langdetect-text-cld2 | Language detection using CLD2 with same API as @qvac/langdetect-text | Addon |
| ocr-onnx | Optical Character Recognition (OCR) addon using ONNX Runtime | Addon |
| rag | JavaScript library for Retrieval-Augmented Generation (RAG) with document ingestion, vector search, and LLM integration | Addon |
| lib-dl-base | Base class for QVAC dataloader libraries providing common interface for loading data from various sources | Core |
| lib-dl-filesystem | Data loading library for loading model weights and resources from local filesystem | Core |
| lib-dl-hyperdrive | Data loading library for loading model weights and resources from Hyperdrive distributed file system | Core |
| error | Standardized error handling capabilities for all QVAC libraries | Core |
| lib-infer-base | Base class for inference addon clients defining common lifecycle and generic methods for model interaction | Core |
| logging | Logger wrapper that normalizes logging interface across QVAC libraries | Core |
| cli | Command-line interface for the QVAC ecosystem with tooling for building, bundling, and managing QVAC-powered applications | Tool |
| lib-diagnostics | Diagnostic report generation library for QVAC | Tool |
| lib-registry-server | Distributed model registry for downloading AI models for local inference and contributing new models | Tool |
| lint-cpp | Configuration files for formatting and linting C++ source files with pre-commit hooks | Tool |

### Development

- For the standard development workflow used in this monorepo, see [`/docs/gitflow.md`](./docs/gitflow.md).
- For development specifics of each QVAC component, refer to the documentation in the respective subdirectory under `/packages`.
- For the QVAC architecture as a whole, see `/docs/architecture`.