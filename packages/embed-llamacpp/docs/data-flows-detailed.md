# Detailed Flow Diagrams

**⚠️ Warning:** These diagrams may become outdated as the codebase evolves. For debugging, regenerate diagrams from the actual code paths.

**Recommendation:** When investigating issues, trace through the code directly rather than relying solely on these diagrams.

---

## Table of Contents

- [Model Loading Flow](#model-loading-flow)
- [Batch Embedding Generation Flow](#batch-embedding-generation-flow)
- [Removed Weight Streaming](#removed-weight-streaming)
- [Single Text Embedding Flow](#single-text-embedding-flow)

---

## Model Loading Flow

Models load from disk only. Pass exactly one absolute path in `files.model`:
the single GGUF file, or the first shard (`*-00001-of-000NN.gguf`). All shards
must already be in the same directory with their original names. Fabric reads
the GGUF metadata, discovers the remaining shards and reads their weights.
No JavaScript weight buffers or `.tensors.txt` file are needed.

Passing multiple paths or weight buffers is rejected. Migrate an old all-files
list to `[firstShardPath]`. The `loadWeights()` API has been removed.
This removes model-weight streaming, while generated output still streams as before.

```mermaid
sequenceDiagram
    participant App as Application
    participant JS as JS addon
    participant Native as Native model
    participant Fabric as Fabric
    participant Disk as Local GGUF files
    App->>JS: new Model({files: {model: [firstPath]}})
    JS->>JS: Validate one absolute disk path
    App->>JS: load()
    JS->>Native: createInstance(path, config)
    JS->>Native: activate()
    Native->>Fabric: Read metadata from path
    Fabric->>Disk: Read first GGUF header
    Native->>Fabric: common_init_from_params(params)
    Fabric->>Disk: Discover and read disk shards, if split
    Native-->>JS: Model ready
    JS-->>App: load() resolves
```

This path is shared by `GGMLBert`, `LayaDecisions` and `Reranker`.
The reranker also checks shard headers for its classifier tensors; the shard
count comes from the bounded GGUF header, never from the filename.

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

## Removed Weight Streaming

Models load from disk only. Pass exactly one absolute path in `files.model`:
the single GGUF file, or the first shard (`*-00001-of-000NN.gguf`). All shards
must already be in the same directory with their original names. Fabric reads
the GGUF metadata, discovers the remaining shards and reads their weights.
No JavaScript weight buffers or `.tensors.txt` file are needed.

Passing multiple paths or weight buffers is rejected. Migrate an old all-files
list to `[firstShardPath]`. The `loadWeights()` API has been removed.
This removes model-weight streaming, while generated output still streams as before.

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
