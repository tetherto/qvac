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

Additionally, QVAC also provides an HTTP server, _allowing you to use it as a **local model provider** for your favorite AI tools_, such as OpenCode, OpenClaw, and any other application compatible with the [OpenAI API](https://platform.openai.com/docs/api-reference).

Whether you're building applications with the SDK or using QVAC as a local model provider, the principle is the same: load models and run inference locally, or delegate inference to peers using the built-in P2P capabilities.

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
| **Transcription** | Automatic speech recognition (ASR) via a customized Whisper backend or [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). |
| **Text-to-Speech** | Speech synthesis (TTS) via [a customized GGML backend](https://github.com/tetherto/qvac/tree/main/packages/tts-ggml). |
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

Note: access our Keet room via this link:

<details>
<summary><code>keet://chat/nfo61f4e...</code></summary>

```
keet://chat/nfo61f4e6zc5t1ifncyh9yp7s5eynbruz5bs95oc5ufn3e79entmhix74miigc8iz9iawfrb7pzk3am8eotxw8wat7554etbn7d6j4ho84b1zqnb63z7hxq1ubt5w4wi4kpq3mdgpijcnaifnhm7sy4cfxqqoyedpnb5qg1majcggy4s9s91fgtg3khgw
```

</details>

## Quickstart

Want to get hands-on right away? Here's a simple example you can use to test QVAC.

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
