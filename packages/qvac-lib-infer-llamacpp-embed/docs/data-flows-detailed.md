# Detailed Flow Diagrams

**⚠️ Warning:** These diagrams may become outdated as the codebase evolves. For debugging, regenerate diagrams from the actual code paths.

**Recommendation:** When investigating issues, trace through the code directly rather than relying solely on these diagrams.

---

## Table of Contents

- [Model Loading Flow](#model-loading-flow)
- [Batch Embedding Generation Flow](#batch-embedding-generation-flow)
- [Weight Loading Flow](#weight-loading-flow)
- [Single Text Embedding Flow](#single-text-embedding-flow)

---

## Model Loading Flow

### Complete Loading Sequence

```mermaid
sequenceDiagram
    participant App as Application
    participant GGMLBert as GGMLBert
    participant WP as WeightsProvider
    participant DL as DataLoader
    participant BI as BertInterface
    participant Addon as Addon<BertModel>
    participant BM as BertModel
    participant LLAMA as llama.cpp
    
    App->>GGMLBert: new GGMLBert(args, config)
    GGMLBert->>GGMLBert: Store config, modelName, diskPath
    GGMLBert->>WP: new WeightsProvider(loader)
    
    App->>GGMLBert: load(closeLoader, onProgress)
    GGMLBert->>BI: new BertInterface(binding, params, callbacks)
    BI->>Addon: createInstance(params)
    Addon->>BM: BertModel(path, config, backendsDir)
    BM->>BM: Delayed init (InitLoader)
    
    alt Sharded Model
        GGMLBert->>GGMLBert: _loadWeights(onProgress)
        GGMLBert->>WP: streamFiles(shards, onChunk, onProgress)
        loop For each shard
            WP->>DL: getStream(shard)
            DL-->>WP: Stream chunks
            WP->>GGMLBert: onChunk(chunkedWeightsData)
            GGMLBert->>BI: loadWeights({filename, chunk, completed})
            BI->>Addon: loadWeights(handle, data)
            Addon->>BM: set_weights_for_file(filename, streambuf)
            BM->>LLAMA: llama_model_load_fulfill_split_future()
        end
    else Single File Model
        GGMLBert->>GGMLBert: downloadWeights(onProgress)
        GGMLBert->>WP: downloadFiles([modelName], diskPath, opts)
        loop Download progress
            WP->>DL: download(modelName, diskPath)
            DL-->>WP: Progress updates
            WP->>GGMLBert: onDownloadProgress(bytes)
        end
    end
    
    GGMLBert->>BI: activate()
    BI->>Addon: activate(handle)
    Addon->>BM: load()
    BM->>BM: init(modelPath, config, backendsDir)
    BM->>BM: lazyCommonInit()
    BM->>BM: initializeBackend(backendsDir)
    BM->>BM: setupParams(modelPath, config)
    BM->>LLAMA: initFromConfig(params, path, streams, shards)
    LLAMA->>LLAMA: Load model weights
    LLAMA-->>BM: model, context
    BM->>BM: Initialize batch, vocab, pooling
    BM-->>Addon: Model loaded
    Addon-->>BI: Activated
    BI-->>GGMLBert: Ready
    GGMLBert-->>App: Model loaded
```

### Sharded Model Loading Detail

```mermaid
sequenceDiagram
    participant JS as JavaScript
    participant Cpp as C++ Addon
    participant Stream as BlobsStream
    participant LLAMA as llama.cpp
    
    Note over JS: WeightsProvider streams shards
    JS->>Cpp: loadWeights({filename: "model-00001-of-00005.gguf", chunk: ArrayBuffer, completed: false})
    Cpp->>Stream: Append blob to streambuf
    Stream->>Stream: Store ArrayBuffer reference
    
    JS->>Cpp: loadWeights({filename: "model-00002-of-00005.gguf", chunk: ArrayBuffer, completed: false})
    Cpp->>Stream: Append blob to streambuf
    
    Note over JS: Last shard
    JS->>Cpp: loadWeights({filename: "model-00005-of-00005.gguf", chunk: ArrayBuffer, completed: true})
    Cpp->>Stream: Append final blob, mark complete
    
    Note over Cpp: activate() called
    Cpp->>LLAMA: llama_model_load() with streambuf
    LLAMA->>Stream: seekg(), read() operations
    Stream->>Stream: Navigate across blobs
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
    GGMLBert->>BI: append({type: 'sequences', input: ["text1", "text2", "text3"]})
    BI->>Addon: append(handle, {type: 'sequences', input: array})
    Addon->>Addon: Enqueue job [lock mutex]
    Addon->>Addon: cv.notify_one()
    Addon-->>BI: jobId
    BI-->>GGMLBert: jobId
    GGMLBert->>BI: append({type: 'end of job'})
    BI->>Addon: append(handle, {type: 'end of job'})
    Addon->>Addon: Mark job input complete
    GGMLBert-->>App: QvacResponse
    
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
    Addon->>BI: jsOutputCallback('Output', jobId, embeddings)
    BI->>GGMLBert: outputCb('Output', jobId, embeddings)
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

## Weight Loading Flow

### Streaming Weight Loading Sequence

```mermaid
sequenceDiagram
    participant JS as JavaScript
    participant WP as WeightsProvider
    participant DL as DataLoader
    participant BI as BertInterface
    participant Addon as Addon<BertModel>
    participant Stream as BlobsStream
    participant LLAMA as llama.cpp
    
    JS->>WP: streamFiles(shards, onChunk, onProgress)
    WP->>WP: Expand shards from modelName
    
    loop For each shard file
        WP->>DL: getStream(shard)
        DL-->>WP: AsyncIterable<Uint8Array>
        
        loop For each chunk
            DL-->>WP: Uint8Array chunk
            WP->>WP: Track progress
            WP->>JS: onProgress({currentFile, currentFileProgress, overallProgress})
            WP->>JS: onChunk({filename, chunk, completed: false})
        end
        
        DL-->>WP: Stream complete
        WP->>JS: onChunk({filename, chunk: null, completed: true})
    end
    
    Note over JS: All shards streamed
    JS->>BI: loadWeights({filename, chunk, completed})
    BI->>Addon: loadWeights(handle, data)
    Addon->>Addon: Convert Uint8Array to std::streambuf
    Addon->>Stream: Append blob
    Stream->>Stream: Store ArrayBuffer reference (zero-copy)
    
    Note over Addon: activate() called later
    Addon->>LLAMA: llama_model_load() with streambuf
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
    GGMLBert->>BI: append({type: 'text', input: "Hello world"})
    BI->>Addon: append(handle, {type: 'text', input: string})
    Addon->>Addon: Enqueue job [lock mutex]
    Addon->>Addon: cv.notify_one()
    Addon-->>BI: jobId
    BI-->>GGMLBert: jobId
    GGMLBert->>BI: append({type: 'end of job'})
    BI->>Addon: append(handle, {type: 'end of job'})
    GGMLBert-->>App: QvacResponse
    
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
    Addon->>BI: jsOutputCallback('Output', jobId, embeddings)
    BI->>GGMLBert: outputCb('Output', jobId, embeddings)
    GGMLBert->>GGMLBert: Convert to Float32Array
    GGMLBert-->>App: Response.await() resolves with embedding
```

---

## Input Type Detection and Routing

### JavaScript Input Detection

```mermaid
flowchart TD
    Start([run input]) --> CheckType{Is Array?}
    CheckType -->|Yes| ArrayPath[type: 'sequences'<br/>input: string[]]
    CheckType -->|No| StringPath[type: 'text'<br/>input: string]
    ArrayPath --> Append[append to addon]
    StringPath --> Append
    Append --> EndOfJob[append end of job]
    EndOfJob --> Return[Return QvacResponse]
```

### C++ Input Routing

```mermaid
flowchart TD
    Start([process Input]) --> Visit[std::visit input]
    Visit --> CheckVariant{Input type?}
    CheckVariant -->|string| SinglePath[encode_host_f32 string]
    CheckVariant -->|vector<string>| BatchPath[encode_host_f32_sequences vector]
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

**Last Updated:** 2026-01-27
