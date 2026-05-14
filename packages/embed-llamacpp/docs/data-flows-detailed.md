# Detailed Flow Diagrams

**⚠️ Warning:** These diagrams may become outdated as the codebase evolves. For debugging, regenerate diagrams from the actual code paths.

**Recommendation:** When investigating issues, trace through the code directly rather than relying solely on these diagrams.

---

## Table of Contents

- [Model Loading Flow](#model-loading-flow)
- [Batch Embedding Generation Flow](#batch-embedding-generation-flow)
- [Weight Streaming Flow](#weight-streaming-flow)
- [Single Text Embedding Flow](#single-text-embedding-flow)

---

## Model Loading Flow

### Complete Loading Sequence

```mermaid
sequenceDiagram
    participant App as Application
    participant GGMLBert as GGMLBert
    participant FS as bare-fs
    participant BI as BertInterface
    participant Addon as Addon<BertModel>
    participant BM as BertModel
    participant LLAMA as llama.cpp

    App->>GGMLBert: new GGMLBert({ files, config, logger, opts })
    GGMLBert->>GGMLBert: Store files array, config, opts
    GGMLBert->>GGMLBert: createJobHandler + exclusiveRunQueue

    App->>GGMLBert: load()
    GGMLBert->>GGMLBert: pick primaryGgufPath = first entry matching /-\d+-of-\d+\.gguf$/<br/>(falls back to files.model[0] for non-sharded models)
    GGMLBert->>BI: new BertInterface(binding, { path: primaryGgufPath, config }, outputCb)
    BI->>Addon: createInstance(params)
    Addon->>BM: BertModel(path, config, backendsDir)
    BM->>BM: Delayed init (InitLoader)

    alt Sharded Model (files.length > 1)
        GGMLBert->>GGMLBert: _streamShards()
        loop For each absolute path in files.model (in order)
            GGMLBert->>FS: fs.createReadStream(absolutePath)
            loop For each chunk
                FS-->>GGMLBert: chunk
                GGMLBert->>BI: loadWeights({filename, chunk, completed: false})
                BI->>Addon: loadWeights(handle, data)
                Addon->>BM: Append blob to streambuf for filename
            end
            GGMLBert->>BI: loadWeights({filename, chunk: null, completed: true})
            BI->>Addon: mark file complete
        end
    else Single File Model (files.length == 1)
        Note over GGMLBert: Skip streaming — addon will read path directly on activate()
    end

    GGMLBert->>BI: activate()
    BI->>Addon: activate(handle)
    Addon->>BM: load()
    BM->>BM: init(modelPath, config, backendsDir)
    BM->>BM: lazyCommonInit()
    BM->>BM: initializeBackend(backendsDir)
    BM->>BM: setupParams(modelPath, config)
    BM->>LLAMA: initFromConfig(params, path, streams, shards)
    LLAMA->>LLAMA: Load model weights (from streambufs or path)
    LLAMA-->>BM: model, context
    BM->>BM: Initialize batch, vocab, pooling
    BM-->>Addon: Model loaded
    Addon-->>BI: Activated
    BI-->>GGMLBert: Ready
    GGMLBert-->>App: Model loaded
```

### Caller Contract for `files.model`

- **Absolute paths only.** `GGMLBert` does not resolve relative paths or discover companion files.
- **Order matters.** For sharded GGUFs, callers pass the `.tensors.txt` companion first, then shards `00001-of-N`, `00002-of-N`, …, `N-of-N` in numeric order. The addon scans the array for the first entry matching the shard regex `/-\d+-of-\d+\.gguf$/` and uses that as the primary path handed to llama.cpp's `params.model.path`. For non-sharded single-file models, the only entry is used. The `.tensors.txt` file is consumed by the streaming layer (along with the shards) but is never the primary path.
- **All files required.** Every shard and the `.tensors.txt` file must be present in the array; missing any file will fail at load time.
- **No download step.** The addon reads bytes from disk via `bare-fs`. Distribution, caching, and integrity are the caller's responsibility.

### Sharded Model Loading Detail

```mermaid
sequenceDiagram
    participant App as Application
    participant GGMLBert as GGMLBert
    participant FS as bare-fs
    participant Cpp as C++ Addon
    participant Stream as BlobsStream
    participant LLAMA as llama.cpp

    Note over App: Caller passes every file explicitly
    App->>GGMLBert: new GGMLBert({ files: { model: [tensorsTxt, shard1..shardN] }, ... })
    App->>GGMLBert: load()

    loop For each absolute path (in order)
        GGMLBert->>FS: createReadStream(path)
        loop For each chunk
            FS-->>GGMLBert: Buffer chunk
            GGMLBert->>Cpp: loadWeights({filename, chunk, completed: false})
            Cpp->>Stream: Append blob to streambuf (zero-copy)
        end
        GGMLBert->>Cpp: loadWeights({filename, chunk: null, completed: true})
        Cpp->>Stream: Mark file complete
    end

    Note over Cpp: activate() called
    Cpp->>LLAMA: llama_model_load() with streambufs
    LLAMA->>Stream: seekg(), read() operations across blobs
    Stream-->>LLAMA: Model weight data
    LLAMA->>LLAMA: Parse GGUF, load tensors
    LLAMA-->>Cpp: Model loaded
```

---

## Batch Embedding Generation Flow

### Complete Batch Processing Sequence

```mermaid
sequenceDiagram
    participant App as Application
    participant GGMLBert as GGMLBert
    participant BI as BertInterface
    participant Addon as Addon<BertModel>
    participant BM as BertModel
    participant LLAMA as llama.cpp
    
    App->>GGMLBert: run(["text1", "text2", "text3"])
    GGMLBert->>GGMLBert: Detect array input
    GGMLBert->>BI: runJob({type: 'sequences', input: ["text1", "text2", "text3"]})
    BI->>Addon: runJob(handle, {type: 'sequences', input: array})
    Addon->>Addon: Enqueue job [lock mutex]
    Addon->>Addon: cv.notify_one()
    Addon-->>BI: success
    BI-->>GGMLBert: success
    GGMLBert-->>App: QvacResponse (fixed job id 'job')
    
    Note over Addon: Processing Thread
    Addon->>Addon: Dequeue job
    Addon->>Addon: uv_async_send(JobStarted)
    Addon->>BM: process(variant<vector<string>>)
    
    BM->>BM: std::visit (vector<string> branch)
    BM->>BM: encode_host_f32_sequences(vector)
    BM->>BM: tokenizeInput(prompts)
    BM->>BM: Check context overflow (each < 512 tokens)
    BM->>BM: Check batch overflow (total < batch_size)
    
    BM->>BM: Accumulate tokens until batch_size
    BM->>LLAMA: llama_batch_init(batch_size, 0, 1)
    BM->>LLAMA: llama_batch_add() for each sequence
    BM->>LLAMA: llama_decode(ctx, batch)
    LLAMA->>LLAMA: Forward pass (GPU/CPU)
    LLAMA-->>BM: Logits for all sequences
    
    BM->>BM: llama_get_embeddings() for each sequence
    BM->>BM: Apply pooling (mean/cls/last)
    BM->>BM: Normalize embeddings
    BM->>BM: Create BertEmbeddings(vector<float>)
    BM-->>Addon: outputCallback(embeddings)
    
    Addon->>Addon: Queue output [lock]
    Addon->>Addon: uv_async_send()
    
    Note over Addon: UV async callback (JS thread)
    Addon->>BI: jsOutputCallback('Output', embeddings)
    BI->>GGMLBert: outputCb('Output', embeddings)
    GGMLBert->>GGMLBert: Convert to Float32Array[]
    GGMLBert-->>App: Response.await() resolves with embeddings
```

### Batch Token Accumulation Detail

```mermaid
flowchart TD
    Start([Start: vector<string> input]) --> Tokenize[Tokenize all prompts]
    Tokenize --> CheckOverflow{Any sequence > 512 tokens?}
    CheckOverflow -->|Yes| Error1[Throw ContextOverflow]
    CheckOverflow -->|No| InitBatch[Initialize batch accumulator]
    InitBatch --> LoopStart{More sequences?}
    LoopStart -->|No| ProcessBatch[Process accumulated batch]
    LoopStart -->|Yes| GetNext[Get next sequence]
    GetNext --> TokenizeSeq[Tokenize sequence]
    TokenizeSeq --> CheckBatch{Total tokens + seq tokens > batch_size?}
    CheckBatch -->|Yes| ProcessBatch
    CheckBatch -->|No| AddToBatch[Add sequence to batch]
    AddToBatch --> LoopStart
    ProcessBatch --> ForwardPass[llama_decode batch]
    ForwardPass --> ExtractEmbs[Extract embeddings]
    ExtractEmbs --> MoreSeqs{More sequences?}
    MoreSeqs -->|Yes| LoopStart
    MoreSeqs -->|No| Return[Return all embeddings]
    Error1 --> End([End])
    Return --> End
```

---

## Weight Streaming Flow

### Direct File Streaming Sequence

`GGMLBert` has no `WeightsProvider` and no data loader. It streams each caller-supplied absolute path straight from disk using `bare-fs.createReadStream` and forwards chunks to the native addon. Distribution (downloading, P2P, cache, integrity) happens entirely outside this package.

```mermaid
sequenceDiagram
    participant JS as GGMLBert
    participant FS as bare-fs
    participant BI as BertInterface
    participant Addon as Addon<BertModel>
    participant Stream as BlobsStream
    participant LLAMA as llama.cpp

    Note over JS: Caller passed files.model = [file1, file2, ...]
    loop For each absolute path (in order)
        JS->>FS: fs.createReadStream(path)
        loop For each chunk
            FS-->>JS: Buffer chunk
            JS->>BI: loadWeights({filename, chunk, completed: false})
            BI->>Addon: loadWeights(handle, data)
            Addon->>Stream: Append blob (zero-copy ArrayBuffer ref)
        end
        FS-->>JS: stream end
        JS->>BI: loadWeights({filename, chunk: null, completed: true})
        BI->>Addon: loadWeights(handle, data)
        Addon->>Stream: Mark file complete
    end

    Note over Addon: activate() called later
    Addon->>LLAMA: llama_model_load() with streambufs
    LLAMA->>Stream: seekg(offset)
    Stream->>Stream: Find blob containing offset
    Stream->>Stream: Calculate position within blob
    Stream-->>LLAMA: Position ready
    LLAMA->>Stream: read(buffer, size)
    Stream->>Stream: Copy from ArrayBuffer to buffer
    Stream-->>LLAMA: Weight data
    LLAMA->>LLAMA: Parse GGUF, load tensors
```

### Memory Lifecycle

```mermaid
sequenceDiagram
    participant JS as JavaScript
    participant Cpp as C++ Addon
    participant Stream as BlobsStream
    participant RefMgr as ThreadQueuedRefDeleter
    
    Note over JS: ArrayBuffer created from stream
    JS->>Cpp: loadWeights({chunk: ArrayBuffer})
    Cpp->>Cpp: js_get_typedarray_info() - get pointer
    Cpp->>Stream: Append blob (store pointer, no copy)
    Note over Cpp: ArrayBuffer reference kept alive
    
    Note over Cpp: Model loading in progress
    Cpp->>Stream: read() operations
    Stream->>Stream: Access ArrayBuffer memory directly
    
    Note over Cpp: Loading complete
    Cpp->>RefMgr: Schedule ArrayBuffer deletion
    RefMgr->>RefMgr: Queue for JS thread
    
    Note over JS: JS thread processes queue
    RefMgr->>JS: js_delete_reference() on JS thread
    JS->>JS: ArrayBuffer eligible for GC
```

---

## Single Text Embedding Flow

### Single Text Processing Sequence

```mermaid
sequenceDiagram
    participant App as Application
    participant GGMLBert as GGMLBert
    participant BI as BertInterface
    participant Addon as Addon<BertModel>
    participant BM as BertModel
    participant LLAMA as llama.cpp
    
    App->>GGMLBert: run("Hello world")
    GGMLBert->>GGMLBert: Detect string input
    GGMLBert->>BI: runJob({type: 'text', input: "Hello world"})
    BI->>Addon: runJob(handle, {type: 'text', input: string})
    Addon->>Addon: Enqueue job [lock mutex]
    Addon->>Addon: cv.notify_one()
    Addon-->>BI: success
    BI-->>GGMLBert: success
    GGMLBert-->>App: QvacResponse (fixed job id 'job')
    
    Note over Addon: Processing Thread
    Addon->>Addon: Dequeue job
    Addon->>Addon: uv_async_send(JobStarted)
    Addon->>BM: process(variant<string>)
    
    BM->>BM: std::visit (string branch)
    BM->>BM: encode_host_f32(string)
    BM->>BM: tokenizeInput([string])
    BM->>BM: Check context overflow (< 512 tokens)
    
    BM->>LLAMA: llama_batch_init(1, 0, 1)
    BM->>LLAMA: llama_batch_add() for sequence
    BM->>LLAMA: llama_decode(ctx, batch)
    LLAMA->>LLAMA: Forward pass (GPU/CPU)
    LLAMA-->>BM: Logits
    
    BM->>BM: llama_get_embeddings()
    BM->>BM: Apply pooling (mean/cls/last)
    BM->>BM: Normalize embedding
    BM->>BM: Create BertEmbeddings(vector<float>)
    BM-->>Addon: outputCallback(embeddings)
    
    Addon->>Addon: Queue output [lock]
    Addon->>Addon: uv_async_send()
    
    Note over Addon: UV async callback (JS thread)
    Addon->>BI: jsOutputCallback('Output', embeddings)
    BI->>GGMLBert: outputCb('Output', embeddings)
    GGMLBert->>GGMLBert: Convert to Float32Array
    GGMLBert-->>App: Response.await() resolves with embedding
```

---

## Input Type Detection and Routing

### JavaScript Input Detection

```mermaid
flowchart TD
    Start([run input]) --> CheckType{Is Array?}
    CheckType -->|Yes| ArrayPath["type: 'sequences'<br/>input: array of strings"]
    CheckType -->|No| StringPath["type: 'text'<br/>input: string"]
    ArrayPath --> RunJob[runJob to addon]
    StringPath --> RunJob
    RunJob --> Return[Return QvacResponse with fixed job id]
```

### C++ Input Routing

```mermaid
flowchart TD
    Start([process Input]) --> Visit[std::visit input]
    Visit --> CheckVariant{Input type?}
    CheckVariant -->|string| SinglePath[encode_host_f32 string]
    CheckVariant -->|"vector&lt;string&gt;"| BatchPath[encode_host_f32_sequences vector]
    SinglePath --> TokenizeSingle[Tokenize single string]
    BatchPath --> TokenizeBatch[Tokenize all strings]
    TokenizeSingle --> CheckContext1{> 512 tokens?}
    TokenizeBatch --> CheckContext2{Any > 512 tokens?}
    CheckContext1 -->|Yes| Error1[ContextOverflow]
    CheckContext1 -->|No| ProcessSingle[Process single embedding]
    CheckContext2 -->|Yes| Error2[ContextOverflow]
    CheckContext2 -->|No| ProcessBatch[Process batch embeddings]
    ProcessSingle --> Return[Return BertEmbeddings]
    ProcessBatch --> Return
    Error1 --> End
    Error2 --> End
    Return --> End([End])
```

---

**Last Updated:** 2026-04-16
