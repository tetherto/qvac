# QVAC RAG Library

A JavaScript library for Retrieval-Augmented Generation (RAG) within the QVAC ecosystem. Build powerful, context-aware AI applications with seamless document ingestion, vector search, and LLM integration.

## Features

- **Document Ingestion**: Batch embeddings, parallel queries, LRU caching
- **Lifecycle Controls**: AbortSignal cancellation, granular progress reporting, configurable intervals
- **Search Optimization**: Database reindexing API for improved search quality
- **Document Management**: Full pipeline ingestion or direct embedding save, safe deletion
- **Contextual Retrieval**: Hybrid vector + text similarity search
- **Multi-LLM Support**: QVAC runtime models, HTTP APIs (for cloud LLMs), custom adapters
- **Universal Embedding Support**: Use any embedding service via custom function
- **Pluggable Architecture**: Adapter-based design for LLMs, chunking, and databases
- **Type Safety**: Zod validation for runtime type checking

## Installation

Before proceeding with the installation, please generate a **granular Personal Access Token (PAT)** with the `read-only` scope. Once generated, add the token to your environment variables using the name `NPM_TOKEN`.

```bash
export NPM_TOKEN=your_personal_access_token
```

Next, create a `.npmrc` file in the root of your project with the following content:

```ini
@qvac:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken={NPM_TOKEN}
```

This configuration ensures secure access to NPM Packages when installing scoped packages.

```bash
npm install @qvac/rag
```

### Dependencies

Each pluggable adapter has specific dependency requirements. Choose the adapters you need and install their dependencies:

#### Database Adapters

**`HyperDBAdapter`** - Decentralized vector database

```bash
npm install corestore hyperdb hyperschema
```

**`BaseDBAdapter`** - Custom database interface

```bash
# No dependencies - implement your own database logic
```

#### LLM Adapters

**`QvacLlmAdapter`** - QVAC runtime models

```bash
npm install @qvac/llm-llamacpp

# Option 1: Directly through the addon (you will need local model files)
# No additional dependencies. See example in `examples/direct-rag.js`

# Option 2: Through runtime manager. See example in `examples/quickstart.js`
npm install @tetherto/qvac-lib-rt @tetherto/qvac-lib-router-inference @tetherto/qvac-lib-manager-inference
```

**`HttpLlmAdapter`** - HTTP API integration (OpenAI, Anthropic, etc.)

```bash
npm install bare-fetch
```

**`BaseLlmAdapter`** - Custom LLM interface

```bash
# No dependencies - implement your own LLM logic
```

#### Embedding Functions

**QVAC Embedding Addon** - Local model inference

```bash
npm install @qvac/embed-llamacpp

# Option 1: Directly through the addon (you will need local model files)
# No additional dependencies. See example in `examples/direct-rag.js`

# Option 2: Through runtime manager. See example in `examples/quickstart.js`
npm install @tetherto/qvac-lib-rt @tetherto/qvac-lib-router-inference @tetherto/qvac-lib-manager-inference
```

**Custom Embedding Functions** - Any service you prefer

```bash
# No dependencies - implement your own embedding logic and plug it in
```

#### Chunking Adapters

**`LLMChunkAdapter`** - Intelligent text chunking

```bash
# Required
npm install llm-splitter
```

**`BaseChunkAdapter`** - Custom chunking interface

```bash
# No dependencies - implement your own chunking logic
```

#### Common Adapter Combinations

**Full-featured setup** (default adapters with all features):

```bash
npm install @qvac/rag

# Database: HyperDBAdapter
npm install corestore hyperdb hyperschema

# LLM: QvacLlmAdapter
npm install @tetherto/qvac-lib-rt @tetherto/qvac-lib-router-inference @tetherto/qvac-lib-manager-inference @qvac/llm-llamacpp

# Embedding: QVAC Embedding Addon
npm install @qvac/embed-llamacpp

# Chunking: LLMChunkAdapter
npm install llm-splitter
```

**Lightweight HTTP setup** (cloud LLMs, minimal dependencies):

```bash
npm install @qvac/rag

# Database: HyperDBAdapter (still need vector storage)
npm install corestore hyperdb hyperschema

# LLM: HttpLlmAdapter for OpenAI/Anthropic
npm install bare-fetch

# Chunking: LLMChunkAdapter (basic word tokenization)
npm install llm-splitter
```

**Custom implementation** (bring your own adapters):

