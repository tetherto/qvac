# Detailed Data Flows

This document contains detailed diagrams showing how data moves through the `@qvac/translation-nmtcpp` system.

**Audience:** Developers debugging complex behavior, contributors understanding system interactions.

> **⚠️ Note:** These detailed diagrams are intended for initial reference and can quickly become outdated as the codebase evolves. For exact debugging and deep understanding, regenerate diagrams from the actual code or trace through the implementation directly.

<details>
<summary>⚡ TL;DR: Data Flow Overview</summary>

**Communication Pattern:**
- Two-thread architecture: JavaScript thread + dedicated C++ processing thread
- Synchronization via mutex and condition variables
- Cross-thread flow: JS → queue job → wake C++ → process → output → uv_async_send → JS callback

**Translation Path (GGML):**
- JS calls `run(input)` → returns QvacResponse immediately (non-blocking)
- C++ thread dequeues job
- Calls `model.process()` → tokenize → encode → beam search decode → detokenize
- Queues output event → triggers JS callback asynchronously

**Translation Path (Bergamot):**
- Same JS flow, but C++ dispatches to `bergamot_translate()` or `bergamot_translate_batch()`
- Bergamot handles encoding/decoding internally via its BlockingService

**Batch Translation:**
- `runBatch()` bypasses the job queue and calls `processBatch()` directly
- Bergamot: true batch processing; GGML: sequential per-text processing

</details>

## Table of Contents

