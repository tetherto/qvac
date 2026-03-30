# Data Flows: @qvac/tts-onnx

> **⚠️ Warning:** These diagrams represent the data flows as of the last documentation update. Code changes may have introduced differences. For debugging, regenerate diagrams from current source code.

---

## Table of Contents

- [TTS Synthesis Flow (Primary)](#tts-synthesis-flow-primary)
- [Chatterbox Inference Pipeline](#chatterbox-inference-pipeline)
- [Supertonic Inference Pipeline](#supertonic-inference-pipeline)
- [Model Loading Flow](#model-loading-flow)
- [Engine Detection Flow](#engine-detection-flow)

---

## TTS Synthesis Flow (Primary)

The end-to-end flow from JavaScript `run()` call through to audio output delivery.

```mermaid
sequenceDiagram
    participant App as Application
    participant TTS as ONNXTTS (index.js)
    participant IF as TTSInterface (tts.js)
    participant Bind as Native Binding
    participant Addon as Addon<TTSModel>
    participant Model as TTSModel
    participant Engine as Engine

    App->>TTS: run({input: "Hello. World.", type: "text"})
    TTS->>IF: append({type: "text", input: "Hello. World."})
    IF->>Bind: append(handle, data)
    Bind->>Addon: append() [mutex lock]
    Addon->>Addon: Enqueue job, cv.notify_one()
    Bind-->>IF: jobId (number)
    TTS->>IF: append({type: "end of job"})
    IF->>Bind: append(handle, {type: "end of job"})
    TTS-->>App: QvacResponse

    Note over Addon: Processing Thread wakes

    rect rgb(240, 248, 255)
        Note over Addon,Engine: Sentence 1: "Hello."
        Addon->>Addon: getNextPiece() → "Hello."
        Addon->>Model: process("Hello.")
        Model->>Engine: synthesize("Hello.")
        Engine-->>Model: AudioResult{pcm16, sampleRate, durationMs}
        Model-->>Addon: vector<int16_t>
        Addon->>Addon: uv_async_send()
        Note over Addon: JS thread callback
        Addon->>Bind: createOutputData() → Int16Array
        Bind->>IF: outputCb({outputArray})
        IF->>TTS: onUpdate({outputArray: Int16Array})
        TTS->>App: onUpdate({outputArray: Int16Array})
    end

    rect rgb(240, 248, 255)
        Note over Addon,Engine: Sentence 2: " World."
        Addon->>Addon: getNextPiece() → " World."
        Addon->>Model: process(" World.")
        Model->>Engine: synthesize(" World.")
        Engine-->>Model: AudioResult{pcm16, sampleRate, durationMs}
        Model-->>Addon: vector<int16_t>
        Addon->>Addon: uv_async_send()
        Addon->>Bind: createOutputData() → Int16Array
        Bind->>IF: outputCb({outputArray})
        IF->>App: onUpdate({outputArray: Int16Array})
    end

    Addon->>Bind: outputCb({event: "JobEnded", stats})
    Bind->>App: onUpdate({event: "JobEnded", stats})
```

<details>
<summary>📊 LLM-Friendly: Synthesis Data Transformations</summary>

**Data Transformations per Stage:**

| Stage | Input | Output | Transform |
|-------|-------|--------|-----------|
| JS API (run) | `{input: string, type: "text"}` | QvacResponse | Wraps in response object |
| JS Bridge (append) | `{type, input}` object | jobId (number) | Extracts and forwards to native |
| Addon (getNextPiece) | Full text string | Sentence substring | Split on `.!?` with min 25 chars |
| TTSModel (process) | std::string sentence | vector&lt;int16_t&gt; PCM | Dispatches to active engine |
| Engine (synthesize) | std::string sentence | AudioResult | Full inference pipeline |
| Output handler | vector&lt;int16_t&gt; | JS Int16Array | memcpy into ArrayBuffer |
| JS callback | {outputArray: Int16Array} | User processes audio | Application-specific |

</details>

---

## Chatterbox Inference Pipeline

Detailed ONNX session execution order within `ChatterboxEngine::synthesize()`.

```mermaid
flowchart TB
    INPUT["Input Text<br/>'Hello world.'"]

    subgraph Tokenization
        TOK["Tokenize (tokenizers_c)<br/>text → input_ids"]
    end

    subgraph "Embed Tokens Session"
        EMBED_IN["Input: input_ids (int64)"]
        EMBED_ONNX["embed_tokens.onnx"]
        EMBED_OUT["Output: inputs_embeds (float)"]
        EMBED_IN --> EMBED_ONNX --> EMBED_OUT
    end

    subgraph "Speech Encoder Session"
        SE_IN["Input: reference_audio (float)"]
        SE_ONNX["speech_encoder.onnx"]
        SE_OUT["Output: speaker_embeddings (float)<br/>+ speaker_features (float)"]
        SE_IN --> SE_ONNX --> SE_OUT
    end

    subgraph "Language Model Session (Autoregressive Loop)"
        LM_IN["Inputs: inputs_embeds, position_ids,<br/>attention_mask, past_key_values"]
        LM_ONNX["language_model.onnx"]
        LM_OUT["Output: speech_tokens (int64)<br/>+ updated past_key_values"]
        LM_IN --> LM_ONNX --> LM_OUT
        LM_OUT -->|"Loop until EOS<br/>or max tokens"| LM_IN
    end

    subgraph "Conditional Decoder Session"
        CD_IN["Inputs: speech_tokens,<br/>speaker_embeddings, speaker_features"]
        CD_ONNX["conditional_decoder.onnx"]
        CD_OUT["Output: waveform (float)<br/>→ convert to int16 PCM"]
        CD_IN --> CD_ONNX --> CD_OUT
    end

    OUTPUT["AudioResult<br/>24 kHz, 16-bit PCM, mono"]

    INPUT --> TOK
    TOK --> EMBED_IN
    EMBED_OUT --> LM_IN
    SE_OUT --> CD_IN
    LM_OUT -->|"Final speech_tokens"| CD_IN
    CD_OUT --> OUTPUT

    style INPUT fill:#e1f5ff
    style OUTPUT fill:#e1ffe1
```

<details>
<summary>📊 LLM-Friendly: Chatterbox Session Details</summary>

**ONNX Sessions:**

| Session | Model File | Key Inputs | Key Outputs | Purpose |
|---------|-----------|------------|-------------|---------|
| Embed Tokens | embed_tokens.onnx | input_ids (int64) | inputs_embeds (float) | Convert token IDs to embeddings |
| Speech Encoder | speech_encoder.onnx | reference_audio (float) | speaker_embeddings, speaker_features | Extract speaker characteristics from reference audio |
| Language Model | language_model.onnx | inputs_embeds, position_ids, attention_mask, past_key_values | speech_tokens, updated past_key_values | Autoregressive speech token generation |
| Conditional Decoder | conditional_decoder.onnx | speech_tokens, speaker_embeddings, speaker_features | waveform (float) | Convert speech tokens to audio waveform |

**Pipeline Characteristics:**

| Property | Value |
|----------|-------|
| Autoregressive | Yes (language model loop) |
| Output sample rate | 24 kHz |
| Output format | 16-bit PCM, mono |
| Voice cloning | Yes (via reference audio → speech encoder) |
| Supported languages | en, es, fr, de, it, pt, ru |

</details>

---

## Supertonic Inference Pipeline

Detailed ONNX session execution order within `SupertonicEngine::synthesize()`.

```mermaid
flowchart TB
    INPUT["Input Text<br/>'Hello world.'"]

    subgraph Tokenization
        TOK["Tokenize (tokenizers_c)<br/>text → input_ids + attention_mask"]
    end

    subgraph "Voice Style Loading"
        VOICE["Load voice .bin file<br/>→ style_data (float, 1×N×128)"]
    end

    subgraph "Text Encoder Session"
        TE_IN["Inputs: input_ids, attention_mask,<br/>style_data"]
        TE_ONNX["text_encoder.onnx"]
        TE_OUT["Outputs: encoder_outputs (float),<br/>durations (int64)"]
        TE_IN --> TE_ONNX --> TE_OUT
    end

    subgraph "Latent Denoiser Loop"
        LD_IN["Inputs: encoder_outputs,<br/>attention_mask, durations,<br/>noise (random)"]
        LD_ONNX["latent_denoiser.onnx"]
        LD_OUT["Output: denoised latents (float)"]
        LD_IN --> LD_ONNX --> LD_OUT
        LD_OUT -->|"Repeat N steps<br/>(default: 5)"| LD_IN
    end

    subgraph "Voice Decoder Session"
        VD_IN["Input: final latents (float)"]
        VD_ONNX["voice_decoder.onnx"]
        VD_OUT["Output: waveform (float)<br/>→ convert to int16 PCM"]
        VD_IN --> VD_ONNX --> VD_OUT
    end

    OUTPUT["AudioResult<br/>44.1 kHz, 16-bit PCM, mono"]

    INPUT --> TOK
    TOK --> TE_IN
    VOICE --> TE_IN
    TE_OUT --> LD_IN
    LD_OUT -->|"Final latents"| VD_IN
    VD_OUT --> OUTPUT

    style INPUT fill:#e1f5ff
    style OUTPUT fill:#e1ffe1
```

<details>
<summary>📊 LLM-Friendly: Supertonic Session Details</summary>

**ONNX Sessions:**

| Session | Model File | Key Inputs | Key Outputs | Purpose |
|---------|-----------|------------|-------------|---------|
| Text Encoder | text_encoder.onnx | input_ids, attention_mask, style_data | encoder_outputs, durations | Encode text with voice style into latent space |
| Latent Denoiser | latent_denoiser.onnx | encoder_outputs, attention_mask, durations, noise | denoised latents | Iterative diffusion denoising (N steps) |
| Voice Decoder | voice_decoder.onnx | latents | waveform (float) | Decode latents into audio waveform |

**Pipeline Characteristics:**

| Property | Value |
|----------|-------|
| Autoregressive | No (diffusion-based) |
| Output sample rate | 44.1 kHz |
| Output format | 16-bit PCM, mono |
| Voice selection | Via voice .bin files (e.g., "F1.bin") |
| Denoising steps | Configurable (default: 5) |
| Speed control | Configurable multiplier (default: 1.0) |
| Supported languages | en, ko, es, pt, fr |

</details>

---

## Model Loading Flow

The complete flow from `ONNXTTS.load()` through weight downloading and native addon initialization.

```mermaid
sequenceDiagram
    participant App as Application
    participant TTS as ONNXTTS
    participant WP as WeightsProvider
    participant DL as DataLoader
    participant IF as TTSInterface
    participant Bind as Native Binding
    participant Model as TTSModel
    participant Engine as Engine

    App->>TTS: load(closeLoader?, onProgress?)

    alt Has WeightsProvider (loader configured)
        TTS->>WP: downloadFiles(files, cache, opts)
        loop For each model file
            WP->>DL: Download file
            DL-->>WP: File data
            WP->>WP: Write to cache directory
            WP-->>TTS: onProgress(progressData)
        end
    end

    TTS->>TTS: Detect engine type from args
    TTS->>TTS: Build ttsParams (resolve paths)
    TTS->>IF: new TTSInterface(binding, ttsParams, outputCb, logger)
    IF->>Bind: createInstance(this, config, outputCb, logger)
    Bind->>Model: new TTSModel(configMap, referenceAudio)
    Model->>Model: detectEngineType(configMap)

    alt Chatterbox
        Model->>Engine: new ChatterboxEngine(config)
        Engine->>Engine: Load tokenizer
        Engine->>Engine: Create 4 ONNX sessions
    else Supertonic
        Model->>Engine: new SupertonicEngine(config)
        Engine->>Engine: Load tokenizer
        Engine->>Engine: Load voice style
        Engine->>Engine: Create 3 ONNX sessions
    end

    Bind-->>IF: handle (native pointer)
    TTS->>IF: activate()
    IF->>Bind: activate(handle)
    Note over Model: State → LISTENING
    TTS-->>App: load() resolved
```

<details>
<summary>📊 LLM-Friendly: Loading Sequence</summary>

**Model Files per Engine:**

| Engine | Files | Typical Combined Size |
|--------|-------|-----------------------|
| Chatterbox | tokenizer.json, speech_encoder.onnx, embed_tokens.onnx, conditional_decoder.onnx, language_model.onnx | ~500 MB–1 GB |
| Supertonic | tokenizer.json, text_encoder.onnx, latent_denoiser.onnx, voice_decoder.onnx, {voiceName}.bin | ~200–500 MB |

**State Transitions During Load:**

| Step | State | Trigger |
|------|-------|---------|
| 1 | UNLOADED | Initial state |
| 2 | LOADING | createInstance() called |
| 3 | LOADED | Model sessions created |
| 4 | LISTENING | activate() called, ready for input |

</details>

---

## Engine Detection Flow

How `ONNXTTS` determines which engine to use based on constructor arguments.

```mermaid
flowchart TB
    START["Constructor args received"]

    CHECK_SUPER{"textEncoderPath provided?<br/>OR (modelDir + voiceName)?"}

    SUPER["Engine: SUPERTONIC<br/>Store: modelDir, voiceName,<br/>speed, numInferenceSteps"]
    CHATTER["Engine: CHATTERBOX<br/>Store: tokenizerPath,<br/>speechEncoderPath, embedTokensPath,<br/>conditionalDecoderPath, languageModelPath,<br/>referenceAudio"]

    RESOLVE_S{"modelDir provided?"}
    EXPLICIT_S["Use explicit paths:<br/>textEncoderPath, latentDenoiserPath,<br/>voiceDecoderPath, voicesDir"]
    AUTO_S["Auto-resolve from modelDir:<br/>modelDir/tokenizer.json<br/>modelDir/onnx/text_encoder.onnx<br/>modelDir/onnx/latent_denoiser.onnx<br/>modelDir/onnx/voice_decoder.onnx<br/>modelDir/voices/"]

    START --> CHECK_SUPER
    CHECK_SUPER -->|Yes| SUPER
    CHECK_SUPER -->|No| CHATTER

    SUPER --> RESOLVE_S
    RESOLVE_S -->|Yes| AUTO_S
    RESOLVE_S -->|No| EXPLICIT_S

    style START fill:#e1f5ff
    style SUPER fill:#fff3e0
    style CHATTER fill:#e8f5e9
```

<details>
<summary>📊 LLM-Friendly: Engine Selection Rules</summary>

**Detection Logic (JavaScript — index.js):**

| Condition | Engine Selected |
|-----------|----------------|
| `textEncoderPath` is non-empty | Supertonic |
| `modelDir` AND `voiceName` are non-empty | Supertonic |
| Otherwise | Chatterbox |

**C++ Detection Logic (TTSModel.cpp):**

| Condition | Engine Selected |
|-----------|----------------|
| `configMap["textEncoderPath"]` is non-empty | Supertonic |
| `configMap["modelDir"]` AND `configMap["voiceName"]` are non-empty | Supertonic |
| Otherwise | Chatterbox |

</details>

---

**Last Updated:** 2026-02-18