```bash
npm install @qvac/rag
# No additional dependencies - use your custom BaseDBAdapter, BaseLlmAdapter, BaseChunkAdapter
```

**Installation Strategy:**

- **Minimal production bundle**: Only 3 core dependencies (`@qvac/error`, `ready-resource`, `uuid-random`)
- **Tests work out of the box**: Adapter deps included in `devDependencies` for seamless testing
- **Production efficiency**: Use `npm install --omit=dev` to exclude testing dependencies
- **Pick and choose**: Install only the adapter dependencies you actually need
- **Clear error guidance**: Missing dependencies show helpful install commands with exact package names
- **Pluggable architecture**: Mix and match adapters based on your requirements

> **Performance Benefits**: Production deployments get minimal bundle sizes while development and testing have full functionality. Dependencies are only loaded at runtime when specific adapters are used.

## Architecture

The library follows a modular architecture:

```
RAG (Orchestrator)
├── Core Services
│   ├── ChunkingService    - Text segmentation and tokenization
│   └── EmbeddingService   - Vector generation and processing
└── Business Services
    ├── IngestionService   - Document ingestion workflow
    └── RetrievalService   - Context retrieval workflow

Adapters (Plugin System)
├── Database Adapters
│   ├── HyperDBAdapter    - HyperDB implementation
│   └── BaseDBAdapter     - Custom database interface
├── LLM Adapters
│   ├── QvacLlmAdapter    - QVAC runtime models
│   ├── HttpLlmAdapter    - HTTP API integration
│   └── BaseLlmAdapter    - Custom LLM interface
└── Chunking Adapters
    ├── LLMChunkAdapter   - Intelligent text chunking
    └── BaseChunkAdapter  - Custom chunking interface
```

## API Reference

### RAG Class

#### Constructor

```typescript
new RAG({
  llm: BaseLlmAdapter, // Optional: LLM adapter (required for inference)
  embeddingFunction: EmbeddingFunction, // Required: embedding function
  dbAdapter: BaseDBAdapter, // Required: Database adapter
  chunker: BaseChunkAdapter, // Optional: Custom chunker
  chunkOpts: ChunkOpts, // Optional: Chunking configuration
});
```

#### Setting up HyperDBAdapter

The default database adapter requires a Corestore instance for persistent storage:

```javascript
const Corestore = require("corestore");
const { HyperDBAdapter } = require("@qvac/rag");

// Create a Corestore instance with persistent storage
const store = new Corestore("./my-rag-data");

// Create database adapter with store
const dbAdapter = new HyperDBAdapter({ store });

// Alternative: Use external HyperDB instance
const HyperDB = require("hyperdb");
const dbSpec = require("./path/to/your/db-spec");
const hypercore = store.get({ name: "my-db" });
const db = HyperDB.bee(hypercore, dbSpec);
const dbAdapter = new HyperDBAdapter({ db });
```

**Configuration Options:**

- `store`: Corestore instance (required when not providing `db`)
- `db`: External HyperDB instance (optional)
- `dbName`: Name for the hypercore (default: 'rag-vector-store')
- `documentsTable`, `vectorsTable`, etc.: Configurable table names

#### Core Methods

##### `generateEmbeddings(text)`

Generate embeddings for a single text.

```typescript
await rag.generateEmbeddings(text: string): Promise<number[]>
```

##### `generateEmbeddingsForDocs(docs, opts?)`

Generate embeddings for a set of documents.

```typescript
await rag.generateEmbeddingsForDocs(
  docs: string | string[],
  opts?: {
    chunk?: boolean,
    chunkOpts?: BaseChunkOpts,
    signal?: AbortSignal
  }
): Promise<{ [key: string]: number[] }>
```

##### `chunk(input, chunkOpts?)`

Chunks text into multiple chunks using configured chunking options.

```typescript
await rag.chunk(
  input: string | string[],
  chunkOpts?: BaseChunkOpts  // Override default chunking options
): Promise<Doc[]>
```

##### `ingest(docs, opts?)`

Full pipeline: chunk, embed, and save documents to the vector database.

```typescript
await rag.ingest(
  docs: string | string[],
  opts?: {
    chunk?: boolean,                              // Default: true
    chunkOpts?: BaseChunkOpts,
    dbOpts?: DbOpts,
    onProgress?: (stage, current, total) => void, // Stage-aware progress
    progressInterval?: number,                     // Report every N docs (default: 10)
    signal?: AbortSignal                          // Cancellation support
  }
): Promise<{
  processed: SaveEmbeddingsResult[],
  droppedIndices: number[]
}>
```

