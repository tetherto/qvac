HERO-begin:

[![QVAC logo](docs/branding/logo.avif)](https://docs.qvac.tether.io)

Local AI SDK & Model Provider
Run LLMs, speech, vision, image/video generation, and more on any device.
Build mobile and desktop apps with QVAC, or power your favorite AI tools like OpenCode and OpenClaw.

Large GIF

LINK strip
> <a href="https://qvac.tether.io" >Website</a> &nbsp;•&nbsp;
> <a href="https://docs.qvac.tether.io" >Docs</a> &nbsp;•&nbsp;

Badge strip:

**QVAC** lets you run a comprehensive range of AI workloads locally using open models across Linux, macOS, Windows, Android, and iOS.

HERO-end:

QVAC provides:
- **SDK** for building local-first AI applications and systems in JavaScript/TypeScript and Python. You can also delegate inference to peers through QVAC's built-in P2P capabilities.
- **HTTP server** for using QVAC as a local model provider. Its OpenAI-compatible API lets you connect AI tools such as OpenCode and OpenClaw, or any other compatible tool.

## Why QVAC

- **Local-first:** run AI offline with inference optimized for commodity hardware, from consumer apps and embedded systems to on-premises deployments.
- **Privacy and control:** keep data local, own the AI system. No cloud or third-party APIs required.
- **One SDK, all of AI:** a comprehensive range of AI capabilities through one interface.
- **Cross-platform:** one codebase for Linux, macOS, Windows, Android, and iOS, using JavaScript/TypeScript or Python.
- **Peer-to-peer:** delegate inference to peers and build unstoppable internet systems, like BitTorrent or IPFS, but for AI.

## Quickstart

Load a model and run inference locally in a few lines. Pick your language.

### JavaScript

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

You'll see the model download first. Then, QVAC will stream the response tokens and print them to the terminal.

### Python

<details>
<summary>Show Python quickstart</summary>

1. Create the examples workspace:

```bash
mkdir qvac-examples-py
cd qvac-examples-py
python -m venv .venv
source .venv/bin/activate
```

2. Install the package:

```bash
pip install "tetherto-qvac-sdk"
```

3. Install the worker (requires Node.js and npm — `install-worker` shells out to `npm install`):

```bash
python -m tetherto.qvac_sdk install-worker
```

4. Create the quickstart script:

```python
import asyncio
import sys

from tetherto.qvac_sdk import Client, completion, load_model, unload_model
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0


async def main():
    async with Client() as client:
        t = client.transport
        # Load a model into memory
        model_id = await load_model(
            t,
            model_src=LLAMA_3_2_1B_INST_Q4_0,
            on_progress=lambda p: print(p),
        )
        # You can use the loaded model multiple times
        history = [
            {"role": "user", "content": "Explain quantum computing in one sentence"},
        ]
        run = completion(t, model_id=model_id, history=history)
        async for event in run.events:
            if event.type == "contentDelta":
                sys.stdout.write(event.text)
                sys.stdout.flush()
        # Unload model to free up system resources
        await unload_model(t, model_id)


asyncio.run(main())
```

5. Run the quickstart script:

```bash
python quickstart.py
```

You'll see the model download first. Then, QVAC will stream the response tokens and print them to the terminal.

</details>

⭐ If QVAC saves you from shipping yet another cloud dependency, give it a star, it helps other devs find it.

## AI capabilities

| Task | Description |
| --- | --- |
| **Text generation** | LLM inference for text generation and chat via [Fabric LLM](https://github.com/tetherto/qvac-fabric-llm.cpp). |
| **Text embeddings** | Vector embedding generation for semantic search, clustering, and retrieval, via Fabric LLM. |
| **RAG** | Out-of-the-box retrieval-augmented generation workflow. |
| **Fine-tuning** | Adapting LLMs to domain-specific tasks via LoRA. |
| **Multimodal** | LLM inference over text, images, and other media within a single conversation context. |
| **Image generation** | Text-to-image and image-to-image generation via a customized Diffusion backend. |
| **Video generation** | Text-to-video and image-to-video generation via a customized Diffusion backend. |
| **Music generation** | Generate music from text, lyrics, and musical controls with [`@qvac/audiogen-ggml`](packages/audiogen-ggml/README.md), backed by [ACE-Step](https://github.com/ace-step/ACE-Step-1.5). Published prebuilds cover Linux, macOS, Windows, Android arm64, and iOS arm64; the package includes a model downloader for application-owned model directories. |
| **Transcription** | Automatic speech recognition (ASR) via [`@qvac/asr-ggml`](https://github.com/tetherto/qvac/tree/main/packages/asr-ggml) (Whisper or [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)), with duplex streaming and terminal performance statistics. See [Choosing a model](packages/asr-ggml/README.md#choosing-a-model). |
| **Text-to-Speech** | Speech synthesis (TTS) via [`@qvac/tts-ggml`](https://github.com/tetherto/qvac/tree/main/packages/tts-ggml) — Chatterbox, Supertonic, Parler, and CosyVoice3 support opt-in GPU offload (Metal on Apple, Vulkan on desktop Linux/Windows for Chatterbox, Supertonic, and CosyVoice3, OpenCL/Adreno on Android), while Audio8 supports optional desktop Vulkan acceleration. Prebuilds cover Linux, macOS, Windows, Android arm64, and iOS; models can be downloaded from the QVAC registry where published or staged from local converted artifacts. See [Choosing a model](packages/tts-ggml/README.md#choosing-a-model). |
| **Translation** | Text-to-text neural machine translation (NMT), via Fabric LLM and [Bergamot](https://browser.mt). |
| **BCI** | Brain–computer interface transcription via [a customized Whisper backend](https://github.com/tetherto/qvac/tree/main/packages/bci-whispercpp). |
| **VLA** | Vision-language-action for robot control via [a customized GGML backend](https://github.com/tetherto/qvac/tree/main/packages/vla-ggml). |
| **OCR** | Optical character recognition for extracting text from images via ONNX Runtime or GGML backends. |
| **Image classification** | Classify images into labels with confidence scores via [a customized GGML backend](https://github.com/tetherto/qvac/tree/main/packages/classification-ggml). |

## Resources

Explore and use QVAC:

| Resource | Description |
| --- | --- |
| [**Docs**](https://docs.qvac.tether.io) | Comprehensive QVAC documentation. |
| [**Examples**](https://github.com/tetherto/qvac-examples/) | Sample apps and PoCs built with QVAC SDK. |
| [**Local model provider**](https://docs.qvac.tether.io/cli/http-server/connection/) | Use QVAC as a local model provider connected to your favorite AI tools. |
| [**QV.AC**](https://qv.ac) | Get to know our local AI assistant. |
| **Support and community** | We gather on [Discord](https://discord.com/invite/tetherdev) and [Keet](https://keet.io). Ask for help, give feedback, and discuss QVAC. |
| [**Blog**](https://qvac.tether.io/blog/) | Tutorials, deep dives, engineering notes, and announcements. |
| [**Ecosystem**](https://qvac.tether.io) | Discover the broader QVAC ecosystem. |
| [**Research**](https://huggingface.co/qvac) | Papers, datasets, and models optimized for edge devices. |
| [**Our vision**](https://docs.qvac.tether.io/about/vision/) | Learn why Tether built QVAC. |

## Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues.

See [CONTRIBUTING](./CONTRIBUTING.md) for details.

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
