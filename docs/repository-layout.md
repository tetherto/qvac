# Repository layout

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