**Progress Stages:**

- `chunking` - Document chunking phase
- `embedding` - Embedding generation phase
- `saving:deduplicating` - Checking for duplicates
- `saving:preparing` - Computing hashes/centroids
- `saving:writing` - Writing to database

##### `saveEmbeddings(embeddedDocs, opts?)`

Save embedded documents directly to the vector database. Documents must have `id`, `content`, and `embedding` fields.

```typescript
await rag.saveEmbeddings(
  embeddedDocs: EmbeddedDoc[],
  opts?: SaveEmbeddingsOpts
): Promise<SaveEmbeddingsResult[]>
```

**Options:**

- `dbOpts` - Database adapter options
- `onProgress(current, total)` - Progress callback
- `signal` - AbortSignal for cancellation

##### `search(query, params?)`

Search for documents based on semantic similarity.

```typescript
await rag.search(
  query: string,
  params?: {
    topK?: number,      // Number of results (default: 5)
    n?: number,         // Centroids to search (default: 3)
    signal?: AbortSignal
  }
): Promise<SearchResult[]>
```

##### `infer(query, opts?)`

Generate AI responses using retrieved context.

```typescript
await rag.infer(
  query: string,
  opts?: {
    topK?: number,           // Context docs to retrieve
    n?: number,              // Centroids to search
    llmAdapter?: BaseLlmAdapter,  // Override default LLM
    signal?: AbortSignal
  }
): Promise<any>  // Format depends on LLM adapter
```

##### `reindex(opts?)`

Optimize database index structure to improve search quality. Implementation depends on the database adapter (e.g., HyperDBAdapter uses k-means centroid rebalancing).

```typescript
await rag.reindex(
  opts?: {
    onProgress?: (stage, current, total) => void,
    signal?: AbortSignal
  }
): Promise<{
  reindexed: boolean,
  details?: Record<string, any>  // Adapter-specific details
}>
```

**Note:** Progress stages and details vary by adapter. HyperDBAdapter reports: `collecting`, `clustering`, `reassigning`, `updating`.

##### `deleteEmbeddings(ids)`

Delete embeddings for documents from the vector database.

```typescript
await rag.deleteEmbeddings(ids: string[]): Promise<boolean>
```

##### `setLlm(llmAdapter)`

Set the default LLM adapter for the RAG instance.

```typescript
rag.setLlm(llmAdapter: BaseLlmAdapter): void
```

## Text Chunking

The `LLMChunkAdapter` provides token-aware chunking with lots of flexibility.

### Options

```typescript
{
  chunkSize: 256,           // Max tokens per chunk
  chunkOverlap: 50,         // Overlapping tokens
  chunkStrategy: 'paragraph', // How chunks are grouped: 'character' | 'paragraph'
  splitStrategy: 'token',   // Built-in tokenizers: 'token' | 'word' | 'sentence' | 'line' | 'character'
  splitter: (text) => string[]  // Custom tokenizer (overrides splitStrategy)
}
```

**Default**: Token-based chunking

### Custom Tokenizers

Use model-specific tokenizers for accurate chunk sizing:

```javascript
// Install: npm install tiktoken
const tiktoken = require("tiktoken");

// Create tiktoken-based splitter
const encoding = tiktoken.encoding_for_model("text-embedding-ada-002");

const chunker = new LLMChunkAdapter({
  splitter: (text) => {
    const tokens = encoding.encode(text);
    return tokens.map((t) => new TextDecoder().decode(encoding.decode([t])));
  },
  chunkSize: 256,
});

// Don't forget to clean up
encoding.free();
```

**Note**: Custom splitters must preserve original text (no lowercasing/transformations).

## Examples

Get started with these examples:

### [Quick Start](./examples/quickstart.js)

Complete RAG workflow with document ingestion, search, and inference:

```bash
bare examples/quickstart.js
```

### [Custom Chunking Strategies](./examples/chunking.js)

Comparing different tokenizers and chunking approaches:

```bash
bare examples/chunking.js
```

## Testing

To run the tests, use the following commands:

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# All tests
npm test
```

**Important**: Before running the integration tests, make sure you have installed the required libraries as specified in the integration test.

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](https://github.com/tetherto/qvac-lib-rag/blob/main/LICENSE) file for details.

For any questions or issues, please open an issue on the GitHub repository.