- [Model Loading Flow](#model-loading-flow)
- [GGML Translation Pipeline](#ggml-translation-pipeline-opus--marian--indictrans2)
- [Bergamot Translation Pipeline](#bergamot-translation-pipeline)
- [IndicTrans2 Pre/Post Processing](#indictrans2-prepost-processing-flow)
- [Batch Translation Flow](#batch-translation-flow-runbatch)
- [Job Queue and Threading Model](#job-queue-and-threading-model)

---

## Model Loading Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant NMT as TranslationNmtcpp
    participant WP as WeightsProvider
    participant HD as Hyperdrive Loader
    participant TI as TranslationInterface
    participant Addon as Addon<TranslationModel>
    participant TM as TranslationModel
    participant Loader as nmt_loader / bergamot_init

    App->>NMT: load(close?, progressCb?)
    NMT->>WP: downloadFiles(modelFiles, diskPath)
    WP->>HD: download model + vocab files
    HD-->>WP: files on disk

    NMT->>NMT: build configurationParams
    Note over NMT: {path, config, use_gpu}<br/>+ Bergamot vocab paths if needed

    NMT->>TI: new TranslationInterface(config, outputCb, logger)
    TI->>Addon: binding.createInstance()
    Addon->>TM: new TranslationModel()
    Addon->>TM: saveLoadParams(modelPath)
    Addon->>TM: setConfig(config)
    Addon->>TM: setUseGpu(useGpu)

    NMT->>TI: activate()
    TI->>Addon: binding.activate(handle)
    Addon->>TM: load()
    TM->>TM: detectBackendType(modelPath)

    alt GGML Backend (OPUS / IndicTrans2)
        TM->>Loader: nmt_init_from_file_with_params(path, params)
        Loader->>Loader: Read GGUF header
        Loader->>Loader: Detect model type (Marian / IndicTrans2)
        Loader->>Loader: Allocate tensors (encoder + decoder layers)
        Loader->>Loader: Load SentencePiece vocabularies
        Loader->>Loader: Initialize GGML backend (CPU / Metal / Vulkan)
        Loader->>Loader: Build computation schedule
        Loader-->>TM: nmt_context*
    else Bergamot Backend
        TM->>Loader: bergamot_init(modelPath, params)
        Loader->>Loader: Create BlockingService
        Loader->>Loader: Load TranslationModel with vocabs
        Loader-->>TM: bergamot_context*
    end

    TM-->>Addon: loaded
    Addon-->>NMT: state = configLoaded
```

<details>
<summary>📊 LLM-Friendly: Model Loading Steps</summary>

| Step | Component | Action | Details |
|------|-----------|--------|---------|
| 1 | TranslationNmtcpp | downloadWeights | Downloads model + vocab via Hyperdrive |
| 2 | TranslationNmtcpp | build config | Assembles path, config, GPU flag, vocab paths |
| 3 | TranslationInterface | createInstance | Creates native Addon\<TranslationModel\> |
| 4 | Addon | configure | saveLoadParams, setConfig, setUseGpu |
| 5 | TranslationModel | load() | Detects backend type from model file |
| 6a | nmt_loader | init (GGML) | Read header, allocate tensors, load SPM, init backend |
| 6b | bergamot_init | init (Bergamot) | Create BlockingService, load model + vocabs |

</details>

---

## GGML Translation Pipeline (OPUS / Marian / IndicTrans2)

```mermaid
flowchart TB
    INPUT["Input text"] --> TOKENIZE

    subgraph "Tokenization"
        TOKENIZE["nmt_tokenize_input()"]
        TOKENIZE --> SPM["SentencePiece encode"]
        SPM --> BOS_EOS["Add BOS/EOS tokens"]
    end

    BOS_EOS --> ENCODE

    subgraph "Encoding"
        ENCODE["nmt_encode()"]
        ENCODE --> ENC_EMB["Embedding lookup + positional"]
        ENC_EMB --> ENC_LAYERS["Encoder layers (×N)"]

        subgraph "Encoder Layer"
            ENC_SA["Self-Attention<br/>(Q, K, V projections)"]
            ENC_LN1["Layer Norm"]
            ENC_FFN["Feed-Forward Network"]
            ENC_LN2["Layer Norm"]
            ENC_SA --> ENC_LN1 --> ENC_FFN --> ENC_LN2
        end

        ENC_LAYERS --> ENC_NORM["Final Layer Norm"]
    end

    ENC_NORM --> DECODE

    subgraph "Decoding (Beam Search)"
        DECODE["nmt_decode_beam_search()"]
        DECODE --> INIT_BEAMS["Initialize beams<br/>(beam_size candidates)"]
        INIT_BEAMS --> DEC_LOOP["Decode loop"]

        DEC_LOOP --> DEC_STEP["Decoder step"]
        subgraph "Decoder Step"
            DEC_EMB["Token embedding + positional"]
            DEC_SELF_ATT["Self-Attention + KV Cache"]
            DEC_CROSS_ATT["Cross-Attention<br/>(attend to encoder output)"]
            DEC_FFN2["Feed-Forward Network"]
            DEC_LOGITS["Logits computation"]
            DEC_EMB --> DEC_SELF_ATT --> DEC_CROSS_ATT --> DEC_FFN2 --> DEC_LOGITS
        end

        DEC_STEP --> SCORE["Score + length penalty"]
        SCORE --> PRUNE["Prune to top-k beams"]
        PRUNE --> CHECK{"EOS or max length?"}
        CHECK -->|No| DEC_LOOP
        CHECK -->|Yes| SELECT["Select best beam"]
    end

    SELECT --> DETOKENIZE

    subgraph "Detokenization"
        DETOKENIZE["detokenize_sentencepiece()"]
        DETOKENIZE --> OUTPUT["Translated text"]
    end
```

<details>
<summary>📊 LLM-Friendly: GGML Pipeline Breakdown</summary>

| Phase | Component | Operation |
|-------|-----------|-----------|
| Tokenization | nmt_tokenize_input | SentencePiece encode → add BOS/EOS |
| Encoding | nmt_encode | Embedding → N encoder layers (self-attention + FFN) → norm |
| Decoding | nmt_decode_beam_search | Initialize beams → decode loop (self-attn + cross-attn + FFN → logits → score → prune) → select best |
| Detokenization | detokenize_sentencepiece | SentencePiece decode → output text |

</details>

---

## Bergamot Translation Pipeline

```mermaid
sequenceDiagram
    participant TM as TranslationModel
    participant BC as bergamot_context
    participant Service as BlockingService
    participant Model as bergamot::TranslationModel

    alt Single Translation
        TM->>BC: bergamot_translate(ctx, input)
        BC->>Service: translateMultiple(model, [input])
        Service->>Model: encode + decode (Marian engine)
        Model-->>Service: Response
        Service-->>BC: translated text
        BC-->>TM: result string
    else Batch Translation
        TM->>BC: bergamot_translate_batch(ctx, texts[])
        BC->>Service: translateMultiple(model, texts[])
        Service->>Model: batch encode + decode
        Model-->>Service: Response[]
        Service-->>BC: bergamot_batch_result
        BC-->>TM: translations[]
    end
```

<details>
<summary>📊 LLM-Friendly: Bergamot Flow</summary>

| Mode | Method | Flow |
|------|--------|------|
| Single | bergamot_translate | TranslationModel → BlockingService.translateMultiple([text]) → Response → string |
| Batch | bergamot_translate_batch | TranslationModel → BlockingService.translateMultiple(texts[]) → Response[] → string[] |

</details>

---

## IndicTrans2 Pre/Post Processing Flow

```mermaid
flowchart LR
    subgraph "Pre-Processing (JavaScript)"
        INPUT["Input text"] --> PREPROCESS["IndicProcessor.preprocessBatch()"]
        PREPROCESS --> NORM["Normalize script"]
        NORM --> TAG["Add language tags"]
        TAG --> PROCESSED["Processed text"]
    end

    PROCESSED --> NMT["C++ NMT Engine<br/>(GGML pipeline)"]

    subgraph "Post-Processing (JavaScript)"
        NMT --> RAW["Raw translation"]
        RAW --> POSTPROCESS["IndicProcessor.postprocessBatch()"]
        POSTPROCESS --> DENORM["Denormalize script"]
        DENORM --> FINAL["Final translation"]
    end
```

<details>
<summary>📊 LLM-Friendly: IndicTrans2 Processing</summary>

| Phase | Location | Operation |
|-------|----------|-----------|
| Pre-processing | JavaScript (IndicProcessor) | Normalize script → Add language tags |
| Inference | C++ (GGML) | Tokenize → Encode → Decode → Detokenize |
| Post-processing | JavaScript (IndicProcessor) | Denormalize script |

</details>

---

## Batch Translation Flow (runBatch)

```mermaid
sequenceDiagram
    participant App as Application
    participant NMT as TranslationNmtcpp
    participant TI as TranslationInterface
    participant Addon as Addon<TranslationModel>
    participant TM as TranslationModel
    participant Backend as GGML / Bergamot

    App->>NMT: runBatch(["Hello", "World"])

    alt IndicTrans Model
        NMT->>NMT: preprocessBatch(texts, srcLang, dstLang)
    else Standard Model
        NMT->>NMT: prepareInputText() for each text
    end

    NMT->>TI: processBatch(processedTexts)
    TI->>Addon: binding.processBatch(handle, texts)
    Addon->>TM: processBatch(texts)

    alt Bergamot Backend
        TM->>Backend: bergamot_translate_batch(ctx, texts)
        Backend-->>TM: batch results
    else GGML Backend
        loop For each text
            TM->>Backend: process(text)
            Backend-->>TM: translation
        end
    end

    TM-->>Addon: translations[]
    Addon-->>TI: results
    TI-->>NMT: translations[]

    alt IndicTrans Model
        NMT->>NMT: postprocessBatch(results, dstLang)
    else Standard Model
        NMT->>NMT: strip language prefixes
    end

    NMT-->>App: translated texts[]
```

<details>
<summary>📊 LLM-Friendly: Batch Translation Steps</summary>

| Step | Component | Action |
|------|-----------|--------|
| 1 | TranslationNmtcpp | Pre-process texts (IndicTrans: normalize; Standard: add lang prefix) |
| 2 | TranslationInterface | binding.processBatch(handle, texts) |
| 3a | TranslationModel (Bergamot) | bergamot_translate_batch — true batch |
| 3b | TranslationModel (GGML) | Sequential process() per text |
| 4 | TranslationNmtcpp | Post-process (IndicTrans: denormalize; Standard: strip prefixes) |

</details>

---

## Job Queue and Threading Model

```mermaid
sequenceDiagram
    participant JS as JS Thread (Bare Runtime)
    participant Queue as Job Queue
    participant Worker as C++ Worker Thread
    participant TM as TranslationModel
    participant UV as uv_async_t

    JS->>Queue: append({type: "text", input})
    Note over Queue: Job enqueued with jobId

    JS->>Queue: append({type: "end of job"})
    Note over Queue: Signal end of input

    Worker->>Queue: dequeue job
    Worker->>TM: process(input)
    Note over TM: Encoding → Decoding → Beam Search

    TM-->>Worker: translation result
    Worker->>UV: uv_async_send (notify JS thread)
    UV-->>JS: outputCallback(jobId, result)
    JS->>JS: QvacResponse.onUpdate(data)

    Note over JS,Worker: Pause/Cancel signals propagate<br/>from JS → Queue → Worker
```

<details>
<summary>📊 LLM-Friendly: Threading Model</summary>

| Thread | Action | Communication |
|--------|--------|---------------|
| JS Thread | append() jobs to queue | Job Queue (shared) |
| C++ Worker | dequeue and process | TranslationModel.process() |
| C++ Worker | signal result ready | uv_async_send |
| JS Thread | receive callback | outputCallback → QvacResponse.onUpdate |
| JS Thread | pause/cancel | Queue signal → Worker checks |

</details>

---

**Related Documents:**
- [architecture.md](architecture.md) - Complete architecture documentation

**Last Updated:** 2026-02-12
